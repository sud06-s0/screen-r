<!-- README.md -->
# Darkroom — Screen Recorder

Record a **browser tab**, a **window** or your **entire screen**, straight from the browser. There is no backend, and nothing is uploaded.

## Features
- Tab / Window / Screen source hint (preselects the browser picker)
- Quality presets: **Light** (720p·24, VP8, for low-end PCs), **Smooth** (1080p·30), **Sharp** (1080p·60)
- System/tab audio, microphone, or both mixed
- Pause / resume, live timer and file size
- Preview, then download as MP4 (H.264) where supported, otherwise WebM

## Runs on PCs without a GPU
Encoding is done by the browser's native `MediaRecorder`. H.264 is preferred because integrated graphics (Intel Quick Sync, AMD VCE) encode it in hardware. On weak CPUs, use the **Light** preset.

## Develop
```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # outputs dist/
```

## Deploy (Vercel)
Import the repo in Vercel. The framework (Vite), build command and `dist` output are already set in `vercel.json`, which also sends a `Permissions-Policy` header allowing screen capture and microphone on this origin.

## Browser support
Desktop Chrome, Edge, Brave and Opera support everything. Firefox works but ignores the source hint. Safari supports it partly. Mobile browsers can't capture the screen. Full system audio is available on Windows and ChromeOS, and macOS shares tab audio only.
