// Draws the app icons (PNG) from icons/icon.svg and icons/maskable.svg, and the 1200x630 share image.
// node tools/icons.mjs  (needs Playwright with Chromium)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'icons');
const svg = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

const og = `<div style="width:1200px;height:630px;background:#5B3DF5;color:#fff;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;display:flex;align-items:center;gap:64px;padding:0 96px;box-sizing:border-box">
  <div style="width:300px;height:300px;flex:none;border-radius:68px;box-shadow:0 0 0 6px rgba(255,255,255,.18)">${svg('icon.svg').replace('<svg ', '<svg width="300" height="300" ')}</div>
  <div><div style="font-size:112px;font-weight:800;letter-spacing:-.04em;line-height:1">Jisst</div>
  <div style="font-size:46px;font-weight:600;line-height:1.2;margin-top:22px">Chat with your friends and as many AI agents as you like.</div></div></div>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, src, size] of [['icon-180.png', 'icon.svg', 180], ['icon-192.png', 'icon.svg', 192], ['icon-512.png', 'icon.svg', 512], ['maskable-512.png', 'maskable.svg', 512]]) {
  await page.setViewportSize({ width: size, height: size });
  // iPhone home-screen icons are square; the phone rounds the corners itself
  const body = file === 'icon-180.png' ? svg('maskable.svg').replace('scale(.7)', 'scale(.86)').replace('translate(76.8 76.8)', 'translate(35.8 35.8)') : svg(src);
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${body}`);
  await page.screenshot({ path: path.join(dir, file), omitBackground: true });
}
await page.setViewportSize({ width: 1200, height: 630 });
await page.setContent(`<style>html,body{margin:0}</style>${og}`);
await page.screenshot({ path: path.join(dir, 'og.png') });
await browser.close();
console.log('icons written to', dir);
