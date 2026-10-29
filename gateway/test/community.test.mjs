// Communities on the stand-in chat server: a space with an announcements channel only admins post in, groups inside it,
// and new members who join everything at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeHomeserver } from '../../tools/fake-hs.mjs';
import { matrixEngine } from '../../app/js/matrix.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await wait(100); } }
const nodeCrypto = () => import('../../app/vendor/matrix-crypto/node.mjs');

let hs; const ppl = {};
async function person(name) {
  const post = (p, b) => fetch(hs.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  await post('/_matrix/client/v3/register', { username: name, password: 'pw', auth: { type: 'm.login.registration_token', token: 'tok' } });
  const login = await post('/_matrix/client/v3/login', { type: 'm.login.password', identifier: { type: 'm.id.user', user: name }, password: 'pw' });
  const e = matrixEngine({ homeserver: hs.url, ...login }, { cryptoLoad: nodeCrypto, cryptoStore: false }).start();
  await until(() => e.ready());
  return e;
}
test.before(async () => { hs = await fakeHomeserver({ regToken: 'tok' }); for (const n of ['ada', 'tunde', 'kofi']) ppl[n] = await person(n); });
test.after(() => { for (const e of Object.values(ppl)) e.stop(); hs.close(); });

test('a community has announcements only admins post in, groups for everyone, and room for new people', async () => {
  const { ada, tunde, kofi } = ppl;
  const id = await ada.createCommunity('Lagos Racers', 'Weekend races', ['@tunde:jisste.com']);
  const c = await until(() => ada.community(id)?.announce && ada.community(id));
  assert.equal(c.name, 'Lagos Racers'); assert.equal(c.admin, true);
  assert.ok(!ada.rooms().some((r) => r.id === id), 'the community itself is not a chat');

  const seen = await until(() => tunde.community(id)?.announce && tunde.community(id));
  assert.equal(seen.admin, false); assert.equal(seen.about, 'Weekend races');
  const ann = await until(() => tunde.room(seen.announce));
  assert.equal(ann.announce, true); assert.equal(ann.canPost, false); assert.equal(ann.community.name, 'Lagos Racers');
  assert.equal(ada.room(c.announce).canPost, true);

  await ada.send(c.announce, 'Race night is Saturday at 8');
  await until(() => tunde.timeline(c.announce).some((m) => m.text === 'Race night is Saturday at 8'));
  await assert.rejects(tunde.send(c.announce, 'can I post?'));

  const g = await ada.addCommunityGroup(id, 'Saturday meetups');
  await until(() => tunde.community(id)?.groups.includes(g));
  assert.equal(tunde.room(g).community.name, 'Lagos Racers'); assert.equal(tunde.room(g).canPost, true);

  await ada.inviteToCommunity(id, '@kofi:jisste.com');
  const k = await until(() => { const x = kofi.community(id); return x?.announce && x.groups.includes(g) && x; });
  assert.equal(k.members, 3);
  assert.equal(kofi.communities().length, 1);
});
