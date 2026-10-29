// The chat engine on the standard Matrix client-server API (the chat server is Tuwunel). It keeps a small picture of
// your chats in memory from one long-running /sync, and tells the screens when anything changes. demo.js has the same
// shape, so every screen works the same in the demo. Chats between people are private (end-to-end encrypted, crypto.js);
// chats with agents are not, because the agent has to read them, and the app says so.
import { cryptoEngine } from './crypto.js';
import { extras, tally, POLL, preview, contactContent, pollContent, locationContent } from './content.js';
const C = '/_matrix/client/v3';
const enc = encodeURIComponent;
const now = () => Date.now();

const ENCRYPTION = { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } };
const browserCrypto = () => import('../vendor/matrix-crypto/index.mjs');

export function matrixEngine({ homeserver, user_id, access_token, device_id }, { agents = new Map(), tz = -new Date().getTimezoneOffset(), cryptoLoad = browserCrypto, cryptoStore = true } = {}) {
  const hs = homeserver.replace(/\/$/, '');
  const rooms = new Map();                       // id -> room
  const subs = new Set();
  let direct = {}, since = null, stopped = false, names = new Map(), blobs = new Map(), ready = false, starred = [], starBusy = 0, muted = new Set(), blocked = new Set();
  let privacy = { lastSeen: true, readTicks: true }, privacyBusy = 0;
  const presence = new Map();                    // user -> { online, at }  (at: when they were last seen, ms)
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

  const room = (id) => { let r = rooms.get(id); if (!r) rooms.set(id, r = { id, name: '', members: new Map(), events: [], receipts: new Map(), typing: [], membership: 'join', created: 0, readUpTo: null, encrypted: false, reactions: new Map(), redacted: new Set(), edits: new Map(), children: new Set(), parent: null, power: null }); return r; };
  function applyState(r, ev) {
    if (ev.type === 'm.room.name') r.name = ev.content?.name || '';
    if (ev.type === 'm.room.encryption') r.encrypted = true;
    if (ev.type === 'io.jisst.disappear') r.disappear = Math.max(0, +ev.content?.seconds || 0);
    if (ev.type === 'io.jisst.status') r.status = true;   // someone's status updates: a room only its owner posts in
    if (ev.type === 'm.room.create') { r.created = ev.origin_server_ts || r.created; r.creator = ev.sender; if (ev.content?.type === 'm.space') r.space = true; }
    if (ev.type === 'm.room.topic') r.topic = ev.content?.topic || '';
    if (ev.type === 'm.room.power_levels') r.power = ev.content || null;
    // communities are Matrix spaces: the space lists its chats (m.space.child) and each chat names its community (m.space.parent)
    if (ev.type === 'm.space.child') { if (ev.content?.via) r.children.add(ev.state_key); else r.children.delete(ev.state_key); if (ev.content?.['io.jisst.announcements']) r.announce = ev.state_key; }
    if (ev.type === 'm.space.parent' && ev.content?.via) r.parent = ev.state_key;
    if (ev.type === 'io.jisst.announcements') r.announcements = true;
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
    const rel = ev.content?.['m.relates_to'];
    if (ev.type === 'm.room.message' && rel?.rel_type === 'm.replace' && rel.event_id) {   // an edit: keep the newest, by its sender only
      const was = r.edits.get(rel.event_id);
      if (!was || (was.origin_server_ts || 0) <= (ev.origin_server_ts || now())) r.edits.set(rel.event_id, ev);
      return;
    }
    if (ev.type === 'm.room.redaction') { r.redacted.add(ev.redacts || ev.content?.redacts); return; }
    if (!['m.room.message', 'm.room.member', 'm.room.name', 'm.room.create', 'm.room.encryption', 'm.room.encrypted', 'io.jisst.disappear'].includes(ev.type)) return;
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
      if (plain.type === 'm.reaction' || plain.content?.['m.relates_to']?.rel_type === 'm.replace') { if (i >= 0) r.events.splice(i, 1); addTimeline(r, plain); }
      else if (i >= 0) r.events[i] = plain;
    }
  }
  // your public and private read marks can both come back: keep the later one
  const later = (r, a, b) => { if (!b) return true; const i = r.events.findIndex((e) => e.event_id === a), j = r.events.findIndex((e) => e.event_id === b); return i < 0 && j < 0 ? true : i >= j; };
  async function handleSync(s) {
    if (crypto) await crypto.sync(s).catch(() => {});
    for (const ev of s.account_data?.events || []) { if (ev.type === 'm.direct') direct = ev.content || {}; if (ev.type === 'io.jisst.starred' && !starBusy) starred = ev.content?.list || [];
      if (ev.type === 'm.push_rules') muted = new Set((ev.content?.global?.room || []).filter((x) => x.enabled !== false && !(x.actions || []).includes('notify')).map((x) => x.rule_id));
      if (ev.type === 'm.ignored_user_list') blocked = new Set(Object.keys(ev.content?.ignored_users || {}));
      if (ev.type === 'io.jisst.privacy' && !privacyBusy) privacy = { lastSeen: ev.content?.lastSeen !== false, readTicks: ev.content?.readTicks !== false }; }
    for (const ev of s.presence?.events || []) if (ev.type === 'm.presence' && ev.sender !== user_id) {
      const c = ev.content || {}; presence.set(ev.sender, { online: c.presence === 'online' || !!c.currently_active, at: c.last_active_ago != null ? now() - c.last_active_ago : 0 });
    }   // stars: not while our own change is on its way
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
        if (ev.type === 'm.receipt') for (const [eid, rc] of Object.entries(ev.content || {})) for (const t of ['m.read', 'm.read.private']) for (const u of Object.keys(rc[t] || {})) { if (t === 'm.read') r.receipts.set(u, eid); if (u === user_id && later(r, eid, r.readUpTo)) r.readUpTo = eid; }
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
    // statuses and communities never buzz your phone: alerts come from the chats themselves
    if (ready) for (const r of rooms.values()) if ((r.status || r.space) && r.membership === 'join' && !muted.has(r.id) && !r.quieted) { r.quieted = true; call('PUT', `${C}/pushrules/global/room/${enc(r.id)}`, { actions: [] }).catch(() => {}); }
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
        const filter = enc(JSON.stringify({ room: { timeline: { limit: 30 }, state: { lazy_load_members: false } }, presence: { types: ['m.presence'] } }));
        // hiding last seen also hides you from the online list (Matrix shows 'offline' to everyone)
        const s = await call('GET', `${C}/sync?filter=${filter}&set_presence=${privacy.lastSeen ? 'online' : 'offline'}&timeout=${since ? 30000 : 0}${since ? '&since=' + enc(since) : ''}`);
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
    if (ev.type === 'io.jisst.disappear') { const t = +c.seconds || 0; return { ...base, kind: 'notice', text: t ? `${mine ? 'You' : base.senderName} turned on disappearing messages: new messages go after ${spanOf(t)}` : `${mine ? 'You' : base.senderName} turned off disappearing messages` }; }
    if (!mine && blocked.has(ev.sender)) return null;
    if (c['io.jisst.expires'] && c['io.jisst.expires'] < now()) return null;   // a disappearing message whose time is up
    if (ev.event_id && r.redacted.has(ev.event_id)) return { ...base, kind: 'text', text: 'This message was deleted', deleted: true, status: 'sent', card: null, reactions: [] };
    if (ev.locked || ev.type === 'm.room.encrypted') return { ...base, kind: 'text', text: cryptoFailed ? 'Private message: open Jisste in a newer browser to read it' : 'Waiting for this message…', waiting: true, status: 'sent', card: null, reactions: [] };
    let status = 'sent';
    // read ticks work both ways, as in other chat apps: switch yours off and you don't see other people's either
    if (mine) { if (!ev.event_id) status = ev.failed ? 'failed' : 'sending'; else if (privacy.readTicks) { const idx = r.events.indexOf(ev); for (const [u, eid] of r.receipts) if (u !== user_id && r.events.findIndex((e) => e.event_id === eid) >= idx) { status = 'read'; break; } } }
    // an edit by the same person replaces what the message says
    const edit = ev.event_id && r.edits.get(ev.event_id), nc = edit && edit.sender === ev.sender && edit.content?.['m.new_content'];
    const cc = nc ? { ...c, ...nc } : c;
    const x = extras(cc);
    if (cc.file?.url) files.set(cc.file.url, cc.file);
    const per = ev.event_id ? r.reactions.get(ev.event_id) : null;
    const live = per ? [...per].map(([key, list]) => [key, list.filter((v) => !r.redacted.has(v.event_id))]) : [];
    const reactions = live.filter(([key, l]) => l.length && !key.startsWith(POLL)).map(([key, l]) => ({ key, count: l.length, mine: l.some((v) => v.sender === user_id), names: l.map((v) => names.get(v.sender) || '') }));
    const poll = x.pollDef ? tally(x.pollDef, live.filter(([key]) => key.startsWith(POLL)).flatMap(([key, l]) => l.map((v) => ({ key, sender: v.sender }))), user_id) : null;
    const rid = c['m.relates_to']?.['m.in_reply_to']?.event_id;
    const target = rid && r.events.find((e) => e.event_id === rid);
    const tv = target && target !== ev ? view(target, r) : null;
    const replyTo = rid ? (tv ? { id: rid, senderName: tv.mine ? 'You' : tv.senderName, text: preview(tv) } : { id: rid, senderName: '', text: 'Earlier message' }) : null;
    const text = cc['io.jisst.text'] ?? (rid ? String(cc.body || '').replace(/^(> .*\n)+\n?/, '') : cc.body) ?? '';
    return { ...base, ...x, text, card: cc['io.jisst.card'] || null, url: cc.url || cc.file?.url || null, info: cc.info || {}, status, local: ev.localUrl, private: !!ev.private || (mine && r.encrypted), reactions, poll,
      call: cc['io.jisst.call'] || null, replyTo, edited: !!nc, starred: starred.some((s) => s.room === r.id && s.id === ev.event_id) };
  }
  const spanOf = (t) => (t >= 86400 * 60 ? `${Math.round(t / 86400)} days` : t >= 86400 * 7 ? `${Math.round(t / 86400 / 7)} week${t >= 86400 * 14 ? 's' : ''}` : t >= 86400 ? `${Math.round(t / 86400)} day${t >= 172800 ? 's' : ''}` : `${Math.round(t / 3600)} hours`);
  // Your own disappearing messages are deleted from the server once their time is up (the other phones hide them on time anyway)
  function sweep() {
    for (const r of rooms.values()) for (const ev of r.events) {
      const x = ev.content?.['io.jisst.expires'];
      if (x && x < now() && ev.sender === user_id && ev.event_id && !r.redacted.has(ev.event_id)) { r.redacted.add(ev.event_id); call('PUT', `${C}/rooms/${enc(r.id)}/redact/${enc(ev.event_id)}/j${now()}.${n++}`, {}).catch(() => {}); }
    }
  }
  const sweeper = setInterval(() => { if (!stopped) { sweep(); changed(); } }, 60e3);
  const levelOf = (r, u) => (r.power ? r.power.users?.[u] ?? r.power.users_default ?? 0 : 0);
  const canSend = (r) => !r.power || levelOf(r, user_id) >= (r.power.events?.['m.room.message'] ?? r.power.events_default ?? 0);
  function communityOf(r) { const sp = r.parent && rooms.get(r.parent); return sp?.space && sp.membership === 'join' ? { id: sp.id, name: sp.name || 'Community' } : null; }
  function community(sp) {
    const kids = [...sp.children].map((id) => rooms.get(id)).filter((x) => x && x.membership === 'join');
    return { id: sp.id, name: sp.name || 'Community', about: sp.topic || '', admin: levelOf(sp, user_id) >= 50, members: [...sp.members.values()].filter((m) => m.membership === 'join').length,
      announce: kids.find((x) => x.announcements)?.id || null, groups: kids.filter((x) => !x.announcements).map((x) => x.id) };
  }
  const link = (space, child, extra = {}) => Promise.all([
    call('PUT', `${C}/rooms/${enc(space)}/state/m.space.child/${enc(child)}`, { via: [user_id.split(':')[1]], ...extra }),
    call('PUT', `${C}/rooms/${enc(child)}/state/m.space.parent/${enc(space)}`, { via: [user_id.split(':')[1]], canonical: true })]);
  // ---------- status updates ----------
  const DAY = 86400;
  const myStatusRoom = () => [...rooms.values()].find((r) => r.status && r.creator === user_id && r.membership === 'join');
  // the people who see your status: everyone you have a one-to-one chat with (agents don't watch statuses)
  const contacts = () => [...new Set([...rooms.values()].filter((r) => r.membership === 'join' && !r.space && !r.status && (isDirect(r.id) || (!r.name && others(r).length === 1)))
    .flatMap((r) => others(r).map((m) => m.id)))].filter((u) => !agents.has(u) && !blocked.has(u));
  async function statusRoom() {
    let r = myStatusRoom();
    if (!r) {
      const { room_id } = await call('POST', `${C}/createRoom`, { name: 'Status', invite: contacts(), preset: 'private_chat', power_level_content_override: { events_default: 100, users: { [user_id]: 100 } },
        initial_state: [...(cryptoFailed ? [] : [ENCRYPTION]), { type: 'io.jisst.status', state_key: '', content: {} }, { type: 'io.jisst.disappear', state_key: '', content: { seconds: DAY } }] });
      r = room(room_id); r.status = true; r.creator = user_id; r.disappear = DAY; if (!cryptoFailed) r.encrypted = true;
      await until(() => r.members.has(user_id));
    } else {
      // people you started chatting with since get to see it too
      for (const u of contacts()) if (!r.members.has(u) || r.members.get(u).membership === 'leave') await call('POST', `${C}/rooms/${enc(r.id)}/invite`, { user_id: u }).catch(() => {});
    }
    return r;
  }
  async function until(fn, ms = 8000) { const end = now() + ms; while (!fn() && now() < end) await new Promise((ok) => setTimeout(ok, 100)); }
  function statusOf(r) {
    const mine = r.creator === user_id, readIdx = r.readUpTo ? r.events.findIndex((e) => e.event_id === r.readUpTo) : -1;
    const items = r.events.map((ev, i) => [ev, i]).filter(([ev]) => ev.type === 'm.room.message' && ev.sender === r.creator).map(([ev, i]) => {
      const v = view(ev, r); if (!v || v.deleted || v.waiting) return null;
      const seenBy = mine && ev.event_id ? [...r.receipts].filter(([u, eid]) => u !== user_id && r.events.findIndex((e) => e.event_id === eid) >= i).map(([u]) => names.get(u) || u) : [];
      return { id: v.id, kind: v.kind, text: v.text, bg: ev.content?.['io.jisst.bg'] || '', url: v.url, local: v.local, info: v.info, ts: v.ts, seen: mine || i <= readIdx, seenBy, status: v.status };
    }).filter((x) => x && x.ts > now() - DAY * 1000);
    return { user: r.creator, name: mine ? 'You' : names.get(r.creator) || r.creator, mine, roomId: r.id, items, unseen: items.filter((x) => !x.seen).length, ts: items.length ? items[items.length - 1].ts : 0 };
  }
  function summary(r) {
    const o = others(r), dm = isDirect(r.id) || (!r.name && o.length === 1);
    const other = dm ? o[0] : null;
    const name = r.name || (other ? other.name : o.map((m) => m.name.split(' ')[0]).join(', ') || 'Empty chat');
    const msgs = r.events.map((e) => view(e, r)).filter(Boolean);
    const last = msgs[msgs.length - 1];
    let unread = 0;
    const readIdx = r.readUpTo ? r.events.findIndex((e) => e.event_id === r.readUpTo) : -1;
    r.events.forEach((e, i) => { if (i > readIdx && e.type === 'm.room.message' && e.sender !== user_id && !blocked.has(e.sender)) unread++; });
    return { id: r.id, name, dm, encrypted: r.encrypted, favorite: !!r.tags?.['m.favourite'], muted: muted.has(r.id), archived: !!r.tags?.['u.jisst.archived'], pinned: r.tags?.['u.jisst.pinned'] ? +r.tags['u.jisst.pinned'].order || 0 : null,
      disappear: r.disappear || 0, community: communityOf(r), announce: !!r.announcements, canPost: canSend(r), admin: levelOf(r, user_id) >= 50, blocked: !!(other && blocked.has(other.id)), agentId: other && agents.get(other.id)?.id || null, other: other?.id || null, members: [...r.members.values()].filter((m) => m.membership === 'join').map((m) => ({ ...m, agent: agents.has(m.id) })),
      last: last ? { text: last.kind === 'text' || last.kind === 'notice' ? last.text : preview(last), ts: last.ts, mine: last.mine, status: last.status, sender: last.senderName, notice: last.kind === 'notice' } : null,
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
    if (r.disappear) content = { ...content, 'io.jisst.expires': now() + r.disappear * 1000 };
    const local = { type: 'm.room.message', sender: user_id, content, origin_server_ts: now(), txn, ...extra };
    r.events.push(local); changed();
    try { const { event_id } = await put(roomId, 'm.room.message', content, txn); local.event_id = event_id; changed(); }
    catch (e) { local.failed = true; changed(); throw e; }
  }

  return {
    me, ready: () => ready,
    start() { loop(); return this; },
    stop() { stopped = true; clearInterval(sweeper); },
    onchange(f) { subs.add(f); return () => subs.delete(f); },
    rooms: () => [...rooms.values()].filter((r) => r.membership === 'join' && !r.space && !r.status).map(summary).sort((a, b) => b.ts - a.ts),
    room: (id) => (rooms.has(id) ? summary(rooms.get(id)) : null),
    timeline: (id) => { const r = rooms.get(id); return r ? r.events.map((e) => view(e, r)).filter(Boolean) : []; },
    name: (uid) => names.get(uid) || '',
    /** A text message; `replyTo` (a message id) makes it an answer to that message. */
    send(roomId, text, { replyTo } = {}) {
      const rel = replyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: replyTo } } } : {};
      return sendContent(roomId, { msgtype: 'm.text', body: text, 'io.jisst.tz': tz, ...rel });
    },
    /** Change what one of your messages says (everyone sees "edited"). */
    async edit(roomId, eventId, text) {
      const r = room(roomId), ev = r.events.find((e) => e.event_id === eventId);
      if (!ev || ev.sender !== user_id) throw new Error('You can only edit your own messages.');
      const nc = { msgtype: 'm.text', body: text };
      const content = { msgtype: 'm.text', body: '* ' + text, 'm.new_content': nc, 'm.relates_to': { rel_type: 'm.replace', event_id: eventId } };
      r.edits.set(eventId, { sender: user_id, content, origin_server_ts: now() }); changed();
      await put(roomId, 'm.room.message', content, `j${now()}.${n++}`);
    },
    /** Send a copy of a message to another chat, marked as forwarded. */
    forward(toRoomId, fromRoomId, eventId) {
      const r = rooms.get(fromRoomId), ev = r?.events.find((e) => e.event_id === eventId);
      if (!ev) throw new Error("That message isn't here any more.");
      const edit = r.edits.get(eventId), c = { ...(ev.content || {}), ...(edit?.content?.['m.new_content'] || {}) };
      const { 'm.relates_to': _, 'io.jisst.tz': __, 'io.jisst.call': ___, ...copy } = c;
      if (copy['io.jisst.poll']) { copy['io.jisst.poll'] = { ...copy['io.jisst.poll'] }; }
      return sendContent(toRoomId, { ...copy, 'io.jisst.forwarded': true });
    },
    /** Starred messages are kept in your account, so they follow you to every phone. */
    async star(roomId, eventId, on) {
      starred = starred.filter((s) => !(s.room === roomId && s.id === eventId));
      if (on) starred.unshift({ room: roomId, id: eventId, at: now() });
      starred = starred.slice(0, 500); changed();
      starBusy++;
      try { await call('PUT', `${C}/user/${enc(user_id)}/account_data/io.jisst.starred`, { list: starred }); } finally { starBusy--; }
    },
    starred() {
      return starred.map((s) => { const r = rooms.get(s.room), ev = r?.events.find((e) => e.event_id === s.id); return ev ? { roomId: s.room, roomName: summary(r).name, msg: view(ev, r) } : null; }).filter(Boolean);
    },
    sendContact: (roomId, who) => sendContent(roomId, contactContent(who)),
    sendPoll: (roomId, question, options) => sendContent(roomId, pollContent(question, options)),
    sendLocation: (roomId, place) => sendContent(roomId, locationContent(place)),
    /** Vote in a poll (one vote each; the same option again takes it back). */
    async vote(roomId, pollId, index) {
      const r = room(roomId), per = r.reactions.get(pollId);
      const old = per ? [...per].flatMap(([key, l]) => l.filter((v) => v.sender === user_id && !r.redacted.has(v.event_id) && key.startsWith(POLL)).map((v) => ({ key, ...v }))) : [];
      for (const v of old) if (v.event_id) { r.redacted.add(v.event_id); call('PUT', `${C}/rooms/${enc(roomId)}/redact/${enc(v.event_id)}/j${now()}.${n++}`, {}).catch(() => {}); }
      changed();
      if (old.some((v) => v.key === POLL + index)) return;
      const txn = `j${now()}.${n++}`, content = { 'm.relates_to': { rel_type: 'm.annotation', event_id: pollId, key: POLL + index } };
      addReaction(r, { type: 'm.reaction', sender: user_id, content, txn }); changed();
      const { event_id } = await put(roomId, 'm.reaction', content, txn);
      const item = r.reactions.get(pollId)?.get(POLL + index)?.find((v) => v.txn === txn); if (item) item.event_id = event_id;
      changed();
    },
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
      const msgtype = { voice: 'm.audio', image: 'm.image', video: 'm.video', file: 'm.file' }[kind] || 'm.file';
      return sendContent(roomId, { msgtype, body: kind === 'voice' ? 'Voice message' : (file.name || (kind === 'image' ? 'Photo' : kind === 'video' ? 'Video' : 'File')), ...where,
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
    /** Pinned and archived chats are room tags too. */
    async setTag(roomId, tag, on, order = 0.5) {
      const r = room(roomId); r.tags = { ...(r.tags || {}) };
      if (on) r.tags[tag] = { order }; else delete r.tags[tag];
      changed();
      const path = `${C}/user/${enc(user_id)}/rooms/${enc(roomId)}/tags/${enc(tag)}`;
      return on ? call('PUT', path, { order }) : call('DELETE', path);
    },
    pin(roomId, on) {
      if (on && [...rooms.values()].filter((r) => r.tags?.['u.jisst.pinned']).length >= 3) return Promise.reject(new Error('You can pin up to 3 chats.'));
      return this.setTag(roomId, 'u.jisst.pinned', on, now() / 1e13);
    },
    archive(roomId, on) { return this.setTag(roomId, 'u.jisst.archived', on); },
    /** Mute a chat's alerts (a standard push rule, so the chat server stops alerting every phone). */
    async mute(roomId, on) {
      if (on) muted.add(roomId); else muted.delete(roomId);
      changed();
      const path = `${C}/pushrules/global/room/${enc(roomId)}`;
      return on ? call('PUT', path, { actions: [] }) : call('DELETE', path);
    },
    /** Disappearing messages: 0 (off) or seconds; new messages carry their end time. */
    setDisappear: (roomId, seconds) => call('PUT', `${C}/rooms/${enc(roomId)}/state/io.jisst.disappear/`, { seconds }),
    /** Block a person: you stop seeing their messages anywhere (the standard ignore list, kept by the chat server). */
    async block(uid, on) {
      if (on) blocked.add(uid); else blocked.delete(uid);
      changed();
      return call('PUT', `${C}/user/${enc(user_id)}/account_data/m.ignored_user_list`, { ignored_users: Object.fromEntries([...blocked].map((u) => [u, {}])) });
    },
    blocked: () => [...blocked].map((id) => ({ id, name: names.get(id) || id })),
    /** Privacy: last seen and read ticks, kept in account data so every phone you use follows it. */
    privacy: () => ({ ...privacy }),
    async setPrivacy(p) {
      privacy = { ...privacy, ...p }; privacyBusy++; changed();
      try {
        await call('PUT', `${C}/user/${enc(user_id)}/account_data/io.jisst.privacy`, privacy);
        await call('PUT', `${C}/presence/${enc(user_id)}/status`, { presence: privacy.lastSeen ? 'online' : 'offline' }).catch(() => {});
      } finally { privacyBusy--; }
    },
    /** { online, at } for a person, or null when they hide it (or you hide yours: last seen works both ways too). */
    presenceOf(uid) { const p = privacy.lastSeen && presence.get(uid); return p && (p.online || p.at) ? { ...p } : null; },
    /** Communities: one space with an announcements channel only its admins post in, and the groups that belong to it. */
    communities: () => [...rooms.values()].filter((r) => r.space && r.membership === 'join').map(community).sort((a, b) => a.name.localeCompare(b.name)),
    community: (id) => { const r = rooms.get(id); return r?.space ? community(r) : null; },
    async createCommunity(name, about, ids) {
      if (ids.some((u) => agents.has(u))) throw new Error('Add agents to a group inside the community, not to the community itself.');
      const { room_id: space } = await call('POST', `${C}/createRoom`, { name, topic: about || undefined, invite: ids, preset: 'private_chat', creation_content: { type: 'm.space' },
        power_level_content_override: { events_default: 100, users: { [user_id]: 100 } } });
      const { room_id: ann } = await call('POST', `${C}/createRoom`, { name: 'Announcements', topic: `News for everyone in ${name}`, invite: ids, preset: 'private_chat',
        power_level_content_override: { events_default: 50, users: { [user_id]: 100 } }, initial_state: [...(cryptoFailed ? [] : [ENCRYPTION]), { type: 'io.jisst.announcements', state_key: '', content: {} }] });
      await link(space, ann, { order: '0', 'io.jisst.announcements': true });
      return space;
    },
    /** A new group inside a community, with everyone in the community in it. */
    async addCommunityGroup(spaceId, name, extra = []) {
      const sp = rooms.get(spaceId), ids = [...new Set([...[...(sp?.members.values() || [])].filter((m) => ['join', 'invite'].includes(m.membership) && m.id !== user_id).map((m) => m.id), ...extra])];
      const id = await this.createGroup(name, ids);
      await link(spaceId, id);
      return id;
    },
    /** Add someone to a community: the community, its announcements and its groups. */
    async inviteToCommunity(spaceId, uid) {
      const c = this.community(spaceId); if (!c) throw new Error('No such community.');
      await call('POST', `${C}/rooms/${enc(spaceId)}/invite`, { user_id: uid });
      for (const id of [c.announce, ...c.groups].filter(Boolean)) await call('POST', `${C}/rooms/${enc(id)}/invite`, { user_id: uid }).catch(() => {});
    },
    /** Status updates from the last 24 hours: yours first, then people with new ones, then the rest. */
    statuses() {
      const all = [...rooms.values()].filter((r) => r.status && r.membership === 'join' && r.creator && !blocked.has(r.creator)).map(statusOf);
      const mine = all.find((x) => x.mine) || { user: user_id, name: 'You', mine: true, roomId: null, items: [], unseen: 0, ts: 0 };
      return [mine, ...all.filter((x) => !x.mine && x.items.length).sort((a, b) => (b.unseen > 0) - (a.unseen > 0) || b.ts - a.ts)];
    },
    async postStatus({ text, bg, file }) {
      const r = await statusRoom();
      if (file) return this.sendFile(r.id, file, file.type.startsWith('video/') ? 'video' : 'image');
      return sendContent(r.id, { msgtype: 'm.text', body: String(text).slice(0, 700), 'io.jisst.bg': bg || '' });
    },
    /** Mark a status as seen (the owner sees who has seen it, unless your read ticks are off). */
    seeStatus(roomId, eventId) {
      const r = rooms.get(roomId); if (!r || !eventId || eventId.startsWith('j')) return;
      if (r.readUpTo && !later(r, eventId, r.readUpTo)) return;
      r.readUpTo = eventId; changed();
      call('POST', `${C}/rooms/${enc(roomId)}/receipt/${privacy.readTicks ? 'm.read' : 'm.read.private'}/${enc(eventId)}`, {}).catch(() => {});
    },
    /** Chat backup with a recovery key (crypto.js): 'on', 'locked', 'off', or 'none' where private chats can't run. */
    backup: async () => (crypto ? crypto.backup() : 'none'),
    makeRecovery: async () => { if (!crypto) throw new Error('Private chats need a newer browser.'); return crypto.makeRecovery(); },
    async restore(key) { if (!crypto) throw new Error('Private chats need a newer browser.'); const n = await crypto.restore(key); await retryLocked(); changed(); return n; },
    /** Report a message to the people who run Jisste. */
    report: (roomId, eventId, reason) => call('POST', `${C}/rooms/${enc(roomId)}/report/${enc(eventId)}`, { reason: String(reason).slice(0, 500), score: -100 }),
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
      call('POST', `${C}/rooms/${enc(roomId)}/receipt/${privacy.readTicks ? 'm.read' : 'm.read.private'}/${enc(last.event_id)}`, {}).catch(() => {});
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
    async signOut() { stopped = true; clearInterval(sweeper); crypto?.close(); await call('POST', `${C}/logout`, {}).catch(() => {}); },
    /** The call() helper, for features that talk to the chat server directly (calls check membership with it). */
    token: () => access_token,
  };
}
