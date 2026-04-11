"""
Qwen3-ASR HTTP service for lil-agents-win.

Loads Qwen3-ASR-1.7B and exposes a simple REST API:
  GET  /health      -> {"status": "ready"} or {"status": "loading"}
  POST /transcribe  -> {"language": "...", "text": "..."}

Environment variables:
  ASR_MODEL_PATH  - Path to model weights (default: E:/Qwen3-ASR/models/Qwen3-ASR-1.7B)
  ASR_PORT        - Port to listen on (default: 18920)
  ASR_LANGUAGE    - Force language (default: empty = auto-detect)
"""

import io
import os
import shutil
import subprocess
import sys
import tempfile
import traceback
import warnings
from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import threading

# Suppress noisy warnings from transformers/torch
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
warnings.filterwarnings("ignore", message=".*generation flags are not valid.*")
warnings.filterwarnings("ignore", message=".*Setting `pad_token_id`.*")

import numpy as np
import soundfile as sf
import torch

FFMPEG_PATH = shutil.which("ffmpeg") or "ffmpeg"

# Register model before importing Qwen3ASRModel
from qwen_asr.core.transformers_backend import (
    Qwen3ASRConfig,
    Qwen3ASRForConditionalGeneration,
    Qwen3ASRProcessor,
)
from transformers import AutoConfig, AutoModel, AutoProcessor

AutoConfig.register("qwen3_asr", Qwen3ASRConfig)
AutoModel.register(Qwen3ASRConfig, Qwen3ASRForConditionalGeneration)
AutoProcessor.register(Qwen3ASRConfig, Qwen3ASRProcessor)

from qwen_asr.inference.qwen3_asr import Qwen3ASRModel

# Globals
model = None
model_ready = False
model_error = None

MODEL_PATH = os.environ.get("ASR_MODEL_PATH", "E:/Qwen3-ASR/models/Qwen3-ASR-1.7B")
PORT = int(os.environ.get("ASR_PORT", "18920"))
LANGUAGE = os.environ.get("ASR_LANGUAGE", "") or None


def load_model():
    """Load model in background thread."""
    global model, model_ready, model_error
    try:
        print(f"[ASR] Loading model from {MODEL_PATH} ...", flush=True)

        # Try CUDA first, fallback to CPU
        if torch.cuda.is_available():
            print("[ASR] CUDA available, loading on GPU...", flush=True)
            model = Qwen3ASRModel.from_pretrained(
                MODEL_PATH,
                dtype=torch.bfloat16,
                device_map="cuda:0",
                max_inference_batch_size=1,
                max_new_tokens=512,
            )
        else:
            print("[ASR] CUDA not available, loading on CPU (slower)...", flush=True)
            model = Qwen3ASRModel.from_pretrained(
                MODEL_PATH,
                dtype=torch.float32,
                device_map="cpu",
                max_inference_batch_size=1,
                max_new_tokens=512,
            )

        model_ready = True
        print("[ASR] Model loaded successfully.", flush=True)
    except Exception as e:
        model_error = str(e)
        print(f"[ASR] Model loading failed: {e}", flush=True)
        traceback.print_exc()


