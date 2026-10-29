// Private chats end to end: two people on the stand-in chat server, each with the app's own chat engine and the real
// encryption library. The server must only ever see locked messages; both phones must read them.
// node --test gateway/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeHomeserver } from '../../tools/fake-hs.mjs';
import { matrixEngine } from '../../app/js/matrix.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await wait(100); } }
const nodeCrypto = () => import('../../app/vendor/matrix-crypto/node.mjs');

let hs; const people = {};
async function person(name) {
  const post = (p, b) => fetch(hs.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  await post('/_matrix/client/v3/register', { username: name, password: 'pw', auth: { type: 'm.login.registration_token', token: 'tok' } });
  const login = await post('/_matrix/client/v3/login', { type: 'm.login.password', identifier: { type: 'm.id.user', user: name }, password: 'pw' });
  const e = matrixEngine({ homeserver: hs.url, ...login }, { agents: new Map([['@bot:jisst.app', { id: 'bot' }]]), cryptoLoad: nodeCrypto, cryptoStore: false }).start();
  await until(() => e.ready());
  return e;
}
test.before(async () => { hs = await fakeHomeserver({ regToken: 'tok' }); people.ada = await person('ada'); people.tunde = await person('tunde'); });
test.after(() => { people.ada?.stop(); people.tunde?.stop(); hs.close(); });

test('a chat between two people is private, and both of them read it', async () => {
  const { ada, tunde } = people;
  const roomId = await ada.openDirect('@tunde:jisst.app');
  await until(() => tunde.room(roomId) && ada.room(roomId)?.members.length === 2);
  assert.equal(ada.room(roomId).encrypted, true);
  await ada.send(roomId, 'Did you race the Daily?');
  const got = await until(() => tunde.timeline(roomId).find((m) => m.text === 'Did you race the Daily?'));
  assert.equal(got.private, true);
  await tunde.send(roomId, 'Lagos at lunch!');
  await until(() => ada.timeline(roomId).find((m) => m.text === 'Lagos at lunch!'));
  // the server only holds locked messages
  const stored = hs.rooms.get(roomId).events.filter((e) => e.sender !== undefined && ['m.room.message', 'm.room.encrypted'].includes(e.type));
  assert.ok(stored.length >= 2);
  assert.ok(stored.every((e) => e.type === 'm.room.encrypted' && !JSON.stringify(e.content).includes('Lagos')));
});

test('reactions work in a private chat, and a second tap takes them back', async () => {
  const { ada, tunde } = people;
  const roomId = ada.rooms().find((r) => r.dm).id;
  const msg = tunde.timeline(roomId).find((m) => m.text === 'Did you race the Daily?');
  await tunde.react(roomId, msg.id, '🔥');
  await until(() => ada.timeline(roomId).find((m) => m.id === msg.id)?.reactions.some((x) => x.key === '🔥' && x.count === 1));
  await tunde.react(roomId, msg.id, '🔥');
  await until(() => !ada.timeline(roomId).find((m) => m.id === msg.id)?.reactions.length);
});

test('a photo in a private chat is locked on the server and opens on the other phone', async () => {
  const { ada, tunde } = people;
  const roomId = ada.rooms().find((r) => r.dm).id;
  const bytes = new TextEncoder().encode('pretend this is a photo of jollof');
  await ada.sendFile(roomId, new File([bytes], 'jollof.jpg', { type: 'image/jpeg' }), 'image', { w: 10, h: 10 });
  const pic = await until(() => tunde.timeline(roomId).find((m) => m.kind === 'image' && !m.mine));
  for (const f of hs.rooms.get(roomId).events) assert.ok(!JSON.stringify(f.content).includes('jollof.jpg'));
  const url = await tunde.media(pic.url);
  const back = await (await fetch(url)).text();
  assert.equal(back, 'pretend this is a photo of jollof');
});

test('a chat with an agent is not private, and agents cannot join a private group', async () => {
  const { ada } = people;
  hs.users.set('@bot:jisst.app', { pw: 'x', name: 'Bot' });
  const roomId = await ada.openDirect('@bot:jisst.app');
  await until(() => ada.room(roomId));
  assert.equal(ada.room(roomId).encrypted, false);
  const group = await ada.createGroup('Family', ['@tunde:jisst.app']);
  await until(() => ada.room(group)?.encrypted);
  await assert.rejects(ada.invite(group, '@bot:jisst.app'), /Agents can't join a private group/);
});
