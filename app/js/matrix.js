// The chat engine on the standard Matrix client-server API (the chat server is Tuwunel). It keeps a small picture of
// your chats in memory from one long-running /sync, and tells the screens when anything changes. demo.js has the same
// shape, so every screen works the same in the demo. Chats between people are private (end-to-end encrypted, crypto.js);
// chats with agents are not, because the agent has to read them, and the app says so.
import { cryptoEngine } from './crypto.js';
const C = '/_matrix/client/v3';
const enc = encodeURIComponent;
const now = () => Date.now();

const ENCRYPTION = { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } };
const browserCrypto = () => import('../vendor/matrix-crypto/index.mjs');

export function matrixEngine({ homeserver, user_id, access_token, device_id }, { agents = new Map(), tz = -new Date().getTimezoneOffset(), cryptoLoad = browserCrypto, cryptoStore = true } = {}) {
  const hs = homeserver.replace(/\/$/, '');
  const rooms = new Map();                       // id -> room
  const subs = new Set();
  let direct = {}, since = null, stopped = false, names = new Map(), blobs = new Map(), ready = false;
  const me = { user_id, name: '' };
  let crypto = null, cryptoFailed = false;

  async function call(method, path, body, raw) {
    const r = await fetch(hs + path, { method, headers: { authorization: 'Bearer ' + access_token, ...(raw ? { 'content-type': raw.type || 'application/octet-stream' } : { 'content-type': 'application/json' }) },
      body: raw ? raw : body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || `Chat server answered ${r.status}`); e.status = r.status; e.errcode = j.errcode; throw e; }
    return j;
  }
  let pending = null;
  const files = new Map();      // mxc -> key for a locked photo or voice note
  const changed = () => { if (pending) return; pending = globalThis.requestAnimationFrame?.(() => { pending = null; for (const f of subs) f(); }) ?? setTimeout(() => { pending = null; for (const f of subs) f(); }); };

  const room = (id) => { let r = rooms.get(id); if (!r) rooms.set(id, r = { id, name: '', members: new Map(), events: [], receipts: new Map(), typing: [], membership: 'join', created: 0, readUpTo: null, encrypted: false, reactions: new Map(), redacted: new Set() }); return r; };
  function applyState(r, ev) {
    if (ev.type === 'm.room.name') r.name = ev.content?.name || '';
    if (ev.type === 'm.room.encryption') r.encrypted = true;
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
    if (ev.type === 'm.reaction') return addReaction(r, ev);
    if (ev.type === 'm.room.redaction') { r.redacted.add(ev.redacts || ev.content?.redacts); return; }
    if (!['m.room.message', 'm.room.member', 'm.room.name', 'm.room.create', 'm.room.encryption', 'm.room.encrypted'].includes(ev.type)) return;
    if (ev.unsigned?.transaction_id && ev.sender === user_id) { const i = r.events.findIndex((e) => e.txn === ev.unsigned.transaction_id); if (i >= 0) r.events.splice(i, 1); }
    if (r.events.some((e) => e.event_id === ev.event_id)) return;
    r.events.push(ev);
    if (r.events.length > 400) r.events.splice(0, r.events.length - 400);
  }
  function addReaction(r, ev) {
    const rel = ev.content?.['m.relates_to'];
    if (rel?.rel_type !== 'm.annotation' || !rel.event_id || !rel.key) return;
    const per = r.reactions.get(rel.event_id) || new Map(); r.reactions.set(rel.event_id, per);
    const list = per.get(rel.key) || []; per.set(rel.key, list);
    if (!list.some((x) => x.event_id === ev.event_id)) list.push({ sender: ev.sender, event_id: ev.event_id, txn: ev.txn });
  }
  // A private chat's message, unlocked. Messages whose key hasn't arrived yet wait in `locked` and are tried again.
  const locked = new Map();     // event id -> { roomId, ev }
  async function unlock(roomId, ev) {
    if (ev.type !== 'm.room.encrypted') return ev;
    const d = crypto ? await crypto.decrypt(roomId, ev) : null;
    if (!d) { locked.set(ev.event_id, { roomId, ev }); return { ...ev, locked: true }; }
    locked.delete(ev.event_id);
    return { ...ev, type: d.type, content: d.content, private: true };
  }
  async function retryLocked() {
    for (const [eid, { roomId, ev }] of [...locked]) {
      const plain = await unlock(roomId, ev); if (plain.locked) continue;
      const r = rooms.get(roomId); if (!r) continue;
      const i = r.events.findIndex((e) => e.event_id === eid);
      if (plain.type === 'm.reaction') { if (i >= 0) r.events.splice(i, 1); addReaction(r, plain); }
      else if (i >= 0) r.events[i] = plain;
    }
  }
  async function handleSync(s) {
    if (crypto) await crypto.sync(s).catch(() => {});
    for (const ev of s.account_data?.events || []) if (ev.type === 'm.direct') direct = ev.content || {};
    for (const [id, j] of Object.entries(s.rooms?.join || {})) {
      const r = room(id); r.membership = 'join';
      for (const ev of j.state?.events || []) applyState(r, ev);
      for (const ev of j.timeline?.events || []) {
        if (ev.unsigned?.transaction_id && ev.sender === user_id && r.events.some((e) => e.txn === ev.unsigned.transaction_id && e.event_id)) continue;
        if (r.events.some((e) => e.event_id && e.event_id === ev.event_id)) continue;
        addTimeline(r, await unlock(id, ev));
      }
      for (const ev of j.ephemeral?.events || []) {
        if (ev.type === 'm.typing') r.typing = (ev.content?.user_ids || []).filter((u) => u !== user_id);
        if (ev.type === 'm.receipt') for (const [eid, rc] of Object.entries(ev.content || {})) for (const u of Object.keys(rc['m.read'] || {})) { r.receipts.set(u, eid); if (u === user_id) r.readUpTo = eid; }
      }
      for (const ev of j.account_data?.events || []) if (ev.type === 'm.tag') r.tags = ev.content?.tags || {};
      if (j.summary?.['m.joined_member_count'] != null) r.count = j.summary['m.joined_member_count'] + (j.summary['m.invited_member_count'] || 0);
    }
    for (const [id, inv] of Object.entries(s.rooms?.invite || {})) {
      const r = room(id); r.membership = 'invite';
      for (const ev of inv.invite_state?.events || []) applyState(r, ev);
      // like WhatsApp: when someone adds you to a chat, you're in it
      call('POST', `${C}/join/${enc(id)}`, {}).catch(() => {});
    }
    for (const id of Object.keys(s.rooms?.leave || {})) rooms.delete(id);
    if (crypto) {
      if (locked.size) await retryLocked();
      const people = new Set();
      for (const r of rooms.values()) if (r.encrypted && r.membership === 'join') for (const m of r.members.values()) if (['join', 'invite'].includes(m.membership)) people.add(m.id);
      await crypto.track([...people]).catch(() => {});
    }
  }
  async function startCrypto() {
    if (!device_id || !cryptoLoad) { cryptoFailed = true; return; }
    try { crypto = await cryptoEngine({ call, user_id, device_id, load: cryptoLoad, store: cryptoStore }); }
    catch (e) { cryptoFailed = true; console.warn('Private chats unavailable here:', e.message); }
  }
  async function loop() {
    await startCrypto();
    while (!stopped) {
      try {
        const filter = enc(JSON.stringify({ room: { timeline: { limit: 30 }, state: { lazy_load_members: false } }, presence: { not_types: ['*'] } }));
        const s = await call('GET', `${C}/sync?filter=${filter}&timeout=${since ? 30000 : 0}${since ? '&since=' + enc(since) : ''}`);
        await handleSync(s); since = s.next_batch; ready = true; changed();
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
    if (ev.type === 'm.room.encryption') return null;   // the banner at the top of a private chat says it
    if (ev.event_id && r.redacted.has(ev.event_id)) return { ...base, kind: 'text', text: 'This message was deleted', deleted: true, status: 'sent', card: null, reactions: [] };
    if (ev.locked || ev.type === 'm.room.encrypted') return { ...base, kind: 'text', text: cryptoFailed ? 'Private message: open Jisste in a newer browser to read it' : 'Waiting for this message…', waiting: true, status: 'sent', card: null, reactions: [] };
    let status = 'sent';
    if (mine) { if (!ev.event_id) status = ev.failed ? 'failed' : 'sending'; else { const idx = r.events.indexOf(ev); for (const [u, eid] of r.receipts) if (u !== user_id && r.events.findIndex((e) => e.event_id === eid) >= idx) { status = 'read'; break; } } }
    const kind = c.msgtype === 'm.image' ? 'image' : c.msgtype === 'm.audio' ? 'voice' : c.msgtype === 'm.notice' && !c['io.jisst.card'] ? 'text' : 'text';
    if (c.file?.url) files.set(c.file.url, c.file);
    const per = ev.event_id ? r.reactions.get(ev.event_id) : null;
    const reactions = per ? [...per].map(([key, list]) => { const live = list.filter((x) => !r.redacted.has(x.event_id)); return { key, count: live.length, mine: live.some((x) => x.sender === user_id), names: live.map((x) => names.get(x.sender) || '') }; }).filter((x) => x.count) : [];
    return { ...base, kind, text: c['io.jisst.text'] ?? c.body ?? '', card: c['io.jisst.card'] || null, url: c.url || c.file?.url || null, info: c.info || {}, status, local: ev.localUrl, private: !!ev.private || (mine && r.encrypted), reactions, call: c['io.jisst.call'] || null };
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
    return { id: r.id, name, dm, encrypted: r.encrypted, favorite: !!r.tags?.['m.favourite'], agentId: other && agents.get(other.id)?.id || null, other: other?.id || null, members: [...r.members.values()].filter((m) => m.membership === 'join').map((m) => ({ ...m, agent: agents.has(m.id) })),
      last: last ? { text: last.kind === 'image' ? 'Photo' : last.kind === 'voice' ? 'Voice message' : last.text, ts: last.ts, mine: last.mine, status: last.status, sender: last.senderName, notice: last.kind === 'notice' } : null,
      ts: last?.ts || r.created || 0, unread, typing: r.typing.map((u) => (names.get(u) || '').split(' ')[0]).filter(Boolean) };
  }

  // ---------- writing ----------
  let n = 0;
  const members = (r) => [...r.members.values()].filter((m) => ['join', 'invite'].includes(m.membership)).map((m) => m.id);
  /** Send one event; in a private chat it is locked for everyone in the room first. */
  async function put(roomId, type, content, txn) {
    const r = room(roomId);
    if (r.encrypted) {
      if (!crypto) throw new Error(cryptoFailed ? 'Private chats need a newer browser.' : 'Getting this private chat ready. Try again in a moment.');
      const locked = await crypto.encrypt(roomId, members(r), type, content);
      return call('PUT', `${C}/rooms/${enc(roomId)}/send/m.room.encrypted/${txn}`, locked);
    }
    return call('PUT', `${C}/rooms/${enc(roomId)}/send/${enc(type)}/${txn}`, content);
  }
  async function sendContent(roomId, content, extra = {}) {
    const r = room(roomId), txn = `j${now()}.${n++}`;
    const local = { type: 'm.room.message', sender: user_id, content, origin_server_ts: now(), txn, ...extra };
    r.events.push(local); changed();
    try { const { event_id } = await put(roomId, 'm.room.message', content, txn); local.event_id = event_id; changed(); }
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
      const localUrl = URL.createObjectURL(file), r = room(roomId);
      let where;
      if (r.encrypted && crypto) {
        const { data, file: key } = crypto.encryptFile(new Uint8Array(await file.arrayBuffer()));
        const up = await call('POST', `/_matrix/media/v3/upload?filename=locked`, undefined, new Blob([data], { type: 'application/octet-stream' }));
        where = { file: { ...key, url: up.content_uri, mimetype: file.type } };
      } else {
        const up = await call('POST', `/_matrix/media/v3/upload?filename=${enc(file.name || kind)}`, undefined, file);
        where = { url: up.content_uri };
      }
      return sendContent(roomId, { msgtype: kind === 'voice' ? 'm.audio' : 'm.image', body: kind === 'voice' ? 'Voice message' : (file.name || 'Photo'), ...where,
        info: { mimetype: file.type, size: file.size, ...info }, ...(kind === 'voice' ? { 'org.matrix.msc3245.voice': {} } : {}) }, { localUrl });
    },
    /** React to a message with an emoji; the same emoji again takes it back. */
    async react(roomId, eventId, key) {
      const r = room(roomId), mineNow = (r.reactions.get(eventId)?.get(key) || []).find((x) => x.sender === user_id && !r.redacted.has(x.event_id));
      if (mineNow) {
        if (!mineNow.event_id) return;
        r.redacted.add(mineNow.event_id); changed();
        return call('PUT', `${C}/rooms/${enc(roomId)}/redact/${enc(mineNow.event_id)}/j${now()}.${n++}`, {});
      }
      const txn = `j${now()}.${n++}`, ev = { type: 'm.reaction', sender: user_id, content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key } }, txn };
      addReaction(r, { ...ev, event_id: undefined }); changed();
      const { event_id } = await put(roomId, 'm.reaction', ev.content, txn);
      const item = r.reactions.get(eventId)?.get(key)?.find((x) => x.txn === txn); if (item) item.event_id = event_id;
      changed();
    },
    /** Favorites are a Matrix room tag, so they follow you to every phone. */
    async setFavorite(roomId, on) {
      const r = room(roomId); r.tags = { ...(r.tags || {}) };
      if (on) r.tags['m.favourite'] = { order: 0.5 }; else delete r.tags['m.favourite'];
      changed();
      const path = `${C}/user/${enc(user_id)}/rooms/${enc(roomId)}/tags/m.favourite`;
      return on ? call('PUT', path, { order: 0.5 }) : call('DELETE', path);
    },
    /** Delete one of your own messages for everyone. */
    async remove(roomId, eventId) { const r = room(roomId); r.redacted.add(eventId); changed(); await call('PUT', `${C}/rooms/${enc(roomId)}/redact/${enc(eventId)}/j${now()}.${n++}`, {}); },
    /** Any extra kind of message (calls use this). */
    sendRaw: (roomId, content) => sendContent(roomId, content),
    privateChats: () => !cryptoFailed,
    async media(mxc) {
      if (!mxc?.startsWith('mxc://')) return mxc;
      if (blobs.has(mxc)) return blobs.get(mxc);
      const [server, id] = mxc.slice(6).split('/');
      let r = await fetch(`${hs}/_matrix/client/v1/media/download/${enc(server)}/${enc(id)}`, { headers: { authorization: 'Bearer ' + access_token } });
      if (!r.ok) r = await fetch(`${hs}/_matrix/media/v3/download/${enc(server)}/${enc(id)}`, { headers: { authorization: 'Bearer ' + access_token } });
      let blob = await r.blob();
      const key = files.get(mxc);
      if (key) { if (!crypto) throw new Error('locked'); blob = new Blob([crypto.decryptFile(new Uint8Array(await blob.arrayBuffer()), key)], { type: key.mimetype || 'application/octet-stream' }); }
      const url = URL.createObjectURL(blob); blobs.set(mxc, url); return url;
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
      // a chat with a person is private; a chat with an agent can't be, since the agent must read it
      const { room_id } = await call('POST', `${C}/createRoom`, { is_direct: true, invite: [uid], preset: 'trusted_private_chat', initial_state: agents.has(uid) || cryptoFailed ? [] : [ENCRYPTION] });
      direct = { ...direct, [uid]: [...(direct[uid] || []), room_id] };
      await call('PUT', `${C}/user/${enc(user_id)}/account_data/m.direct`, direct).catch(() => {});
      return room_id;
    },
    async createGroup(name, ids) {
      const withAgent = ids.some((u) => agents.has(u));
      const { room_id } = await call('POST', `${C}/createRoom`, { name, invite: ids, preset: 'private_chat', initial_state: withAgent || cryptoFailed ? [] : [ENCRYPTION] });
      return room_id;
    },
    async invite(roomId, uid) {
      if (rooms.get(roomId)?.encrypted && agents.has(uid)) throw new Error("Agents can't join a private group. Make a new group with the agent in it.");
      return call('POST', `${C}/rooms/${enc(roomId)}/invite`, { user_id: uid });
    },
    async leave(roomId) { await call('POST', `${C}/rooms/${enc(roomId)}/leave`, {}); rooms.delete(roomId); changed(); },
    async rename(roomId, name) { await call('PUT', `${C}/rooms/${enc(roomId)}/state/m.room.name/`, { name }); },
    async setName(name) { await call('PUT', `${C}/profile/${enc(user_id)}/displayname`, { displayname: name }); me.name = name; changed(); },
    async setPusher(p, on = true) {
      return call('POST', `${C}/pushers/set`, on ? { kind: 'http', app_id: p.app_id, pushkey: p.pushkey, app_display_name: 'Jisste', device_display_name: navigator.userAgent.slice(0, 60), lang: navigator.language || 'en', data: { url: p.url } }
        : { kind: null, app_id: p.app_id, pushkey: p.pushkey });
    },
    async signOut() { stopped = true; crypto?.close(); await call('POST', `${C}/logout`, {}).catch(() => {}); },
    /** The call() helper, for features that talk to the chat server directly (calls check membership with it). */
    token: () => access_token,
  };
}
