"""
Edge-TTS HTTP service for lil-agents-win.

Uses Microsoft Edge's online TTS (via edge-tts package) for near-instant
speech synthesis. Exposes the same REST API as the previous Qwen3-TTS server:
  GET  /health      -> {"status": "ready"}
  POST /synthesize  -> WAV audio bytes (or chunked streaming)

No GPU required. No model to load. Requires internet.

Environment variables:
  TTS_PORT             - Port to listen on (default: 18921)
  TTS_VOICE_ZH         - Chinese voice (default: zh-CN-XiaoyiNeural)
  TTS_VOICE_EN         - English voice (default: en-US-AnaNeural)
  TTS_VOICE_JA         - Japanese voice (default: ja-JP-NanamiNeural)
  TTS_MAX_TEXT_LENGTH   - Max text length before truncation (default: 500)
"""

import asyncio
import io
import os
import re
import struct
import subprocess
import shutil
import tempfile
import time
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
import json

import edge_tts

PORT = int(os.environ.get("TTS_PORT", "18921"))
VOICE_ZH = os.environ.get("TTS_VOICE_ZH", "zh-CN-XiaoxiaoNeural")
VOICE_EN = os.environ.get("TTS_VOICE_EN", "en-US-AnaNeural")
VOICE_JA = os.environ.get("TTS_VOICE_JA", "ja-JP-NanamiNeural")
MAX_TEXT_LENGTH = int(os.environ.get("TTS_MAX_TEXT_LENGTH", "500"))
FFMPEG_PATH = shutil.which("ffmpeg") or "ffmpeg"

# Shared event loop for async edge-tts calls
_loop = asyncio.new_event_loop()


def detect_language(text):
    """Auto-detect language from text content."""
    cjk = len(re.findall(r'[\u4e00-\u9fff\u3400-\u4dbf]', text))
    jp = len(re.findall(r'[\u3040-\u309f\u30a0-\u30ff]', text))
    kr = len(re.findall(r'[\uac00-\ud7af]', text))
    if jp > 0:
        return "Japanese"
    if kr > 0:
        return "Korean"
    if cjk > 2:
        return "Chinese"
    return "English"


def get_voice(language):
    """Map language to edge-tts voice name."""
    if language == "Chinese":
        return VOICE_ZH
    if language == "Japanese":
        return VOICE_JA
    return VOICE_EN


