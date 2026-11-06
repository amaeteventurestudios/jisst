// Jisste on one computer, for building and testing: the app, the gateway and a stand-in chat server behind one address,
// laid out like the real server (Caddy sends /api and /_matrix/push to the gateway, the rest of /_matrix to the chat server).
// npm run dev  ->  http://localhost:8310 (sign in with any name: the test sign-in is on)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeHomeserver } from './fake-hs.mjs';
import { gateway } from '../gateway/server.mjs';
import { config } from '../gateway/lib/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const PORT = +(process.env.PORT || 8310), GW = PORT + 1;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm' };

const hs = await fakeHomeserver({ regToken: 'dev-token' });
const cfg = config({ ...process.env, JISST_DATA: process.env.JISST_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'jisst-dev-')), JISST_PORT: String(GW),
  JISST_PUBLIC_URL: `http://localhost:${PORT}`, JISST_HS_URL: hs.url, JISST_REGISTRATION_TOKEN: 'dev-token', JISST_DEV_SIGNIN: '1', JISST_INSECURE_COOKIES: '1' });
const gw = gateway(cfg).start();

function pass(req, res, target) {
  const u = new URL(req.url, target);
  const p = http.request(u, { method: req.method, headers: { ...req.headers, host: u.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  p.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(p);
}
http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.startsWith('/api/') || p.startsWith('/_matrix/push/')) return pass(req, res, `http://127.0.0.1:${GW}`);
  if (p.startsWith('/_matrix/')) return pass(req, res, hs.url);
  let f = path.join(root, p.endsWith('/') ? p + 'index.html' : p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`Jisste dev on http://localhost:${PORT}  (demo: /?demo)`));
process.on('SIGINT', () => { gw.stop(); hs.close(); process.exit(0); });
