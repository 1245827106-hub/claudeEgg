/**
 * Voice Input - Microphone recording + ASR transcription
 * Uses MediaRecorder -> raw WebM -> backend ffmpeg + Qwen3-ASR
 * States: idle -> recording -> transcribing -> idle
 */
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
    this.micBtn.addEventListener('click', () => this.toggle());
  }

  async toggle() {
    if (this._busy) return;
    if (this.state === 'idle') await this.startRecording();
    else if (this.state === 'recording') this.stopRecording();
  }

  async startFromWakeword() {
    if (this.state !== 'idle') return;
    await this.startRecording();
  }

  async startRecording() {
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
      this.maxDurationTimer = setTimeout(() => { if (this.state === 'recording') this.stopRecording(); }, 60000);
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
    if (this.maxDurationTimer) { clearTimeout(this.maxDurationTimer); this.maxDurationTimer = null; }
    if (this.mediaRecorder?.state === 'recording') this.mediaRecorder.stop();
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
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
