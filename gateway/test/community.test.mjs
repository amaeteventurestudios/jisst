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

test('a status reaches your chats for 24 hours, and you see who has seen it', async () => {
  const { ada, tunde, kofi } = ppl;
  const dm = await ada.openDirect('@tunde:jisste.com');
  await until(() => tunde.room(dm));
  await ada.postStatus({ text: 'Race night!', bg: '#0f7b5f' });
  const st = await until(() => tunde.statuses().find((x) => x.user === '@ada:jisste.com' && x.items.length));
  assert.equal(st.items[0].text, 'Race night!'); assert.equal(st.items[0].bg, '#0f7b5f'); assert.equal(st.unseen, 1);
  assert.ok(!tunde.rooms().some((r) => r.id === st.roomId), 'a status is not a chat');
  assert.equal(kofi.statuses().filter((x) => !x.mine).length, 0, 'only your chats see it');
  await assert.rejects(tunde.send(st.roomId, 'reply in the status room'));
  tunde.seeStatus(st.roomId, st.items[0].id);
  assert.equal(tunde.statuses().find((x) => x.user === '@ada:jisste.com').unseen, 0);
  await until(() => ada.statuses()[0].items[0]?.seenBy.length === 1);
  assert.equal(ada.statuses()[0].mine, true);
});
