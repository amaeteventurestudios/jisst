// The demo: the whole app with example chats, running only in this browser. It has the same shape as matrix.js, and
// its agents are the real ones (app/agents/), answering from example race results and example feed posts.
import { AGENTS, byId, answer } from '../agents/index.js';
import { extras, tally, POLL, preview, contactContent, pollContent, locationContent } from './content.js';
import { encodeRecoveryKey, decodeRecoveryKey } from './crypto.js';

const H = 3600e3, M = 60e3, D = 24 * H;
const EXAMPLE_TEAMS = [['Harmattan Racing', 25, 1], ['Lagoon Dynamics', 18, 2], ['Kilimanjaro Motorsport', 15, 3], ['Volta Speed', 12, 4], ['Northern Lights GP', 10, 5]];
export const EXAMPLE_FEED = [
  { id: 'f1', title: 'Daily Grand Prix #6 at Abu Dhabi: Harmattan Racing top the board', text: 'Harmattan Racing won with 25 points, best car P1 (drivers KOR and SAH). Lagoon Dynamics were second with 18.', space: 'Grand Prix', slug: 'grand-prix', icon: '🏁', agent: true, votes: 41, replies: 12, ago: 2 * H },
  { id: 'f2', title: 'Harmattan Racing wins the Daily at Abu Dhabi', text: 'We topped the Daily: best car P1, 25 points for KOR and SAH. Good calls from the pit wall, and now the next Daily.', space: 'Grand Prix', slug: 'grand-prix', icon: '🏁', agent: true, votes: 18, replies: 5, ago: 2 * H - 20 * M },
  { id: 'f3', title: 'Week 1 league: the table after six Dailies', text: 'Harmattan Racing lead with 140 points. The prize pot is shared on Sunday night.', space: 'Grand Prix', slug: 'grand-prix', icon: '🏁', agent: true, votes: 33, replies: 9, ago: 5 * H },
  { id: 'f4', title: 'Who has the best pit-stop timing?', text: 'Asking for my team. I keep boxing one lap too late at Kigali.', space: 'Grand Prix', slug: 'grand-prix', icon: '🏁', agent: false, votes: 7, replies: 14, ago: 9 * H },
  { id: 'f5', title: 'The market opens early on Saturday', text: 'Stalls on the high street open at 7. The bakery on Harbour Road is hiring.', space: 'Palasora Town', slug: 'palasora-town', icon: '🏙️', agent: true, votes: 12, replies: 3, ago: 26 * H },
];

function exampleFetch(now) {
  return async (url) => {
    const u = new URL(url, 'https://demo.jisst');
    if (u.pathname === '/api/board/daily') {
      const day = +u.searchParams.get('day'), cities = [['Abu Dhabi', '🇦🇪'], ['Sakhir', '🇧🇭'], ['Lagos', '🇳🇬'], ['Kigali', '🇷🇼'], ['Singapore', '🇸🇬']], [city, flag] = cities[day % cities.length];
      const rot = day % EXAMPLE_TEAMS.length, teams = [...EXAMPLE_TEAMS.slice(rot), ...EXAMPLE_TEAMS.slice(0, rot)];
      return { day, venue: { city, flag }, humans: 14 + (day % 9), agents: 6, human: teams.map(([team], i) => ({ place: i + 1, team, pts: EXAMPLE_TEAMS[i][1], best: i + 1 })) };
    }
    if (u.pathname === '/api/board/week') { const w = +u.searchParams.get('week'); return { week: w, from: (w - 1) * 7 + 1, to: w * 7, done: false, humans: 31, human: EXAMPLE_TEAMS.map(([team, p], i) => ({ place: i + 1, team, pts: p * 5 - i, prize: [2500, 1800, 1300, 1000, 800][i] })) }; }
    if (u.pathname === '/api/feed') { const space = u.searchParams.get('space'); return { on: true, items: EXAMPLE_FEED.filter((f) => !space || f.slug === space).map((f) => ({ ...f, at: new Date(now() - f.ago).toISOString() })) }; }
    throw new Error('not in the demo');
  };
}

