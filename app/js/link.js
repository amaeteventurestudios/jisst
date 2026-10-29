// Link a computer by QR code. The computer draws a QR code (qrcode-generator, MIT); the phone that is signed in reads it with
// its camera (the browser's own BarcodeDetector where there is one, jsQR, Apache 2.0, everywhere else) and approves it.
// Both scripts live in app/vendor/qr and only load when someone links a computer.
const loaded = new Map();
function script(src) {
  if (!loaded.has(src)) loaded.set(src, new Promise((ok, no) => {
    const s = document.createElement('script'); s.src = new URL(src, import.meta.url).href; s.onload = ok; s.onerror = () => no(new Error("The QR code tools didn't load. Check your connection."));
    document.head.append(s);
  }));
  return loaded.get(src);
}

/** An SVG QR code for some text, drawn in the page's ink colour on a light square so phones read it in dark mode too. */
export async function qrSvg(text) {
  await script('../vendor/qr/qrcode.js');
  const q = window.qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), pad = 3, size = n + pad * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + pad} ${r + pad}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#15131f"/></svg>`;
}

/** Read the link code out of what a QR code says (a jisste address with #link=..., or the bare code). */
export function linkCode(text) {
  const m = /[#&?]link=([\w-]+)/.exec(String(text || ''));
  return m ? m[1] : /^[\w-]{16,40}$/.test(String(text).trim()) ? String(text).trim() : null;
}

/** Start the camera in a <video> and call found(code) once a link QR code is in view. Returns stop(). */
export async function scan(video, found) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  video.srcObject = stream; video.setAttribute('playsinline', ''); await video.play();
  let stopped = false, detector = null;
  try { if ('BarcodeDetector' in window && (await window.BarcodeDetector.getSupportedFormats()).includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch {}
  if (!detector) await script('../vendor/qr/jsQR.min.js');
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  const stop = () => { stopped = true; for (const t of stream.getTracks()) t.stop(); };
  (async function look() {
    while (!stopped) {
      await new Promise((r) => setTimeout(r, 180));
      if (stopped || video.readyState < 2) continue;
      let text = null;
      try {
        if (detector) text = (await detector.detect(video))[0]?.rawValue || null;
        else {
          const w = Math.min(640, video.videoWidth), h = Math.round(video.videoHeight * (w / video.videoWidth));
          canvas.width = w; canvas.height = h; ctx.drawImage(video, 0, 0, w, h);
          text = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data || null;
        }
      } catch {}
      const code = linkCode(text);
      if (code) { stop(); found(code); return; }
    }
  })();
  return stop;
}
