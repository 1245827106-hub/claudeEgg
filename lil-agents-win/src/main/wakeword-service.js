/**
 * Wake Word Service Manager
 * Manages the Python wakeword_server.py HTTP service lifecycle.
 * Follows the same pattern as asr-service.js and tts-service.js.
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const config = require('./config');

class WakewordService {
  constructor() {
    this.process = null;
    this.ready = false;
    this.starting = false;
    this.error = null;
    this._healthCheckTimer = null;
    this._restartTimer = null;
    this._sseReconnectTimer = null;
    this._sseReq = null;        // SSE long-polling connection
    this._sseBuf = '';          // SSE parse buffer
    this.onWakeword = null;     // callback: called when wake word detected
    this._autoListenOnReady = false;
    this._stopped = false;
  }

  /**
   * Start the Python wake word service.
   */
  async start() {
    if (this.process || this.starting) {
      console.log('[Wakeword] Already started or starting, skipping');
      return;
    }
    this._stopped = false;
    this.starting = true;
    this.ready = false;
    this.error = null;

    const { pythonPath, port, asrPort } = config.getWakewordConfig();
    const scriptPath = path.join(__dirname, '..', 'asr', 'wakeword_server.py');

    console.log(`[Wakeword] Starting service: ${pythonPath} ${scriptPath}`);
    console.log(`[Wakeword] Port: ${port}, ASR URL: http://127.0.0.1:${asrPort}`);

    try {
      this.process = spawn(pythonPath, [scriptPath], {
        env: {
          ...process.env,
          WAKEWORD_PORT: String(port),
          ASR_URL: `http://127.0.0.1:${asrPort}`,
          PYTHONIOENCODING: 'utf-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      console.log(`[Wakeword] Process spawned, PID: ${this.process.pid}`);

      this.process.stdout.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.log(msg);
      });

      this.process.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.error(`[Wakeword stderr] ${msg}`);
      });

      this.process.on('error', (err) => {
        console.error(`[Wakeword] Process error: ${err.message}`);
        this.error = err.message;
        this.starting = false;
        this.ready = false;
        this.process = null;
      });

      this.process.on('exit', (code) => {
        console.log(`[Wakeword] Process exited with code ${code}`);
        this.ready = false;
        this.starting = false;
        this.process = null;
        this._disconnectSSE();
        if (!this._stopped && code !== 0 && code !== null) {
          this.error = `Process exited with code ${code}`;
          console.log('[Wakeword] Will attempt restart in 5 seconds...');
          this._restartTimer = setTimeout(() => {
            this._restartTimer = null;
            if (!this._stopped) this.start();
          }, 5000);
        }
      });

      this._startHealthCheck();
    } catch (err) {
      console.error(`[Wakeword] Failed to start: ${err.message}`);
      this.error = err.message;
      this.starting = false;
    }
  }

  async stop() {
    console.log('[Wakeword] Stopping service...');
    this._stopped = true;
    this._disconnectSSE();
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this._sseReconnectTimer) {
      clearTimeout(this._sseReconnectTimer);
      this._sseReconnectTimer = null;
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.ready = false;
    this.starting = false;
  }

  isReady() { return this.ready; }

  getStatus() {
    if (this.ready) return 'ready';
    if (this.error) return 'error';
    if (this.starting) return 'loading';
    return 'stopped';
  }

  async startListening() {
    if (!this.ready) {
      this._autoListenOnReady = true;
      console.log('[Wakeword] Service not ready yet, queued startListening for when ready');
      return;
    }
    this._autoListenOnReady = false;
    const { port } = config.getWakewordConfig();
    console.log(`[Wakeword] Sending POST /start to port ${port}`);

    return new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/start',
        method: 'POST', timeout: 5000,
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          console.log(`[Wakeword] POST /start response: ${body}`);
          resolve();
        });
      });
      req.on('error', (err) => {
        console.error(`[Wakeword] POST /start error: ${err.message}`);
        resolve();
      });
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.end();
    });
  }

  async stopListening() {
    this._autoListenOnReady = false;
    if (!this.ready) return;
    const { port } = config.getWakewordConfig();
    console.log(`[Wakeword] Sending POST /stop to port ${port}`);

    return new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/stop',
        method: 'POST', timeout: 5000,
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          console.log(`[Wakeword] POST /stop response: ${body}`);
          resolve();
        });
      });
      req.on('error', (err) => {
        console.error(`[Wakeword] POST /stop error: ${err.message}`);
        resolve();
      });
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.end();
    });
  }

  _connectSSE() {
    if (this._sseReq) {
      console.log('[Wakeword] SSE already connected');
      return;
    }
    const { port } = config.getWakewordConfig();

    console.log(`[Wakeword] Connecting SSE to port ${port}...`);
    this._sseBuf = '';

    this._sseReq = http.get({
      hostname: '127.0.0.1', port, path: '/events',
      timeout: 0,
      headers: { 'Accept': 'text/event-stream' },
    }, (res) => {
      console.log(`[Wakeword] SSE connected, status=${res.statusCode}`);

      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        console.log(`[Wakeword] SSE raw data: ${JSON.stringify(chunk)}`);
        this._sseBuf += chunk;
        this._parseSSE();
      });

      res.on('end', () => {
        console.log('[Wakeword] SSE connection closed by server');
        this._sseReq = null;
        if (this.ready && !this._stopped) {
          this._sseReconnectTimer = setTimeout(() => {
            this._sseReconnectTimer = null;
            if (!this._stopped) this._connectSSE();
          }, 2000);
        }
      });
    });

    this._sseReq.on('error', (err) => {
      console.error(`[Wakeword] SSE connection error: ${err.message}`);
      this._sseReq = null;
      if (this.ready && !this._stopped) {
        this._sseReconnectTimer = setTimeout(() => {
          this._sseReconnectTimer = null;
          if (!this._stopped) this._connectSSE();
        }, 3000);
      }
    });
  }

  _disconnectSSE() {
    if (this._sseReq) {
      console.log('[Wakeword] Disconnecting SSE');
      this._sseReq.destroy();
      this._sseReq = null;
    }
    this._sseBuf = '';
  }

  _parseSSE() {
    let idx;
    while ((idx = this._sseBuf.indexOf('\n\n')) !== -1) {
      const block = this._sseBuf.slice(0, idx);
      this._sseBuf = this._sseBuf.slice(idx + 2);

      let eventType = null;
      let eventData = null;

      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event: ')) eventType = line.slice(7).trim();
        else if (line.startsWith('data: ')) eventData = line.slice(6).trim();
      }

      console.log(`[Wakeword] SSE parsed block: type=${eventType}, data=${eventData}`);

      if (eventType === 'wakeword' && eventData) {
        try {
          const data = JSON.parse(eventData);
          console.log(`[Wakeword] *** WAKE WORD EVENT: ${JSON.stringify(data)} ***`);
          if (this.onWakeword) {
            console.log('[Wakeword] Calling onWakeword callback');
            this.onWakeword(data);
          } else {
            console.log('[Wakeword] WARNING: onWakeword callback is null!');
          }
        } catch (e) {
          console.error(`[Wakeword] Failed to parse event data: ${eventData}`);
        }
      }
    }
  }

  _startHealthCheck() {
    const { port } = config.getWakewordConfig();
    let attempts = 0;
    const maxAttempts = 60;

    console.log(`[Wakeword] Starting health check polling on port ${port}`);

    this._healthCheckTimer = setInterval(() => {
      attempts++;
      if (attempts > maxAttempts) {
        clearInterval(this._healthCheckTimer);
        this._healthCheckTimer = null;
        this.error = 'Service startup timed out';
        this.starting = false;
        console.error('[Wakeword] Health check timed out after 1 minute');
        return;
      }

      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 3000 }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => { chunks.push(chunk); });
        res.on('end', () => {
          try {
            const data = Buffer.concat(chunks).toString('utf-8');
            const result = JSON.parse(data);
            if (result.status === 'ready' || result.status === 'listening') {
              if (!this.ready) {
                this.ready = true;
                this.starting = false;
                this.error = null;
                clearInterval(this._healthCheckTimer);
                this._healthCheckTimer = null;
                console.log(`[Wakeword] Service is ready! (status=${result.status})`);
                this._connectSSE();
                if (this._autoListenOnReady) {
                  console.log('[Wakeword] Auto-starting listening (was queued)...');
                  this.startListening();
                }
              }
            } else {
              console.log(`[Wakeword] Health check attempt ${attempts}: status=${result.status}`);
            }
          } catch (e) {
            console.log(`[Wakeword] Health check attempt ${attempts}: parse error`);
          }
        });
      });

      req.on('error', () => {
        if (attempts % 5 === 0) console.log(`[Wakeword] Health check attempt ${attempts}: server not up yet`);
      });
      req.on('timeout', () => { req.destroy(); });
    }, 1000);
  }
}

module.exports = { WakewordService };
