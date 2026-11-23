// src/mini.js
// Floating mini controls (timer, Pause/Resume, Stop) usable while you work in other windows.
// Chrome/Edge: Document Picture-in-Picture window that stays on top of everything.
// Others (Firefox): a small popup window.

export const hasPiP = () => 'documentPictureInPicture' in window;

const CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{background:#0f1512;color:#e9e4d8;font-family:system-ui,sans-serif;
       display:flex;align-items:center;justify-content:center;overflow:hidden;user-select:none}
  .bar{display:flex;align-items:center;gap:10px;padding:10px 12px;width:100%}
  .dot{width:11px;height:11px;border-radius:50%;background:#ff4d3d;flex:none;
       box-shadow:0 0 10px 2px rgba(255,77,61,.55);animation:p 1.2s infinite}
  .paused .dot{background:#ffb238;animation:none;box-shadow:0 0 8px 2px rgba(255,178,56,.5)}
  @keyframes p{50%{opacity:.4}}
  .t{font:600 20px ui-monospace,"JetBrains Mono",Menlo,monospace;color:#ff4d3d;flex:1;letter-spacing:.02em}
  .paused .t{color:#ffb238}
  button{font:600 13px system-ui,sans-serif;border-radius:999px;padding:8px 14px;cursor:pointer;
         border:1px solid #26322c;background:transparent;color:#e9e4d8}
  button:hover{border-color:#3d4d44}
  .st{background:#ff4d3d;border-color:#ff4d3d;color:#fff}
`;

/**
 * Opens the floating controls. Must be called from a click (needs user activation).
 * Returns { update(mode, timeText), close() } or throws if the browser refuses.
 */
export async function openMini({ onToggle, onStop, onClosed }) {
  let win;
  if (hasPiP()) {
    win = await window.documentPictureInPicture.requestWindow({ width: 300, height: 64 });
  } else {
    win = window.open('', 'darkroom-controls', 'popup,width=320,height=90');
    if (!win) throw new Error('Popup blocked');
  }

  const d = win.document;
  d.title = 'Darkroom — recording';
  d.head.innerHTML = '';
  const style = d.createElement('style');
  style.textContent = CSS;
  d.head.append(style);
  d.body.innerHTML =
    '<div class="bar"><span class="dot"></span><span class="t">00:00:00</span>' +
    '<button class="pz" type="button">Pause</button>' +
    '<button class="st" type="button">Stop</button></div>';

  const bar = d.querySelector('.bar');
  const time = d.querySelector('.t');
  const pz = d.querySelector('.pz');
  pz.addEventListener('click', onToggle);
  d.querySelector('.st').addEventListener('click', onStop);

  let closedByApp = false;
  win.addEventListener('pagehide', () => { if (!closedByApp) onClosed(); });

  return {
    update(mode, timeText) {
      if (win.closed) return;
      bar.classList.toggle('paused', mode === 'paused');
      pz.textContent = mode === 'paused' ? 'Resume' : 'Pause';
      time.textContent = timeText;
    },
    close() {
      closedByApp = true;
      try { win.close(); } catch { /* already gone */ }
    }
  };
}
