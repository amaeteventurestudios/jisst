// End to end: the gateway against the stand-in chat server, with stand-ins for Agent Grand Prix and the Jisste feed.
// node --test gateway/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeHomeserver } from '../../tools/fake-hs.mjs';
import { gateway, callTicket } from '../server.mjs';
import { config } from '../lib/config.mjs';
import { encrypt, decrypt, vapidHeader, vapidKeys } from '../lib/webpush.mjs';

const listen = (handler) => new Promise((ok) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await wait(100); } }

let hs, agp, net, gw, base, dir;
test.before(async () => {
  hs = await fakeHomeserver({ regToken: 'tok' });
  agp = await listen((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/api/board/daily') return res.end(JSON.stringify({ day: +u.searchParams.get('day'), venue: { city: 'Lagos', flag: '🇳🇬' }, humans: 3, agents: 2,
      human: [{ place: 1, team: 'Harmattan Racing', pts: 25, best: 1, codes: ['KOR', 'SAH'] }, { place: 2, team: 'Lagoon Dynamics', pts: 18, best: 2, codes: ['ADE', 'MAR'] }] }));
    if (u.pathname === '/api/board/week') return res.end(JSON.stringify({ week: 1, from: 1, to: 7, done: false, humans: 1, human: [{ place: 1, team: 'Harmattan Racing', pts: 70, prize: 2500 }] }));
    res.statusCode = 404; res.end('{}');
  });
  net = await listen((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/v1/subpals')) return res.end(JSON.stringify({ data: [{ id: 'sp1aaaaaaaaaaaa', slug: 'grand-prix', name: 'Grand Prix', icon: '🏁' }] }));
    if (req.url.startsWith('/api/v1/feed')) return res.end(JSON.stringify({ data: [{ id: 'p1', slug: 'daily-1', headline: 'Daily Grand Prix #1 at Abuja: Harmattan top the board', lede: 'Harmattan won.', community_id: 'sp1aaaaaaaaaaaa', author_agent_id: 'a1', published_at: '2026-10-28 10:00:00Z', up_votes: 4, counts: { human_comments: 1, ai_contributions: 2 } }] }));
    res.statusCode = 404; res.end('{}');
  });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jisst-'));
  const cfg = config({ JISST_DATA: dir, JISST_PORT: '0', JISST_HS_URL: hs.url, JISST_REGISTRATION_TOKEN: 'tok', JISST_DEV_SIGNIN: '1', JISST_INSECURE_COOKIES: '1', JISST_AGP_URL: agp.url, JISST_FEED_URL: net.url, JISST_PUBLIC_URL: 'http://localhost', JISST_LIVEKIT_SECRET: 'call-secret' });
  gw = gateway(cfg);
  await new Promise((ok) => gw.server.listen(0, '127.0.0.1', ok));
  cfg.port = gw.server.address().port;
  base = `http://127.0.0.1:${cfg.port}`;
  gw.bots.start();
});
test.after(() => { gw.stop(); hs.close(); agp.s.close(); net.s.close(); });

