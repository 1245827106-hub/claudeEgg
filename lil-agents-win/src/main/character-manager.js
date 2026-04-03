const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const { getCharacterWalkArea } = require('./taskbar');
const { ClaudeSession } = require('./claude-session');
const { getCharacterTheme, formatTitle } = require('./themes');
const Store = require('./store');

const CHAR_WIDTH = 113;
const CHAR_HEIGHT = 200;
const BOTTOM_PADDING = 30; // bottom 15% of video is transparent padding
const WALK_REFERENCE_WIDTH = 500;

const BRUCE_CONFIG = {
  id: 'bruce',
  color: '#66b88c', // matches Mac: NSColor(0.4, 0.72, 0.55)
  videoFile: 'walk-bruce-01.webm',
  accelStart: 3.0, fullSpeedStart: 3.75, decelStart: 8.0, walkStop: 8.5,
  walkAmountRange: [0.4, 0.65],
  videoDuration: 10.0,
};

const JAZZ_CONFIG = {
  id: 'jazz',
  color: '#ff6600', // matches Mac: NSColor(1.0, 0.4, 0.0)
  videoFile: 'walk-jazz-01.webm',
  accelStart: 3.9, fullSpeedStart: 4.5, decelStart: 8.0, walkStop: 8.75,
  walkAmountRange: [0.35, 0.60],
  videoDuration: 10.0,
};

const THINKING_PHRASES = [
  'hmm...', 'thinking...', 'one sec...', 'ok hold on',
  'let me check', 'working on it', 'almost...', 'bear with me',
  'on it!', 'gimme a sec', 'brb', 'processing...',
  'hang tight', 'just a moment', 'figuring it out',
  'crunching...', 'reading...', 'looking...',
  'cooking...', 'vibing...', 'digging in',
  'connecting dots', 'give me a sec',
  "don't rush me", 'calculating...', 'assembling\u2026'
];

const COMPLETION_PHRASES = [
  'done!', 'all set!', 'ready!', 'here you go', 'got it!',
  'finished!', 'ta-da!', 'voila!',
  'boom!', 'there ya go!', 'check it out!'
];

// Sound files (ported from WalkerCharacter.swift)
const COMPLETION_SOUNDS = [
  'ping-aa.mp3', 'ping-bb.mp3', 'ping-cc.mp3',
  'ping-dd.mp3', 'ping-ee.mp3', 'ping-ff.mp3',
  'ping-gg.mp3', 'ping-hh.mp3', 'ping-jj.m4a'
];
let lastSoundIndex = -1;
let soundsEnabled = true;

function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}
function randomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

class WalkerCharacter {
  constructor(config, manager) {
    this.config = config;
    this.manager = manager;
    this.window = null;
    this.bubbleWindow = null;
    this.chatWindow = null;

    // Walk state
    this.positionProgress = config.id === 'bruce' ? 0.3 : 0.7;
    this.isWalking = false;
    this.isPaused = true;
    this.goingRight = true;
    this.walkStartTime = 0;
    this.walkStartPos = 0;
    this.walkEndPos = 0;
    this.walkStartPixel = 0;
    this.walkEndPixel = 0;
    this.currentTravelDistance = 500;
    this.pauseEndTime = Date.now() + randomInRange(1000, 3000);

    // Popover state
    this.isIdleForPopover = false;
    this.isOnboarding = false;
    this.session = null;
    this.currentStreamingText = '';
    this.lastAssistantText = '';

    // Bubble state
    this.showingCompletion = false;
    this.completionBubbleExpiry = 0;
    this.currentPhrase = '';
    this.lastPhraseUpdate = 0;

    // Sound player window (hidden, used to play audio)
    this.soundWindow = null;
  }

