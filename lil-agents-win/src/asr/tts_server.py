"""
Qwen3-TTS HTTP service for lil-agents-win.

Loads Qwen3-TTS-12Hz-1.7B-VoiceDesign and exposes a simple REST API:
  GET  /health      -> {"status": "ready"} or {"status": "loading"}
  POST /synthesize  -> WAV audio bytes (Content-Type: audio/wav)
                       Supports sentence-level chunked streaming for low latency.

All smart logic lives here (language detection, text truncation, markdown
stripping, default voice instruct). The Electron frontend is a thin relay.

Performance optimizations:
  - SDPA attention (PyTorch native scaled_dot_product_attention)
  - Dynamic max_new_tokens based on text length
  - Model warmup after loading (pre-compiles CUDA kernels)
  - Sentence splitting with chunked HTTP streaming (first audio plays fast)

Environment variables:
  TTS_MODEL_PATH       - Path to model weights
  TTS_PORT             - Port to listen on (default: 18921)
  TTS_VOICE_INSTRUCT   - Default voice style instruction
  TTS_MAX_TEXT_LENGTH   - Max text length before truncation (default: 500)
"""

import io
import os
import re
import time
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import threading

import numpy as np
import soundfile as sf
import torch

# Globals
model = None
model_ready = False
model_error = None

MODEL_PATH = os.environ.get(
    "TTS_MODEL_PATH",
    "E:/Qwen3-TTS/models/Qwen3-TTS-12Hz-1.7B-VoiceDesign/",
)
PORT = int(os.environ.get("TTS_PORT", "18921"))
DEFAULT_INSTRUCT = os.environ.get(
    "TTS_VOICE_INSTRUCT",
    "体现撒娇稚嫩的萝莉女声，音调偏高且起伏明显，营造出黏人、做作又刻意卖萌的听觉效果",
)
MAX_TEXT_LENGTH = int(os.environ.get("TTS_MAX_TEXT_LENGTH", "500"))

# 12Hz tokenizer: ~12.5 codec tokens per second of audio
# Estimate ~3 tokens per character (conservative) + overhead
TOKENS_PER_CHAR = 3
MIN_TOKENS = 256
MAX_TOKENS = 2048


def estimate_max_tokens(text_length):
    """Dynamically compute max_new_tokens based on text length."""
    estimated = text_length * TOKENS_PER_CHAR + 128  # +128 overhead
    return max(MIN_TOKENS, min(estimated, MAX_TOKENS))


def load_model():
    """Load model in background thread, with warmup."""
    global model, model_ready, model_error
    try:
        print(f"[TTS] Loading model from {MODEL_PATH} ...", flush=True)

        from qwen_tts import Qwen3TTSModel

        if torch.cuda.is_available():
            print("[TTS] CUDA available, loading on GPU with SDPA...", flush=True)
            model = Qwen3TTSModel.from_pretrained(
                MODEL_PATH,
                dtype=torch.bfloat16,
                device_map="cuda:0",
                attn_implementation="sdpa",
            )
        else:
            print("[TTS] CUDA not available, loading on CPU (slower)...", flush=True)
            model = Qwen3TTSModel.from_pretrained(
                MODEL_PATH,
                dtype=torch.float32,
                device_map="cpu",
            )

        # Warmup: run a dummy inference to pre-compile CUDA kernels
        print("[TTS] Warming up model (first inference)...", flush=True)
        t0 = time.time()
        model.generate_voice_design(
            text="hello",
            language="English",
            instruct="neutral voice",
            max_new_tokens=MIN_TOKENS,
        )
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        print(f"[TTS] Warmup done in {time.time() - t0:.1f}s", flush=True)

        model_ready = True
        print("[TTS] Model loaded and ready.", flush=True)
    except Exception as e:
        model_error = str(e)
        print(f"[TTS] Model loading failed: {e}", flush=True)
        traceback.print_exc()


# ---------------------------------------------------------------------------
# Smart logic (all on Python side)
# ---------------------------------------------------------------------------

def detect_language(text):
    """Auto-detect language from text content using Unicode ranges."""
    cjk = len(re.findall(r'[\u4e00-\u9fff\u3400-\u4dbf]', text))
    jp = len(re.findall(r'[\u3040-\u309f\u30a0-\u30ff]', text))
    kr = len(re.findall(r'[\uac00-\ud7af\u1100-\u11ff]', text))
    cyrillic = len(re.findall(r'[\u0400-\u04ff]', text))

    if jp > 0:
        return "Japanese"
    if kr > 0:
        return "Korean"
    if cjk > 2:
        return "Chinese"
    if cyrillic > 2:
        return "Russian"
    return "English"


def strip_markdown(text):
    """Remove markdown formatting, keep plain text for TTS."""
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
    """Truncate text at sentence boundary if exceeding max_length."""
    if len(text) <= max_length:
        return text

    truncated = text[:max_length]
    for sep in ['。', '！', '？', '. ', '! ', '? ', '\n']:
        idx = truncated.rfind(sep)
        if idx > max_length // 2:
            return truncated[:idx + len(sep)].strip()
    return truncated.strip()


def split_sentences(text):
    """Split text into sentences for chunked synthesis."""
    # Split on sentence-ending punctuation (keep the punctuation with the sentence)
    parts = re.split(r'(?<=[。！？.!?\n])\s*', text)
    sentences = []
    current = ""
    for part in parts:
        part = part.strip()
        if not part:
            continue
        # Merge very short fragments with previous sentence
        if len(current) + len(part) < 20 and current:
            current += part
        else:
            if current:
                sentences.append(current)
            current = part
    if current:
        sentences.append(current)
    return sentences if sentences else [text]