const post = async (p, b, cookie) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json(), cookie: (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ') }; };
const mx = (who, method, p, b) => fetch(hs.url + p, { method, headers: { authorization: 'Bearer ' + who.chat.access_token, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
async function messagesFrom(who, roomId, sender) { const s = await mx(who, 'GET', '/_matrix/client/v3/sync'); return (s.rooms.join[roomId]?.timeline.events || []).filter((e) => e.type === 'm.room.message' && e.sender === sender); }

let ada, tunde;
test('signing in makes a chat account and a session', async () => {
  const r = await post('/api/signin/dev', { name: 'Ada Obi' });
  assert.equal(r.status, 200);
  assert.match(r.body.chat.user_id, /^@u[a-z0-9]+:jisste\.com$/);
  assert.ok(r.body.chat.access_token);
  ada = { ...r.body, cookie: r.cookie };
  const again = await fetch(base + '/api/session', { headers: { cookie: ada.cookie } }).then((x) => x.json());
  assert.equal(again.chat.user_id, ada.chat.user_id, 'the same person gets the same chat account');
  tunde = { ...(await post('/api/signin/dev', { name: 'Tunde Bakare' })).body };
  tunde.cookie = (await post('/api/signin/dev', { name: 'Tunde Bakare' })).cookie;
});

test('people are found by name or handle, never yourself', async () => {
  const r = await fetch(base + '/api/people?q=tun', { headers: { cookie: ada.cookie } }).then((x) => x.json());
  assert.deepEqual(r.people.map((p) => p.name), ['Tunde Bakare']);
  const none = await fetch(base + '/api/people?q=ada', { headers: { cookie: ada.cookie } }).then((x) => x.json());
  assert.equal(none.people.length, 0);
  assert.equal((await fetch(base + '/api/people?q=tun')).status, 401);
});

test('an agent joins a new chat, says hello and answers with a card', async () => {
  const list = await fetch(base + '/api/agents').then((x) => x.json());
  const gp = list.agents.find((a) => a.id === 'grandprix');
  await until(async () => (await fetch(base + '/api/agents').then((x) => x.json())).agents.find((a) => a.id === 'grandprix').mxid);
  const room = await mx(ada, 'POST', '/_matrix/client/v3/createRoom', { is_direct: true, invite: [gp.mxid], preset: 'trusted_private_chat' });
  const hello = await until(async () => (await messagesFrom(ada, room.room_id, gp.mxid))[0]);
  assert.match(hello.content.body, /Grand Prix desk/);
  assert.ok(hello.content['io.jisst.card'].buttons.length >= 3);
  await mx(ada, 'PUT', `/_matrix/client/v3/rooms/${room.room_id}/send/m.room.message/t1`, { msgtype: 'm.text', body: 'today' });
  const ans = await until(async () => (await messagesFrom(ada, room.room_id, gp.mxid))[1]);
  assert.match(ans.content['io.jisst.text'], /Harmattan Racing lead with 25 points/);
  assert.deepEqual(ans.content['io.jisst.card'].fields[0], ['1. Harmattan Racing', '25 pts · best P1']);
});

test('in a group an agent only answers when it is named', async () => {
  const gp = (await fetch(base + '/api/agents').then((x) => x.json())).agents.find((a) => a.id === 'grandprix');
  const room = await mx(ada, 'POST', '/_matrix/client/v3/createRoom', { name: 'Race crew', invite: [gp.mxid, tunde.chat.user_id] });
  await until(async () => hs.rooms.get(room.room_id).members.get(gp.mxid) === 'join');
  await mx(ada, 'PUT', `/_matrix/client/v3/rooms/${room.room_id}/send/m.room.message/g1`, { msgtype: 'm.text', body: 'who is racing today?' });
  await wait(800);
  assert.equal((await messagesFrom(ada, room.room_id, gp.mxid)).length, 0, 'not named, so quiet');
  await mx(ada, 'PUT', `/_matrix/client/v3/rooms/${room.room_id}/send/m.room.message/g2`, { msgtype: 'm.text', body: 'Grand Prix week' });
  const a = await until(async () => (await messagesFrom(ada, room.room_id, gp.mxid))[0]);
  assert.match(a.content['io.jisst.text'], /Week 1 league/);
});

test('reminders are stored and sent on time', async () => {
  const r = (await fetch(base + '/api/agents').then((x) => x.json())).agents.find((a) => a.id === 'reminders');
  const room = await mx(ada, 'POST', '/_matrix/client/v3/createRoom', { is_direct: true, invite: [r.mxid] });
  await until(async () => (await messagesFrom(ada, room.room_id, r.mxid))[0]);
  await mx(ada, 'PUT', `/_matrix/client/v3/rooms/${room.room_id}/send/m.room.message/r1`, { msgtype: 'm.text', body: 'remind me in 5 minutes to call Mum', 'io.jisst.tz': 60 });
  const ok = await until(async () => (await messagesFrom(ada, room.room_id, r.mxid))[1]);
  assert.match(ok.content['io.jisst.text'], /I'll remind you in 5 minutes \(\d\d:\d\d\): call Mum/);
  const rec = gw.db.all('reminders')[0];
  gw.db.put('reminders', rec.id, { ...rec, at: Date.now() - 1 });
  await gw.bots.tickReminders();
  const due = await until(async () => (await messagesFrom(ada, room.room_id, r.mxid))[2]);
  assert.equal(due.content.body, 'Reminder: call Mum');
  assert.equal(gw.db.all('reminders').length, 0);
});

test('the feed reads the Jisste social network', async () => {
  const f = await fetch(base + '/api/feed?space=grand-prix').then((x) => x.json());
  assert.equal(f.items.length, 1);
  assert.equal(f.items[0].space, 'Grand Prix');
  assert.equal(f.items[0].replies, 3);
  assert.equal((await fetch(base + '/api/feed?space=faliga').then((x) => x.json())).items.length, 0);
});

test('a developer can make their own agent and sign it in', async () => {
  const r = await post('/api/dev/agents', { name: 'Jollof Bot', about: 'Recipes', public: true }, ada.cookie);
  assert.equal(r.status, 200);
  const me = await fetch(hs.url + '/_matrix/client/v3/account/whoami', { headers: { authorization: 'Bearer ' + r.body.key } }).then((x) => x.json());
  assert.equal(me.user_id, r.body.agent.mxid);
  const list = await fetch(base + '/api/agents').then((x) => x.json());
  assert.ok(list.community.some((a) => a.name === 'Jollof Bot'));
});

test('phone alerts: subscribe, the chat server notifies, the alert is encrypted for that phone only', async () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  let got = null;
  const pushSvc = await listen(async (req, res) => { const c = []; for await (const d of req) c.push(d); got = { headers: req.headers, body: Buffer.concat(c) }; res.statusCode = 201; res.end(); });
  // a push service has to be https in real life; the test points the subscription at a local one
  const sub = { endpoint: pushSvc.url.replace('http:', 'https:') + '/push/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const r = await post('/api/push/subscribe', { subscription: sub }, ada.cookie);
  assert.equal(r.status, 200);
  const rec = gw.db.get('push', r.body.pushkey);
  rec.sub.endpoint = pushSvc.url + '/push/abc'; gw.db.put('push', rec.pushkey, rec);
  const n = await post('/_matrix/push/v1/notify', { notification: { room_id: '!r', sender_display_name: 'Tunde', content: { body: 'Are you coming?' }, devices: [{ pushkey: r.body.pushkey }, { pushkey: 'gone' }] } });
  assert.deepEqual(n.body.rejected, ['gone']);
  await until(() => got);
  assert.match(got.headers.authorization, /^vapid t=.+, k=/);
  assert.equal(got.headers['content-encoding'], 'aes128gcm');
  const data = JSON.parse(decrypt(got.body, ua, auth));
  assert.equal(data.body, 'Are you coming?');
  assert.equal(data.title, 'Tunde');
  pushSvc.s.close();
});

test('web push encryption round-trips and the VAPID signature verifies', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://push.example/x', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  assert.equal(decrypt(encrypt('hello phone', sub), ua, auth), 'hello phone');
  const keys = vapidKeys(dir), h = vapidHeader(sub.endpoint, keys), jwt = h.match(/t=([^,]+)/)[1], [hd, bd, sg] = jwt.split('.');
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${hd}.${bd}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sg, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(bd, 'base64url')).aud, 'https://push.example');
});

test('call tickets: only for people in the chat, signed for the call server', async () => {
  const room = await mx(ada, 'POST', '/_matrix/client/v3/createRoom', { name: 'Call test', invite: [] });
  const ok = await post('/api/calls/token', { room: room.room_id, token: ada.chat.access_token });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.url, 'ws://localhost/livekit');
  const [h, c, sig] = ok.body.token.split('.');
  assert.equal(crypto.createHmac('sha256', 'call-secret').update(`${h}.${c}`).digest('base64url'), sig);
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claims.sub, ada.chat.user_id);
  assert.equal(claims.video.roomJoin, true);
  assert.equal(claims.video.room, JSON.parse(Buffer.from(callTicket({ key: 'jisst', secret: 'x' }, room.room_id, 'a', 'b').split('.')[1], 'base64url').toString()).video.room);
  assert.equal((await post('/api/calls/token', { room: room.room_id, token: tunde.chat.access_token })).status, 403, 'not in the chat');
  assert.equal((await post('/api/calls/token', { room: room.room_id, token: 'nonsense' })).status, 401);
});

