// The Jisst gateway: the small piece we build ourselves so the open-source parts work as one app (the 20%).
// Plain Node 22, no dependencies. It sits behind Caddy next to the chat server (Tuwunel) and does what a chat server
// doesn't: Noveniqe sign-in, making chat accounts, Jisst's own agents, finding people, the feed, and phone alerts.
//
// Browser endpoints (same address as the app):
//   GET  /api/health                       is it up, and what is switched on
//   GET  /api/signin/ways                  { email, dev }
//   POST /api/signin/email/start {email}   Noveniqe Core emails a 6-digit code
//   POST /api/signin/email/verify {email, code}
//   POST /api/signin/profile {display_name, handle}   a new person's name and @handle
//   GET  /api/session                      a fresh chat sign-in for someone already signed in (cookie)
//   POST /api/signout
//   GET  /api/people?q=                    people on Jisst by name or @handle
//   GET  /api/agents                       the agents you can add
//   POST /api/dev/agents {name, about}     make your own agent; answers with its chat key, once
//   GET  /api/feed?space=                  the newest posts from the Jisst social network
//   GET  /api/push/key, POST /api/push/subscribe {subscription}    phone alerts (Web Push)
//   POST /api/calls/token {room, token}    a ticket to join the call in a chat (LiveKit), for members of that chat only
// Chat server endpoint:
//   POST /_matrix/push/v1/notify           the chat server tells us a message arrived; we send the phone alert
import http from 'node:http';
import crypto from 'node:crypto';
import { config } from './lib/config.mjs';
import { store } from './lib/store.mjs';
import { matrix } from './lib/matrix.mjs';
import { bots } from './lib/bots.mjs';
import { vapidKeys, send as pushSend } from './lib/webpush.mjs';
import { AGENTS, SOON } from '../app/agents/index.js';

/** A LiveKit access ticket (a JWT signed with the call server's secret): this person may join this chat's call. */
export function callTicket({ key, secret }, room, identity, name, now = Date.now()) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const t = Math.floor(now / 1000);
  const head = part({ alg: 'HS256', typ: 'JWT' });
  const claims = part({ iss: key, sub: identity, name, nbf: t - 10, exp: t + 6 * 3600,
    video: { room: 'r' + crypto.createHash('sha256').update(room).digest('hex').slice(0, 32), roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true } });
  return `${head}.${claims}.${crypto.createHmac('sha256', secret).update(`${head}.${claims}`).digest('base64url')}`;
}

