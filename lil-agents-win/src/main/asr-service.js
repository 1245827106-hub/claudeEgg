/**
 * ASR Service Manager
 * Manages the Python Qwen3-ASR HTTP service lifecycle.
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const Store = require('./store');

const DEFAULT_PYTHON_PATH = 'E:/Qwen3-ASR/envs/qwen3-asr/python.exe';
const DEFAULT_MODEL_PATH = 'E:/Qwen3-ASR/models/Qwen3-ASR-1.7B';
const DEFAULT_PORT = 18920;

class ASRService {
  constructor() {
    this.process = null;
    this.ready = false;
    this.starting = false;
    this.error = null;
    this._healthCheckTimer = null;
  }

  /**
   * Start the Python ASR service.
   */
  async start() {
    if (this.process || this.starting) return;
    this.starting = true;
    this.ready = false;
    this.error = null;

    const pythonPath = Store.get('asr_python_path', DEFAULT_PYTHON_PATH);
    const modelPath = Store.get('asr_model_path', DEFAULT_MODEL_PATH);
    const port = Store.get('asr_port', DEFAULT_PORT);
    const language = Store.get('asr_language', '');
    const scriptPath = path.join(__dirname, '..', 'asr', 'asr_server.py');

    console.log(`[ASR] Starting service: ${pythonPath} ${scriptPath}`);
    console.log(`[ASR] Model: ${modelPath}, Port: ${port}`);

    try {
      this.process = spawn(pythonPath, [scriptPath], {
        env: {
          ...process.env,
          ASR_MODEL_PATH: modelPath,
          ASR_PORT: String(port),
          ASR_LANGUAGE: language,
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
        if (msg) console.error(`[ASR stderr] ${msg}`);
      });

      this.process.on('error', (err) => {
        console.error(`[ASR] Process error: ${err.message}`);
        this.error = err.message;
        this.starting = false;
        this.ready = false;
        this.process = null;
      });

      this.process.on('exit', (code) => {
        console.log(`[ASR] Process exited with code ${code}`);
        this.ready = false;
        this.starting = false;
        this.process = null;
        // Auto-restart on unexpected exit
        if (code !== 0 && code !== null) {
          this.error = `Process exited with code ${code}`;
          console.log('[ASR] Will attempt restart in 5 seconds...');
          setTimeout(() => this.start(), 5000);
        }
      });

      // Start health check polling
      this._startHealthCheck();
    } catch (err) {
      console.error(`[ASR] Failed to start: ${err.message}`);
      this.error = err.message;
      this.starting = false;
    }
  }

  /**
   * Stop the Python ASR service.
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
   * Transcribe audio buffer (WAV format).
   * @param {Buffer} wavBuffer - WAV audio data
   * @returns {Promise<{text: string, language: string}>}
   */
  async transcribe(wavBuffer) {
    if (!this.ready) {
      const status = this.getStatus();
      if (status === 'loading') throw new Error('ASR model loading... please wait');
      if (status === 'error') throw new Error(`ASR service error: ${this.error}`);
      throw new Error('ASR service not running');
    }

    const port = Store.get('asr_port', DEFAULT_PORT);

    return new Promise((resolve, reject) => {
      const boundary = '----LilAgentsBoundary' + Date.now();
      const language = Store.get('asr_language', '');

      // Build multipart body
      const parts = [];

      // File part
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
        `Content-Type: audio/wav\r\n\r\n`
      ));
      parts.push(wavBuffer);
      parts.push(Buffer.from('\r\n'));

      // Language part (optional)
      if (language) {
        parts.push(Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="language"\r\n\r\n` +
          `${language}\r\n`
        ));
      }

      // End boundary
      parts.push(Buffer.from(`--${boundary}--\r\n`));

      const body = Buffer.concat(parts);

      const req = http.request({
        hostname: '127.0.0.1',
        port: port,
        path: '/transcribe',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        timeout: 30000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode === 200) {
              resolve(result);
            } else {
              reject(new Error(result.error || `HTTP ${res.statusCode}`));
            }
          } catch (e) {
            reject(new Error(`Invalid response: ${data}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(new Error(`ASR service unreachable: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Transcription timed out'));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Poll /health until the service reports ready.
   */
  _startHealthCheck() {
    const port = Store.get('asr_port', DEFAULT_PORT);
    let attempts = 0;
    const maxAttempts = 120; // 2 minutes at 1s interval

    this._healthCheckTimer = setInterval(() => {
      attempts++;
      if (attempts > maxAttempts) {
        clearInterval(this._healthCheckTimer);
        this._healthCheckTimer = null;
        this.error = 'Model loading timed out';
        this.starting = false;
        console.error('[ASR] Health check timed out after 2 minutes');
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
              console.log('[ASR] Service is ready!');
            } else if (result.status === 'error') {
              this.error = result.error;
              this.starting = false;
              clearInterval(this._healthCheckTimer);
              this._healthCheckTimer = null;
              console.error(`[ASR] Service error: ${result.error}`);
            }
          } catch (e) { /* ignore parse errors during startup */ }
        });
      });

      req.on('error', () => { /* server not up yet, keep trying */ });
      req.on('timeout', () => { req.destroy(); });
    }, 1000);
  }
}

module.exports = { ASRService };
