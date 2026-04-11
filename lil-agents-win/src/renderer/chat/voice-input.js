/**
 * Voice Input - Microphone recording + ASR transcription
 * Uses MediaRecorder -> raw WebM -> backend ffmpeg + Qwen3-ASR
 * States: idle -> recording -> transcribing -> idle
 *
 * Keeps a persistent audio stream to avoid Bluetooth reconnection issues.
 * Right-click the mic button to switch microphone device.
 */
class VoiceInput {
  constructor(micBtn, inputField, onError) {
    this.micBtn = micBtn;
    this.inputField = inputField;
    this.onError = onError || (() => {});
    this.state = 'idle';
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.stream = null;           // persistent stream — kept alive between recordings
    this.selectedDeviceId = null;  // remembered device
    this.maxDurationTimer = null;
    this.micBtn.addEventListener('click', () => this.toggle());
    this.micBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); this._pickDevice(); });
  }

  async toggle() {
    if (this.state === 'idle') await this.startRecording();
    else if (this.state === 'recording') this.stopRecording();
  }

  /** Ensure we have a live audio stream, reusing the existing one when possible. */
  async _ensureStream() {
    // Check if existing stream is still alive
    if (this.stream) {
      const track = this.stream.getAudioTracks()[0];
      if (track && track.readyState === 'live') return;
      // Dead track — clean up
      this.stream = null;
    }

    const constraints = {
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
    };
    if (this.selectedDeviceId) {
      constraints.audio.deviceId = { exact: this.selectedDeviceId };
    }

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
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
      await this._ensureStream();
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
      // If the remembered device is gone, fall back to default
      if (this.selectedDeviceId) {
        console.warn('[VoiceInput] Selected device unavailable, falling back to default');
        this.selectedDeviceId = null;
        this.stream = null;
        return this.startRecording();
      }
      const msg = err.name === 'NotFoundError' ? 'No microphone detected'
        : err.name === 'NotAllowedError' ? 'Microphone permission denied'
        : 'Microphone error: ' + err.message;
      this.onError(msg);
    }
  }

  stopRecording() {
    if (this.maxDurationTimer) { clearTimeout(this.maxDurationTimer); this.maxDurationTimer = null; }
    if (this.mediaRecorder?.state === 'recording') this.mediaRecorder.stop();
    // NOTE: stream is intentionally kept alive to avoid Bluetooth reconnection
  }

  async _processAudio() {
    this.setState('transcribing');
    try {
      const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
      if (audioBlob.size < 100) { this.onError('No speech detected'); this.setState('idle'); return; }

      const result = await window.lilAgents.transcribeAudio(await audioBlob.arrayBuffer());
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

  /** Right-click handler: let user pick a specific microphone. */
  async _pickDevice() {
    try {
      // Need a temporary stream to get permission for enumerateDevices labels
      await this._ensureStream();
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter(d => d.kind === 'audioinput');

      if (mics.length === 0) { this.onError('No microphone found'); return; }
      if (mics.length === 1) { this.onError('Only one microphone available'); return; }

      // Build a simple selection menu
      const currentId = this.selectedDeviceId || this.stream?.getAudioTracks()[0]?.getSettings()?.deviceId;
      const names = mics.map((d, i) => {
        const label = d.label || `Microphone ${i + 1}`;
        const marker = d.deviceId === currentId ? ' [current]' : '';
        return `${i + 1}. ${label}${marker}`;
      });

      const choice = prompt('Select microphone:\n' + names.join('\n') + '\n\nEnter number:');
      if (!choice) return;
      const idx = parseInt(choice, 10) - 1;
      if (idx < 0 || idx >= mics.length) return;

      this.selectedDeviceId = mics[idx].deviceId;
      // Release old stream so next recording uses the new device
      if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
      this.onError(`Switched to: ${mics[idx].label || `Microphone ${idx + 1}`}`);
    } catch (err) {
      this.onError('Device selection failed: ' + err.message);
    }
  }

  setState(state) {
    this.state = state;
    if (window.lilAgents.setVoiceActive) window.lilAgents.setVoiceActive(state !== 'idle');
    this.micBtn.classList.remove('recording', 'transcribing');
    if (state === 'recording') { this.micBtn.classList.add('recording'); this.micBtn.title = 'Click to stop recording'; }
    else if (state === 'transcribing') { this.micBtn.classList.add('transcribing'); this.micBtn.title = 'Transcribing...'; }
    else { this.micBtn.title = 'Voice input (right-click to switch mic)'; }
  }
}
