/**
 * Voice Input - Microphone recording + ASR transcription
 * Uses MediaRecorder -> raw WebM -> backend ffmpeg + Qwen3-ASR
 * States: idle -> recording -> transcribing -> idle
 */

// VAD end-of-speech thresholds (front-end only).
// Browser's autoGainControl amplifies background noise, so a fixed floor
// (like Python's 0.015) is unreliable. We sample the first CALIBRATION window
// as ambient noise, then require RMS > max(ABS_MIN, baseline * MULT) to count
// as speech.
const VAD_TICK_MS = 50;
const VAD_CALIBRATION_MS = 500;
const VAD_SPEECH_MULT = 2.5;       // rms must exceed baseline * 2.5 to count as speech
const VAD_ABS_MIN = 0.012;         // absolute floor regardless of baseline
const VAD_SILENCE_MS = 1200;       // continuous silence to call "done"
const VAD_MIN_RECORD_MS = 1000;    // protect against false trigger on short utterances
const VAD_NO_SPEECH_MS = 3000;     // give up if user never spoke
const MAX_RECORD_MS_VAD = 30000;   // auto-end mode hard cap
const MAX_RECORD_MS_MANUAL = 60000; // wakeword / legacy path cap
const VAD_DEBUG = true;            // log every 10 ticks (~500ms) to tune thresholds

class VoiceInput {
  constructor(micBtn, inputField, onError) {
    this.micBtn = micBtn;
    this.inputField = inputField;
    this.onError = onError || (() => {});
    this.state = 'idle';
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.stream = null;
    this.maxDurationTimer = null;
    this._busy = false;

    // VAD end-of-speech detection state
    this.vadTimer = null;
    this.audioContext = null;
    this.analyser = null;
    this._vadBuffer = null;
    this._vadStartTime = 0;
    this._vadSilenceMs = 0;
    this._vadHadSpeech = false;
    this._vadBaseline = 0;
    this._vadThreshold = 0;
    this._vadTickCount = 0;

    this.micBtn.addEventListener('click', () => this.toggle());
  }

  async toggle() {
    if (this._busy) return;
    if (this.state === 'idle') await this.startRecording({ autoEnd: true });
    else if (this.state === 'recording') this.stopRecording();
  }

  async startFromWakeword() {
    if (this.state !== 'idle') return;
    await this.startRecording({ autoEnd: true });
  }

  async startRecording({ autoEnd = false } = {}) {
    try {
      const status = await window.lilAgents.getASRStatus();
      if (!status.ready) {
        this.onError(status.status === 'loading' ? 'ASR model loading...' : 'ASR service not available');
        return;
      }
    } catch {
      this.onError('ASR service not available');
      return;
    }

    try {
      this._busy = true;
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      this.audioChunks = [];

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      this.mediaRecorder = new MediaRecorder(this.stream, { mimeType });
      this.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) this.audioChunks.push(e.data); };
      this.mediaRecorder.onstop = () => this._processAudio();
      this.mediaRecorder.onerror = (e) => { this.onError('Recording error: ' + (e.error?.message || 'unknown')); this.setState('idle'); };

      this.mediaRecorder.start(500);
      this.setState('recording');

      if (autoEnd) this._startVAD();

