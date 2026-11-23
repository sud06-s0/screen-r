// src/recorder.js
// Capture + encoding. All work is done by the browser's native MediaRecorder,
// so it runs fine on PCs without a dedicated GPU.

export const PRESETS = {
  light:    { w: 1280, h: 720,  fps: 24, vbr: 3_000_000, codec: 'vp8'  },
  balanced: { w: 1920, h: 1080, fps: 30, vbr: 6_000_000, codec: 'auto' },
  high:     { w: 1920, h: 1080, fps: 60, vbr: 9_000_000, codec: 'auto' }
};

// Ordered by preference. H.264 first: integrated GPUs (Intel Quick Sync, AMD VCE)
// encode it in hardware. VP8 is the cheapest software codec, used for "light".
const MIME_LISTS = {
  vp8: ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm'],
  auto: [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,opus',
    'video/mp4',
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ]
};

export const isSupported = () =>
  !!(navigator.mediaDevices?.getDisplayMedia && window.MediaRecorder);

/**
 * Picks the codec that puts the least load on this PC.
 * 1. Any supported format the browser says it can encode "power-efficiently"
 *    (= hardware encoder on the integrated/dedicated GPU) wins.
 * 2. Otherwise Light uses VP8 (cheapest software codec), others the first supported.
 */
async function pickMime(preset) {
  const supported = MIME_LISTS.auto.filter(m => MediaRecorder.isTypeSupported(m));

  if (navigator.mediaCapabilities?.encodingInfo) {
    for (const m of supported) {
      if (!m.includes('codecs=')) continue;
      try {
        const info = await navigator.mediaCapabilities.encodingInfo({
          type: 'record',
          video: {
            contentType: m.replace(/,(opus|mp4a\.40\.2)$/, ''),
            width: preset.w, height: preset.h,
            bitrate: preset.vbr, framerate: preset.fps
          }
        });
        if (info.supported && info.powerEfficient) return { mime: m, hardware: true };
      } catch { /* not answerable for this type; try the next */ }
    }
  }

  const fallback = preset.codec === 'vp8'
    ? MIME_LISTS.vp8.find(m => MediaRecorder.isTypeSupported(m))
    : supported[0];
  return { mime: fallback || '', hardware: false };
}

export class ScreenRecorder {
  constructor({ onData, onStop, onWarn } = {}) {
    this.onData = onData || (() => {});
    this.onStop = onStop || (() => {});
    this.onWarn = onWarn || (() => {});
    this.display = null;
    this.mic = null;
    this.audioCtx = null;
    this.recorder = null;
    this.chunks = [];
    this.bytes = 0;
    this.mime = '';
    this.lastSettings = null;
    this.hardware = false;
  }

  get state() { return this.recorder ? this.recorder.state : 'inactive'; }

  get videoSettings() {
    const live = this.display?.getVideoTracks()[0]?.getSettings();
    if (live) this.lastSettings = live;
    return live || this.lastSettings || {};
  }