  createWindow() {
    const area = getCharacterWalkArea();
    const x = area.walkXStart + area.walkWidth * this.positionProgress;
    const initialY = area.walkY - CHAR_HEIGHT + BOTTOM_PADDING;

    this.window = new BrowserWindow({
      x: Math.round(x), y: initialY,
      width: CHAR_WIDTH, height: CHAR_HEIGHT,
      frame: false, transparent: true, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, focusable: false, hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload.js'),
        contextIsolation: true, nodeIntegration: false,
      }
    });
    this.window.setIgnoreMouseEvents(false);
    this.window.loadFile(path.join(__dirname, '..', 'renderer', 'character', 'index.html'));
    this.window.webContents.on('did-finish-load', () => {
      this.window.webContents.send('character:flip', { goingRight: this.goingRight });
      this.window.webContents.send('character:update-position', {
        characterId: this.config.id, color: this.config.color,
        videoSrc: `../../assets/videos/${this.config.videoFile}`,
      });
    });

    // Bubble window
    const bubbleWidth = 120;
    const charWindowY = area.walkY - CHAR_HEIGHT + BOTTOM_PADDING;
    this.bubbleWindow = new BrowserWindow({
      x: Math.round(x + CHAR_WIDTH / 2 - bubbleWidth / 2), y: charWindowY - 6,
      width: bubbleWidth, height: 30,
      frame: false, transparent: true, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, focusable: false, hasShadow: false, show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload.js'),
        contextIsolation: true, nodeIntegration: false,
      }
    });
    this.bubbleWindow.setIgnoreMouseEvents(true);
    this.bubbleWindow.loadFile(path.join(__dirname, '..', 'renderer', 'bubble', 'index.html'));
  }

  // Movement easing (ported from WalkerCharacter.swift)
  movementPosition(videoTime) {
    const { accelStart, fullSpeedStart, decelStart, walkStop } = this.config;
    const dIn = fullSpeedStart - accelStart;
    const dLin = decelStart - fullSpeedStart;
    const dOut = walkStop - decelStart;
    const v = 1.0 / (dIn / 2.0 + dLin + dOut / 2.0);
    if (videoTime <= accelStart) return 0.0;
    if (videoTime <= fullSpeedStart) { const t = videoTime - accelStart; return v * t * t / (2.0 * dIn); }
    if (videoTime <= decelStart) { const t = videoTime - fullSpeedStart; return v * dIn / 2.0 + v * t; }
    if (videoTime <= walkStop) { const t = videoTime - decelStart; return v * dIn / 2.0 + v * dLin + v * (t - t * t / (2.0 * dOut)); }
    return 1.0;
  }

  startWalk() {
    this.isPaused = false;
    this.isWalking = true;
    this.walkStartTime = Date.now();
    if (this.positionProgress > 0.85) this.goingRight = false;
    else if (this.positionProgress < 0.15) this.goingRight = true;
    else this.goingRight = Math.random() > 0.5;

    this.walkStartPos = this.positionProgress;
    const [minAmt, maxAmt] = this.config.walkAmountRange;
    const walkPixels = randomInRange(minAmt, maxAmt) * WALK_REFERENCE_WIDTH;
    const walkAmount = this.currentTravelDistance > 0 ? walkPixels / this.currentTravelDistance : 0.3;
    this.walkEndPos = this.goingRight
      ? Math.min(this.walkStartPos + walkAmount, 1.0)
      : Math.max(this.walkStartPos - walkAmount, 0.0);
    this.walkStartPixel = this.walkStartPos * this.currentTravelDistance;
    this.walkEndPixel = this.walkEndPos * this.currentTravelDistance;

    // Sibling collision avoidance
    const sibling = this.manager.getOtherCharacter(this.config.id);
    if (sibling) {
      const sibPos = sibling.positionProgress;
      if (Math.abs(this.walkEndPos - sibPos) < 0.12) {
        this.walkEndPos = this.goingRight
          ? Math.max(this.walkStartPos, sibPos - 0.12)
          : Math.min(this.walkStartPos, sibPos + 0.12);
        this.walkEndPixel = this.walkEndPos * this.currentTravelDistance;
      }
    }
    this.updateFlip();
    if (this.window && !this.window.isDestroyed())
      this.window.webContents.send('character:flip', { goingRight: this.goingRight, walking: true });
  }

  enterPause() {
    this.isWalking = false;
    this.isPaused = true;
    this.pauseEndTime = Date.now() + randomInRange(5000, 12000);
    if (this.window && !this.window.isDestroyed())
      this.window.webContents.send('character:flip', { goingRight: this.goingRight, walking: false });
  }

  updateFlip() {
    if (this.window && !this.window.isDestroyed())
      this.window.webContents.send('character:flip', { goingRight: this.goingRight, walking: this.isWalking });
  }

  update() {
    const area = getCharacterWalkArea();
    this.currentTravelDistance = Math.max(area.walkWidth - CHAR_WIDTH, 0);
    if (this.isIdleForPopover) { this._updatePosition(area); this._updateBubble(); return; }
    const now = Date.now();
    if (this.isPaused) {
      if (now >= this.pauseEndTime) this.startWalk();
      else { this._updatePosition(area); this._updateBubble(); return; }
    }
    if (this.isWalking) {
      const elapsed = (now - this.walkStartTime) / 1000;
      const walkNorm = elapsed >= this.config.videoDuration ? 1.0 : this.movementPosition(Math.min(elapsed, this.config.videoDuration));
      const currentPixel = this.walkStartPixel + (this.walkEndPixel - this.walkStartPixel) * walkNorm;
      if (this.currentTravelDistance > 0)
        this.positionProgress = Math.min(Math.max(currentPixel / this.currentTravelDistance, 0), 1);
      if (elapsed >= this.config.videoDuration) { this.walkEndPos = this.positionProgress; this.enterPause(); }
      this._updatePosition(area);
    }
    this._updateBubble();
  }

  _updatePosition(area) {
    if (!this.window || this.window.isDestroyed()) return;
    const x = Math.round(area.walkXStart + this.currentTravelDistance * this.positionProgress);
    const y = area.walkY - CHAR_HEIGHT + BOTTOM_PADDING;
    const bounds = this.window.getBounds();
    if (bounds.x !== x || bounds.y !== y)
      this.window.setBounds({ x, y, width: CHAR_WIDTH, height: CHAR_HEIGHT });
    this._updateBubblePosition(x, y);
    if (this.isIdleForPopover && this.chatWindow && !this.chatWindow.isDestroyed()) {
      const chatWidth = 432, chatHeight = 352;
      const chatX = Math.round(x + CHAR_WIDTH / 2 - chatWidth / 2);
      const chatY = y - chatHeight - 10;
      const display = screen.getPrimaryDisplay();
      const clampedX = Math.max(display.workArea.x + 4, Math.min(chatX, display.workArea.x + display.workArea.width - chatWidth - 4));
      this.chatWindow.setBounds({ x: clampedX, y: Math.max(0, chatY), width: chatWidth, height: chatHeight });
    }
  }

  _updateBubblePosition(charX, charY) {
    if (!this.bubbleWindow || this.bubbleWindow.isDestroyed() || !this.bubbleWindow.isVisible()) return;
    const bubbleWidth = 120;
    this.bubbleWindow.setBounds({
      x: Math.round(charX + CHAR_WIDTH / 2 - bubbleWidth / 2),
      y: charY - 6, width: bubbleWidth, height: 30
    });
  }

  // Bubble logic
  _updateBubble() {
    const now = Date.now();
    if (this.showingCompletion) {
      if (now >= this.completionBubbleExpiry) { this.showingCompletion = false; this._hideBubble(); return; }
      if (this.isIdleForPopover) this._hideBubble();
      else this._showBubble(this.currentPhrase, true);
      return;
    }
    const agentBusy = this.session ? this.session.isBusy : false;
    if (agentBusy && !this.isIdleForPopover) {
      this._updateThinkingPhrase();
      this._showBubble(this.currentPhrase, false);
    } else if (!this.showingCompletion) {
      this._hideBubble();
    }
  }

  _updateThinkingPhrase() {
    const now = Date.now();
    if (!this.currentPhrase || now - this.lastPhraseUpdate > randomInRange(3000, 5000)) {
      let next = randomElement(THINKING_PHRASES);
      while (next === this.currentPhrase && THINKING_PHRASES.length > 1) next = randomElement(THINKING_PHRASES);
      this.currentPhrase = next;
      this.lastPhraseUpdate = now;
    }
  }

  showCompletionBubble() {
    this.currentPhrase = randomElement(COMPLETION_PHRASES);
    this.showingCompletion = true;
    this.completionBubbleExpiry = Date.now() + 3000;
    this.lastPhraseUpdate = 0;
    if (!this.isIdleForPopover) this._showBubble(this.currentPhrase, true);
  }

  _showBubble(text, isCompletion) {
    if (!this.bubbleWindow || this.bubbleWindow.isDestroyed()) return;
    const theme = getCharacterTheme(this.config.id);
    this.bubbleWindow.webContents.send('bubble:update', {
      text, isCompletion,
      bubbleBg: theme.bubbleBg,
      bubbleBorder: theme.bubbleBorder,
      bubbleText: theme.bubbleText,
      bubbleCompletionBorder: theme.bubbleCompletionBorder,
      bubbleCompletionText: theme.bubbleCompletionText,
      bubbleRadius: theme.bubbleRadius,
      bubbleFontWeight: theme.bubbleFontWeight,
      bubbleFontSize: theme.bubbleFontSize,
      bubbleFontFamily: theme.fontFamily,
    });
    if (!this.bubbleWindow.isVisible()) this.bubbleWindow.showInactive();
  }

  _hideBubble() {
    if (this.bubbleWindow && !this.bubbleWindow.isDestroyed() && this.bubbleWindow.isVisible())
      this.bubbleWindow.hide();
  }

  // Sound effects (ported from WalkerCharacter.swift)
  playCompletionSound() {
    if (!soundsEnabled) return;
    let idx;
    do { idx = Math.floor(Math.random() * COMPLETION_SOUNDS.length); }
    while (idx === lastSoundIndex && COMPLETION_SOUNDS.length > 1);
    lastSoundIndex = idx;

    const soundFile = COMPLETION_SOUNDS[idx];
    const soundPath = path.join(__dirname, '..', 'assets', 'sounds', soundFile);
    const fileUrl = 'file:///' + soundPath.replace(/\\/g, '/');

    // Play via the chat window if open, otherwise use a dedicated sound window
    const targetWindow = (this.chatWindow && !this.chatWindow.isDestroyed())
      ? this.chatWindow
      : this._getSoundWindow();

    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.executeJavaScript(
        `(function(){ var a = new Audio('${fileUrl}'); a.volume = 0.6; a.play().catch(function(){}); })()`
      ).catch(() => {});
    }
  }

  _getSoundWindow() {
    if (!this.soundWindow || this.soundWindow.isDestroyed()) {
      this.soundWindow = new BrowserWindow({
        width: 1, height: 1, show: false, skipTaskbar: true,
        webPreferences: { contextIsolation: false, nodeIntegration: false }
      });
      this.soundWindow.loadFile(path.join(__dirname, '..', 'renderer', 'sound', 'index.html'));
    }
    return this.soundWindow;
  }

  // Onboarding (ported from WalkerCharacter.swift)
  openOnboarding() {
    this.isOnboarding = true;
    this.showingCompletion = false;
    this._hideBubble();
    this.isIdleForPopover = true;
    this.isWalking = false;
    this.isPaused = true;
    if (this.window && !this.window.isDestroyed())
      this.window.webContents.send('character:flip', { goingRight: this.goingRight, walking: false });

    if (!this.chatWindow || this.chatWindow.isDestroyed()) this._createChatWindow();

    this.chatWindow.webContents.on('did-finish-load', () => {
      const theme = getCharacterTheme(this.config.id);
      this.chatWindow.webContents.send('theme:update', { theme, title: formatTitle(theme) });
      // Send onboarding welcome message
      const welcome = `hey! we're bruce and jazz — your lil dock agents.

click either of us to open a Claude AI chat. we'll walk around while you work and let you know when Claude's thinking.

check the system tray icon (bottom right) for themes, sounds, and more options.

click anywhere outside to dismiss, then click us again to start chatting.`;
      this.chatWindow.webContents.send('chat:stream-text', welcome);
      this.chatWindow.webContents.send('chat:turn-complete');
    });

    this.chatWindow.show();

    this.chatWindow.once('blur', () => {
      this.closeOnboarding();
    });
  }

  closeOnboarding() {
    if (this.chatWindow && !this.chatWindow.isDestroyed()) this.chatWindow.hide();
    this.chatWindow = null;
    this.isIdleForPopover = false;
    this.isOnboarding = false;
    this.isPaused = true;
    this.pauseEndTime = Date.now() + randomInRange(1000, 3000);
    this.manager.completeOnboarding();
  }

  // Click handler
  handleClick() {
    // Cancel any pending blur-close so the popover doesn't flicker
    if (this._blurTimer) { clearTimeout(this._blurTimer); this._blurTimer = null; }
    if (this.isOnboarding) { this.closeOnboarding(); return; }
    if (this.isIdleForPopover) this.closePopover();
    else this.openPopover();
  }

  openPopover() {
    const sibling = this.manager.getOtherCharacter(this.config.id);
    if (sibling && sibling.isIdleForPopover) sibling.closePopover();

    this.isIdleForPopover = true;
    this.isWalking = false;
    this.isPaused = true;
    this.showingCompletion = false;
    this._hideBubble();
    if (this.window && !this.window.isDestroyed())
      this.window.webContents.send('character:flip', { goingRight: this.goingRight, walking: false });

    if (!this.session) {
      this.session = new ClaudeSession();
      this._wireSession(this.session);
      this.session.start();
    }

    if (!this.chatWindow || this.chatWindow.isDestroyed()) this._createChatWindow();

    // Send theme & replay history after load
    const sendThemeAndHistory = () => {
      const theme = getCharacterTheme(this.config.id);
      this.chatWindow.webContents.send('theme:update', { theme, title: formatTitle(theme) });
      if (this.session.history.length > 0)
        this.chatWindow.webContents.send('chat:replay-history', this.session.history);
    };

    if (this.chatWindow.webContents.isLoading()) {
      this.chatWindow.webContents.once('did-finish-load', sendThemeAndHistory);
    } else {
      sendThemeAndHistory();
    }

    // Reposition chat window to current character location BEFORE showing
    const area = getCharacterWalkArea();
    const curX = Math.round(area.walkXStart + this.currentTravelDistance * this.positionProgress);
    const chatWidth = 432, chatHeight = 352;
    const chatX = Math.round(curX + CHAR_WIDTH / 2 - chatWidth / 2);
    const chatY = area.walkY - chatHeight - 10;
    const display = screen.getPrimaryDisplay();
    const clampedX = Math.max(display.workArea.x + 4, Math.min(chatX, display.workArea.x + display.workArea.width - chatWidth - 4));
    this.chatWindow.setBounds({ x: clampedX, y: Math.max(0, chatY), width: chatWidth, height: chatHeight });

    // Ignore blur events briefly after opening to prevent flicker
    this._ignoreBlurUntil = Date.now() + 500;

    // Show without animation: set opacity 0 → show → set opacity 1
    if (this.chatWindow.getOpacity() < 1) {
      this.chatWindow.setOpacity(0);
      this.chatWindow.showInactive();
      // Let one frame render, then reveal
      setTimeout(() => {
        if (this.chatWindow && !this.chatWindow.isDestroyed()) {
          this.chatWindow.setOpacity(1);
          this.chatWindow.focus();
        }
      }, 50);
    } else {
      this.chatWindow.show();
      this.chatWindow.focus();
    }
  }

  closePopover() {
    if (!this.isIdleForPopover) return;
    if (this.chatWindow && !this.chatWindow.isDestroyed()) {
      this.chatWindow.setOpacity(0);  // Instant hide, no animation
      this.chatWindow.hide();
    }
    this.isIdleForPopover = false;

    if (this.showingCompletion) {
      this.completionBubbleExpiry = Date.now() + 3000;
      this._showBubble(this.currentPhrase, true);
    } else if (this.session && this.session.isBusy) {
      this.currentPhrase = '';
      this.lastPhraseUpdate = 0;
      this._updateThinkingPhrase();
      this._showBubble(this.currentPhrase, false);
    }
    this.pauseEndTime = Date.now() + randomInRange(2000, 5000);
  }

  _createChatWindow() {
    const area = getCharacterWalkArea();
    const charX = area.walkXStart + this.currentTravelDistance * this.positionProgress;
    const chatWidth = 432, chatHeight = 352;
    const chatX = Math.round(charX + CHAR_WIDTH / 2 - chatWidth / 2);
    const chatY = area.walkY - chatHeight - 10;
    const display = screen.getPrimaryDisplay();
    const clampedX = Math.max(display.workArea.x + 4, Math.min(chatX, display.workArea.x + display.workArea.width - chatWidth - 4));

    this.chatWindow = new BrowserWindow({
      x: clampedX, y: Math.max(0, chatY), width: chatWidth, height: chatHeight,
      frame: false, transparent: true, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, show: false,
      thickFrame: false,          // Disable Windows window animation
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload.js'),
        contextIsolation: true, nodeIntegration: false,
      }
    });
    this.chatWindow.setOpacity(0); // Start invisible, fade in after ready
    this.chatWindow.loadFile(path.join(__dirname, '..', 'renderer', 'chat', 'index.html'));

    this.chatWindow.webContents.on('did-finish-load', () => {
      this.chatWindow.webContents.send('character:update-position', {
        characterId: this.config.id, color: this.config.color,
      });
      // Apply theme on load
      const theme = getCharacterTheme(this.config.id);
      this.chatWindow.webContents.send('theme:update', { theme, title: formatTitle(theme) });
      // Replay history if any
      if (this.session && this.session.history.length > 0) {
        this.chatWindow.webContents.send('chat:replay-history', this.session.history);
      }
    });

    // Close popover when clicking outside
    this.chatWindow.on('blur', () => {
      this._blurTimer = setTimeout(() => {
        // Skip if we just opened, or window regained focus, or character was clicked
        if (this._ignoreBlurUntil && Date.now() < this._ignoreBlurUntil) return;
        if (this.chatWindow && !this.chatWindow.isDestroyed() && !this.chatWindow.isFocused())
          this.closePopover();
      }, 300);
    });
  }

  applyTheme() {
    const theme = getCharacterTheme(this.config.id);
    if (this.chatWindow && !this.chatWindow.isDestroyed()) {
      this.chatWindow.webContents.send('theme:update', { theme, title: formatTitle(theme) });
    }
  }

  _wireSession(session) {
    session.onText = (text) => {
      this.currentStreamingText += text;
      if (this.chatWindow && !this.chatWindow.isDestroyed())
        this.chatWindow.webContents.send('chat:stream-text', text);
    };
    session.onTurnComplete = () => {
      if (this.currentStreamingText) this.lastAssistantText = this.currentStreamingText;
      this.currentStreamingText = '';
      if (this.chatWindow && !this.chatWindow.isDestroyed())
        this.chatWindow.webContents.send('chat:turn-complete');
      this.showCompletionBubble();
      this.playCompletionSound();
    };
    session.onError = (text) => {
      if (this.chatWindow && !this.chatWindow.isDestroyed())
        this.chatWindow.webContents.send('chat:error', text);
    };
    session.onToolUse = (toolName, input) => {
      const summary = this._formatToolInput(input);
      if (this.chatWindow && !this.chatWindow.isDestroyed())
        this.chatWindow.webContents.send('chat:tool-use', { toolName, summary });
    };
    session.onToolResult = (summary, isError) => {
      if (this.chatWindow && !this.chatWindow.isDestroyed())
        this.chatWindow.webContents.send('chat:tool-result', { summary, isError });
    };
    session.onProcessExit = () => {
      if (this.chatWindow && !this.chatWindow.isDestroyed())
        this.chatWindow.webContents.send('chat:error', 'Claude session ended.');
    };
  }

  _formatToolInput(input) {
    if (input.command) return input.command;
    if (input.file_path) return input.file_path;
    if (input.pattern) return input.pattern;
    return Object.keys(input).sort().slice(0, 3).join(', ');
  }

  cleanup() {
    if (this.session) this.session.terminate();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    if (this.bubbleWindow && !this.bubbleWindow.isDestroyed()) this.bubbleWindow.destroy();
    if (this.chatWindow && !this.chatWindow.isDestroyed()) this.chatWindow.destroy();
    if (this.soundWindow && !this.soundWindow.isDestroyed()) this.soundWindow.destroy();
  }
}

