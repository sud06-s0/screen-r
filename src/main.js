// src/main.js
import './style.css';
import { ScreenRecorder, PRESETS, isSupported } from './recorder.js';
import { fmtTime, fmtSize, codecLabel, fileName } from './utils.js';

const $ = s => document.querySelector(s);

const els = {
  video: $('#video'), screen: $('#screen'), clock: $('#clock'), meta: $('#meta'),
  msg: $('#msg'), badge: $('#badge'),
  start: $('#startBtn'), pause: $('#pauseBtn'), stop: $('#stopBtn'),
  download: $('#downloadBtn'), newRec: $('#newBtn'),
  sysAudio: $('#sysAudio'), mic: $('#mic'), livePreview: $('#livePreview'),
  emptyTitle: $('#emptyTitle'), emptySub: $('#emptySub')
};

const IDLE_TEXT = { title: els.emptyTitle.textContent, sub: els.emptySub.textContent };
let liveStream = null;

const settings = { source: 'monitor', preset: 'balanced' };
let elapsed = 0, lastTick = 0, tickId = null, blobUrl = null;

const rec = new ScreenRecorder({
  onData: () => updateMeta(),
  onWarn: text => say(text, true),
  onStop: showResult
});

// ---------- UI helpers ----------
function say(text, isErr = false) {
  els.msg.textContent = text || '';
  els.msg.classList.toggle('err', isErr);
}

function bindSeg(selector, key) {
  const seg = $(selector);
  seg.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    seg.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    settings[key] = b.dataset.v;
  });
}

function setMode(mode) {
  const live = mode === 'rec' || mode === 'paused';
  document.body.classList.toggle('rec', mode === 'rec');
  document.body.classList.toggle('paused', mode === 'paused');
  els.start.hidden = mode !== 'idle';
  els.pause.hidden = !live;
  els.stop.hidden = !live;
  els.download.hidden = mode !== 'done';
  els.newRec.hidden = mode !== 'done';
  els.pause.querySelector('span').textContent = mode === 'paused' ? 'Resume' : 'Pause';
  els.badge.textContent = mode === 'paused' ? '❚❚ PAUSED' : '● REC';
  document.querySelectorAll('#settings button, #settings input')
    .forEach(el => { el.disabled = mode !== 'idle' && el !== els.livePreview; });
}

function setEmpty(title, sub) {
  els.emptyTitle.textContent = title;
  els.emptySub.textContent = sub;
}

/** Shows or hides the live preview while recording. Hidden = no redraw cost. */
function applyLivePreview() {
  const v = els.video;
  if (!liveStream) return;
  if (els.livePreview.checked) {
    v.srcObject = liveStream;
    v.muted = true;
    v.controls = false;
    v.play().catch(() => {});
    els.screen.classList.add('has-video');
  } else {
    v.pause();
    v.srcObject = null;
    els.screen.classList.remove('has-video');
    setEmpty('Recording…', 'Live preview is off to keep your PC light. Stop to save the file.');
  }
}

function tick() {
  const now = performance.now();
  if (rec.state === 'recording') elapsed += now - lastTick;
  lastTick = now;
  els.clock.textContent = fmtTime(elapsed);
}

function updateMeta(extra) {
  const p = PRESETS[settings.preset];
  const s = rec.videoSettings;
  const res = s.width ? `${s.width}×${s.height}` : `${p.w}×${p.h}`;
  const enc = rec.hardware ? 'GPU encode' : 'CPU encode';
  els.meta.innerHTML = `${res} · ${p.fps}fps · ${codecLabel(rec.mime)} · ${enc}<br>${fmtSize(rec.bytes)}${extra ? ' · ' + extra : ''}`;
}

// ---------- actions ----------
async function start() {
  say('');
  let display;
  try {
    display = await rec.start({
      source: settings.source,
      preset: settings.preset,
      systemAudio: els.sysAudio.checked,
      microphone: els.mic.checked
    });
  } catch (e) {
    if (e.name === 'NotAllowedError') say('Sharing was cancelled.');
    else say('Could not start recording: ' + e.message, true);
    return;
  }

  liveStream = display;
  applyLivePreview();

  elapsed = 0;
  lastTick = performance.now();
  tickId = setInterval(tick, 250);
  setMode('rec');
  updateMeta();
}

function togglePause() {
  tick();
  if (rec.state === 'recording') { rec.pause(); setMode('paused'); }
  else if (rec.state === 'paused') { rec.resume(); lastTick = performance.now(); setMode('rec'); }
}

function stop() {
  tick();
  rec.stop();
}

function showResult({ blob, ext }) {
  clearInterval(tickId);
  tickId = null;
  liveStream = null;

  if (!blob.size) {
    reset();
    say('Nothing was captured. Try the Light preset, or use Chrome/Edge.', true);
    return;
  }

  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = URL.createObjectURL(blob);

  els.download.href = blobUrl;
  els.download.download = fileName(ext);

  const v = els.video;
  v.srcObject = null;
  v.src = blobUrl;
  v.muted = false;
  v.controls = true;
  els.screen.classList.add('has-video');

  // WebM from MediaRecorder has no duration header; this nudge fixes the preview seek bar.
  if (ext === 'webm') {
    v.addEventListener('loadedmetadata', () => {
      if (v.duration !== Infinity) return;
      v.addEventListener('timeupdate', () => { v.currentTime = 0; }, { once: true });
      v.currentTime = 1e101;
    }, { once: true });
  }

  setMode('done');
  updateMeta(ext.toUpperCase());

  // Auto-save to the PC's Downloads folder. The button stays for a second copy.
  els.download.click();
  say(`Saved as ${els.download.download} in your Downloads folder.`);
}

function reset() {
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  els.video.removeAttribute('src');
  els.video.load();
  els.screen.classList.remove('has-video');
  setEmpty(IDLE_TEXT.title, IDLE_TEXT.sub);
  elapsed = 0;
  els.clock.textContent = '00:00:00';
  els.meta.textContent = 'idle';
  say('');
  setMode('idle');
}

// ---------- boot ----------
bindSeg('#sourceSeg', 'source');
bindSeg('#presetSeg', 'preset');

els.start.addEventListener('click', start);
els.pause.addEventListener('click', togglePause);
els.stop.addEventListener('click', stop);
els.newRec.addEventListener('click', reset);
els.livePreview.addEventListener('change', applyLivePreview);

window.addEventListener('beforeunload', e => {
  if (rec.state !== 'inactive') { e.preventDefault(); e.returnValue = ''; }
});

setMode('idle');

if (!isSupported()) {
  els.start.disabled = true;
  say(window.isSecureContext
    ? "This browser can't record the screen. Use Chrome, Edge or Firefox on a desktop."
    : 'Screen recording needs https:// or localhost.', true);
}
