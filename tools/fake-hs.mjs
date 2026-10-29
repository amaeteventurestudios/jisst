// A stand-in chat server for tests and local runs. It speaks the part of the Matrix client-server API that Jisst uses
// (accounts with a registration token, sign-in, profiles, rooms, invites, messages, read receipts, typing, account data,
// media, pushers and sync), in memory. It is not a chat server: production uses Tuwunel (server/install.sh).
import http from 'node:http';
import crypto from 'node:crypto';

export function fakeHomeserver({ serverName = 'jisst.app', regToken = 'test-token', port = 0 } = {}) {
  const users = new Map(), tokens = new Map(), rooms = new Map(), account = new Map(), media = new Map(), pushers = new Map();
  const stream = []; let seq = 0; const waiters = new Set();
  const uid = (l) => `@${l}:${serverName}`;
  const bump = (entry) => { entry.seq = ++seq; stream.push(entry); for (const w of [...waiters]) w(); };
  const id = (p) => p + crypto.randomBytes(9).toString('base64url');
  const json = (res, code, b) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }); res.end(JSON.stringify(b)); };
  const err = (res, code, errcode, error) => json(res, code, { errcode, error });
  const read = (req) => new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); });

  function event(roomId, sender, type, content, stateKey) {
    const room = rooms.get(roomId);
    const ev = { event_id: id('$'), room_id: roomId, sender, type, content, origin_server_ts: Date.now(), ...(stateKey !== undefined ? { state_key: stateKey } : {}) };
    room.events.push(ev);
    if (stateKey !== undefined) room.state.set(type + '\u0000' + stateKey, ev);
    if (type === 'm.room.member') room.members.set(stateKey, content.membership);
    bump({ room: roomId, ev });
    if (type === 'm.room.message') notify(room, ev);
    return ev;
  }
  async function notify(room, ev) {
    for (const [member, m] of room.members) {
      if (m !== 'join' || member === ev.sender) continue;
      for (const p of pushers.get(member) || []) {
        fetch(p.data.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notification: {
          event_id: ev.event_id, room_id: room.id, type: ev.type, sender: ev.sender, sender_display_name: users.get(ev.sender)?.name, room_name: name(room), content: ev.content,
          counts: { unread: 1 }, devices: [{ app_id: p.app_id, pushkey: p.pushkey, data: p.data }] } }) }).catch(() => {});
      }
    }
  }
  const name = (room) => room.state.get('m.room.name\u0000')?.content?.name || '';
  const members = (room, m = 'join') => [...room.members].filter(([, v]) => v === m).map(([k]) => k);
  const summary = (room) => ({ 'm.joined_member_count': members(room).length, 'm.invited_member_count': members(room, 'invite').length, 'm.heroes': [...room.members.keys()].slice(0, 5) });

  function sync(user, since) {
    const out = { next_batch: 's' + seq, rooms: { join: {}, invite: {}, leave: {} }, account_data: { events: [...(account.get(user) || new Map())].map(([type, content]) => ({ type, content })) } };
    const s = since ? +String(since).slice(1) : null;
    if (s == null) {
      for (const room of rooms.values()) {
        const m = room.members.get(user);
        if (m === 'join') out.rooms.join[room.id] = { summary: summary(room), state: { events: [...room.state.values()] }, timeline: { events: room.events.filter((e) => e.state_key === undefined).slice(-30), limited: true, prev_batch: 'p0' },
          ephemeral: { events: [{ type: 'm.receipt', content: receiptContent(room) }] }, unread_notifications: { notification_count: 0 } };
        if (m === 'invite') out.rooms.invite[room.id] = { invite_state: { events: [...room.state.values()] } };
      }
      return out;
    }
    for (const e of stream) {
      if (e.seq <= s) continue;
      const room = rooms.get(e.room); if (!room) continue;
      const m = room.members.get(user);
      if (e.ev?.type === 'm.room.member' && e.ev.state_key === user && m === 'invite') { out.rooms.invite[room.id] = { invite_state: { events: [...room.state.values()] } }; continue; }
      if (e.ev?.type === 'm.room.member' && e.ev.state_key === user && m === 'leave') { out.rooms.leave[room.id] = { timeline: { events: [e.ev] } }; continue; }
      if (m !== 'join') continue;
      const j = out.rooms.join[room.id] ||= { summary: summary(room), state: { events: [] }, timeline: { events: [] }, ephemeral: { events: [] } };
      if (e.ev?.type === 'm.room.member' && e.ev.state_key === user && e.ev.content.membership === 'join') j.state.events = [...room.state.values()];
      if (e.ev) j.timeline.events.push(e.ev);
      if (e.receipt) j.ephemeral.events = [{ type: 'm.receipt', content: receiptContent(room) }];
      if (e.typing) j.ephemeral.events.push({ type: 'm.typing', content: { user_ids: [...room.typing].filter(([, t]) => t > Date.now()).map(([u]) => u) } });
    }
    return out;
  }
  function receiptContent(room) {
    const c = {};
    for (const [u, evId] of room.receipts) ((c[evId] ||= { 'm.read': {} })['m.read'][u] = { ts: Date.now() });
    return c;
  }

  async function route(req, res) {
    const u = new URL(req.url, 'http://x'), p = decodeURIComponent(u.pathname);
    if (req.method === 'OPTIONS') return json(res, 200, {});
    if (p === '/_matrix/client/versions') return json(res, 200, { versions: ['v1.11'] });
    const raw = await read(req); let b = {}; try { b = raw.length && !p.includes('/media/') ? JSON.parse(raw) : {}; } catch {}
    if (p === '/_matrix/client/v3/register') {
      if (!b.auth) return json(res, 401, { session: id('s'), flows: [{ stages: ['m.login.registration_token'] }], params: {} });
      if (b.auth.type !== 'm.login.registration_token' || b.auth.token !== regToken) return err(res, 401, 'M_FORBIDDEN', 'Bad token');
      if (users.has(uid(b.username))) return err(res, 400, 'M_USER_IN_USE', 'Taken');
      users.set(uid(b.username), { pw: b.password, name: b.username });
      return json(res, 200, { user_id: uid(b.username) });
    }
    if (p === '/_matrix/client/v3/login') {
      const user = uid(b.identifier?.user || ''), rec = users.get(user);
      if (!rec || rec.pw !== b.password) return err(res, 403, 'M_FORBIDDEN', 'Invalid password');
      const t = id('syt_'); tokens.set(t, user);
      return json(res, 200, { user_id: user, access_token: t, device_id: id('D') });
    }
    const me = tokens.get(String(req.headers.authorization || '').replace(/^Bearer /, '') || u.searchParams.get('access_token'));
    let m;
    if ((m = p.match(/^\/_matrix\/(?:client\/v1|media\/v3)\/media\/download\/([^/]+)\/([^/]+)/)) || (m = p.match(/^\/_matrix\/media\/v3\/download\/([^/]+)\/([^/]+)/))) {
      const f = media.get(m[2]); if (!f) return err(res, 404, 'M_NOT_FOUND', 'No media');
      res.writeHead(200, { 'content-type': f.type, 'access-control-allow-origin': '*' }); return res.end(f.data);
    }
    if (!me) return err(res, 401, 'M_MISSING_TOKEN', 'Sign in');
    if (p === '/_matrix/client/v3/account/whoami') return json(res, 200, { user_id: me });
    if (p === '/_matrix/client/v3/logout') { tokens.delete(String(req.headers.authorization).slice(7)); return json(res, 200, {}); }
    if ((m = p.match(/^\/_matrix\/client\/v3\/profile\/([^/]+)\/displayname$/))) {
      if (req.method === 'PUT') { users.get(me).name = b.displayname; for (const r of rooms.values()) if (r.members.get(me) === 'join') event(r.id, me, 'm.room.member', { membership: 'join', displayname: b.displayname }, me); return json(res, 200, {}); }
      return json(res, 200, { displayname: users.get(m[1])?.name });
    }
    if ((m = p.match(/^\/_matrix\/client\/v3\/profile\/([^/]+)$/))) return users.has(m[1]) ? json(res, 200, { displayname: users.get(m[1]).name }) : err(res, 404, 'M_NOT_FOUND', 'No user');
    if (p === '/_matrix/client/v3/createRoom') {
      const roomId = id('!') + ':' + serverName;
      rooms.set(roomId, { id: roomId, events: [], state: new Map(), members: new Map(), receipts: new Map(), typing: new Map() });
      event(roomId, me, 'm.room.create', { creator: me }, '');
      event(roomId, me, 'm.room.member', { membership: 'join', displayname: users.get(me).name }, me);
      if (b.name) event(roomId, me, 'm.room.name', { name: b.name }, '');
      for (const s of b.initial_state || []) event(roomId, me, s.type, s.content, s.state_key || '');
      for (const inv of b.invite || []) if (users.has(inv)) event(roomId, me, 'm.room.member', { membership: 'invite', is_direct: !!b.is_direct, displayname: users.get(inv).name }, inv);
      return json(res, 200, { room_id: roomId });
    }
    if ((m = p.match(/^\/_matrix\/client\/v3\/(?:join|rooms\/([^/]+)\/join)(?:\/([^/]+))?$/))) {
      const roomId = m[1] || m[2], room = rooms.get(roomId);
      if (!room || !['invite', 'join'].includes(room.members.get(me))) return err(res, 403, 'M_FORBIDDEN', 'Not invited');
      if (room.members.get(me) !== 'join') event(roomId, me, 'm.room.member', { membership: 'join', displayname: users.get(me).name }, me);
      return json(res, 200, { room_id: roomId });
    }
    if ((m = p.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/(\w+)(?:\/(.*))?$/))) {
      const [, roomId, verb, rest] = m, room = rooms.get(roomId);
      if (!room) return err(res, 404, 'M_NOT_FOUND', 'No room');
      const mine = room.members.get(me);
      if (verb === 'leave') { event(roomId, me, 'm.room.member', { membership: 'leave' }, me); return json(res, 200, {}); }
      if (mine !== 'join') return err(res, 403, 'M_FORBIDDEN', 'Not in room');
      if (verb === 'invite') { if (!users.has(b.user_id)) return err(res, 404, 'M_NOT_FOUND', 'No user'); event(roomId, me, 'm.room.member', { membership: 'invite', displayname: users.get(b.user_id).name }, b.user_id); return json(res, 200, {}); }
      if (verb === 'send') { const [type] = rest.split('/'); const ev = event(roomId, me, type, b); room.receipts.set(me, ev.event_id); return json(res, 200, { event_id: ev.event_id }); }
      if (verb === 'state') { const [type, key = ''] = rest.split('/'); const ev = event(roomId, me, type, b, key); return json(res, 200, { event_id: ev.event_id }); }
      if (verb === 'receipt') { room.receipts.set(me, rest.split('/').pop()); bump({ room: roomId, receipt: true }); return json(res, 200, {}); }
      if (verb === 'read_markers') { if (b['m.read']) { room.receipts.set(me, b['m.read']); bump({ room: roomId, receipt: true }); } return json(res, 200, {}); }
      if (verb === 'typing') { room.typing.set(me, b.typing ? Date.now() + (b.timeout || 5000) : 0); bump({ room: roomId, typing: true }); return json(res, 200, {}); }
      if (verb === 'messages') { const evs = room.events.filter((e) => e.state_key === undefined); const before = u.searchParams.get('from') === 'p0' ? Math.max(0, evs.length - 30) : evs.length; const lim = +u.searchParams.get('limit') || 30;
        return json(res, 200, { chunk: evs.slice(Math.max(0, before - lim), before).reverse(), end: before - lim > 0 ? 'p0' : undefined }); }
      if (verb === 'members') return json(res, 200, { chunk: [...room.state.values()].filter((e) => e.type === 'm.room.member') });
      return err(res, 404, 'M_UNRECOGNIZED', 'Unknown');
    }
    if ((m = p.match(/^\/_matrix\/client\/v3\/user\/([^/]+)\/account_data\/([^/]+)$/))) {
      const a = account.get(me) || new Map(); account.set(me, a);
      if (req.method === 'PUT') { a.set(m[2], b); bump({ account: me }); return json(res, 200, {}); }
      return a.has(m[2]) ? json(res, 200, a.get(m[2])) : err(res, 404, 'M_NOT_FOUND', 'None');
    }
    if (p === '/_matrix/client/v3/pushers/set') { const list = (pushers.get(me) || []).filter((x) => x.pushkey !== b.pushkey); if (b.kind) list.push(b); pushers.set(me, list); return json(res, 200, {}); }
    if (p === '/_matrix/media/v3/upload' || p === '/_matrix/client/v1/media/upload') { const mid = id(''); media.set(mid, { type: req.headers['content-type'] || 'application/octet-stream', data: raw }); return json(res, 200, { content_uri: `mxc://${serverName}/${mid}` }); }
    if (p === '/_matrix/client/v3/sync') {
      const since = u.searchParams.get('since'), timeout = Math.min(+u.searchParams.get('timeout') || 0, 30000);
      let out = sync(me, since);
      const empty = (o) => !Object.keys(o.rooms.join).length && !Object.keys(o.rooms.invite).length && !Object.keys(o.rooms.leave).length;
      if (since && empty(out) && timeout > 0) {
        await new Promise((ok) => { const t = setTimeout(done, timeout); function done() { clearTimeout(t); waiters.delete(done); ok(); } waiters.add(done); });
        out = sync(me, since);
      }
      return json(res, 200, out);
    }
    return err(res, 404, 'M_UNRECOGNIZED', 'Unknown endpoint ' + p);
  }
  const server = http.createServer((req, res) => route(req, res).catch((e) => err(res, 500, 'M_UNKNOWN', e.message)));
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}`, server, users, rooms, close: () => { for (const w of waiters) w(); server.close(); } })));
}

if (import.meta.url === `file://${process.argv[1]}`) fakeHomeserver({ port: +(process.env.PORT || 8008) }).then((h) => console.log('stand-in chat server on', h.url));
