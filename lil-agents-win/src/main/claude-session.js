const { spawn } = require('child_process');
const os = require('os');
const { findBinary, getProcessEnv, getClaudeFallbackPaths } = require('./shell-env');

/**
 * Claude Code CLI session manager
 * Implements the stream-json bidirectional protocol
 */
class ClaudeSession {
  constructor() {
    this.process = null;
    this.lineBuffer = '';
    this.currentResponseText = '';
    this.pendingMessages = [];
    this.isRunning = false;
    this.isBusy = false;
    this.history = [];

    // Callbacks
    this.onText = null;
    this.onError = null;
    this.onToolUse = null;
    this.onToolResult = null;
    this.onSessionReady = null;
    this.onTurnComplete = null;
    this.onProcessExit = null;
  }

  start() {
    const binaryPath = findBinary('claude', getClaudeFallbackPaths());
    if (!binaryPath) {
      const msg = 'Claude CLI not found.\n\nInstall with: npm install -g @anthropic-ai/claude-code\nOr visit: https://claude.ai/download';
      if (this.onError) this.onError(msg);
      this.history.push({ role: 'error', text: msg });
      return;
    }
    this._launchProcess(binaryPath);
  }

  _launchProcess(binaryPath) {
    const env = getProcessEnv();
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose'
    ];

    try {
      this.process = spawn(binaryPath, args, {
        cwd: os.homedir(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      this.isRunning = true;

      this.process.stdout.on('data', (data) => {
        this._processOutput(data.toString('utf8'));
      });

      this.process.stderr.on('data', (data) => {
        const text = data.toString('utf8').trim();
        if (text && this.onError) {
          this.onError(text);
        }
      });

      this.process.on('close', (code) => {
        this.isRunning = false;
        this.isBusy = false;
        if (this.onProcessExit) this.onProcessExit();
      });

      this.process.on('error', (err) => {
        this.isRunning = false;
        const msg = `Failed to launch Claude CLI: ${err.message}`;
        if (this.onError) this.onError(msg);
        this.history.push({ role: 'error', text: msg });
      });

      // Send any pending messages
      const pending = this.pendingMessages;
      this.pendingMessages = [];
      for (const msg of pending) {
        this._writeMessage(msg);
      }
    } catch (err) {
      const msg = `Failed to launch Claude CLI: ${err.message}`;
      if (this.onError) this.onError(msg);
      this.history.push({ role: 'error', text: msg });
    }
  }

  send(message) {
    if (!this.isRunning || !this.process) {
      this.pendingMessages.push(message);
      return;
    }
    this._writeMessage(message);
  }

  _writeMessage(message) {
    this.isBusy = true;
    this.currentResponseText = '';
    this.history.push({ role: 'user', text: message });

    const payload = {
      type: 'user',
      message: {
        role: 'user',
        content: message
      }
    };

    try {
      this.process.stdin.write(JSON.stringify(payload) + '\n');
    } catch (err) {
      if (this.onError) this.onError(`Write error: ${err.message}`);
    }
  }

  terminate() {
    if (this.process) {
      this.process.kill();
      this.isRunning = false;
      this.pendingMessages = [];
    }
  }

  // NDJSON line parsing
  _processOutput(text) {
    this.lineBuffer += text;
    let newlineIdx;
    while ((newlineIdx = this.lineBuffer.indexOf('\n')) !== -1) {
      const line = this.lineBuffer.slice(0, newlineIdx);
      this.lineBuffer = this.lineBuffer.slice(newlineIdx + 1);
      if (line.trim()) {
        this._parseLine(line);
      }
    }
  }

  _parseLine(line) {
    let json;
    try {
      json = JSON.parse(line);
    } catch {
      return; // Ignore non-JSON lines
    }

    const type = json.type || '';

    switch (type) {
      case 'system': {
        const subtype = json.subtype || '';
        if (subtype === 'init' && this.onSessionReady) {
          this.onSessionReady();
        }
        break;
      }

      case 'assistant': {
        const message = json.message;
        if (message && Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'text' && block.text) {
              this.currentResponseText += block.text;
              if (this.onText) this.onText(block.text);
            } else if (block.type === 'tool_use') {
              const toolName = block.name || 'Tool';
              const input = block.input || {};
              const summary = this._formatToolSummary(toolName, input);
              this.history.push({ role: 'toolUse', text: `${toolName}: ${summary}` });
              if (this.onToolUse) this.onToolUse(toolName, input);
            }
          }
        }
        break;
      }

      case 'user': {
        const message = json.message;
        if (message && Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'tool_result') {
              const isError = block.is_error || false;
              let summary = '';
              const result = json.tool_use_result;
              if (result && typeof result === 'object') {
                if (result.file && result.file.filePath) {
                  summary = `${result.file.filePath} (${result.file.totalLines || 0} lines)`;
                }
              } else if (typeof result === 'string') {
                summary = result.slice(0, 80);
              }
              if (!summary && typeof block.content === 'string') {
                summary = block.content.slice(0, 80);
              }
              this.history.push({ role: 'toolResult', text: isError ? `ERROR: ${summary}` : summary });
              if (this.onToolResult) this.onToolResult(summary, isError);
            }
          }
        }
        break;
      }

      case 'result': {
        this.isBusy = false;
        let finalText = '';
        if (json.result && typeof json.result === 'string') {
          finalText = json.result;
        } else if (this.currentResponseText) {
          finalText = this.currentResponseText;
        }
        if (finalText) {
          this.history.push({ role: 'assistant', text: finalText });
        }
        this.currentResponseText = '';
        if (this.onTurnComplete) this.onTurnComplete();
        break;
      }
    }
  }

  _formatToolSummary(toolName, input) {
    switch (toolName) {
      case 'Bash': return input.command || '';
      case 'Read': return input.file_path || '';
      case 'Edit':
      case 'Write': return input.file_path || '';
      case 'Glob': return input.pattern || '';
      case 'Grep': return input.pattern || '';
      default:
        if (input.description) return input.description;
        return Object.keys(input).sort().slice(0, 3).join(', ');
    }
  }
}

module.exports = { ClaudeSession };