      const maxDuration = autoEnd ? MAX_RECORD_MS_VAD : MAX_RECORD_MS_MANUAL;
      this.maxDurationTimer = setTimeout(() => { if (this.state === 'recording') this.stopRecording(); }, maxDuration);
    } catch (err) {
      const msg = err.name === 'NotFoundError' ? 'No microphone detected'
        : err.name === 'NotAllowedError' ? 'Microphone permission denied'
        : 'Microphone error: ' + err.message;
      this.onError(msg);
    } finally {
      this._busy = false;
    }
  }

  stopRecording() {
    this._stopVAD();
    if (this.maxDurationTimer) { clearTimeout(this.maxDurationTimer); this.maxDurationTimer = null; }
    if (this.mediaRecorder?.state === 'recording') this.mediaRecorder.stop();
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
  }

  _startVAD() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx();
      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);
      this._vadBuffer = new Float32Array(this.analyser.fftSize);
    } catch (err) {
      console.warn('[VAD] Audio graph setup failed, falling back to manual stop:', err.message);
      this._stopVAD();
      return;
    }

    this._vadStartTime = Date.now();
    this._vadSilenceMs = 0;
    this._vadHadSpeech = false;
    this._vadBaseline = 0;
    this._vadThreshold = 0;
    this._vadTickCount = 0;
    let baselineSum = 0;
    let baselineCount = 0;

    this.vadTimer = setInterval(() => {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(this._vadBuffer);
      let sum = 0;
      for (let i = 0; i < this._vadBuffer.length; i++) {
        sum += this._vadBuffer[i] * this._vadBuffer[i];
      }
      const rms = Math.sqrt(sum / this._vadBuffer.length);
      const elapsed = Date.now() - this._vadStartTime;

      // Phase 1: calibrate ambient noise baseline
      if (elapsed < VAD_CALIBRATION_MS) {
        baselineSum += rms;
        baselineCount++;
        return;
      }
      if (this._vadThreshold === 0) {
        this._vadBaseline = baselineCount > 0 ? baselineSum / baselineCount : VAD_ABS_MIN;
        this._vadThreshold = Math.max(VAD_ABS_MIN, this._vadBaseline * VAD_SPEECH_MULT);
        console.log(`[VAD] Calibrated baseline=${this._vadBaseline.toFixed(4)} threshold=${this._vadThreshold.toFixed(4)}`);
      }

      // Phase 2: speech / silence tracking
      const isSpeech = rms > this._vadThreshold;
      if (isSpeech) {
        this._vadSilenceMs = 0;
        this._vadHadSpeech = true;
      } else {
        this._vadSilenceMs += VAD_TICK_MS;
      }

      if (VAD_DEBUG && ++this._vadTickCount % 10 === 0) {
        console.log(`[VAD] rms=${rms.toFixed(4)} thr=${this._vadThreshold.toFixed(4)} speech=${isSpeech} silenceMs=${this._vadSilenceMs} hadSpeech=${this._vadHadSpeech}`);
      }

      if (elapsed < VAD_MIN_RECORD_MS) return;

      if (!this._vadHadSpeech && elapsed >= VAD_NO_SPEECH_MS) {
        console.log('[VAD] No speech detected, aborting');
        this.stopRecording();
        return;
      }
      if (this._vadHadSpeech && this._vadSilenceMs >= VAD_SILENCE_MS) {
        console.log(`[VAD] End of speech after ${elapsed}ms (baseline=${this._vadBaseline.toFixed(4)}, threshold=${this._vadThreshold.toFixed(4)})`);
        this.stopRecording();
      }
    }, VAD_TICK_MS);
  }

  _stopVAD() {
    if (this.vadTimer) { clearInterval(this.vadTimer); this.vadTimer = null; }
    if (this.audioContext) {
      try { this.audioContext.close(); } catch {}
      this.audioContext = null;
    }
    this.analyser = null;
    this._vadBuffer = null;
  }

  async _processAudio() {
    this.setState('transcribing');
    try {
      const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
      console.log(`[VoiceInput] chunks=${this.audioChunks.length}, blobSize=${audioBlob.size}`);
      if (audioBlob.size < 100) { console.log('[VoiceInput] Blob too small, skipping'); this.onError('No speech detected'); this.setState('idle'); return; }

      const result = await window.lilAgents.transcribeAudio(await audioBlob.arrayBuffer());
      console.log('[VoiceInput] ASR result:', JSON.stringify(result));
      if (result.error) {
        this.onError(result.error);
      } else if (result.text?.trim()) {
        const existing = this.inputField.value;
        const text = result.text.trim();
        this.inputField.value = existing ? existing + ' ' + text : text;
        this.inputField.focus();
      } else {
        this.onError('No speech detected');
      }
    } catch (err) {
      this.onError('Transcription failed: ' + err.message);
    }
    this.setState('idle');
  }

  setState(state) {
    this.state = state;
    if (window.lilAgents.setVoiceActive) window.lilAgents.setVoiceActive(state !== 'idle');
    this.micBtn.classList.remove('recording', 'transcribing');
    if (state === 'recording') { this.micBtn.classList.add('recording'); this.micBtn.title = 'Click to stop recording'; }
    else if (state === 'transcribing') { this.micBtn.classList.add('transcribing'); this.micBtn.title = 'Transcribing...'; }
    else { this.micBtn.title = 'Voice input'; }
  }
}