  /** Opens the picker and starts recording. Throws on cancel/failure. */
  async start({ source, preset, systemAudio, microphone, onPickerShown }) {
    const p = PRESETS[preset];

    const request = withAudio => navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: source,
        width: { ideal: p.w },
        height: { ideal: p.h },
        frameRate: { ideal: p.fps, max: p.fps }
      },
      audio: withAudio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: withAudio ? 'include' : 'exclude'
    });

    // The picker must be requested synchronously inside the click (browsers require
    // a fresh user gesture). Anything else that needs the gesture runs right after.
    const picking = request(systemAudio);
    try { onPickerShown?.(); } catch { /* optional extra, never blocks recording */ }

    let audioFellBack = false;
    try {
      this.display = await picking;
    } catch (e) {
      audioFellBack = true;
      // Some PCs fail to open the system audio device; record video-only rather than nothing.
      // (A gesture/permission error can't be retried: the click is used up.)
      if (!systemAudio || e.name === 'NotAllowedError' || e.name === 'InvalidStateError') throw e;
      this.display = await request(false);
      this.onWarn("System sound couldn't be captured on this PC, so recording continues without it.");
    }

    if (microphone) {
      try {
        this.mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
      } catch {
        this.onWarn('Microphone was blocked, so recording continues without it.');
      }
    }

    if (systemAudio && !audioFellBack && !this.display.getAudioTracks().length) {
      this.onWarn('No system sound was shared. Tick "Share audio" in the picker next time if you need it.');
    }

    const stream = new MediaStream([...this.display.getVideoTracks(), ...this.#mixAudio()]);
    const hasAudio = stream.getAudioTracks().length > 0;

    // Tell the encoder what it's encoding: screen text stays sharp ('detail');
    // 60fps favours smooth movement ('motion').
    const vTrack = this.display.getVideoTracks()[0];
    if ('contentHint' in vTrack) vTrack.contentHint = p.fps >= 60 ? 'motion' : 'detail';

    const { mime: wanted, hardware } = await pickMime(p);
    this.hardware = hardware;
    this.preset = p;
    this.stream = stream;
    this.chunks = [];
    this.bytes = 0;
    this.finished = false;
    this.fellBack = false;

    try {
      // Don't name an audio codec when there's no audio track: some browsers
      // (Firefox) refuse to encode on a codec/track mismatch.
      this.#startRecorder(hasAudio ? wanted : videoOnly(wanted));
    } catch (e) {
      this.#release();
      throw e;
    }

    // User pressed the browser's own "Stop sharing" bar.
    vTrack.addEventListener('ended', () => this.stop());

    return this.display;
  }

  pause()  { if (this.state === 'recording') this.recorder.pause(); }
  resume() { if (this.state === 'paused') this.recorder.resume(); }

  /** Always ends the session, even if the encoder already died. */
  stop() {
    if (this.finished) return;
    if (this.state !== 'inactive') {
      this.recorder.stop();
      // Safety net: if the browser never fires 'stop', save what we have.
      clearTimeout(this.stopTimer);
      this.stopTimer = setTimeout(() => this.#finish(), 4000);
    } else {
      this.#finish();
    }
  }

  #startRecorder(mime) {
    const rec = new MediaRecorder(this.stream, {
      ...(mime && { mimeType: mime }),
      videoBitsPerSecond: this.preset.vbr,
      audioBitsPerSecond: 128_000
    });
    this.recorder = rec;
    this.mime = rec.mimeType || mime || 'video/webm';

    rec.ondataavailable = e => {
      if (rec !== this.recorder || !e.data?.size) return;
      this.chunks.push(e.data);
      this.bytes += e.data.size;
      this.onData(this.bytes);
    };
    rec.onstop = () => { if (rec === this.recorder) this.#finish(); };
    rec.onerror = e => this.#onEncoderError(rec, e.error || e);

    rec.start(1000);
  }

  /** Encoder crashed (common with some hardware encoders). Recover instead of hanging. */
  #onEncoderError(rec, err) {
    if (rec !== this.recorder || this.finished) return;
    const reason = err?.message || err?.name || 'encoder error';

    // Nothing recorded yet: silently switch to the safe software codec and carry on.
    if (this.bytes === 0 && !this.fellBack) {
      this.fellBack = true;
      this.hardware = false;
      const hasAudio = this.stream.getAudioTracks().length > 0;
      const safe = MIME_LISTS.vp8.find(m => MediaRecorder.isTypeSupported(m)) || '';
      try {
        this.#startRecorder(hasAudio ? safe : videoOnly(safe));
        this.onWarn('Hardware encoder failed, so it switched to the safe encoder and is still recording.');
        return;
      } catch { /* fall through and save what we have */ }
    }

    this.onWarn(`Recording stopped unexpectedly (${reason}). Saving what was captured.`);
    this.#finish();
  }

  /** Returns one audio track: system, mic, or both mixed. */
  #mixAudio() {
    const sources = [this.display, this.mic].filter(s => s?.getAudioTracks().length);
    if (sources.length === 0) return [];
    if (sources.length === 1) return [sources[0].getAudioTracks()[0]];

    this.audioCtx = new AudioContext();
    const dest = this.audioCtx.createMediaStreamDestination();
    sources.forEach(s => this.audioCtx.createMediaStreamSource(s).connect(dest));
    return dest.stream.getAudioTracks();
  }

  #release() {
    [this.display, this.mic].forEach(s => s?.getTracks().forEach(t => t.stop()));
    this.audioCtx?.close().catch(() => {});
    this.display = this.mic = this.audioCtx = this.stream = null;
  }

  #finish() {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.stopTimer);
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch { /* already dead */ }
    }
    this.recorder = null;
    this.#release();
    const blob = new Blob(this.chunks, { type: this.mime });
    this.chunks = [];
    const ext = this.mime.includes('mp4') ? 'mp4' : 'webm';
    this.onStop({ blob, ext, mime: this.mime });
  }
}

function videoOnly(mime) {
  return (mime || '').replace(/,\s*(opus|mp4a\.40\.2)$/, '');
}