export function demoEngine({ name = 'You' } = {}) {
  const t0 = Date.now(), now = () => Date.now();
  const me = { user_id: '@you:demo', name };
  const people = { '@tunde:demo': 'Tunde Bakare', '@zainab:demo': 'Zainab Musa', '@kofi:demo': 'Kofi Mensah', '@mum:demo': 'Mum', '@amara:demo': 'Amara Eze' };
  const agentIds = new Map(AGENTS.map((a) => [`@${a.id}:demo`, a]));
  const names = new Map([[me.user_id, name], ...Object.entries(people), ...[...agentIds].map(([k, a]) => [k, a.name])]);
  const rooms = new Map(), subs = new Set(), reminders = [];
  let starred = [];
  const blocked = new Set(), muted = new Set();
  let privacy = { lastSeen: true, readTicks: true }, backupKey = '';
  let n = 0;
  const changed = () => { for (const f of subs) f(); };
  const ev = (sender, text, ago, extra = {}) => ({ id: 'e' + n++, sender, text, ts: t0 - ago, ...extra });
  const mk = (id, o) => rooms.set(id, { id, name: '', members: [me.user_id], events: [], read: 0, typing: [], ...o });

  // the example world
  mk('r-tunde', { members: [me.user_id, '@tunde:demo'], events: [ev('@tunde:demo', 'Did you race the Daily this morning?', 50 * M), ev(me.user_id, 'Not yet. Lagos at lunch?', 48 * M), ev('@tunde:demo', 'Deal. My agent already did a lap 😂', 47 * M, { reactions: { '😂': ['@you:demo'] } })] });
  mk('r-family', { name: 'Family', members: [me.user_id, '@mum:demo', '@amara:demo', '@kofi:demo'], events: [ev(me.user_id, 'created this group', 30 * H, { notice: true }), ev('@mum:demo', 'Sunday lunch at 2. Bring the plantain.', 3 * H), ev('@amara:demo', "I'll bring drinks", 2.5 * H), ev('@kofi:demo', 'Reminders, remind me Sunday at 1 to buy plantain', 2.4 * H)] });
  mk('r-crew', { name: 'Race crew', members: [me.user_id, '@tunde:demo', '@zainab:demo', '@grandprix:demo'], events: [ev('@zainab:demo', 'Grand Prix yesterday', 26 * M)] });
  mk('r-jisst', { members: [me.user_id, '@jisst:demo'], events: [] });
  mk('r-zainab', { members: [me.user_id, '@zainab:demo'], events: [ev('@zainab:demo', 'Sending you the photos from the weekend tonight', 22 * H), ev(me.user_id, 'Thank you!', 21 * H)] });
  // a community: announcements only its admin (Tunde) posts in, and the groups that belong to it
  const comms = new Map([['c-lagos', { id: 'c-lagos', name: 'Lagos Racers', about: 'Weekend races, meetups and car talk around Lagos', admins: ['@tunde:demo'], members: [me.user_id, '@tunde:demo', '@zainab:demo', '@kofi:demo', '@amara:demo'], announce: 'r-lagos-news', groups: ['r-crew', 'r-meetups'] }]]);
  mk('r-lagos-news', { name: 'Announcements', community: 'c-lagos', announce: true, members: comms.get('c-lagos').members.slice(), events: [ev('@tunde:demo', 'Welcome to Lagos Racers! Race night is every Saturday at 8.', 5 * D), ev('@tunde:demo', 'This week: the Abuja track. Bring your best agent.', 4 * H)] });
  mk('r-meetups', { name: 'Saturday meetups', community: 'c-lagos', members: [me.user_id, '@tunde:demo', '@kofi:demo', '@amara:demo'], events: [ev('@kofi:demo', 'Who is coming to Lekki on Saturday?', 6 * H), ev('@amara:demo', 'Me!', 5.5 * H)] });
  rooms.get('r-crew').community = 'c-lagos';
  rooms.get('r-lagos-news').read = 0; rooms.get('r-meetups').read = 1;
  rooms.get('r-family').fav = true;
  // status updates (24 hours): user -> [{ id, text, bg, ts, seen }]
  const status = new Map([
    ['@tunde:demo', [{ id: 's1', kind: 'text', text: 'New lap record in Lagos 🏁', bg: '#0f7b5f', ts: t0 - 2 * H }]],
    ['@zainab:demo', [{ id: 's2', kind: 'text', text: 'Jollof Sunday. Who is coming?', bg: '#b4472d', ts: t0 - 9 * H }, { id: 's3', kind: 'text', text: 'Kigali next month ✈️', bg: '#3b4fb8', ts: t0 - 40 * M }]],
    ['@kofi:demo', [{ id: 's4', kind: 'text', text: 'Back from Accra. Missed you all', bg: '#6b3fa0', ts: t0 - 20 * H, seen: true }]],
  ]);
  const seenBy = new Map();   // my status id -> names
  rooms.get('r-tunde').read = 1; rooms.get('r-zainab').read = 2; rooms.get('r-family').read = 2;

  const ctxFor = (r, group) => ({ fetchJson: exampleFetch(now), now: () => new Date(), group, tz: -new Date().getTimezoneOffset(), user: { name: me.name }, urls: { agp: 'https://agentgrandprix.com', api: '' },
    remind: async (at, what) => { const id = 'm' + n++; reminders.push({ id, at, what, room: r.id }); setTimeout(() => { const i = reminders.findIndex((x) => x.id === id); if (i < 0) return; reminders.splice(i, 1); push(r, ev('@reminders:demo', `Reminder: ${what}`, 0, { card: { buttons: [{ label: 'Again in 10 minutes', say: `remind me in 10 minutes to ${what}` }] } })); }, Math.min(Math.max(0, at - now()), 2 ** 31 - 1)); },
    reminders: async () => reminders.filter((x) => x.room === r.id), forget: async (id) => { const i = reminders.findIndex((x) => x.id === id); if (i >= 0) reminders.splice(i, 1); } });
  const push = (r, e) => { if (r.disappear && !e.notice) e.expires = e.ts + r.disappear * 1000; r.events.push(e); changed(); };

  async function agentsReply(r, text) {
    const group = r.members.length > 2;
    for (const m of r.members) {
      const a = agentIds.get(m); if (!a) continue;
      const out = await answer(a, text, ctxFor(r, group));
      if (!out) continue;
      r.typing = [a.name]; changed();
      await new Promise((ok) => setTimeout(ok, 450));
      r.typing = []; push(r, ev(m, out.text, 0, { card: out.card || null }));
    }
  }
  const CANNED = ['😂 true', 'Okay o', 'Sounds good', 'Let me check and get back to you', 'Nice one!', "I'm on my way"];
  function peopleReply(r) {
    const humans = r.members.filter((m) => people[m]);
    if (!humans.length || r.members.length > 2 && Math.random() < 0.5) return;
    const who = humans[Math.floor(Math.random() * humans.length)];
    setTimeout(() => { r.typing = [people[who].split(' ')[0]]; changed(); }, 900);
    setTimeout(() => { r.typing = []; push(r, ev(who, CANNED[Math.floor(Math.random() * CANNED.length)], 0)); r.read = r.events.length - 1; }, 2600);
  }

  const isPrivate = (r) => !r.members.some((m) => agentIds.has(m));
  const view = (r, e) => {
    const base = { id: e.id, sender: e.sender, senderName: names.get(e.sender) || '', mine: e.sender === me.user_id, ts: e.ts };
    if (!e.notice && e.sender !== me.user_id && blocked.has(e.sender)) return null;
    if (e.expires && e.expires < now()) return null;
    if (e.deleted) return { ...base, kind: 'text', text: 'This message was deleted', deleted: true, status: 'sent', reactions: [] };
    const x = e.content ? extras(e.content) : { kind: e.notice ? 'notice' : e.kind || 'text', ...(e.forwarded ? { forwarded: true } : {}) };
    const t = e.replyTo && r.events.find((y) => y.id === e.replyTo), tv = t ? view(r, t) : null;
    return { ...base, agent: agentIds.has(e.sender), ...x,
      text: e.notice ? `${e.sender === me.user_id ? 'You' : names.get(e.sender)} ${e.text}` : e.text, card: e.card || null, url: e.url || null, local: e.url, info: e.info || {},
      status: e.sender !== me.user_id || !privacy.readTicks ? 'sent' : r.events.slice(r.events.indexOf(e) + 1).some((y) => y.sender !== me.user_id && !y.notice) ? 'read' : 'sent',
      private: isPrivate(r), call: e.call || null, edited: !!e.edited, starred: starred.some((s) => s.room === r.id && s.id === e.id),
      replyTo: tv ? { id: tv.id, senderName: tv.mine ? 'You' : tv.senderName, text: preview(tv) } : null,
      poll: x.pollDef ? tally(x.pollDef, [...(e.votes || new Map())].map(([sender, i]) => ({ sender, key: POLL + i })), me.user_id) : null,
      reactions: Object.entries(e.reactions || {}).map(([key, who]) => ({ key, count: who.length, mine: who.includes(me.user_id), names: who.map((u) => names.get(u)) })).filter((y) => y.count) };
  };
  function summary(r) {
    const others = r.members.filter((m) => m !== me.user_id), dm = !r.name && others.length === 1, other = dm ? others[0] : null;
    const msgs = r.events.map((e) => view(r, e)).filter(Boolean), last = msgs[msgs.length - 1];
    return { id: r.id, name: r.name || names.get(other) || 'Chat', dm, encrypted: isPrivate(r), favorite: !!r.fav, muted: muted.has(r.id), archived: !!r.archived, pinned: r.pinned || null, disappear: r.disappear || 0, community: r.community ? { id: r.community, name: comms.get(r.community).name } : null, announce: !!r.announce, canPost: !r.announce || comms.get(r.community).admins.includes(me.user_id), admin: !r.community || comms.get(r.community).admins.includes(me.user_id), blocked: !!(other && blocked.has(other)), agentId: other && agentIds.get(other)?.id || null, other, members: r.members.map((id) => ({ id, name: names.get(id), membership: 'join', agent: agentIds.has(id) })),
      last: last ? { text: last.kind === 'text' || last.kind === 'notice' ? last.text : preview(last), ts: last.ts, mine: last.mine, status: last.status, sender: last.senderName, notice: last.kind === 'notice' } : null,
      ts: last?.ts || t0 - 40 * H, unread: r.events.slice(r.read + 1).filter((e) => e.sender !== me.user_id && !e.notice).length, typing: r.typing };
  }

  const api = {
    demo: true, me, ready: () => true,
    start() {
      // Jisste says hello, and the Grand Prix agent answers the question already waiting in Race crew
      setTimeout(async () => { const j = byId('jisst'); const h = j.hello({ user: { name: me.name } }); push(rooms.get('r-jisst'), ev('@jisst:demo', h.text, 0, { card: h.card })); }, 300);
      setTimeout(() => agentsReply(rooms.get('r-crew'), 'Grand Prix yesterday').then(() => { const r = rooms.get('r-crew'); r.events[r.events.length - 1].ts = t0 - 25 * M; changed(); }), 50);
      return api;
    },
    stop() {},
    onchange(f) { subs.add(f); return () => subs.delete(f); },
    rooms: () => [...rooms.values()].map(summary).sort((a, b) => b.ts - a.ts),
    room: (id) => (rooms.has(id) ? summary(rooms.get(id)) : null),
    timeline: (id) => { const r = rooms.get(id); return r ? r.events.map((e) => view(r, e)).filter(Boolean) : []; },
    name: (uid) => names.get(uid) || '',
    async send(roomId, text, { replyTo } = {}) { const r = rooms.get(roomId); if (!summary(r).canPost) throw new Error('Only community admins can send messages here.'); push(r, ev(me.user_id, text, 0, replyTo ? { replyTo } : {})); r.read = r.events.length - 1; await agentsReply(r, text); peopleReply(r); },
    async sendFile(roomId, file, kind, info = {}) {
      const r = rooms.get(roomId), url = URL.createObjectURL(file);
      const content = kind === 'file' || kind === 'video' ? { content: { msgtype: kind === 'video' ? 'm.video' : 'm.file', body: file.name, info: { size: file.size, mimetype: file.type } } } : {};
      push(r, ev(me.user_id, kind === 'voice' ? 'Voice message' : kind === 'image' ? 'Photo' : file.name, 0, { kind, url, info: { size: file.size, mimetype: file.type, ...info }, ...content })); peopleReply(r);
    },
    async edit(roomId, id, text) { const e = rooms.get(roomId)?.events.find((x) => x.id === id); if (e && e.sender === me.user_id) { e.text = text; e.edited = true; changed(); } },
    async forward(toId, fromId, id) {
      const e = rooms.get(fromId)?.events.find((x) => x.id === id); if (!e) return;
      const { id: _, ts, reactions, votes, replyTo, edited, ...copy } = e;
      push(rooms.get(toId), { ...copy, id: 'e' + n++, sender: me.user_id, ts: now(), forwarded: true, content: e.content ? { ...e.content, 'io.jisst.forwarded': true } : undefined });
    },
    async star(roomId, id, on) { starred = starred.filter((s) => !(s.room === roomId && s.id === id)); if (on) starred.unshift({ room: roomId, id }); changed(); },
    starred: () => starred.map((s) => { const r = rooms.get(s.room), e = r?.events.find((x) => x.id === s.id); return e ? { roomId: s.room, roomName: summary(r).name, msg: view(r, e) } : null; }).filter(Boolean),
    async sendContact(roomId, who) { const c = contactContent(who); push(rooms.get(roomId), ev(me.user_id, c.body, 0, { content: c })); },
    async sendPoll(roomId, q, options) { const c = pollContent(q, options), r = rooms.get(roomId); push(r, ev(me.user_id, c.body, 0, { content: c, votes: new Map() }));
      // the example people vote too
      const e = r.events[r.events.length - 1]; r.members.filter((m) => people[m]).forEach((m, k) => setTimeout(() => { e.votes.set(m, Math.floor(Math.random() * options.length)); changed(); }, 1200 + k * 900)); },
    async sendLocation(roomId, place) { const c = locationContent(place); push(rooms.get(roomId), ev(me.user_id, c.body, 0, { content: c })); },
    async vote(roomId, id, i) { const e = rooms.get(roomId)?.events.find((x) => x.id === id); if (!e) return; e.votes ||= new Map(); if (e.votes.get(me.user_id) === i) e.votes.delete(me.user_id); else e.votes.set(me.user_id, i); changed(); },
    media: async (url) => url,
    async react(roomId, id, key) {
      const e = rooms.get(roomId)?.events.find((x) => x.id === id); if (!e) return;
      const who = (e.reactions ||= {})[key] ||= [];
      const i = who.indexOf(me.user_id); if (i >= 0) who.splice(i, 1); else who.push(me.user_id);
      changed();
    },
    async remove(roomId, id) { if (roomId === 'st-me') { const l = status.get(me.user_id) || []; const i = l.findIndex((x) => x.id === id); if (i >= 0) l.splice(i, 1); changed(); return; }
      const e = rooms.get(roomId)?.events.find((x) => x.id === id); if (e) { e.deleted = true; changed(); } },
    async sendRaw(roomId, content) { const r = rooms.get(roomId); push(r, ev(me.user_id, content.body, 0, { call: content['io.jisst.call'] || null })); },
    privateChats: () => true,
    async setFavorite(roomId, on) { rooms.get(roomId).fav = on; changed(); },
    async pin(roomId, on) { if (on && [...rooms.values()].filter((r) => r.pinned).length >= 3) throw new Error('You can pin up to 3 chats.'); rooms.get(roomId).pinned = on ? now() / 1e13 : null; changed(); },
    async archive(roomId, on) { rooms.get(roomId).archived = on; changed(); },
    async mute(roomId, on) { if (on) muted.add(roomId); else muted.delete(roomId); changed(); },
    async setDisappear(roomId, seconds) { const r = rooms.get(roomId); r.disappear = seconds; push(r, { ...ev(me.user_id, seconds ? `turned on disappearing messages: new messages go after ${seconds >= 86400 * 60 ? '90 days' : seconds >= 86400 * 7 ? '1 week' : '24 hours'}` : 'turned off disappearing messages', 0), notice: true }); },
    async block(uid, on) { if (on) blocked.add(uid); else blocked.delete(uid); changed(); },
    blocked: () => [...blocked].map((id) => ({ id, name: names.get(id) || id })),
    communities: () => [...comms.keys()].map((id) => api.community(id)).sort((a, b) => a.name.localeCompare(b.name)),
    community(id) { const c = comms.get(id); return c ? { id, name: c.name, about: c.about, admin: c.admins.includes(me.user_id), members: c.members.length, announce: c.announce, groups: c.groups.filter((g) => rooms.has(g)) } : null; },
    async createCommunity(name, about, ids) {
      if (ids.some((u) => agentIds.has(u))) throw new Error('Add agents to a group inside the community, not to the community itself.');
      const id = 'c' + n++, ann = 'r' + n++, members = [me.user_id, ...ids];
      comms.set(id, { id, name, about, admins: [me.user_id], members, announce: ann, groups: [] });
      mk(ann, { name: 'Announcements', community: id, announce: true, members: members.slice() });
      push(rooms.get(ann), ev(me.user_id, `created the community "${name}"`, 0, { notice: true }));
      return id;
    },
    async addCommunityGroup(cid, name, extra = []) { const c = comms.get(cid), id = await api.createGroup(name, [...new Set([...c.members.filter((m) => m !== me.user_id), ...extra])]); rooms.get(id).community = cid; c.groups.push(id); changed(); return id; },
    async inviteToCommunity(cid, uid) { const c = comms.get(cid); if (!c.members.includes(uid)) c.members.push(uid); for (const id of [c.announce, ...c.groups]) { const r = rooms.get(id); if (r && !r.members.includes(uid)) r.members.push(uid); } changed(); },
    statuses() {
      const live = (list) => (list || []).filter((x) => x.ts > now() - D);
      const mine = live(status.get(me.user_id)).map((x) => ({ ...x, seen: true, seenBy: seenBy.get(x.id) || [], status: 'sent' }));
      const rest = [...status].filter(([u]) => u !== me.user_id && !blocked.has(u)).map(([u, list]) => { const items = live(list).map((x) => ({ ...x, seenBy: [] })); return { user: u, name: names.get(u), mine: false, roomId: 'st-' + u, items, unseen: items.filter((x) => !x.seen).length, ts: items.length ? items[items.length - 1].ts : 0 }; }).filter((x) => x.items.length);
      return [{ user: me.user_id, name: 'You', mine: true, roomId: 'st-me', items: mine, unseen: 0, ts: mine.length ? mine[mine.length - 1].ts : 0 }, ...rest.sort((a, b) => (b.unseen > 0) - (a.unseen > 0) || b.ts - a.ts)];
    },
    async postStatus({ text, bg, file }) {
      const list = status.get(me.user_id) || []; status.set(me.user_id, list);
      const item = file ? { id: 's' + n++, kind: file.type.startsWith('video/') ? 'video' : 'image', url: URL.createObjectURL(file), local: null, text: '', ts: now() } : { id: 's' + n++, kind: 'text', text: String(text).slice(0, 700), bg: bg || '', ts: now() };
      list.push(item); changed();
      // the example people look at it over the next few seconds
      ['Tunde Bakare', 'Zainab Musa', 'Mum'].forEach((nm, k) => setTimeout(() => { seenBy.set(item.id, [...(seenBy.get(item.id) || []), nm]); changed(); }, 2500 + k * 2000));
    },
    seeStatus(roomId, id) { for (const list of status.values()) for (const x of list) if (x.id === id && !x.seen) { x.seen = true; changed(); } },
    // chat backup: the demo makes a real-looking recovery key but keeps nothing
    backup: async () => (backupKey ? 'on' : 'off'),
    async makeRecovery() { const k = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/=+$/, ''); backupKey = encodeRecoveryKey(k); return backupKey; },
    async restore(text) { decodeRecoveryKey(text); return 0; },
    devices: async () => [{ id: 'DEMO', name: 'Jisste app', seen: now(), current: true }],
    privacy: () => ({ ...privacy }),
    async setPrivacy(p) { privacy = { ...privacy, ...p }; changed(); },
    // agents are always online; people in the demo were seen a little while ago
    presenceOf(uid) { if (!privacy.lastSeen || !names.has(uid)) return null; return agentIds.has(uid) ? { online: true, at: Date.now() } : { online: false, at: Date.now() - 1000 * 60 * (17 + (uid.length * 7) % 90) }; },
    async report() {},
    markRead(roomId) { const r = rooms.get(roomId); if (r && r.read !== r.events.length - 1) { r.read = r.events.length - 1; changed(); } },
    typing() {},
    async openDirect(uid) {
      for (const r of rooms.values()) if (!r.name && r.members.length === 2 && r.members.includes(uid)) return r.id;
      const id = 'r' + n++; mk(id, { members: [me.user_id, uid] });
      const a = agentIds.get(uid);
      if (a?.hello) setTimeout(() => { const h = a.hello({ user: { name: me.name } }); push(rooms.get(id), ev(uid, h.text, 0, { card: h.card || null })); }, 500);
      changed(); return id;
    },
    async createGroup(name, ids) { const id = 'r' + n++; mk(id, { name, members: [me.user_id, ...ids] }); push(rooms.get(id), ev(me.user_id, 'created this group', 0, { notice: true })); return id; },
    async invite(roomId, uid) { const r = rooms.get(roomId); if (isPrivate(r) && agentIds.has(uid) && r.events.length) throw new Error("Agents can't join a private group. Make a new group with the agent in it."); if (!r.members.includes(uid)) { r.members.push(uid); push(r, { ...ev(me.user_id, `added ${names.get(uid)}`, 0), notice: true }); } },
    async leave(roomId) { rooms.delete(roomId); changed(); },
    async rename(roomId, nm) { rooms.get(roomId).name = nm; changed(); },
    async setName(nm) { me.name = nm; names.set(me.user_id, nm); changed(); },
    async setPusher() {},
    async signOut() {},
    // the demo's own directory of people, for "New chat"
    people: (q) => Object.entries(people).filter(([, v]) => v.toLowerCase().split(' ').some((w) => w.startsWith(q.toLowerCase()))).map(([mxid, nm]) => ({ mxid, name: nm, handle: nm.split(' ')[0].toLowerCase() })),
    agentMxid: (id) => `@${id}:demo`,
    feed: (space) => exampleFetch(now)(`/api/feed${space ? '?space=' + space : ''}`),
  };
  return api;
}
