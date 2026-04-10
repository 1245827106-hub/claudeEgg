const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lilAgents', {
  // Character window APIs
  onPositionUpdate: (cb) => ipcRenderer.on('character:update-position', (_, data) => cb(data)),
  onShowBubble: (cb) => ipcRenderer.on('character:show-bubble', (_, data) => cb(data)),
  onHideBubble: (cb) => ipcRenderer.on('character:hide-bubble', () => cb()),
  onFlip: (cb) => ipcRenderer.on('character:flip', (_, data) => cb(data)),
  characterClicked: () => ipcRenderer.send('character:clicked'),

  // Chat window APIs
  sendMessage: (text) => ipcRenderer.send('chat:send-message', text),
  sendCommand: (cmd) => ipcRenderer.send('chat:command', cmd),
  onStreamText: (cb) => ipcRenderer.on('chat:stream-text', (_, text) => cb(text)),
  onTurnComplete: (cb) => ipcRenderer.on('chat:turn-complete', () => cb()),
  onError: (cb) => ipcRenderer.on('chat:error', (_, msg) => cb(msg)),
  onToolUse: (cb) => ipcRenderer.on('chat:tool-use', (_, data) => cb(data)),
  onToolResult: (cb) => ipcRenderer.on('chat:tool-result', (_, data) => cb(data)),
  onClearChat: (cb) => ipcRenderer.on('chat:clear', () => cb()),
  onReplayHistory: (cb) => ipcRenderer.on('chat:replay-history', (_, msgs) => cb(msgs)),
  copyToClipboard: (text) => ipcRenderer.send('chat:copy-clipboard', text),
  requestCopyLast: () => ipcRenderer.send('chat:copy-last'),
  onCopied: (cb) => ipcRenderer.on('chat:copied', (_, text) => cb(text)),

  // Bubble window APIs
  onBubbleUpdate: (cb) => ipcRenderer.on('bubble:update', (_, data) => cb(data)),
  onBubbleHide: (cb) => ipcRenderer.on('bubble:hide', () => cb()),

  // Theme APIs
  onThemeUpdate: (cb) => ipcRenderer.on('theme:update', (_, data) => cb(data)),

  // ASR APIs
  transcribeAudio: (audioArrayBuffer) => ipcRenderer.invoke('asr:transcribe', audioArrayBuffer),
  getASRStatus: () => ipcRenderer.invoke('asr:status'),
  setVoiceActive: (active) => ipcRenderer.send('voice:active', active),
});