def strip_markdown(text):
    """Remove markdown formatting for TTS."""
    text = re.sub(r'```[\s\S]*?```', '', text)
    text = re.sub(r'`([^`]*)`', r'\1', text)
    text = re.sub(r'!\[([^\]]*)\]\([^)]*\)', r'\1', text)
    text = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', text)
    text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'\*{1,3}([^*]+)\*{1,3}', r'\1', text)
    text = re.sub(r'_{1,3}([^_]+)_{1,3}', r'\1', text)
    text = re.sub(r'~~([^~]+)~~', r'\1', text)
    text = re.sub(r'^[\s]*[-*+]\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'^[\s]*\d+\.\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'^>\s?', '', text, flags=re.MULTILINE)
    text = re.sub(r'^[-*_]{3,}\s*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'<[^>]+>', '', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def truncate_text(text, max_length):
    """Truncate at sentence boundary."""
    if len(text) <= max_length:
        return text
    truncated = text[:max_length]
    for sep in ['。', '！', '？', '. ', '! ', '? ', '\n']:
        idx = truncated.rfind(sep)
        if idx > max_length // 2:
            return truncated[:idx + len(sep)].strip()
    return truncated.strip()


def split_sentences(text):
    """Split text into sentences for streaming."""
    parts = re.split(r'(?<=[。！？.!?\n])\s*', text)
    sentences = []
    current = ""
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if len(current) + len(part) < 20 and current:
            current += part
        else:
            if current:
                sentences.append(current)
            current = part
    if current:
        sentences.append(current)
    return sentences if sentences else [text]


def mp3_to_wav(mp3_bytes):
    """Convert MP3 bytes to WAV using ffmpeg."""
    tmp_in = tmp_out = None
    try:
        tmp_in = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
        tmp_in.write(mp3_bytes)
        tmp_in.close()

        tmp_out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp_out.close()

        result = subprocess.run(
            [FFMPEG_PATH, "-y", "-i", tmp_in.name, "-ar", "24000", "-ac", "1", "-f", "wav", tmp_out.name],
            capture_output=True, timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg: {result.stderr.decode('utf-8', errors='replace')[:300]}")

        with open(tmp_out.name, "rb") as f:
            return f.read()
    finally:
        for p in (tmp_in, tmp_out):
            if p and os.path.exists(p.name):
                try:
                    os.unlink(p.name)
                except OSError:
                    pass


async def _synthesize_async(text, voice):
    """Async: synthesize text to MP3 bytes via edge-tts."""
    communicate = edge_tts.Communicate(text, voice)
    mp3_buf = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            mp3_buf.write(chunk["data"])
    return mp3_buf.getvalue()


def synthesize(text, voice):
    """Sync wrapper: text -> MP3 bytes (no ffmpeg conversion needed)."""
    mp3_bytes = _loop.run_until_complete(_synthesize_async(text, voice))
    if not mp3_bytes:
        raise RuntimeError("edge-tts returned empty audio")
    return mp3_bytes


def prepare_text(text):
    """Clean, truncate, detect language."""
    clean = strip_markdown(text)
    if not clean:
        raise ValueError("No text content after markdown stripping")
    clean = truncate_text(clean, MAX_TEXT_LENGTH)
    lang = detect_language(clean)
    return clean, lang


class TTSHandler(BaseHTTPRequestHandler):

    def do_GET(self):
        if self.path == "/health":
            self._json_response(200, {"status": "ready"})
        else:
            self._json_response(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/synthesize":
            self._handle_synthesize()
        else:
            self._json_response(404, {"error": "not found"})

    def _handle_synthesize(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length == 0:
                self._json_response(400, {"error": "No request body"})
                return

            body = json.loads(self.rfile.read(content_length))
            text = body.get("text", "").strip()
            if not text:
                self._json_response(400, {"error": "No text provided"})
                return

            stream = body.get("stream", False)

            if stream:
                self._handle_stream(text)
            else:
                self._handle_single(text)

        except ValueError as e:
            self._json_response(400, {"error": str(e)})
        except Exception as e:
            traceback.print_exc()
            self._json_response(500, {"error": str(e)})

    def _handle_single(self, text):
        """Full synthesis then return."""
        clean, lang = prepare_text(text)
        voice = get_voice(lang)

        t0 = time.time()
        print(f"[TTS] Synthesizing: lang={lang}, voice={voice}, len={len(clean)}", flush=True)

        mp3_bytes = synthesize(clean, voice)

        elapsed = time.time() - t0
        print(f"[TTS] Done in {elapsed:.1f}s, {len(mp3_bytes)} bytes", flush=True)

        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(mp3_bytes)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(mp3_bytes)

    def _handle_stream(self, text):
        """Sentence-level chunked streaming."""
        try:
            clean, lang = prepare_text(text)
            voice = get_voice(lang)
            sentences = split_sentences(clean)
            print(f"[TTS] Streaming {len(sentences)} sentence(s): lang={lang}, voice={voice}", flush=True)

            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("X-TTS-Sentences", str(len(sentences)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            for i, sentence in enumerate(sentences):
                t0 = time.time()
                mp3_bytes = synthesize(sentence, voice)
                elapsed = time.time() - t0
                print(f"[TTS]   [{i+1}/{len(sentences)}] {len(sentence)} chars "
                      f"-> {len(mp3_bytes)} bytes in {elapsed:.1f}s", flush=True)

                chunk_data = struct.pack('<I', len(mp3_bytes)) + mp3_bytes
                chunk_header = f"{len(chunk_data):X}\r\n".encode()
                self.wfile.write(chunk_header)
                self.wfile.write(chunk_data)
                self.wfile.write(b"\r\n")
                self.wfile.flush()

            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()

        except Exception as e:
            traceback.print_exc()
            print(f"[TTS] Stream error: {e}", flush=True)

    def _json_response(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        print(f"[TTS] {args[0]}", flush=True)


def main():
    server = HTTPServer(("127.0.0.1", PORT), TTSHandler)
    print(f"[TTS] edge-tts server listening on http://127.0.0.1:{PORT}", flush=True)
    print(f"[TTS] Voices: zh={VOICE_ZH}, en={VOICE_EN}, ja={VOICE_JA}", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[TTS] Shutting down.", flush=True)
        server.shutdown()


if __name__ == "__main__":
    main()