test('a computer links by QR code: the phone approves, the computer gets its own sign-in, and can be signed out', async () => {
  const start = await post('/api/link/start', { device: 'Chrome on Mac' });
  assert.equal(start.status, 200);
  assert.match(start.body.url, /#link=/); assert.match(start.body.short, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const { code, secret } = start.body;
  assert.equal((await post('/api/link/poll', { code, secret })).body.waiting, true);
  assert.equal((await post('/api/link/poll', { code, secret: 'guess' })).status, 404, 'only the computer that asked can collect');
  assert.equal((await post('/api/link/approve', { code })).status, 401, 'approving needs a signed-in phone');
  assert.equal((await post('/api/link/approve', { code: start.body.short.toLowerCase() }, ada.cookie)).status, 200, 'the short code works too');
  assert.equal((await post('/api/link/approve', { code }, ada.cookie)).status, 404, 'a code works once');
  const done = await post('/api/link/poll', { code, secret });
  assert.equal(done.status, 200);
  assert.equal(done.body.chat.user_id, ada.chat.user_id);
  assert.notEqual(done.body.chat.device_id, ada.chat.device_id);
  assert.ok(done.cookie, 'the computer gets its own session');
  const list = await mx(ada, 'GET', '/_matrix/client/v3/devices');
  assert.ok(list.devices.some((d) => d.display_name === 'Jisste on Chrome on Mac'));
  assert.equal((await post('/api/link/poll', { code, secret })).status, 404, 'and only once');

  assert.equal((await post('/api/devices/remove', { token: ada.chat.access_token, device_id: ada.chat.device_id }, ada.cookie)).status, 400);
  assert.equal((await post('/api/devices/remove', { token: ada.chat.access_token, device_id: done.body.chat.device_id }, ada.cookie)).status, 200);
  const whoami = await fetch(hs.url + '/_matrix/client/v3/account/whoami', { headers: { authorization: 'Bearer ' + done.body.chat.access_token } });
  assert.equal(whoami.status, 401, 'the computer is signed out of the chat');
});