export function gateway(cfg = config()) {
  const db = store(cfg.dir), mx = matrix(cfg), vapid = vapidKeys(cfg.dir);
  const log = (...a) => console.log(new Date().toISOString(), ...a);

  // ---------- helpers ----------
  const json = (res, code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
  const fail = (res, code, message, extra = {}) => json(res, code, { error: { message, ...extra } });
  const body = (req) => new Promise((ok, no) => { let n = 0; const parts = []; req.on('data', (c) => { n += c.length; if (n > 64 * 1024) { no(new Error('too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts)) : {}); } catch { ok({}); } }); req.on('error', no); });
  const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((s) => { const i = s.indexOf('='); return i < 0 ? ['', ''] : [s.slice(0, i).trim(), decodeURIComponent(s.slice(i + 1))]; }));
  const sign = (obj) => { const p = Buffer.from(JSON.stringify(obj)).toString('base64url'); return p + '.' + crypto.createHmac('sha256', cfg.key).update(p).digest('base64url'); };
  const unsign = (v) => { const [p, s] = String(v || '').split('.'); if (!p || !s) return null;
    const want = crypto.createHmac('sha256', cfg.key).update(p).digest('base64url'); if (s.length !== want.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want))) return null;
    try { const o = JSON.parse(Buffer.from(p, 'base64url')); return o.exp > Date.now() ? o : null; } catch { return null; } };
  const cookie = (name, val, maxAge) => `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cfg.secureCookies ? '; Secure' : ''}`;
  const who = (req) => unsign(cookies(req)['jisst.sid']);
  const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const hits = new Map();
  const limited = (k, n, ms) => { const now = Date.now(), h = (hits.get(k) || []).filter((t) => now - t < ms); h.push(now); hits.set(k, h); return h.length > n; };
  setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (!h.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

  async function fetchJson(url) {
    if (url.startsWith(`http://127.0.0.1:${cfg.port}/api/feed`)) return feed(new URL(url).searchParams.get('space') || '');
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`${url} ${r.status}`);
    return r.json();
  }

  // ---------- Noveniqe Core (one account for every Noveniqe game) ----------
  const coreAuth = 'Basic ' + Buffer.from(`${cfg.core.id}:${cfg.core.secret}`).toString('base64');
  async function core(route, b) {
    try {
      const r = await fetch(cfg.core.url + route, { method: 'POST', headers: { authorization: coreAuth, 'content-type': 'application/json' }, body: JSON.stringify(b), signal: AbortSignal.timeout(15000) });
      let j = {}; try { j = await r.json(); } catch {}
      return { status: r.status, body: j };
    } catch { return { status: 502, body: { error: { message: 'Sign-in is not available right now. Please try again soon.' } } }; }
  }
  let ways = { at: 0, email: false };
  async function signinWays() {
    if (cfg.core.secret && Date.now() - ways.at > 60000) {
      try { const h = await (await fetch(cfg.core.url + '/health', { signal: AbortSignal.timeout(3000) })).json(); ways = { at: Date.now(), email: !!h.email }; }
      catch { ways = { ...ways, at: Date.now() - 50000 }; }
    }
    return { email: !!cfg.core.secret && ways.email, dev: cfg.devSignin };
  }

  /** Signed in at Core: make or find the person's chat account and hand the app its chat sign-in. */
  async function finish(res, user) {
    const localpart = 'u' + String(user.id).toLowerCase();
    const s = await mx.ensure(localpart, 'Jisst app');
    const name = String(user.display_name || user.handle || 'Jisst user').slice(0, 60);
    await mx.setName(s.access_token, s.user_id, name).catch(() => {});
    db.put('people', user.id, { id: user.id, mxid: s.user_id, name, handle: String(user.handle || '').toLowerCase(), joined: db.get('people', user.id)?.joined || Date.now() });
    const sid = sign({ u: user.id, exp: Date.now() + 180 * 86400e3 });
    json(res, 200, { me: { id: user.id, name, handle: user.handle || '' }, chat: { user_id: s.user_id, access_token: s.access_token, device_id: s.device_id, homeserver: cfg.publicUrl } },
      { 'set-cookie': [cookie('jisst.sid', sid, 180 * 86400), cookie('jisst.t', '', 0)] });
  }
  async function afterCore(res, r) {
    if (r.status !== 200) return json(res, r.status, r.body);
    if (r.body.needs_profile) return json(res, 200, { needs_profile: true, suggest: r.body.user?.display_name || '' }, { 'set-cookie': cookie('jisst.t', sign({ t: r.body.ticket, exp: Date.now() + 25 * 60e3 }), 1500) });
    return finish(res, r.body.user);
  }

  // ---------- the feed: the Jisst social network ----------
  let spaces = { at: 0, map: new Map() }, feedCache = { at: 0, items: [] };
  async function feed(space) {
    if (!cfg.feedUrl) return { items: [], on: false };
    if (Date.now() - spaces.at > 600e3) {
      try { const j = await (await fetch(cfg.feedUrl + '/api/v1/subpals', { signal: AbortSignal.timeout(8000) })).json();
        spaces = { at: Date.now(), map: new Map((j.data || []).map((s) => [s.id, { slug: s.slug, name: s.name, icon: s.icon || '' }])) }; } catch { spaces.at = Date.now() - 540e3; }
    }
    if (Date.now() - feedCache.at > 60e3) {
      try { const j = await (await fetch(cfg.feedUrl + '/api/v1/feed?mode=new&limit=40', { signal: AbortSignal.timeout(8000) })).json();
        feedCache = { at: Date.now(), items: (j.data || []).map((p) => { const sp = spaces.map.get(p.community_id);
          return { id: p.id, title: p.headline, text: p.lede || '', at: p.published_at || p.first_published_at, space: sp?.name || '', slug: sp?.slug || '', icon: sp?.icon || '',
            agent: !!p.author_agent_id, votes: p.up_votes ?? p.counts?.votes ?? 0, replies: (p.counts?.human_comments || 0) + (p.counts?.ai_contributions || 0), url: `${cfg.feedUrl}/posts/${p.slug}` }; }) }; }
      catch { feedCache.at = Date.now() - 45e3; }
    }
    return { on: true, site: cfg.feedUrl, items: space ? feedCache.items.filter((i) => i.slug === space) : feedCache.items };
  }

  // ---------- agents you can add ----------
  const B = bots(cfg, mx, db, { fetchJson, log });
  const agentList = () => ({
    agents: AGENTS.map((a) => ({ id: a.id, name: a.name, about: a.about, glyph: a.glyph, color: a.color, kind: a.kind, commands: a.commands, mxid: B.who(a.id) })),
    soon: SOON,
    community: db.all('devagents').filter((d) => d.public).map((d) => ({ id: d.id, name: d.name, about: d.about, glyph: d.name.slice(0, 2).toUpperCase(), color: '#3D4B66', kind: `Made by @${d.ownerHandle || 'someone'}`, mxid: d.mxid })),
  });

  // ---------- routes ----------
  async function route(req, res) {
    const u = new URL(req.url, 'http://x'), p = u.pathname, ip = ipOf(req);
    if (p === '/api/health') return json(res, 200, { ok: true, chat: (await mx.call('GET', '/_matrix/client/versions').catch(() => ({ status: 0 }))).status === 200, ways: await signinWays(), feed: !!cfg.feedUrl, push: true, calls: !!cfg.livekit.secret });
    if (p === '/api/signin/ways') return json(res, 200, await signinWays());
    if (req.method === 'POST' && p.startsWith('/api/signin/')) {
      if (limited('signin:' + ip, 40, 600e3)) return fail(res, 429, 'Too many tries. Please wait a few minutes.');
      const b = await body(req);
      if (p === '/api/signin/email/start') return (async (r) => json(res, r.status, r.body))(await core('/v1/signin/email/start', { email: String(b.email || '').slice(0, 200), ip }));
      if (p === '/api/signin/email/verify') return afterCore(res, await core('/v1/signin/email/verify', { email: String(b.email || '').slice(0, 200), code: String(b.code || '').slice(0, 12), ip }));
      if (p === '/api/signin/profile') {
        const t = unsign(cookies(req)['jisst.t']);
        if (!t) return fail(res, 400, 'That sign-in expired. Please start again.');
        return afterCore(res, await core('/v1/signin/profile', { ticket: t.t, display_name: String(b.display_name || '').slice(0, 60), handle: String(b.handle || '').slice(0, 30) }));
      }
      if (p === '/api/signin/dev' && cfg.devSignin) {
        const name = String(b.name || 'Tester').slice(0, 40), id = crypto.createHash('sha256').update(name).digest('hex').slice(0, 15).replace(/[^a-z0-9]/g, 'a');
        return finish(res, { id, display_name: name, handle: name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) });
      }
      return fail(res, 404, 'No such sign-in step');
    }
    if (p === '/api/session') {
      const s = who(req), person = s && db.get('people', s.u);
      if (!person) return json(res, 200, { me: null });               // not signed in: a plain answer, so the browser logs no error
      return finish(res, { id: person.id, display_name: person.name, handle: person.handle });
    }
    if (p === '/api/signout' && req.method === 'POST') return json(res, 200, { ok: true }, { 'set-cookie': cookie('jisst.sid', '', 0) });
    if (p === '/api/people') {
      const s = who(req); if (!s) return fail(res, 401, 'Please sign in.');
      const q = String(u.searchParams.get('q') || '').toLowerCase().replace(/^@/, '').trim();
      if (q.length < 2) return json(res, 200, { people: [] });
      const out = db.all('people').filter((x) => x.id !== s.u && (x.handle.startsWith(q) || x.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || x.name.toLowerCase().startsWith(q)))
        .slice(0, 20).map((x) => ({ mxid: x.mxid, name: x.name, handle: x.handle }));
      return json(res, 200, { people: out });
    }
    if (p === '/api/agents') return json(res, 200, agentList());
    if (p === '/api/dev/agents' && req.method === 'POST') {
      const s = who(req), me = s && db.get('people', s.u); if (!me) return fail(res, 401, 'Please sign in.');
      const b = await body(req), name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (name.length < 2) return fail(res, 400, 'Give your agent a name.');
      if (db.all('devagents').filter((d) => d.owner === me.id).length >= 10) return fail(res, 400, 'You can make up to 10 agents for now.');
      const slug = 'a_' + (name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'agent') + '_' + crypto.randomBytes(2).toString('hex');
      const acct = await mx.ensure(slug, 'Agent key');
      await mx.setName(acct.access_token, acct.user_id, name).catch(() => {});
      const rec = db.put('devagents', slug, { id: slug, mxid: acct.user_id, name, about: String(b.about || '').slice(0, 300), owner: me.id, ownerHandle: me.handle, public: !!b.public, made: Date.now() });
      return json(res, 200, { agent: rec, key: acct.access_token, homeserver: cfg.publicUrl, note: 'Keep this key secret. It signs your agent in to Jisst through the Matrix client API. It is shown once.' });
    }
    if (p === '/api/feed') return json(res, 200, await feed(String(u.searchParams.get('space') || '').slice(0, 40)));
    if (p === '/api/push/key') return json(res, 200, { key: vapid.publicKey });
    if (p === '/api/calls/token' && req.method === 'POST') {
      if (!cfg.livekit.secret) return fail(res, 503, "Calls aren't switched on on this server yet.");
      if (limited('call:' + ipOf(req), 60, 600_000)) return fail(res, 429, 'Too many tries. Please wait a few minutes.');
      // the app shows its own chat sign-in; the chat server says who that is and whether they're in the chat
      const b = await body(req), room = String(b.room || ''), token = String(b.token || '');
      const asUser = (path) => fetch(cfg.hs + path, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const whoami = await asUser('/_matrix/client/v3/account/whoami');
      if (!whoami?.user_id) return fail(res, 401, 'Please sign in again.');
      const joined = await asUser(`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/joined_members`);
      if (!joined?.joined?.[whoami.user_id]) return fail(res, 403, "You're not in this chat.");
      const name = joined.joined[whoami.user_id].display_name || whoami.user_id;
      return json(res, 200, { url: cfg.livekit.url, token: callTicket(cfg.livekit, room, whoami.user_id, name) });
    }
    if (p === '/api/push/subscribe' && req.method === 'POST') {
      const s = who(req); if (!s) return fail(res, 401, 'Please sign in.');
      const b = await body(req), sub = b.subscription;
      if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return fail(res, 400, 'Not a push subscription.');
      // a random key per subscription: only the chat server learns it, so no one else can send alerts to it
      const pushkey = db.all('push').find((x) => x.sub.endpoint === sub.endpoint && x.user === s.u)?.pushkey || crypto.randomBytes(24).toString('base64url');
      db.put('push', pushkey, { pushkey, user: s.u, sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, at: Date.now() });
      return json(res, 200, { pushkey, app_id: 'app.jisst.web', url: cfg.publicUrl + '/_matrix/push/v1/notify' });
    }
    if (p === '/_matrix/push/v1/notify' && req.method === 'POST') {
      const n = (await body(req)).notification || {}, rejected = [];
      for (const d of n.devices || []) {
        const rec = db.get('push', d.pushkey);
        if (!rec) { rejected.push(d.pushkey); continue; }
        const text = n.content?.['io.jisst.text'] || n.content?.body || (n.type === 'm.room.member' ? 'invited you to a chat' : 'New message');
        const st = await pushSend(rec.sub, { title: n.room_name || n.sender_display_name || 'Jisst', body: (n.room_name && n.sender_display_name ? n.sender_display_name + ': ' : '') + String(text).slice(0, 180), room: n.room_id, unread: n.counts?.unread || 0 }, vapid).catch(() => 0);
        if (st === 404 || st === 410) { db.del('push', d.pushkey); rejected.push(d.pushkey); }
      }
      return json(res, 200, { rejected });
    }
    return fail(res, 404, 'Not found');
  }

  const server = http.createServer((req, res) => route(req, res).catch((e) => { log('error', req.url, e.message); if (!res.headersSent) fail(res, 500, 'Something went wrong. Please try again.'); }));
  return { server, start() { server.listen(cfg.port, '127.0.0.1', () => log(`Jisst gateway on 127.0.0.1:${cfg.port}`)); B.start(); return this; }, stop() { B.stop(); server.close(); }, bots: B, db };
}

if (import.meta.url === `file://${process.argv[1]}`) gateway().start();
