/**
 * TTS Voice Output - Streaming sentence-by-sentence player.
 *
 * Uses streaming mode: Python backend synthesizes one sentence at a time,
 * each chunk is sent to renderer via IPC as soon as it's ready.
 * The player queues chunks and plays them back-to-back, so the user hears
 * the first sentence while the rest are still being synthesized.
 *
 * No smart logic here — all handled by the Python backend.
 */

class VoiceOutput {
  constructor() {
    this.state = 'idle'; // idle | playing
    this.queue = [];     // queued audio data URLs
    this.currentAudio = null; // AudioBufferSourceNode
    this._audioCtx = null;
    this._setupListeners();
  }

  /** Lazy-init AudioContext (Web Audio API doesn't trigger Windows media OSD) */
  _getAudioCtx() {
    if (!this._audioCtx || this._audioCtx.state === 'closed') {
      this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this._audioCtx.state === 'suspended') this._audioCtx.resume();
    return this._audioCtx;
  }

  _setupListeners() {
    // Receive audio chunks from main process (one per sentence)
    window.lilAgents.onTTSChunk((data) => {
      this.queue.push(data.audioDataUrl);
      // If not currently playing, start playing from queue
      if (this.state !== 'playing') {
        this._playNext();
      }
    });

    window.lilAgents.onTTSDone(() => {
      // All sentences synthesized; queue will drain naturally
    });

    window.lilAgents.onTTSError((msg) => {
      console.warn('[TTS]', msg);
    });
  }

  /**
   * Start streaming synthesis. Silently skips if TTS not ready.
   * @param {string} text - Raw assistant response text
   */
  async play(text) {
    if (!text || !text.trim()) return;

    try {
      const status = await window.lilAgents.getTTSStatus();
      if (!status.ready) return;

      // Stop any current playback and clear queue
      this.stop();

      // Request streaming synthesis from backend
      window.lilAgents.ttsStreamStart(text);
    } catch (err) {
      console.warn('[TTS] play error:', err.message);
    }
  }

  /**
   * Stop playback and cancel any in-progress synthesis.
   */
  stop() {
    window.lilAgents.ttsStreamStop();
    if (this.currentAudio) {
      try { this.currentAudio.stop(); } catch {}
      this.currentAudio = null;
    }
    this.queue = [];
    this.state = 'idle';
  }

  /**
   * Play next chunk from queue using Web Audio API
   * (AudioContext does not trigger Windows media overlay).
   */
  async _playNext() {
    if (this.queue.length === 0) {
      this.state = 'idle';
      this.currentAudio = null;
      return;
    }

    this.state = 'playing';
    const url = this.queue.shift();

    try {
      const ctx = this._getAudioCtx();

      // Convert data-URL to ArrayBuffer
      const resp = await fetch(url);
      const arrayBuf = await resp.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(arrayBuf);

      const source = ctx.createBufferSource();
      source.buffer = audioBuf;
      source.connect(ctx.destination);

      source.onended = () => {
        this.currentAudio = null;
        this._playNext();
      };

      this.currentAudio = source;
      source.start(0);
    } catch {
      this.currentAudio = null;
      this._playNext(); // Skip failed chunk, try next
    }
  }
}