class CharacterManager {
  constructor() {
    this.characters = {};
    this.animationTimer = null;
    this.onboardingComplete = Store.get('onboardingComplete', false);
  }

  init() {
    soundsEnabled = Store.get('soundsEnabled', true);

    this.characters.bruce = new WalkerCharacter(BRUCE_CONFIG, this);
    this.characters.jazz = new WalkerCharacter(JAZZ_CONFIG, this);
    this.characters.bruce.createWindow();
    this.characters.jazz.createWindow();
    this._setupIPC();
    this._startAnimationLoop();

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
    soundsEnabled = enabled;
    Store.set('soundsEnabled', enabled);
  }

  static getSoundsEnabled() {
    return soundsEnabled;
  }

  _setupIPC() {
    ipcMain.on('character:clicked', (event) => {
      for (const char of Object.values(this.characters)) {
        if (char.window && !char.window.isDestroyed() && char.window.webContents === event.sender) {
          char.handleClick(); return;
        }
      }
    });
    ipcMain.on('chat:send-message', (event, text) => {
      for (const char of Object.values(this.characters)) {
        if (char.chatWindow && !char.chatWindow.isDestroyed() && char.chatWindow.webContents === event.sender) {
          if (char.session) char.session.send(text); return;
        }
      }
    });
    ipcMain.on('chat:copy-last', (event) => {
      for (const char of Object.values(this.characters)) {
        if (char.chatWindow && !char.chatWindow.isDestroyed() && char.chatWindow.webContents === event.sender) {
          event.sender.send('chat:copied', char.lastAssistantText || ''); return;
        }
      }
    });
    ipcMain.on('chat:copy-clipboard', (_, text) => {
      require('electron').clipboard.writeText(text);
    });
    ipcMain.on('chat:command', (event, cmd) => {
      for (const char of Object.values(this.characters)) {
        if (char.chatWindow && !char.chatWindow.isDestroyed() && char.chatWindow.webContents === event.sender) {
          if (cmd === '/clear' && char.session) char.session.history = [];
          return;
        }
      }
    });
  }

  _startAnimationLoop() {
    this.animationTimer = setInterval(() => {
      for (const char of Object.values(this.characters)) char.update();
    }, 33);
  }

  cleanup() {
    if (this.animationTimer) clearInterval(this.animationTimer);
    for (const char of Object.values(this.characters)) char.cleanup();
  }
}

module.exports = { CharacterManager };
