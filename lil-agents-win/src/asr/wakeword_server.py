"""
Wake Word Detection HTTP service for lil-agents-win.

Continuously listens to the microphone, performs VAD (Voice Activity Detection),
and sends short audio clips to the ASR service for wake word detection.

REST API:
  GET  /health   -> {"status": "ready"|"listening"|"stopped"}
  POST /start    -> Start listening for wake word
  POST /stop     -> Stop listening
  GET  /events   -> SSE stream (pushes "wakeword" events when detected)

Environment variables:
  WAKEWORD_PORT  - Port to listen on (default: 18922)
  ASR_URL        - ASR service base URL (default: http://127.0.0.1:18920)
  WAKE_WORDS     - Comma-separated wake words (default: 小爱,小艾,小哎)
"""

import io
import json
import os
import queue
import threading
import time
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

import numpy as np
import sounddevice as sd
import soundfile as sf

# --- Configuration ---
PORT = int(os.environ.get("WAKEWORD_PORT", "18922"))
ASR_URL = os.environ.get("ASR_URL", "http://127.0.0.1:18920")
# Wake words are hardcoded to avoid Windows env var encoding issues (GBK vs UTF-8).
# Includes tolerance variants because the leading "小" is often dropped or
# misheard as "哎"/"诶"/"爱" by the ASR, producing strings like "哎同学".
WAKE_WORDS = [
    "小爱", "小艾", "小哎",
    "爱同学", "哎同学", "诶同学", "艾同学",
]

SAMPLE_RATE = 16000
CHANNELS = 1
BLOCK_DURATION = 0.1        # seconds per audio block
BLOCK_SIZE = int(SAMPLE_RATE * BLOCK_DURATION)

RMS_THRESHOLD = 0.015       # VAD energy threshold (lowered for sensitivity)
SPEECH_MIN_DURATION = 0.2   # seconds of continuous speech before recording (reduced)
RECORD_DURATION = 2.0       # seconds to record for ASR check
COOLDOWN = 3.0              # seconds between ASR checks
SILENCE_TIMEOUT = 0.5       # seconds of silence to reset VAD
LOOKBACK_SECONDS = 0.8      # seconds of audio to prepend before speech onset (raised from 0.5 to better capture soft "小" onset)

# --- Global state ---
listening = False
sse_clients = []             # list of queue.Queue for SSE connections
sse_lock = threading.Lock()
_listen_thread = None
_stop_event = threading.Event()


def log(msg):
    print(f"[Wakeword] {msg}", flush=True)


def push_sse_event(event_type, data):
    """Push an SSE event to all connected clients."""
    msg = f"event: {event_type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
    with sse_lock:
        client_count = len(sse_clients)
        log(f"Pushing SSE event '{event_type}' to {client_count} client(s)")
        dead = []
        for q in sse_clients:
            try:
                q.put_nowait(msg)
            except queue.Full:
                dead.append(q)
        for q in dead:
            sse_clients.remove(q)


def transcribe_audio(wav_bytes):
    """Send WAV audio to ASR service for transcription."""
    import urllib.request
    import urllib.error

    boundary = "----WakewordBoundary"
    parts = []

    # File part
    parts.append(f"--{boundary}\r\n".encode())
    parts.append(b'Content-Disposition: form-data; name="file"; filename="wakeword.wav"\r\n')
    parts.append(b"Content-Type: audio/wav\r\n\r\n")
    parts.append(wav_bytes)
    parts.append(b"\r\n")

    # End boundary
    parts.append(f"--{boundary}--\r\n".encode())

    body = b"".join(parts)

    req = urllib.request.Request(
        f"{ASR_URL}/transcribe",
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        },
        method="POST",
    )

    try:
        log(f"Sending {len(wav_bytes)} bytes to ASR at {ASR_URL}/transcribe")
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            text = result.get("text", "")
            log(f"ASR response: text='{text}', lang={result.get('language', '?')}")
            return text
    except urllib.error.URLError as e:
        log(f"ASR request failed: {e}")
        return ""
    except Exception as e:
        log(f"ASR error: {e}")
        return ""


def check_wake_word(text):
    """Check if transcribed text contains any wake word."""
    if not text:
        return False
    for word in WAKE_WORDS:
        if word in text:
            log(f"Wake word '{word}' found in '{text}'")
            return True
    return False