def synthesize_one(text, language, instruct):
    """Synthesize a single text segment to WAV bytes."""
    max_tokens = estimate_max_tokens(len(text))
    wavs, sr = model.generate_voice_design(
        text=text,
        language=language,
        instruct=instruct,
        max_new_tokens=max_tokens,
    )
    buf = io.BytesIO()
    sf.write(buf, wavs[0], sr, format="WAV", subtype="PCM_16")
    return buf.getvalue(), sr


def synthesize_text(text, language=None, instruct=None):
    """Synthesize text to WAV bytes (single-shot, no streaming)."""
    clean_text = strip_markdown(text)
    if not clean_text:
        raise ValueError("No text content after markdown stripping")

    clean_text = truncate_text(clean_text, MAX_TEXT_LENGTH)
    lang = language or detect_language(clean_text)
    voice_instruct = instruct or DEFAULT_INSTRUCT

    t0 = time.time()
    max_tokens = estimate_max_tokens(len(clean_text))
    print(f"[TTS] Synthesizing: lang={lang}, len={len(clean_text)}, "
          f"tokens={max_tokens}", flush=True)

    wavs, sr = model.generate_voice_design(
        text=clean_text,
        language=lang,
        instruct=voice_instruct,
        max_new_tokens=max_tokens,
    )

    elapsed = time.time() - t0
    print(f"[TTS] Done in {elapsed:.1f}s", flush=True)

    buf = io.BytesIO()
    sf.write(buf, wavs[0], sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def prepare_text(text):
    """Clean and truncate text. Returns (clean_text, language)."""
    clean_text = strip_markdown(text)
    if not clean_text:
        raise ValueError("No text content after markdown stripping")
    clean_text = truncate_text(clean_text, MAX_TEXT_LENGTH)
    lang = detect_language(clean_text)
    return clean_text, lang


# ---------------------------------------------------------------------------
# HTTP Server
# ---------------------------------------------------------------------------

class TTSHandler(BaseHTTPRequestHandler):
    """HTTP request handler for TTS service."""

    def do_GET(self):
        if self.path == "/health":
            if model_ready:
                self._json_response(200, {"status": "ready"})
            elif model_error:
                self._json_response(503, {"status": "error", "error": model_error})
            else:
                self._json_response(503, {"status": "loading"})
        else:
            self._json_response(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/synthesize":
            self._handle_synthesize()
        else:
            self._json_response(404, {"error": "not found"})

    def _handle_synthesize(self):
        if not model_ready:
            self._json_response(503, {"error": "Model not ready yet"})
            return

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

            language = body.get("language") or None
            instruct = body.get("instruct") or None
            stream = body.get("stream", False)

            if stream:
                self._handle_stream_synthesize(text, language, instruct)
            else:
                wav_bytes = synthesize_text(text, language=language, instruct=instruct)
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(wav_bytes)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(wav_bytes)

        except ValueError as e:
            self._json_response(400, {"error": str(e)})
        except Exception as e:
            traceback.print_exc()
            self._json_response(500, {"error": str(e)})

    def _handle_stream_synthesize(self, text, language, instruct):
        """Sentence-level chunked streaming: synthesize each sentence and
        send its WAV as a chunk immediately, so the client can start playback
        while remaining sentences are still being synthesized."""
        try:
            clean_text, detected_lang = prepare_text(text)
            lang = language or detected_lang
            voice_instruct = instruct or DEFAULT_INSTRUCT

            sentences = split_sentences(clean_text)
            print(f"[TTS] Streaming {len(sentences)} sentence(s): lang={lang}", flush=True)

            # Chunked transfer encoding: each chunk is a length-prefixed WAV blob
            # Format: 4-byte little-endian length + WAV bytes, repeated per sentence
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("X-TTS-Sentences", str(len(sentences)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            for i, sentence in enumerate(sentences):
                t0 = time.time()
                wav_bytes, sr = synthesize_one(sentence, lang, voice_instruct)
                elapsed = time.time() - t0
                print(f"[TTS]   [{i+1}/{len(sentences)}] {len(sentence)} chars "
                      f"-> {len(wav_bytes)} bytes in {elapsed:.1f}s", flush=True)

                # Write as HTTP chunked encoding: hex-length\r\n + data + \r\n
                # Inside each chunk: 4-byte LE length prefix + WAV data
                import struct
                chunk_data = struct.pack('<I', len(wav_bytes)) + wav_bytes
                chunk_header = f"{len(chunk_data):X}\r\n".encode()
                self.wfile.write(chunk_header)
                self.wfile.write(chunk_data)
                self.wfile.write(b"\r\n")
                self.wfile.flush()

            # Final empty chunk to signal end
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()

        except Exception as e:
            traceback.print_exc()
            # Can't send JSON error if we already started chunked response
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
    loader_thread = threading.Thread(target=load_model, daemon=True)
    loader_thread.start()

    server = HTTPServer(("127.0.0.1", PORT), TTSHandler)
    print(f"[TTS] Server listening on http://127.0.0.1:{PORT}", flush=True)
    print(f"[TTS] Model path: {MODEL_PATH}", flush=True)
    print(f"[TTS] Max text length: {MAX_TEXT_LENGTH}", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[TTS] Shutting down.", flush=True)
        server.shutdown()


if __name__ == "__main__":
    main()