def convert_to_wav(audio_bytes):
    """Convert any audio format to 16kHz mono WAV using ffmpeg. Returns WAV bytes."""
    try:
        # Try reading directly with soundfile first (supports WAV, FLAC, OGG)
        with io.BytesIO(audio_bytes) as f:
            audio_data, sr = sf.read(f, dtype="float32", always_2d=False)
        # Re-encode as WAV bytes for consistency
        buf = io.BytesIO()
        sf.write(buf, audio_data, sr, format="WAV", subtype="PCM_16")
        return buf.getvalue()
    except Exception:
        pass

    # Fallback: use ffmpeg for formats like m4a, mp3, webm, ogg, aac, wma, etc.
    tmp_in = None
    tmp_out = None
    try:
        tmp_in = tempfile.NamedTemporaryFile(suffix=".audio", delete=False)
        tmp_in.write(audio_bytes)
        tmp_in.close()

        tmp_out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp_out.close()

        result = subprocess.run(
            [FFMPEG_PATH, "-y", "-i", tmp_in.name, "-ar", "16000", "-ac", "1", "-f", "wav", tmp_out.name],
            capture_output=True, timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg error: {result.stderr.decode('utf-8', errors='replace')[:500]}")

        with open(tmp_out.name, "rb") as f:
            return f.read()
    finally:
        for p in (tmp_in, tmp_out):
            if p and os.path.exists(p.name):
                try:
                    os.unlink(p.name)
                except OSError:
                    pass


def transcribe_audio(audio_bytes, language=None):
    """Transcribe audio bytes (any format) to text."""
    # Convert to WAV first
    wav_bytes = convert_to_wav(audio_bytes)

    with io.BytesIO(wav_bytes) as f:
        audio_data, sr = sf.read(f, dtype="float32", always_2d=False)

    # Ensure mono
    if audio_data.ndim > 1:
        audio_data = np.mean(audio_data, axis=-1).astype(np.float32)

    audio_input = (np.asarray(audio_data, dtype=np.float32), int(sr))

    duration = len(audio_data) / sr
    print(f"[ASR] Audio: {duration:.1f}s, sr={sr}, samples={len(audio_data)}", flush=True)

    results = model.transcribe(
        audio=audio_input,
        language=language,
        return_time_stamps=False,
    )

    if results and len(results) > 0:
        print(f"[ASR] Result: lang={results[0].language}, text='{results[0].text}'", flush=True)
        return {"language": results[0].language, "text": results[0].text}
    print("[ASR] Result: empty", flush=True)
    return {"language": "", "text": ""}


class ASRHandler(BaseHTTPRequestHandler):
    """HTTP request handler for ASR service."""

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
        if self.path == "/transcribe":
            self._handle_transcribe()
        else:
            self._json_response(404, {"error": "not found"})

    def _handle_transcribe(self):
        if not model_ready:
            self._json_response(503, {"error": "Model not ready yet"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length == 0:
                self._json_response(400, {"error": "No audio data"})
                return

            content_type = self.headers.get("Content-Type", "")

            if "multipart/form-data" in content_type:
                # Parse multipart form data
                wav_bytes, lang = self._parse_multipart(content_length, content_type)
            else:
                # Raw WAV body
                wav_bytes = self.rfile.read(content_length)
                lang = self.headers.get("X-Language", LANGUAGE)

            if not wav_bytes:
                self._json_response(400, {"error": "No audio data in request"})
                return

            result = transcribe_audio(wav_bytes, language=lang or LANGUAGE)
            self._json_response(200, result)

        except Exception as e:
            traceback.print_exc()
            self._json_response(500, {"error": str(e)})

    def _parse_multipart(self, content_length, content_type):
        """Simple multipart parser - extracts 'file' field and optional 'language' field."""
        body = self.rfile.read(content_length)

        # Extract boundary
        boundary = None
        for part in content_type.split(";"):
            part = part.strip()
            if part.startswith("boundary="):
                boundary = part[len("boundary="):].strip().strip('"')
                break

        if not boundary:
            return body, None  # Fallback: treat entire body as WAV

        boundary_bytes = ("--" + boundary).encode()
        parts = body.split(boundary_bytes)

        wav_bytes = None
        language = None

        for part in parts:
            if b"Content-Disposition" not in part:
                continue

            # Split headers and body
            header_end = part.find(b"\r\n\r\n")
            if header_end == -1:
                continue
            headers_str = part[:header_end].decode("utf-8", errors="replace")
            part_body = part[header_end + 4:]
            # Remove trailing \r\n
            if part_body.endswith(b"\r\n"):
                part_body = part_body[:-2]

            if 'name="file"' in headers_str or 'name="audio"' in headers_str:
                wav_bytes = part_body
            elif 'name="language"' in headers_str:
                language = part_body.decode("utf-8").strip()

        return wav_bytes, language

    def _json_response(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Prefix log with [ASR]
        print(f"[ASR] {args[0]}", flush=True)


def main():
    # Start model loading in background
    loader_thread = threading.Thread(target=load_model, daemon=True)
    loader_thread.start()

    server = HTTPServer(("127.0.0.1", PORT), ASRHandler)
    print(f"[ASR] Server listening on http://127.0.0.1:{PORT}", flush=True)
    print(f"[ASR] Model path: {MODEL_PATH}", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[ASR] Shutting down.", flush=True)
        server.shutdown()


if __name__ == "__main__":
    main()