def _listen_loop():
    """Main listening loop - runs in a background thread."""
    global listening
    from collections import deque

    log(f"Listen loop started (threshold={RMS_THRESHOLD}, record={RECORD_DURATION}s, lookback={LOOKBACK_SECONDS}s)")
    log(f"Default input device: {sd.default.device[0]}")

    # Lookback buffer: keeps last N blocks of audio so we capture the start of speech
    lookback_blocks = int(LOOKBACK_SECONDS / BLOCK_DURATION)
    lookback = deque(maxlen=lookback_blocks)

    # VAD state
    speech_start = None
    recording = False
    record_start = None
    recorded_frames = []
    last_check_time = 0
    rms_log_counter = 0

    try:
        with sd.InputStream(samplerate=SAMPLE_RATE, channels=CHANNELS,
                            blocksize=BLOCK_SIZE, dtype="float32") as stream:
            log(f"Microphone stream opened: sr={SAMPLE_RATE}, blocksize={BLOCK_SIZE}, lookback={lookback_blocks} blocks")
            while not _stop_event.is_set() and listening:
                data, overflowed = stream.read(BLOCK_SIZE)
                if overflowed:
                    continue

                audio = data[:, 0] if data.ndim > 1 else data
                rms = np.sqrt(np.mean(audio ** 2))
                now = time.time()

                # Log RMS every ~3 seconds
                rms_log_counter += 1
                if rms_log_counter % 30 == 0:
                    above = "ABOVE" if rms > RMS_THRESHOLD else "below"
                    state = 'recording' if recording else ('speech' if speech_start else 'idle')
                    log(f"RMS={rms:.6f} ({above} threshold), state={state}")

                if recording:
                    recorded_frames.append(audio.copy())
                    elapsed = now - record_start

                    if elapsed >= RECORD_DURATION:
                        recording = False
                        speech_start = None

                        if now - last_check_time < COOLDOWN:
                            log(f"In cooldown, skipping ASR check")
                            recorded_frames = []
                            continue

                        last_check_time = now

                        full_audio = np.concatenate(recorded_frames)
                        recorded_frames = []

                        wav_buf = io.BytesIO()
                        sf.write(wav_buf, full_audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
                        wav_bytes = wav_buf.getvalue()

                        duration = len(full_audio) / SAMPLE_RATE
                        log(f"Recording complete: {duration:.1f}s, {len(wav_bytes)} bytes WAV")

                        text = transcribe_audio(wav_bytes)

                        if text:
                            if check_wake_word(text):
                                log(f"*** WAKE WORD DETECTED in '{text}' ***")
                                push_sse_event("wakeword", {
                                    "text": text,
                                    "timestamp": int(now),
                                })
                                last_check_time = now + 5.0
                            else:
                                log(f"No wake word in: '{text}'")
                        else:
                            log(f"ASR returned empty text")

                elif rms > RMS_THRESHOLD:
                    if speech_start is None:
                        speech_start = now
                    elif now - speech_start >= SPEECH_MIN_DURATION:
                        # Start recording, prepend lookback buffer to capture word onset
                        recording = True
                        record_start = now - LOOKBACK_SECONDS  # adjust start time
                        recorded_frames = list(lookback) + [audio.copy()]
                        log(f"Speech sustained {now - speech_start:.2f}s, START RECORDING (with {len(lookback)} lookback blocks)")
                else:
                    if speech_start is not None:
                        if now - speech_start > SILENCE_TIMEOUT:
                            speech_start = None

                # Always maintain lookback buffer (when not recording)
                if not recording:
                    lookback.append(audio.copy())

    except Exception as e:
        log(f"Listen loop error: {e}")
        traceback.print_exc()
    finally:
        listening = False
        log("Listen loop exited")


def start_listening():
    """Start the wake word detection loop."""
    global listening, _listen_thread, _stop_event

    if listening:
        log("Already listening, ignoring start request")
        return

    log("Starting wake word listening...")
    _stop_event.clear()
    listening = True
    _listen_thread = threading.Thread(target=_listen_loop, daemon=True)
    _listen_thread.start()


def stop_listening():
    """Stop the wake word detection loop."""
    global listening
    log("Stopping wake word listening...")
    listening = False
    _stop_event.set()


class WakewordHandler(BaseHTTPRequestHandler):
    """HTTP request handler for wake word service."""

    def do_GET(self):
        if self.path == "/health":
            status = "listening" if listening else "ready"
            self._json_response(200, {
                "status": status,
                "wake_words": WAKE_WORDS,
            })
        elif self.path == "/events":
            self._handle_sse()
        else:
            self._json_response(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/start":
            start_listening()
            self._json_response(200, {"status": "listening"})
        elif self.path == "/stop":
            stop_listening()
            self._json_response(200, {"status": "stopped"})
        else:
            self._json_response(404, {"error": "not found"})

    def _handle_sse(self):
        """Server-Sent Events stream."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        q = queue.Queue(maxsize=100)
        with sse_lock:
            sse_clients.append(q)
            log(f"SSE client connected (total: {len(sse_clients)})")

        try:
            # Send initial heartbeat
            self.wfile.write(b": heartbeat\n\n")
            self.wfile.flush()

            while True:
                try:
                    msg = q.get(timeout=30)
                    log(f"SSE sending event to client...")
                    self.wfile.write(msg.encode("utf-8"))
                    self.wfile.flush()
                    log(f"SSE event sent successfully")
                except queue.Empty:
                    # Send keepalive
                    try:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        break
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with sse_lock:
                if q in sse_clients:
                    sse_clients.remove(q)
                log(f"SSE client disconnected (remaining: {len(sse_clients)})")

    def _json_response(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        log(f"HTTP {args[0]}")


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    """Handle each request in a new thread so SSE doesn't block other endpoints."""
    daemon_threads = True


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), WakewordHandler)
    log(f"Server listening on http://127.0.0.1:{PORT}")
    log(f"ASR URL: {ASR_URL}")
    log(f"Wake words: {WAKE_WORDS}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Shutting down.")
        stop_listening()
        server.shutdown()


if __name__ == "__main__":
    main()
