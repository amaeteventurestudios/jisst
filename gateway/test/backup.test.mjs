// Chat backup: a recovery key lets a new phone read old private messages; a wrong key is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeHomeserver } from '../../tools/fake-hs.mjs';
import { matrixEngine } from '../../app/js/matrix.js';
import { encodeRecoveryKey, decodeRecoveryKey } from '../../app/js/crypto.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await wait(100); } }
const nodeCrypto = () => import('../../app/vendor/matrix-crypto/node.mjs');

let hs; const open = [];
const post = (p, b) => fetch(hs.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
async function phone(name, register) {
  if (register) await post('/_matrix/client/v3/register', { username: name, password: 'pw', auth: { type: 'm.login.registration_token', token: 'tok' } });
  const login = await post('/_matrix/client/v3/login', { type: 'm.login.password', identifier: { type: 'm.id.user', user: name }, password: 'pw' });
  const e = matrixEngine({ homeserver: hs.url, ...login }, { cryptoLoad: nodeCrypto, cryptoStore: false }).start();
  open.push(e); await until(() => e.ready());
  return e;
}
test.before(async () => { hs = await fakeHomeserver({ regToken: 'tok' }); });
test.after(() => { for (const e of open) e.stop(); hs.close(); });

test('the recovery key is written the standard way and checks its own letters', () => {
  const k = Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '');
  const text = encodeRecoveryKey(k);
  assert.match(text, /^E[sS]\w{2}( \w{4}){11}$/);
  assert.equal(decodeRecoveryKey(text), k);
  assert.throws(() => decodeRecoveryKey(text.slice(0, -1) + (text.endsWith('a') ? 'b' : 'a')));
});

test('a new phone reads old private messages after the recovery key is entered', async () => {
  const ada = await phone('ada', true), tunde = await phone('tunde', true);
  assert.equal(await ada.backup(), 'off');
  const key = await ada.makeRecovery();
  assert.equal(await ada.backup(), 'on');
  const roomId = await ada.openDirect('@tunde:jisste.com');
  await until(() => tunde.room(roomId) && ada.room(roomId)?.members.length === 2);
  await ada.send(roomId, 'Meet at the Lagos track at 6');
  await until(() => tunde.timeline(roomId).some((m) => m.text === 'Meet at the Lagos track at 6'));
  await tunde.send(roomId, 'See you there');
  await until(() => ada.timeline(roomId).some((m) => m.text === 'See you there'));
  await wait(1500);   // the backup catches up with the newest keys

  const again = await phone('ada');
  await until(() => again.room(roomId));
  assert.ok(again.timeline(roomId).some((m) => m.waiting), 'a new phone cannot read old messages yet');
  assert.equal(await again.backup(), 'locked');
  await assert.rejects(again.restore('EsTc 1234'));
  const n = await again.restore(key);
  assert.ok(n >= 2, `restored ${n} keys`);
  await until(() => again.timeline(roomId).some((m) => m.text === 'Meet at the Lagos track at 6') && again.timeline(roomId).some((m) => m.text === 'See you there'));
  assert.equal(await again.backup(), 'on');
});
