// The message features of a chat app, end to end in a private chat on the stand-in chat server: reply, edit, forward,
// star, polls, contact cards, places and documents. Both phones run the app's chat engine with the real encryption library.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeHomeserver } from '../../tools/fake-hs.mjs';
import { matrixEngine } from '../../app/js/matrix.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await wait(100); } }
const nodeCrypto = () => import('../../app/vendor/matrix-crypto/node.mjs');

let hs, ada, tunde, roomId;
async function person(name) {
  const post = (p, b) => fetch(hs.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  await post('/_matrix/client/v3/register', { username: name, password: 'pw', auth: { type: 'm.login.registration_token', token: 'tok' } });
  const login = await post('/_matrix/client/v3/login', { type: 'm.login.password', identifier: { type: 'm.id.user', user: name }, password: 'pw' });
  const e = matrixEngine({ homeserver: hs.url, ...login }, { cryptoLoad: nodeCrypto, cryptoStore: false }).start();
  await until(() => e.ready());
  return e;
}
test.before(async () => {
  hs = await fakeHomeserver({ regToken: 'tok' }); ada = await person('ada'); tunde = await person('tunde');
  roomId = await ada.openDirect('@tunde:jisste.com');
  await until(() => tunde.room(roomId) && ada.room(roomId)?.members.length === 2);
});
test.after(() => { ada?.stop(); tunde?.stop(); hs.close(); });
const theirs = (fn) => until(() => tunde.timeline(roomId).find(fn));

test('a reply quotes the message it answers, and an edit changes the text for everyone', async () => {
  await ada.send(roomId, 'Race at noon?');
  const q = await theirs((m) => m.text === 'Race at noon?');
  await tunde.send(roomId, 'Yes, Lagos', { replyTo: q.id });
  const r = await until(() => ada.timeline(roomId).find((m) => m.text === 'Yes, Lagos'));
  assert.equal(r.replyTo.id, q.id); assert.equal(r.replyTo.text, 'Race at noon?');
  const mine = ada.timeline(roomId).find((m) => m.text === 'Race at noon?');
  await ada.edit(roomId, mine.id, 'Race at one?');
  const edited = await theirs((m) => m.id === q.id && m.text === 'Race at one?');
  assert.equal(edited.edited, true);
  await assert.rejects(tunde.edit(roomId, q.id, 'hacked'));
});

test('polls count one vote per person, and a vote can move or be taken back', async () => {
  await ada.sendPoll(roomId, 'Where on Saturday?', ['Lagos', 'Kigali', 'Abuja']);
  const p = await theirs((m) => m.kind === 'poll');
  await tunde.vote(roomId, p.id, 1);
  await ada.vote(roomId, p.id, 1);
  await until(() => ada.timeline(roomId).find((m) => m.id === p.id)?.poll.options[1].count === 2);
  await tunde.vote(roomId, p.id, 2);
  const moved = await until(() => { const m = ada.timeline(roomId).find((x) => x.id === p.id); return m.poll.options[2].count === 1 && m.poll.options[1].count === 1 && m; });
  assert.equal(moved.poll.total, 2); assert.equal(moved.poll.mine, 1);
  assert.equal(moved.reactions.length, 0);   // votes never show as emoji reactions
  await ada.vote(roomId, p.id, 1);
  await until(() => tunde.timeline(roomId).find((m) => m.id === p.id)?.poll.total === 1);
});

test('contact cards, places and documents arrive as what they are', async () => {
  await ada.sendContact(roomId, { mxid: '@zainab:jisste.com', name: 'Zainab Musa' });
  await ada.sendLocation(roomId, { lat: 6.4541, lon: 3.3947, label: 'Tafawa Balewa Square' });
  await ada.sendFile(roomId, new File([new TextEncoder().encode('%PDF race plan')], 'race-plan.pdf', { type: 'application/pdf' }), 'file');
  const c = await theirs((m) => m.kind === 'contact'); assert.equal(c.contact.name, 'Zainab Musa');
  const l = await theirs((m) => m.kind === 'location'); assert.equal(l.location.lat, 6.4541); assert.equal(l.location.label, 'Tafawa Balewa Square');
  const f = await theirs((m) => m.kind === 'file'); assert.equal(f.file.name, 'race-plan.pdf');
  assert.equal(await (await fetch(await tunde.media(f.url))).text(), '%PDF race plan');
  for (const e of hs.rooms.get(roomId).events) assert.ok(!JSON.stringify(e.content).includes('Zainab'));
});

test('forwarding copies a message to another chat, marked as forwarded; stars follow the account', async () => {
  const group = await ada.createGroup('Race crew', ['@tunde:jisste.com']);
  await until(() => tunde.room(group));
  const src = ada.timeline(roomId).find((m) => m.kind === 'location');
  await ada.forward(group, roomId, src.id);
  const fw = await until(() => tunde.timeline(group).find((m) => m.kind === 'location'));
  assert.equal(fw.forwarded, true); assert.equal(fw.location.label, 'Tafawa Balewa Square');
  await tunde.star(group, fw.id, true);
  assert.equal(tunde.starred()[0].msg.id, fw.id);
  await until(() => tunde.timeline(group).find((m) => m.id === fw.id)?.starred);
  await tunde.star(group, fw.id, false);
  assert.equal(tunde.starred().length, 0);
});

test('mute, pin, archive, disappearing messages, block and report', async () => {
  await ada.mute(roomId, true); await ada.pin(roomId, true); await ada.archive(roomId, true);
  await until(() => { const r = ada.room(roomId); return r.muted && r.pinned != null && r.archived; });
  await ada.setDisappear(roomId, 3600);
  await until(() => tunde.room(roomId)?.disappear === 3600);
  await tunde.send(roomId, 'gone in an hour');
  const raw = hs.rooms.get(roomId).events.at(-1);
  assert.equal(raw.type, 'm.room.encrypted');   // the end time travels inside the locked message
  const m = await until(() => ada.timeline(roomId).find((x) => x.text === 'gone in an hour'));
  await ada.report(roomId, m.id, 'Spam');
  assert.equal(hs.reports.at(-1).reason, 'Spam');
  await ada.block('@tunde:jisste.com', true);
  assert.ok(!ada.timeline(roomId).some((x) => x.text === 'gone in an hour'));
  assert.equal(ada.room(roomId).blocked, true);
  await ada.block('@tunde:jisste.com', false);
  await ada.setDisappear(roomId, 0);
});
