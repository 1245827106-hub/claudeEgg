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
    this.currentAudio = null;
    this._setupListeners();
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
      this.currentAudio.pause();
      this.currentAudio.currentTime = 0;
      this.currentAudio = null;
    }
    this.queue = [];
    this.state = 'idle';
  }

  /**
   * Play next chunk from queue.
   */
  _playNext() {
    if (this.queue.length === 0) {
      this.state = 'idle';
      this.currentAudio = null;
      return;
    }

    this.state = 'playing';
    const url = this.queue.shift();
    this.currentAudio = new Audio(url);

    this.currentAudio.onended = () => {
      this.currentAudio = null;
      this._playNext(); // Play next sentence in queue
    };

    this.currentAudio.onerror = () => {
      this.currentAudio = null;
      this._playNext(); // Skip failed chunk, try next
    };

    this.currentAudio.play().catch(() => {
      this.currentAudio = null;
      this._playNext();
    });
  }
}
