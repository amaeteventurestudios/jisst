// Photo safety: a photo someone else sends stays blurred until a small model on this phone (NSFWJS, MIT, with TensorFlow.js,
// Apache 2.0, in app/vendor/nsfwjs) has looked at it. A photo that may be explicit stays hidden behind "Show photo".
// The check runs on the phone, so it works in private chats too and nothing leaves the phone. Switch: You > Blur explicit photos.
let ready = null;
const verdicts = new Map();   // photo address -> 'ok' | 'hide'
const LIMIT = 0.6;            // Porn + Hentai + Sexy above this hides the photo

function script(src) {
  return new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = new URL(src, import.meta.url).href; s.onload = ok; s.onerror = () => no(new Error('The photo check failed to load.'));
    document.head.append(s);
  });
}
function model() {
  // the model's two parts register themselves before the library, which then finds them without the internet
  ready ||= script('../vendor/nsfwjs/model.min.js').then(() => script('../vendor/nsfwjs/group1-shard1of1.min.js'))
    .then(() => script('../vendor/nsfwjs/nsfwjs.min.js')).then(() => window.nsfwjs.load('MobileNetV2'));
  return ready;
}

/** 'ok' or 'hide' for one loaded <img>. A photo that can't be checked is shown (the check is a help, not a wall). */
export async function judge(img, key) {
  if (verdicts.has(key)) return verdicts.get(key);
  try {
    const m = await model();
    if (!img.complete) await new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); });
    const p = await m.classify(img, 5);
    const risk = p.filter((x) => ['Porn', 'Hentai', 'Sexy'].includes(x.className)).reduce((a, x) => a + x.probability, 0);
    verdicts.set(key, risk > LIMIT ? 'hide' : 'ok');
  } catch { verdicts.set(key, 'ok'); }
  return verdicts.get(key);
}
export const known = (key) => verdicts.get(key);
