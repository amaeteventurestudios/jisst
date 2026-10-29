// The chat engine on the standard Matrix client-server API (the chat server is Tuwunel). It keeps a small picture of
// your chats in memory from one long-running /sync, and tells the screens when anything changes. demo.js has the same
// shape, so every screen works the same in the demo.
const C = '/_matrix/client/v3';
const enc = encodeURIComponent;
const now = () => Date.now();

export function matrixEngine({ homeserver, user_id, access_token }, { agents = new Map(), tz = -new Date().getTimezoneOffset() } = {}) {
  const hs = homeserver.replace(/\/$/, '');
  const rooms = new Map();                       // id -> room
  const subs = new Set();
  let direct = {}, since = null, stopped = false, names = new Map(), blobs = new Map(), ready = false;
  const me = { user_id, name: '' };

  async function call(method, path, body, raw) {
    const r = await fetch(hs + path, { method, headers: { authorization: 'Bearer ' + access_token, ...(raw ? { 'content-type': raw.type || 'application/octet-stream' } : { 'content-type': 'application/json' }) },
      body: raw ? raw : body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || `Chat server answered ${r.status}`); e.status = r.status; e.errcode = j.errcode; throw e; }
    return j;
  }
  let pending = null;
  const changed = () => { if (pending) return; pending = requestAnimationFrame?.(() => { pending = null; for (const f of subs) f(); }) ?? setTimeout(() => { pending = null; for (const f of subs) f(); }); };

  const room = (id) => { let r = rooms.get(id); if (!r) rooms.set(id, r = { id, name: '', members: new Map(), events: [], receipts: new Map(), typing: [], membership: 'join', created: 0, readUpTo: null }); return r; };
  function applyState(r, ev) {
    if (ev.type === 'm.room.name') r.name = ev.content?.name || '';
    if (ev.type === 'm.room.create') r.created = ev.origin_server_ts || r.created;
    if (ev.type === 'm.room.member') {
      const m = { id: ev.state_key, name: ev.content?.displayname || r.members.get(ev.state_key)?.name || ev.state_key.slice(1).split(':')[0], membership: ev.content?.membership };
      r.members.set(ev.state_key, m);
      if (m.name) names.set(ev.state_key, m.name);
      if (ev.state_key === user_id && m.name) me.name = m.name;
    }
  }
  function addTimeline(r, ev) {
    if (ev.state_key !== undefined) applyState(r, ev);
    if (!['m.room.message', 'm.room.member', 'm.room.name', 'm.room.create'].includes(ev.type)) return;
    if (ev.unsigned?.transaction_id) { const i = r.events.findIndex((e) => e.txn === ev.unsigned.transaction_id); if (i >= 0) r.events.splice(i, 1); }
    if (r.events.some((e) => e.event_id === ev.event_id)) return;
    r.events.push(ev);
    if (r.events.length > 400) r.events.splice(0, r.events.length - 400);
  }
  function handleSync(s) {
    for (const ev of s.account_data?.events || []) if (ev.type === 'm.direct') direct = ev.content || {};
    for (const [id, j] of Object.entries(s.rooms?.join || {})) {
      const r = room(id); r.membership = 'join';
      for (const ev of j.state?.events || []) applyState(r, ev);
      for (const ev of j.timeline?.events || []) addTimeline(r, ev);
      for (const ev of j.ephemeral?.events || []) {
        if (ev.type === 'm.typing') r.typing = (ev.content?.user_ids || []).filter((u) => u !== user_id);
        if (ev.type === 'm.receipt') for (const [eid, rc] of Object.entries(ev.content || {})) for (const u of Object.keys(rc['m.read'] || {})) { r.receipts.set(u, eid); if (u === user_id) r.readUpTo = eid; }
      }
      if (j.summary?.['m.joined_member_count'] != null) r.count = j.summary['m.joined_member_count'] + (j.summary['m.invited_member_count'] || 0);
    }
    for (const [id, inv] of Object.entries(s.rooms?.invite || {})) {
      const r = room(id); r.membership = 'invite';
      for (const ev of inv.invite_state?.events || []) applyState(r, ev);
      // like WhatsApp: when someone adds you to a chat, you're in it
      call('POST', `${C}/join/${enc(id)}`, {}).catch(() => {});
    }
    for (const id of Object.keys(s.rooms?.leave || {})) rooms.delete(id);
  }
  async function loop() {
    while (!stopped) {
      try {
        const filter = enc(JSON.stringify({ room: { timeline: { limit: 30 }, state: { lazy_load_members: false } }, presence: { not_types: ['*'] } }));
        const s = await call('GET', `${C}/sync?filter=${filter}&timeout=${since ? 30000 : 0}${since ? '&since=' + enc(since) : ''}`);
        since = s.next_batch; handleSync(s); ready = true; changed();
      } catch (e) {
        if (e.status === 401) { stopped = true; for (const f of subs) f({ signedOut: true }); return; }
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }

  // ---------- reading ----------
  const isDirect = (id) => Object.values(direct).some((list) => list.includes(id));
  const others = (r) => [...r.members.values()].filter((m) => m.id !== user_id && ['join', 'invite'].includes(m.membership));
  function view(ev, r) {
    const c = ev.content || {}, mine = ev.sender === user_id;
    const base = { id: ev.event_id || ev.txn, sender: ev.sender, senderName: names.get(ev.sender) || ev.sender.slice(1).split(':')[0], mine, ts: ev.origin_server_ts || now(), agent: agents.has(ev.sender) };
    if (ev.type === 'm.room.member') {
      const who = names.get(ev.state_key) || '', m = c.membership;
      if (m === 'invite') return { ...base, kind: 'notice', text: `${mine ? 'You' : base.senderName} added ${who}` };
      if (m === 'leave') return { ...base, kind: 'notice', text: `${who} left` };
      return null;
    }
    if (ev.type === 'm.room.name') return { ...base, kind: 'notice', text: `${base.senderName} named the group "${c.name}"` };
    if (ev.type === 'm.room.create') return r.name ? { ...base, kind: 'notice', text: `${mine ? 'You' : base.senderName} created this group` } : null;
    let status = 'sent';
    if (mine) { if (ev.txn) status = ev.failed ? 'failed' : 'sending'; else { const idx = r.events.indexOf(ev); for (const [u, eid] of r.receipts) if (u !== user_id && r.events.findIndex((e) => e.event_id === eid) >= idx) { status = 'read'; break; } } }
    const kind = c.msgtype === 'm.image' ? 'image' : c.msgtype === 'm.audio' ? 'voice' : c.msgtype === 'm.notice' && !c['io.jisst.card'] ? 'text' : 'text';
    return { ...base, kind, text: c['io.jisst.text'] ?? c.body ?? '', card: c['io.jisst.card'] || null, url: c.url || null, info: c.info || {}, status, local: ev.localUrl };
  }
  function summary(r) {
    const o = others(r), dm = isDirect(r.id) || (!r.name && o.length === 1);
    const other = dm ? o[0] : null;
    const name = r.name || (other ? other.name : o.map((m) => m.name.split(' ')[0]).join(', ') || 'Empty chat');
    const msgs = r.events.map((e) => view(e, r)).filter(Boolean);
    const last = msgs[msgs.length - 1];
    let unread = 0;
    const readIdx = r.readUpTo ? r.events.findIndex((e) => e.event_id === r.readUpTo) : -1;
    r.events.forEach((e, i) => { if (i > readIdx && e.type === 'm.room.message' && e.sender !== user_id) unread++; });
    return { id: r.id, name, dm, agentId: other && agents.get(other.id)?.id || null, other: other?.id || null, members: [...r.members.values()].filter((m) => m.membership === 'join'),
      last: last ? { text: last.kind === 'image' ? 'Photo' : last.kind === 'voice' ? 'Voice message' : last.text, ts: last.ts, mine: last.mine, status: last.status, sender: last.senderName, notice: last.kind === 'notice' } : null,
      ts: last?.ts || r.created || 0, unread, typing: r.typing.map((u) => (names.get(u) || '').split(' ')[0]).filter(Boolean) };
  }

  // ---------- writing ----------
  let n = 0;
  async function sendContent(roomId, content, extra = {}) {
    const r = room(roomId), txn = `j${now()}.${n++}`;
    const local = { type: 'm.room.message', sender: user_id, content, origin_server_ts: now(), txn, ...extra };
    r.events.push(local); changed();
    try { const { event_id } = await call('PUT', `${C}/rooms/${enc(roomId)}/send/m.room.message/${txn}`, content); local.event_id = event_id; delete local.txn; changed(); }
    catch (e) { local.failed = true; changed(); throw e; }
  }

  return {
    me, ready: () => ready,
    start() { loop(); return this; },
    stop() { stopped = true; },
    onchange(f) { subs.add(f); return () => subs.delete(f); },
    rooms: () => [...rooms.values()].filter((r) => r.membership === 'join').map(summary).sort((a, b) => b.ts - a.ts),
    room: (id) => (rooms.has(id) ? summary(rooms.get(id)) : null),
    timeline: (id) => { const r = rooms.get(id); return r ? r.events.map((e) => view(e, r)).filter(Boolean) : []; },
    name: (uid) => names.get(uid) || '',
    send: (roomId, text, extra = {}) => sendContent(roomId, { msgtype: 'm.text', body: text, 'io.jisst.tz': tz, ...extra }),
    async sendFile(roomId, file, kind, info = {}) {
      const localUrl = URL.createObjectURL(file);
      const up = await call('POST', `/_matrix/media/v3/upload?filename=${enc(file.name || kind)}`, undefined, file);
      return sendContent(roomId, { msgtype: kind === 'voice' ? 'm.audio' : 'm.image', body: kind === 'voice' ? 'Voice message' : (file.name || 'Photo'), url: up.content_uri,
        info: { mimetype: file.type, size: file.size, ...info }, ...(kind === 'voice' ? { 'org.matrix.msc3245.voice': {} } : {}) }, { localUrl });
    },
    async media(mxc) {
      if (!mxc?.startsWith('mxc://')) return mxc;
      if (blobs.has(mxc)) return blobs.get(mxc);
      const [server, id] = mxc.slice(6).split('/');
      let r = await fetch(`${hs}/_matrix/client/v1/media/download/${enc(server)}/${enc(id)}`, { headers: { authorization: 'Bearer ' + access_token } });
      if (!r.ok) r = await fetch(`${hs}/_matrix/media/v3/download/${enc(server)}/${enc(id)}`, { headers: { authorization: 'Bearer ' + access_token } });
      const url = URL.createObjectURL(await r.blob()); blobs.set(mxc, url); return url;
    },
    markRead(roomId) {
      const r = rooms.get(roomId); if (!r) return;
      const last = [...r.events].reverse().find((e) => e.event_id && e.sender !== user_id);
      if (!last || r.readUpTo === last.event_id) return;
      r.readUpTo = last.event_id; changed();
      call('POST', `${C}/rooms/${enc(roomId)}/receipt/m.read/${enc(last.event_id)}`, {}).catch(() => {});
    },
    typing(roomId, on) { call('PUT', `${C}/rooms/${enc(roomId)}/typing/${enc(user_id)}`, on ? { typing: true, timeout: 6000 } : { typing: false }).catch(() => {}); },
    /** One-to-one chat with a person or an agent; reuses the chat you already have. */
    async openDirect(uid) {
      for (const r of rooms.values()) { const s = summary(r); if (r.membership === 'join' && s.dm && s.other === uid) return r.id; }
      const { room_id } = await call('POST', `${C}/createRoom`, { is_direct: true, invite: [uid], preset: 'trusted_private_chat' });
      direct = { ...direct, [uid]: [...(direct[uid] || []), room_id] };
      await call('PUT', `${C}/user/${enc(user_id)}/account_data/m.direct`, direct).catch(() => {});
      return room_id;
    },
    async createGroup(name, ids) { const { room_id } = await call('POST', `${C}/createRoom`, { name, invite: ids, preset: 'private_chat' }); return room_id; },
    invite: (roomId, uid) => call('POST', `${C}/rooms/${enc(roomId)}/invite`, { user_id: uid }),
    async leave(roomId) { await call('POST', `${C}/rooms/${enc(roomId)}/leave`, {}); rooms.delete(roomId); changed(); },
    async rename(roomId, name) { await call('PUT', `${C}/rooms/${enc(roomId)}/state/m.room.name/`, { name }); },
    async setName(name) { await call('PUT', `${C}/profile/${enc(user_id)}/displayname`, { displayname: name }); me.name = name; changed(); },
    async setPusher(p, on = true) {
      return call('POST', `${C}/pushers/set`, on ? { kind: 'http', app_id: p.app_id, pushkey: p.pushkey, app_display_name: 'Jisst', device_display_name: navigator.userAgent.slice(0, 60), lang: navigator.language || 'en', data: { url: p.url } }
        : { kind: null, app_id: p.app_id, pushkey: p.pushkey });
    },
    async signOut() { stopped = true; await call('POST', `${C}/logout`, {}).catch(() => {}); },
  };
}
