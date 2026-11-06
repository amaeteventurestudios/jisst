// A stand-in chat server for tests and local runs. It speaks the part of the Matrix client-server API that Jisste uses
// (accounts with a registration token, sign-in, profiles, rooms, invites, messages, read receipts, typing, account data,
// media, pushers, sync, and the keys and to-device messages that private chats need), in memory. It is not a chat server: production uses Tuwunel (server/install.sh).
import http from 'node:http';
import crypto from 'node:crypto';

export function fakeHomeserver({ serverName = 'jisste.com', regToken = 'test-token', port = 0 } = {}) {
  const users = new Map(), tokens = new Map(), rooms = new Map(), account = new Map(), media = new Map(), pushers = new Map();
  const tags = new Map();         // user + room -> { tag: {order} }
  const reports = [];             // what people reported: { by, room, event, reason }
  const devices = new Map();      // user -> Map(device -> { keys, otks: Map(id -> key), fallback: Map(id -> key) })
  const deviceOf = new Map();     // access token -> device id
  const dev = (user, d) => { const m = devices.get(user) || new Map(); devices.set(user, m); if (!m.has(d)) m.set(d, { keys: null, otks: new Map(), fallback: new Map() }); return m.get(d); };
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

  function sync(user, since, device) {
    const out = { next_batch: 's' + seq, rooms: { join: {}, invite: {}, leave: {} }, account_data: { events: [...(account.get(user) || new Map())].map(([type, content]) => ({ type, content })) },
      to_device: { events: [] }, device_lists: { changed: [], left: [] }, presence: { events: presenceFor(user) } };
    const s = since ? +String(since).slice(1) : null;
    const d = devices.get(user)?.get(device);
    if (d) { out.device_one_time_keys_count = { signed_curve25519: d.otks.size }; out.device_unused_fallback_key_types = d.fallback.size ? ['signed_curve25519'] : []; }
    for (const e of stream) {
      if (s != null && e.seq <= s) continue;
      if (e.toDevice && e.toDevice.user === user && (e.toDevice.device === device || e.toDevice.device === '*')) out.to_device.events.push(e.toDevice.ev);
      if (s != null && e.keysChanged && !out.device_lists.changed.includes(e.keysChanged)) out.device_lists.changed.push(e.keysChanged);
    }
    if (s == null) {
      for (const room of rooms.values()) {
        const m = room.members.get(user);
        if (m === 'join') out.rooms.join[room.id] = { account_data: { events: [{ type: 'm.tag', content: { tags: tags.get(user + '\u0000' + room.id) || {} } }] }, summary: summary(room), state: { events: [...room.state.values()] }, timeline: { events: room.events.filter((e) => e.state_key === undefined).slice(-30), limited: true, prev_batch: 'p0' },
          ephemeral: { events: [{ type: 'm.receipt', content: receiptContent(room, user) }] }, unread_notifications: { notification_count: 0 } };
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
      if (e.receipt) j.ephemeral.events = [{ type: 'm.receipt', content: receiptContent(room, user) }];
      if (e.tags === user) j.account_data = { events: [{ type: 'm.tag', content: { tags: tags.get(user + '\u0000' + room.id) || {} } }] };
      if (e.typing) j.ephemeral.events.push({ type: 'm.typing', content: { user_ids: [...room.typing].filter(([, t]) => t > Date.now()).map(([u]) => u) } });
    }
    return out;
  }
  // read receipts: public ones for everyone, a private one (read ticks turned off) only for its owner
  function receiptContent(room, user) {
    const c = {};
    for (const [u, evId] of room.receipts) ((c[evId] ||= {})['m.read'] ||= {})[u] = { ts: Date.now() };
    const mine = room.priv?.get(user); if (mine) ((c[mine] ||= {})['m.read.private'] ||= {})[user] = { ts: Date.now() };
    return c;
  }
  // presence: when each person's app last synced, unless they asked to be shown offline
  const seen = new Map();   // user -> { at, hidden }
  const keyBackups = new Map();
  function presenceFor(user) {
    const near = new Set(); for (const room of rooms.values()) if (room.members.get(user) === 'join') for (const u of members(room)) if (u !== user) near.add(u);
    return [...near].filter((u) => seen.has(u)).map((u) => { const x = seen.get(u); return { type: 'm.presence', sender: u, content: x.hidden ? { presence: 'offline' } : { presence: Date.now() - x.at < 60e3 ? 'online' : 'offline', last_active_ago: Date.now() - x.at, currently_active: Date.now() - x.at < 60e3 } }; });
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
      const t = id('syt_'), d = b.device_id || id('D'); tokens.set(t, user); deviceOf.set(t, d); dev(user, d).name = b.initial_device_display_name || dev(user, d).name || ''; dev(user, d).seen = Date.now();
      return json(res, 200, { user_id: user, access_token: t, device_id: d });
    }
    const me = tokens.get(String(req.headers.authorization || '').replace(/^Bearer /, '') || u.searchParams.get('access_token'));
    let m;
    if ((m = p.match(/^\/_matrix\/(?:client\/v1|media\/v3)\/media\/download\/([^/]+)\/([^/]+)/)) || (m = p.match(/^\/_matrix\/media\/v3\/download\/([^/]+)\/([^/]+)/))) {
      const f = media.get(m[2]); if (!f) return err(res, 404, 'M_NOT_FOUND', 'No media');
      res.writeHead(200, { 'content-type': f.type, 'access-control-allow-origin': '*' }); return res.end(f.data);
    }
    if (!me) return err(res, 401, 'M_MISSING_TOKEN', 'Sign in');
    if (p === '/_matrix/client/v3/account/whoami') return json(res, 200, { user_id: me, device_id: deviceOf.get(String(req.headers.authorization || '').replace(/^Bearer /, '')) });
    if (p === '/_matrix/client/v3/logout') { tokens.delete(String(req.headers.authorization).slice(7)); return json(res, 200, {}); }
    if ((m = p.match(/^\/_matrix\/client\/v3\/profile\/([^/]+)\/displayname$/))) {
      if (req.method === 'PUT') { users.get(me).name = b.displayname; for (const r of rooms.values()) if (r.members.get(me) === 'join') event(r.id, me, 'm.room.member', { membership: 'join', displayname: b.displayname }, me); return json(res, 200, {}); }
      return json(res, 200, { displayname: users.get(m[1])?.name });
    }
    if ((m = p.match(/^\/_matrix\/client\/v3\/profile\/([^/]+)$/))) return users.has(m[1]) ? json(res, 200, { displayname: users.get(m[1]).name }) : err(res, 404, 'M_NOT_FOUND', 'No user');
    if (p === '/_matrix/client/v3/createRoom') {
      const roomId = id('!') + ':' + serverName;
      rooms.set(roomId, { id: roomId, events: [], state: new Map(), members: new Map(), receipts: new Map(), typing: new Map() });
      event(roomId, me, 'm.room.create', { creator: me, ...(b.creation_content || {}) }, '');
      event(roomId, me, 'm.room.member', { membership: 'join', displayname: users.get(me).name }, me);
      event(roomId, me, 'm.room.power_levels', { users: { [me]: 100 }, users_default: 0, events_default: 0, state_default: 50, events: {}, ...(b.power_level_content_override || {}) }, '');
      if (b.name) event(roomId, me, 'm.room.name', { name: b.name }, '');
      if (b.topic) event(roomId, me, 'm.room.topic', { topic: b.topic }, '');
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
      // power levels: who may send what (an announcements channel lets only its admins post)
      const level = (u) => { const pl = room.state.get('m.room.power_levels\u0000')?.content; return pl ? { me: pl.users?.[u] ?? pl.users_default ?? 0, need: (t, st) => pl.events?.[t] ?? (st ? pl.state_default ?? 50 : pl.events_default ?? 0) } : { me: 100, need: () => 0 }; };
      if ((verb === 'send' || verb === 'state') && rest) { const t = rest.split('/')[0], L = level(me); if (t !== 'm.reaction' && L.me < L.need(t, verb === 'state')) return err(res, 403, 'M_FORBIDDEN', 'Not allowed to send here'); }
      if (verb === 'send') { const [type, txn] = rest.split('/'); const ev = event(roomId, me, type, b); ev.unsigned = { transaction_id: txn }; room.receipts.set(me, ev.event_id); return json(res, 200, { event_id: ev.event_id }); }
      if (verb === 'redact') { const [target] = rest.split('/'); const ev = event(roomId, me, 'm.room.redaction', { redacts: target }); ev.redacts = target; return json(res, 200, { event_id: ev.event_id }); }
      if (verb === 'state') { const [type, key = ''] = rest.split('/'); const ev = event(roomId, me, type, b, key); return json(res, 200, { event_id: ev.event_id }); }
      if (verb === 'receipt') { const [type, evId] = rest.split('/'); if (type === 'm.read.private') (room.priv ||= new Map()).set(me, evId); else room.receipts.set(me, evId); bump({ room: roomId, receipt: true }); return json(res, 200, {}); }
      if (verb === 'read_markers') { if (b['m.read']) { room.receipts.set(me, b['m.read']); bump({ room: roomId, receipt: true }); } return json(res, 200, {}); }
      if (verb === 'typing') { room.typing.set(me, b.typing ? Date.now() + (b.timeout || 5000) : 0); bump({ room: roomId, typing: true }); return json(res, 200, {}); }
      if (verb === 'messages') { const evs = room.events.filter((e) => e.state_key === undefined); const before = u.searchParams.get('from') === 'p0' ? Math.max(0, evs.length - 30) : evs.length; const lim = +u.searchParams.get('limit') || 30;
        return json(res, 200, { chunk: evs.slice(Math.max(0, before - lim), before).reverse(), end: before - lim > 0 ? 'p0' : undefined }); }
      if (verb === 'report') { reports.push({ by: me, room: roomId, event: rest, reason: b.reason || '' }); return json(res, 200, {}); }
      if (verb === 'joined_members') return json(res, 200, { joined: Object.fromEntries(members(room).map((x) => [x, { display_name: users.get(x)?.name }])) });
      if (verb === 'members') return json(res, 200, { chunk: [...room.state.values()].filter((e) => e.type === 'm.room.member') });
      return err(res, 404, 'M_UNRECOGNIZED', 'Unknown');
    }
    if ((m = p.match(/^\/_matrix\/client\/v3\/user\/([^/]+)\/rooms\/([^/]+)\/tags\/([^/]+)$/))) {
      const key = me + '\u0000' + m[2], t = tags.get(key) || {}; tags.set(key, t);
      if (req.method === 'PUT') t[m[3]] = b; else if (req.method === 'DELETE') delete t[m[3]];
      bump({ room: m[2], tags: me });
      return json(res, 200, {});
    }
    if ((m = p.match(/^\/_matrix\/client\/v3\/pushrules\/global\/room\/([^/]+)$/))) {   // muting a chat
      const a = account.get(me) || new Map(); account.set(me, a);
      const rules = a.get('m.push_rules') || { global: { room: [] } }, list = rules.global.room.filter((r) => r.rule_id !== decodeURIComponent(m[1]));
      if (req.method === 'PUT') list.push({ rule_id: decodeURIComponent(m[1]), actions: b.actions || [], enabled: true, default: false });
      a.set('m.push_rules', { global: { ...rules.global, room: list } }); bump({ account: me });
      return json(res, 200, {});
    }
    if ((m = p.match(/^\/_matrix\/client\/v3\/user\/([^/]+)\/account_data\/([^/]+)$/))) {
      const a = account.get(me) || new Map(); account.set(me, a);
      if (req.method === 'PUT') { a.set(m[2], b); bump({ account: me }); return json(res, 200, {}); }
      return a.has(m[2]) ? json(res, 200, a.get(m[2])) : err(res, 404, 'M_NOT_FOUND', 'None');
    }
    // ---- keys for private chats ----
    const myDev = deviceOf.get(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (p === '/_matrix/client/v3/keys/upload') {
      const d = dev(me, myDev);
      if (b.device_keys) { const first = !d.keys; d.keys = b.device_keys; if (first) bump({ keysChanged: me }); }
      for (const [k, v] of Object.entries(b.one_time_keys || {})) d.otks.set(k, v);
      for (const [k, v] of Object.entries(b.fallback_keys || b['org.matrix.msc2732.fallback_keys'] || {})) { d.fallback.clear(); d.fallback.set(k, v); }
      return json(res, 200, { one_time_key_counts: { signed_curve25519: d.otks.size } });
    }
    if (p === '/_matrix/client/v3/keys/query') {
      const out = { device_keys: {}, failures: {}, master_keys: {}, self_signing_keys: {}, user_signing_keys: {} };
      for (const [user, want] of Object.entries(b.device_keys || {})) {
        out.device_keys[user] = {};
        for (const [d, rec] of devices.get(user) || []) if (rec.keys && (!want?.length || want.includes(d))) out.device_keys[user][d] = rec.keys;
      }
      return json(res, 200, out);
    }
    if (p === '/_matrix/client/v3/keys/claim') {
      const out = { one_time_keys: {}, failures: {} };
      for (const [user, want] of Object.entries(b.one_time_keys || {})) for (const d of Object.keys(want)) {
        const rec = devices.get(user)?.get(d); if (!rec) continue;
        let pick = [...rec.otks][0];
        if (pick) rec.otks.delete(pick[0]); else pick = [...rec.fallback][0];
        if (pick) ((out.one_time_keys[user] ||= {})[d] = { [pick[0]]: pick[1] });
      }
      return json(res, 200, out);
    }
    if (p === '/_matrix/client/v3/keys/signatures/upload') return json(res, 200, { failures: {} });
    if ((m = p.match(/^\/_matrix\/client\/v3\/sendToDevice\/([^/]+)\/([^/]+)$/))) {
      for (const [user, perDevice] of Object.entries(b.messages || {})) for (const [d, content] of Object.entries(perDevice)) bump({ toDevice: { user, device: d, ev: { type: m[1], sender: me, content } } });
      return json(res, 200, {});
    }
    if (p === '/_matrix/client/v3/pushers/set') { const list = (pushers.get(me) || []).filter((x) => x.pushkey !== b.pushkey); if (b.kind) list.push(b); pushers.set(me, list); return json(res, 200, {}); }
    if (p === '/_matrix/media/v3/upload' || p === '/_matrix/client/v1/media/upload') { const mid = id(''); media.set(mid, { type: req.headers['content-type'] || 'application/octet-stream', data: raw }); return json(res, 200, { content_uri: `mxc://${serverName}/${mid}` }); }
    if ((m = p.match(/^\/_matrix\/client\/v3\/presence\/([^/]+)\/status$/)) && req.method === 'PUT') {
      seen.set(me, { at: Date.now(), hidden: b.presence === 'offline' }); for (const w of [...waiters]) w(); return json(res, 200, {});
    }
    // chat backup (room_keys): one current backup version per person, keys stored as the phone sent them (locked)
    // devices: the list, and signing one out (needs the password, as on a real server)
    if (p === '/_matrix/client/v3/devices') return json(res, 200, { devices: [...(devices.get(me) || [])].map(([device_id, d]) => ({ device_id, display_name: d.name || null, last_seen_ts: d.seen || null })) });
    if ((m = p.match(/^\/_matrix\/client\/v3\/devices\/([^/]+)$/)) && req.method === 'DELETE') {
      if (b.auth?.type !== 'm.login.password' || users.get(me)?.pw !== b.auth.password) return json(res, 401, { flows: [{ stages: ['m.login.password'] }], session: id('uia'), params: {} });
      const gone = decodeURIComponent(m[1]); devices.get(me)?.delete(gone);
      for (const [t, d] of deviceOf) if (d === gone && tokens.get(t) === me) { tokens.delete(t); deviceOf.delete(t); }
      return json(res, 200, {});
    }
    if (p === '/_matrix/client/v3/room_keys/version') {
      const kb = keyBackups.get(me);
      if (req.method === 'POST') { const v = String((kb?.n || 0) + 1); keyBackups.set(me, { n: +v, version: v, algorithm: b.algorithm, auth_data: b.auth_data, rooms: {} }); return json(res, 200, { version: v }); }
      if (!kb) return err(res, 404, 'M_NOT_FOUND', 'No current backup version');
      return json(res, 200, { version: kb.version, algorithm: kb.algorithm, auth_data: kb.auth_data, count: 0, etag: '1' });
    }
    if (p === '/_matrix/client/v3/room_keys/keys') {
      const kb = keyBackups.get(me);
      if (!kb || u.searchParams.get('version') !== kb.version) return err(res, kb ? 403 : 404, 'M_WRONG_ROOM_KEYS_VERSION', 'Wrong backup version', );
      if (req.method === 'PUT') { for (const [r, x] of Object.entries(b.rooms || {})) Object.assign((kb.rooms[r] ||= { sessions: {} }).sessions, x.sessions || {}); return json(res, 200, { etag: '1', count: 0 }); }
      return json(res, 200, { rooms: kb.rooms });
    }
    if (p === '/_matrix/client/v3/sync') {
      const since = u.searchParams.get('since'), timeout = Math.min(+u.searchParams.get('timeout') || 0, 30000);
      const myDevice = deviceOf.get(String(req.headers.authorization || '').replace(/^Bearer /, ''));
      seen.set(me, { at: Date.now(), hidden: u.searchParams.get('set_presence') === 'offline' });
      let out = sync(me, since, myDevice);
      const empty = (o) => !Object.keys(o.rooms.join).length && !Object.keys(o.rooms.invite).length && !Object.keys(o.rooms.leave).length && !o.to_device.events.length && !o.device_lists.changed.length;
      if (since && empty(out) && timeout > 0) {
        await new Promise((ok) => { const t = setTimeout(done, timeout); function done() { clearTimeout(t); waiters.delete(done); ok(); } waiters.add(done); });
        out = sync(me, since, myDevice);
      }
      return json(res, 200, out);
    }
    return err(res, 404, 'M_UNRECOGNIZED', 'Unknown endpoint ' + p);
  }
  const server = http.createServer((req, res) => route(req, res).catch((e) => err(res, 500, 'M_UNKNOWN', e.message)));
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}`, server, users, rooms, reports, close: () => { for (const w of waiters) w(); server.close(); } })));
}

if (import.meta.url === `file://${process.argv[1]}`) fakeHomeserver({ port: +(process.env.PORT || 8008) }).then((h) => console.log('stand-in chat server on', h.url));
