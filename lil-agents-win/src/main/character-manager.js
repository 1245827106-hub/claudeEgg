const { ipcMain, session, clipboard } = require('electron');
const Store = require('./store');
const { ASRService } = require('./asr-service');
const { TTSService } = require('./tts-service');
const { WakewordService } = require('./wakeword-service');
const {
  WalkerCharacter,
  BRUCE_CONFIG,
  JAZZ_CONFIG,
  PAUSE_SIBLING_BLOCK_MS,
  randomInRange,
  setSoundsEnabled,
  getSoundsEnabled,
} = require('./walker-character');

const ANIMATION_INTERVAL_MS = 33; // ~30 fps

class CharacterManager {
  constructor() {
    this.characters = {};
    this.animationTimer = null;
    this.onboardingComplete = Store.get('onboardingComplete', false);
    this.asrService = new ASRService();
    this.ttsService = new TTSService();
    this.wakewordService = new WakewordService();
    this.lastActiveCharacterId = 'bruce';
    this._ttsCancel = null;
  }

  init() {
    setSoundsEnabled(Store.get('soundsEnabled', true));

    // Grant microphone permission for voice input
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(permission === 'media');
    });

    this.characters.bruce = new WalkerCharacter(BRUCE_CONFIG, this);
    this.characters.jazz = new WalkerCharacter(JAZZ_CONFIG, this);
    this.characters.bruce.createWindow();
    this.characters.jazz.createWindow();

    // Restore visibility state from store
    if (!Store.get('bruceVisible', true)) {
      const bruce = this.characters.bruce;
      if (bruce.window && !bruce.window.isDestroyed()) bruce.window.hide();
    }
    if (!Store.get('jazzVisible', true)) {
      const jazz = this.characters.jazz;
      if (jazz.window && !jazz.window.isDestroyed()) jazz.window.hide();
    }
    this._setupIPC();
    this._startAnimationLoop();

    // Auto-start ASR service
    this.asrService.start().catch(err => {
      console.error('[ASR] Auto-start failed:', err.message);
    });

    // Auto-start TTS service only if enabled (default: off to save GPU memory)
    if (CharacterManager.getTTSEnabled()) {
      this.ttsService.start().catch(err => {
        console.error('[TTS] Auto-start failed:', err.message);
      });
    }

    // Auto-start wake word service if enabled
    if (Store.get('wakewordEnabled', false)) {
      this.wakewordService.onWakeword = () => this._handleWakewordDetected();
      this.wakewordService.start().then(() => {
        this.wakewordService.startListening();
      }).catch(err => {
        console.error('[Wakeword] Auto-start failed:', err.message);
      });
    }

    // First-run onboarding
    if (!this.onboardingComplete) {
      setTimeout(() => {
        this.characters.bruce.openOnboarding();
      }, 2000);
    }
  }

  completeOnboarding() {
    this.onboardingComplete = true;
    Store.set('onboardingComplete', true);
  }

  getOtherCharacter(id) {
    return id === 'bruce' ? this.characters.jazz : this.characters.bruce;
  }

  applyTheme() {
    for (const char of Object.values(this.characters)) {
      char.applyTheme();
    }
  }

  static setSoundsEnabled(enabled) {
    setSoundsEnabled(enabled);
    Store.set('soundsEnabled', enabled);
  }

  static getSoundsEnabled() {
    return getSoundsEnabled();
  }

  static getTTSEnabled() {
    return Store.get('ttsEnabled', false);
  }

  static setTTSEnabled(enabled) {
    Store.set('ttsEnabled', enabled);
  }

  static getWakewordEnabled() {
    return Store.get('wakewordEnabled', false);
  }

  setWakewordEnabled(enabled) {
    Store.set('wakewordEnabled', enabled);
    if (enabled) {
      this.wakewordService.onWakeword = () => this._handleWakewordDetected();
      this.wakewordService.start().then(() => {
        this.wakewordService.startListening();
      }).catch(err => console.error('[Wakeword] Start failed:', err.message));
    } else {
      this.wakewordService.stop();
    }
  }

  _handleWakewordDetected() {
    console.log('[Wakeword] === _handleWakewordDetected called ===');
    const charId = this.lastActiveCharacterId || 'bruce';
    const char = this.characters[charId];
    if (!char) { console.log('[Wakeword] No character found for id:', charId); return; }

    if (char._voiceInputActive) { console.log('[Wakeword] Voice already active, ignoring'); return; }

    console.log('[Wakeword] Pausing wake word listening...');
    this.wakewordService.stopListening();

    const sendStartASR = (delay) => {
      setTimeout(() => {
        if (char.chatWindow && !char.chatWindow.isDestroyed()) {
          console.log('[Wakeword] Sending chat:start-asr to chat window');
          try {
            char.chatWindow.webContents.send('chat:start-asr');
          } catch (e) { console.error('[Wakeword] Error sending start-asr:', e.message); }
        }
      }, delay);
    };

    if (char.isIdleForPopover) {
      console.log('[Wakeword] Chat already open, triggering ASR');
      sendStartASR(300);
    } else {
      console.log('[Wakeword] Opening popover for character:', charId);
      char.openPopover();
      // Use fixed delay instead of did-finish-load to avoid race conditions
      // Local HTML loads in <500ms, 1.5s is a safe margin
      sendStartASR(1500);
    }

    console.log('[Wakeword] Will resume listening in 10 seconds');
    setTimeout(() => {
      if (Store.get('wakewordEnabled', false)) {
        console.log('[Wakeword] Resuming wake word listening');
        this.wakewordService.startListening();
      }
    }, 10000);
  }

  // Finds the character whose character-window webContents sent the event (for
  // character:clicked). Returns null if none matches.
  _characterFromCharacterSender(sender) {
    for (const char of Object.values(this.characters)) {
      if (char.window && !char.window.isDestroyed() && char.window.webContents === sender) return char;
    }
    return null;
  }

  // Finds the character whose chat-window webContents sent the event.
  _characterFromChatSender(sender) {
    for (const char of Object.values(this.characters)) {
      if (char.chatWindow && !char.chatWindow.isDestroyed() && char.chatWindow.webContents === sender) return char;
    }
    return null;
  }

  _setupIPC() {
    ipcMain.on('character:clicked', (event) => {
      const char = this._characterFromCharacterSender(event.sender);
      if (!char) return;
      this.lastActiveCharacterId = char.config.id;
      char.handleClick();
    });

    ipcMain.on('chat:send-message', (event, text) => {
      const char = this._characterFromChatSender(event.sender);
      if (char && char.session) char.session.send(text);
    });

    ipcMain.on('chat:copy-last', (event) => {
      const char = this._characterFromChatSender(event.sender);
      if (char) event.sender.send('chat:copied', char.lastAssistantText || '');
    });

    ipcMain.on('chat:copy-clipboard', (_, text) => {
      clipboard.writeText(text);
    });

    ipcMain.on('chat:command', (event, cmd) => {
      const char = this._characterFromChatSender(event.sender);
      if (char && cmd === '/clear' && char.session) char.session.history = [];
    });

    // Voice input state: suppress blur while recording/transcribing
    ipcMain.on('voice:active', (event, active) => {
      const char = this._characterFromChatSender(event.sender);
      if (!char) return;
      char._voiceInputActive = active;
      // Resume wake word listening when chat recording ends
      if (!active && Store.get('wakewordEnabled', false)) {
        console.log('[Wakeword] Voice recording ended, resuming listening in 2s');
        setTimeout(() => {
          if (Store.get('wakewordEnabled', false)) {
            this.wakewordService.startListening();
          }
        }, 2000);
      }
    });

    // ASR IPC handlers
    ipcMain.handle('asr:transcribe', async (event, audioData) => {
      try {
        const buf = Buffer.from(audioData);
        console.log(`[ASR IPC] Received audio: ${buf.length} bytes`);
        const result = await this.asrService.transcribe(buf);
        console.log(`[ASR IPC] Result: ${JSON.stringify(result)}`);
        return result;
      } catch (err) {
        console.error(`[ASR IPC] Error: ${err.message}`);
        return { error: err.message };
      }
    });
    ipcMain.handle('asr:status', async () => {
      return { status: this.asrService.getStatus(), ready: this.asrService.isReady() };
    });

    // TTS IPC handlers
    ipcMain.handle('tts:synthesize', async (event, text) => {
      try {
        return await this.ttsService.synthesize(text);
      } catch (err) {
        return { error: err.message };
      }
    });
    ipcMain.handle('tts:status', async () => {
      return { status: this.ttsService.getStatus(), ready: this.ttsService.isReady() };
    });

    // TTS streaming: synthesize sentence-by-sentence, send each chunk to renderer
    ipcMain.on('tts:stream-start', (event, text) => {
      // Cancel any in-progress stream
      if (this._ttsCancel) { this._ttsCancel(); this._ttsCancel = null; }

      this._ttsCancel = this.ttsService.synthesizeStream(
        text,
        (chunk) => {
          try {
            if (!event.sender.isDestroyed()) event.sender.send('tts:stream-chunk', chunk);
          } catch {}
        },
        () => {
          try {
            if (!event.sender.isDestroyed()) event.sender.send('tts:stream-done');
          } catch {}
          this._ttsCancel = null;
        },
        (err) => {
          try {
            if (!event.sender.isDestroyed()) event.sender.send('tts:stream-error', err.message);
          } catch {}
          this._ttsCancel = null;
        }
      );
    });
    ipcMain.on('tts:stream-stop', () => {
      if (this._ttsCancel) { this._ttsCancel(); this._ttsCancel = null; }
    });
  }

  _startAnimationLoop() {
    this.animationTimer = setInterval(() => {
      const chars = Object.values(this.characters);
      // One-at-a-time walking: if any character is walking, delay others
      const anyWalking = chars.some(c => c.isWalking && !c.isIdleForPopover);
      if (anyWalking) {
        for (const char of chars) {
          if (!char.isIdleForPopover && char.isPaused && Date.now() >= char.pauseEndTime) {
            char.pauseEndTime = Date.now() + randomInRange(...PAUSE_SIBLING_BLOCK_MS);
          }
        }
      }
      for (const char of chars) char.update();
    }, ANIMATION_INTERVAL_MS);
  }

  cleanup() {
    if (this.animationTimer) { clearInterval(this.animationTimer); this.animationTimer = null; }
    if (this._ttsCancel) { this._ttsCancel(); this._ttsCancel = null; }
    for (const char of Object.values(this.characters)) char.cleanup();
    this.asrService.stop();
    this.ttsService.stop();
    this.wakewordService.stop();
  }
}

module.exports = { CharacterManager };
