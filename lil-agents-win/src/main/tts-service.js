/**
 * TTS Service Manager
 * Manages the Python Qwen3-TTS HTTP service lifecycle.
 * Thin relay — all smart logic (language detection, text truncation,
 * markdown stripping, default voice instruct) lives in tts_server.py.
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const Store = require('./store');

const DEFAULT_PYTHON_PATH = 'C:/Users/ZMJ/miniconda3/envs/lilvoice/python.exe';
const DEFAULT_PORT = 18921;

class TTSService {
  constructor() {
    this.process = null;
    this.ready = false;
    this.starting = false;
    this.error = null;
    this._healthCheckTimer = null;
  }

  /**
   * Start the Python TTS service.
   */
  async start() {
    if (this.process || this.starting) return;
    this.starting = true;
    this.ready = false;
    this.error = null;

    const pythonPath = Store.get('tts_python_path', DEFAULT_PYTHON_PATH);
    const port = Store.get('tts_port', DEFAULT_PORT);
    const scriptPath = path.join(__dirname, '..', 'asr', 'tts_server.py');

    console.log(`[TTS] Starting service: ${pythonPath} ${scriptPath}`);
    console.log(`[TTS] Port: ${port}`);

    try {
      this.process = spawn(pythonPath, [scriptPath], {
        env: {
          ...process.env,
          TTS_PORT: String(port),
          PYTHONIOENCODING: 'utf-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this.process.stdout.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.log(msg);
      });

      this.process.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.error(`[TTS stderr] ${msg}`);
      });

      this.process.on('error', (err) => {
        console.error(`[TTS] Process error: ${err.message}`);
        this.error = err.message;
        this.starting = false;
        this.ready = false;
        this.process = null;
      });

      this.process.on('exit', (code) => {
        console.log(`[TTS] Process exited with code ${code}`);
        this.ready = false;
        this.starting = false;
        this.process = null;
        // Auto-restart on unexpected exit
        if (code !== 0 && code !== null) {
          this.error = `Process exited with code ${code}`;
          console.log('[TTS] Will attempt restart in 5 seconds...');
          setTimeout(() => this.start(), 5000);
        }
      });

      // Start health check polling
      this._startHealthCheck();
    } catch (err) {
      console.error(`[TTS] Failed to start: ${err.message}`);
      this.error = err.message;
      this.starting = false;
    }
  }

  /**
   * Stop the Python TTS service.
   */
  async stop() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.ready = false;
    this.starting = false;
  }

  /**
   * Check if the service is ready.
   */
  isReady() {
    return this.ready;
  }

  /**
   * Get current status.
   */
  getStatus() {
    if (this.ready) return 'ready';
    if (this.error) return 'error';
    if (this.starting) return 'loading';
    return 'stopped';
  }

  /**
   * Synthesize text to audio (single-shot, waits for full result).
   * Only sends text — Python side handles language detection, truncation, etc.
   * @param {string} text - Text to synthesize
   * @returns {Promise<{audioDataUrl: string}>}
   */
  async synthesize(text) {
    if (!this.ready) {
      const status = this.getStatus();
      if (status === 'loading') throw new Error('TTS model loading... please wait');
      if (status === 'error') throw new Error(`TTS service error: ${this.error}`);
      throw new Error('TTS service not running');
    }

    const port = Store.get('tts_port', DEFAULT_PORT);

    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ text });

      const req = http.request({
        hostname: '127.0.0.1',
        port: port,
        path: '/synthesize',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 60000,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode === 200) {
            const base64 = buf.toString('base64');
            resolve({ audioDataUrl: `data:audio/wav;base64,${base64}` });
          } else {
            try {
              const err = JSON.parse(buf.toString());
              reject(new Error(err.error || `HTTP ${res.statusCode}`));
            } catch {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          }
        });
      });

      req.on('error', (err) => reject(new Error(`TTS service unreachable: ${err.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('TTS synthesis timed out')); });
      req.write(body);
      req.end();
    });
  }

  /**
   * Synthesize text with sentence-level streaming.
   * Calls onChunk(audioDataUrl) for each sentence as it's synthesized.
   * Returns a cancel function.
   * @param {string} text
   * @param {function} onChunk - Called with {audioDataUrl} for each sentence
   * @param {function} onDone - Called when all sentences are done
   * @param {function} onError - Called on error
   * @returns {function} cancel - Call to abort the request
   */
  synthesizeStream(text, onChunk, onDone, onError) {
    if (!this.ready) {
      const status = this.getStatus();
      const msg = status === 'loading' ? 'TTS model loading...'
        : status === 'error' ? `TTS error: ${this.error}`
        : 'TTS not running';
      onError(new Error(msg));
      return () => {};
    }

    const port = Store.get('tts_port', DEFAULT_PORT);
    const body = JSON.stringify({ text, stream: true });

    let cancelled = false;
    let pendingBuf = Buffer.alloc(0);

    const req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: '/synthesize',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 120000, // Longer timeout for streaming multiple sentences
    }, (res) => {
      if (res.statusCode !== 200) {
        let errData = '';
        res.on('data', (c) => { errData += c; });
        res.on('end', () => {
          try {
            const err = JSON.parse(errData);
            onError(new Error(err.error || `HTTP ${res.statusCode}`));
          } catch {
            onError(new Error(`HTTP ${res.statusCode}`));
          }
        });
        return;
      }

      // Parse chunked binary stream: each chunk = 4-byte LE length + WAV bytes
      res.on('data', (chunk) => {
        if (cancelled) return;
        pendingBuf = Buffer.concat([pendingBuf, chunk]);

        // Extract complete WAV segments from buffer
        while (pendingBuf.length >= 4) {
          const wavLen = pendingBuf.readUInt32LE(0);
          if (pendingBuf.length < 4 + wavLen) break; // Wait for more data

          const wavBuf = pendingBuf.slice(4, 4 + wavLen);
          pendingBuf = pendingBuf.slice(4 + wavLen);

          const base64 = wavBuf.toString('base64');
          onChunk({ audioDataUrl: `data:audio/wav;base64,${base64}` });
        }
      });

      res.on('end', () => {
        if (!cancelled) onDone();
      });
    });

    req.on('error', (err) => {
      if (!cancelled) onError(new Error(`TTS unreachable: ${err.message}`));
    });
    req.on('timeout', () => {
      req.destroy();
      if (!cancelled) onError(new Error('TTS streaming timed out'));
    });
    req.write(body);
    req.end();

    return () => { cancelled = true; req.destroy(); };
  }

  /**
   * Poll /health until the service reports ready.
   */
  _startHealthCheck() {
    const port = Store.get('tts_port', DEFAULT_PORT);
    let attempts = 0;
    const maxAttempts = 120; // 2 minutes at 1s interval

    this._healthCheckTimer = setInterval(() => {
      attempts++;
      if (attempts > maxAttempts) {
        clearInterval(this._healthCheckTimer);
        this._healthCheckTimer = null;
        this.error = 'Model loading timed out';
        this.starting = false;
        console.error('[TTS] Health check timed out after 2 minutes');
        return;
      }

      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 3000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.status === 'ready') {
              this.ready = true;
              this.starting = false;
              this.error = null;
              clearInterval(this._healthCheckTimer);
              this._healthCheckTimer = null;
              console.log('[TTS] Service is ready!');
            } else if (result.status === 'error') {
              this.error = result.error;
              this.starting = false;
              clearInterval(this._healthCheckTimer);
              this._healthCheckTimer = null;
              console.error(`[TTS] Service error: ${result.error}`);
            }
          } catch (e) { /* ignore parse errors during startup */ }
        });
      });

      req.on('error', () => { /* server not up yet, keep trying */ });
      req.on('timeout', () => { req.destroy(); });
    }, 1000);
  }
}

module.exports = { TTSService };
