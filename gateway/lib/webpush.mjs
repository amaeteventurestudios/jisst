// Phone alerts without a paid service: the Web Push standard (RFC 8291 message encryption, RFC 8292 VAPID), built on
// Node's own crypto. A browser or installed Jisst app gives us a subscription (an address at its maker's push service,
// plus two keys); we encrypt each alert for that subscription only and post it there. The push services are free.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** The server's own key pair, made once and kept in the data folder. */
export function vapidKeys(dir) {
  const f = path.join(dir, 'vapid.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  const ec = crypto.createECDH('prime256v1'); ec.generateKeys();
  const keys = { publicKey: b64u(ec.getPublicKey()), privateKey: b64u(ec.getPrivateKey()) };
  fs.writeFileSync(f, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

function signingKey(keys) {
  const pub = unb64u(keys.publicKey);
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
}

export function vapidHeader(endpoint, keys, subject = 'mailto:support@jisst.app', now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })), body = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: signingKey(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** Encrypt one message for one subscription (aes128gcm, a single record). */
export function encrypt(payload, sub, salt = crypto.randomBytes(16), server = null) {
  const ua = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const ec = server || crypto.createECDH('prime256v1'); if (!server) ec.generateKeys();
  const as = ec.getPublicKey(), shared = ec.computeSecret(ua);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), ua, as, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([as.length]), as, body]);
}

/** Send one alert. Returns the push service's status (201 sent; 404 or 410 means the subscription is gone). */
export async function send(sub, data, keys, ttl = 86400) {
  const r = await fetch(sub.endpoint, { method: 'POST', body: encrypt(JSON.stringify(data), sub),
    headers: { authorization: vapidHeader(sub.endpoint, keys), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: String(ttl), urgency: 'high' },
    signal: AbortSignal.timeout(10000) });
  return r.status;
}

/** The receiving side, as a browser does it. Used by the tests to prove the encryption is right. */
export function decrypt(buf, ua, auth) {
  const salt = buf.subarray(0, 16), idlen = buf[20], as = buf.subarray(21, 21 + idlen), ct = buf.subarray(21 + idlen);
  const shared = ua.computeSecret(as), uaPub = ua.getPublicKey();
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, as, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const out = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return out.subarray(0, out.lastIndexOf(2)).toString();
}
