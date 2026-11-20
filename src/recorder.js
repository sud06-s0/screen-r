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
  async start({ source, preset, systemAudio, microphone }) {
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

    let audioFellBack = false;
    try {
      this.display = await request(systemAudio);
    } catch (e) {
      audioFellBack = true;
      // Some PCs fail to open the system audio device; record video-only rather than nothing.
      if (!systemAudio || e.name === 'NotAllowedError') throw e;
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

    // Tell the encoder what it's encoding: screen text stays sharp ('detail');
    // 60fps favours smooth movement ('motion').
    const vTrack = this.display.getVideoTracks()[0];
    if ('contentHint' in vTrack) vTrack.contentHint = p.fps >= 60 ? 'motion' : 'detail';

    const { mime: wanted, hardware } = await pickMime(p);
    this.hardware = hardware;
    try {
      this.recorder = new MediaRecorder(stream, {
        ...(wanted && { mimeType: wanted }),
        videoBitsPerSecond: p.vbr,
        audioBitsPerSecond: 128_000
      });
    } catch (e) {
      this.#release();
      throw e;
    }
    this.mime = this.recorder.mimeType || wanted || 'video/webm';

    this.chunks = [];
    this.bytes = 0;
    this.recorder.ondataavailable = e => {
      if (e.data?.size) {
        this.chunks.push(e.data);
        this.bytes += e.data.size;
        this.onData(this.bytes);
      }
    };
    this.recorder.onstop = () => this.#finish();

    // User pressed the browser's own "Stop sharing" bar.
    this.display.getVideoTracks()[0].addEventListener('ended', () => this.stop());

    this.recorder.start(1000);
    return this.display;
  }

  pause()  { if (this.state === 'recording') this.recorder.pause(); }
  resume() { if (this.state === 'paused') this.recorder.resume(); }
  stop()   { if (this.state !== 'inactive') this.recorder.stop(); }

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
    this.display = this.mic = this.audioCtx = null;
  }

  #finish() {
    this.#release();
    const blob = new Blob(this.chunks, { type: this.mime });
    this.chunks = [];
    const ext = this.mime.includes('mp4') ? 'mp4' : 'webm';
    this.onStop({ blob, ext, mime: this.mime });
  }
}
