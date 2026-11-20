// src/utils.js

export function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return [s / 3600, (s % 3600) / 60, s % 60]
    .map(n => String(Math.floor(n)).padStart(2, '0'))
    .join(':');
}

export function fmtSize(b) {
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

export function codecLabel(mime) {
  if (/avc1|h264/i.test(mime)) return 'H.264';
  if (/vp9/i.test(mime)) return 'VP9';
  if (/vp8/i.test(mime)) return 'VP8';
  return mime.includes('mp4') ? 'MP4' : 'WebM';
}

export function fileName(ext) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `recording-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${ext}`;
}
