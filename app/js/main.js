// Jisste, the app. Five tabs (Chats, Feed, Agents, Calls, You), WhatsApp-simple chats with people and agents, and the
// sign-in. The chat engine is matrix.js on a real server, or demo.js in the preview; the screens can't tell them apart.
import { api } from './api.js';
import { matrixEngine } from './matrix.js';
import { demoEngine, EXAMPLE_FEED } from './demo.js';
import { AGENTS, SOON } from '../agents/index.js';
import { BRAND, html, raw, esc, icon, avatar, when, hhmm, dayLabel, ago, linkify, toast, store } from './ui.js';
import { calls, callBubble, callStates } from './calls.js';
import { judge, known } from './safety.js';
import { preview } from './content.js';
import { qrSvg, scan } from './link.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $('#app');
const S = { compose: null, engine: null, demo: false, tab: 'chats', room: null, view: null, q: '', space: '', agents: null, feed: null, feedErr: false, pick: [], gateway: null, installEvt: null, pushOn: store.get('push', false), tr: {} };

// ---------- theme ----------
function applyTheme(t = store.get('theme', 'system')) { if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; }
applyTheme();

// ---------- agents: who in a chat is an agent ----------
const agentMeta = new Map();          // chat id (mxid) -> agent card info
function learnAgents(list) {
  S.agents = list;
  for (const a of [...(list.agents || []), ...(list.community || [])]) if (a.mxid) agentMeta.set(a.mxid, a);
}
const agentOf = (mxid) => agentMeta.get(mxid) || null;
const CALLS = calls({ getEngine: () => S.engine, isDemo: () => S.demo, roomInfo: (id) => S.engine.room(id) });

// ---------- start ----------
async function boot() {
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; });
  const wantDemo = new URLSearchParams(location.search).has('demo');
  S.gateway = wantDemo ? null : await api.health();
  // Visitor stats: page views only (no cookies, no names, never what anyone writes), and none for people who ask browsers not to track them
  if (S.gateway?.stats) { const t = document.createElement('script'); t.defer = true; t.src = S.gateway.stats.url + '/script.js'; t.dataset.websiteId = S.gateway.stats.site; t.dataset.doNotTrack = 'true'; t.dataset.excludeHash = 'true'; document.head.append(t); }
  if (!S.gateway) return startDemo(store.get('demoName', ''));
  // installed app and alerts: only on a real Jisste server (a preview copy has nothing to keep offline)
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  learnAgents(await api.agents().catch(() => ({ agents: [], soon: SOON, community: [] })));
  const chat = store.get('chat');
  if (chat?.access_token) return startLive(chat);
  try { const s = await api.session(); if (s.chat) { store.set('chat', s.chat); store.set('me', s.me); return startLive(s.chat); } } catch {}
  welcome();
}

function startLive(chat, fresh = false) {
  S.demo = false;
  S.engine = matrixEngine({ homeserver: chat.homeserver || location.origin, user_id: chat.user_id, access_token: chat.access_token, device_id: chat.device_id }, { agents: agentMeta }).start();
  S.engine.me.name = store.get('me')?.name || '';
  S.engine.onchange((e) => { if (e?.signedOut) { store.set('chat', null); toast('Please sign in again.'); return welcome(); } update(); });
  shell();
  if (S.pushOn) enablePush(true).catch(() => {});
  if (fresh) greet();
  // opened from a message alert
  const lk = /^#link=([\w-]+)$/.exec(location.hash);
  if (lk) { history.replaceState(null, '', location.pathname + location.search); if (confirm(`Link a computer to your ${BRAND.name}? Only say yes if you just scanned the code on your own computer.`)) approveLink(lk[1]); }
  const ck = /^#call=([^|]+)\|(.+)$/.exec(location.hash);
  if (ck) { history.replaceState(null, '', location.pathname + location.search); const rid = decodeURIComponent(ck[1]); openSoon(rid); answerSoon(rid, decodeURIComponent(ck[2])); }
  const m = /^#room=(.+)$/.exec(location.hash); if (m) { history.replaceState(null, '', location.pathname + location.search); openSoon(decodeURIComponent(m[1])); }
}
// a brand-new account starts with a chat with the Jisste helper instead of an empty list
function greet(tries = 40) {
  if (!S.engine?.ready()) { if (tries > 0) setTimeout(() => greet(tries - 1), 250); return; }
  const helper = S.agents?.agents?.find((a) => a.id === 'jisst');
  if (helper && !S.engine.rooms().length) S.engine.openDirect(helper.mxid).then((id) => { if (!S.room && !S.view) openSoon(id); }).catch(() => {});
}
// the chat list may still be loading when an alert opens a chat: wait for that room to arrive
function openSoon(id, then, tries = 40) { if (S.engine?.room(id)) { openRoom(id); return then?.(); } if (tries > 0) setTimeout(() => openSoon(id, then, tries - 1), 250); }
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.jisst === 'open' && e.data.room && S.engine) { S.view = null; openSoon(e.data.room); if (e.data.call) answerSoon(e.data.room, e.data.call); } });
// Answer from a ringing alert: wait for the chat and its call message, then join
function answerSoon(roomId, callId, tries = 50) {
  const m = S.engine?.timeline(roomId).find((x) => x.call && x.call.id === callId && x.call.state !== 'ended');
  if (m) { if (!CALLS.active()) CALLS.join(roomId, m.call); return; }
  if (tries > 0) setTimeout(() => answerSoon(roomId, callId, tries - 1), 200); else toast('That call has ended.');
}
function startDemo(name) {
  S.demo = true;
  if (!name) return welcome();
  const e = demoEngine({ name });
  learnAgents({ agents: AGENTS.map((a) => ({ id: a.id, name: a.name, about: a.about, glyph: a.glyph, color: a.color, kind: a.kind, commands: a.commands, mxid: e.agentMxid(a.id) })), soon: SOON, community: [] });
  S.engine = e.start();
  S.engine.onchange(update);
  shell();
}

// ---------- welcome and sign-in ----------
function demoBar() { return S.demo ? html`<div class="demo-bar"><span>Demo with example chats</span>${S.engine ? html`<button data-act="leave-demo">Start over</button>` : ''}</div>` : ''; }
function welcome(step = 'start', data = {}) {
  S.engine = null;
  const pts = html`<div class="points">
      <div>${icon('chats')}<span>Chat with friends, family and groups</span></div>
      <div>${icon('agents')}<span>Add as many AI agents as you like</span></div>
      <div>${icon('feed')}<span>Follow the news from your games</span></div></div>`;
  let body;
  if (S.demo || !S.gateway) {
    body = html`<div class="mark">J</div><h1>Chat. Play.<br>Bring your agents.</h1><p class="lead">${BRAND.name} is a chat app for you, your people and your AI agents.</p>${pts}
      <form data-form="demo"><div class="field"><label for="dn">Your first name, for the demo</label><input id="dn" name="name" autocomplete="given-name" maxlength="30" placeholder="Ada" required></div>
      <button class="btn">Try the demo</button></form>
      <p class="fine">This preview runs in your browser with example chats. Nothing you type leaves this page.</p>`;
  } else if (step === 'start') {
    body = html`<div class="mark">J</div><h1>Chat. Play.<br>Bring your agents.</h1><p class="lead">${BRAND.name} is a chat app for you, your people and your AI agents.</p>${pts}
      ${S.gateway?.ways?.email === false ? html`<p class="note">Email sign-in opens soon on this server.</p>${data.err ? html`<p class="err">${data.err}</p>` : ''}` : html`<form data-form="email"><div class="field"><label for="em">Your email</label><input id="em" name="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" required></div>
      ${data.err ? html`<p class="err">${data.err}</p>` : ''}<button class="btn">Continue</button></form>`}
      ${S.gateway?.ways?.dev ? html`<form data-form="dev"><div class="field"><label for="dv">Test sign-in (this server only)</label><input id="dv" name="name" placeholder="Your name" required></div><button class="btn ghost">Sign in for testing</button></form>` : ''}
      <button class="btn plain" data-act="try-demo">Look around first</button>
      <p class="fine">One account for ${BRAND.name} and every Noveniqe game. We email you a 6-digit code; there's no password.</p>`;
  } else if (step === 'code') {
    body = html`<div class="mark">J</div><h1>Check your email</h1><p class="lead">We sent a 6-digit code to ${data.masked || data.email}.</p>
      <form data-form="code" data-email="${data.email}"><div class="field"><label for="cd">Code</label><input id="cd" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="123456" required></div>
      ${data.err ? html`<p class="err">${data.err}</p>` : ''}<button class="btn">Sign in</button></form><button class="btn plain" data-act="restart">Use another email</button>`;
  } else if (step === 'profile') {
    body = html`<div class="mark">J</div><h1>Welcome!</h1><p class="lead">Pick the name your friends will see, and an @handle they can find you by.</p>
      <form data-form="profile"><div class="field"><label for="pn">Your name</label><input id="pn" name="display_name" maxlength="40" value="${data.suggest || ''}" required></div>
      <div class="field"><label for="ph">@handle</label><input id="ph" name="handle" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" placeholder="ada_obi" required></div>
      ${data.err ? html`<p class="err">${data.err}</p>` : ''}<button class="btn">Done</button></form>`;
  }
  const linkCard = !S.demo && S.gateway && step === 'start' && innerWidth >= 900;
  app.innerHTML = String(html`${demoBar()}<main class="welcome ${linkCard ? 'withlink' : ''}"><div class="inner">${body}</div>${linkCard ? html`<aside class="linkcard" id="linkcard"><h2>Use ${BRAND.name} on this computer</h2>
    <ol><li>Open ${BRAND.name} on your phone</li><li>Go to <b>You</b>, then <b>Linked computers</b></li><li>Tap <b>Link a computer</b> and point your phone at this code</li></ol>
    <div class="qr" id="qr"><span class="spin"></span></div><p class="fine" id="qrshort"></p></aside>` : ''}</main>`);
  if (linkCard) showLinkCode(); else stopLinkCode();
  $('input', app)?.focus();
}
// ---------- link this computer by QR code ----------
let linkT = 0;
function stopLinkCode() { clearTimeout(linkT); linkT = 0; }
async function showLinkCode() {
  stopLinkCode();
  const box = $('#qr'); if (!box) return;
  const ua = navigator.userAgent, device = `${/Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'a browser'} on ${/Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'a computer'}`;
  let l;
  try { l = await api.linkStart(device); box.innerHTML = await qrSvg(l.url); $('#qrshort').textContent = `No camera? Type ${l.short} on your phone.`; }
  catch (e) { box.innerHTML = ''; $('#qrshort').textContent = e.message; linkT = setTimeout(showLinkCode, 15000); return; }
  const until = Date.now() + (l.expires - 5) * 1000;
  const poll = async () => {
    if (!$('#qr')) return stopLinkCode();
    if (Date.now() > until) return showLinkCode();
    try {
      const r = await api.linkPoll(l.code, l.secret);
      if (r.chat) { stopLinkCode(); store.set('chat', r.chat); store.set('me', r.me); return startLive(r.chat); }
    } catch (e) { if (e.status === 404 || e.status === 410) return showLinkCode(); }
    linkT = setTimeout(poll, 2000);
  };
  linkT = setTimeout(poll, 2000);
}
async function approveLink(code) {
  try { const r = await api.linkApprove(code); toast(`Linked: ${BRAND.name} on ${r.device}`); if (S.view === 'devices') side(); }
  catch (e) { toast(e.message); }
}
let scanStop = null;
function openScanner() {
  sheet(html`<div class="picker scanner"><h3>Link a computer</h3><p class="fine">On the computer, open ${BRAND.site.replace('https://', '')} and point your phone at the QR code.</p>
    <div class="cam"><video id="scanv" muted playsinline></video><i class="frame"></i></div>
    <form data-form="linkcode" class="linkform"><input name="code" placeholder="Or type the code, like ABCD-EFGH" autocomplete="off" autocapitalize="characters" maxlength="9"><button class="btn">Link</button></form></div>`, 'Link a computer');
  scan($('#scanv'), (code) => { scanStop = null; closeSheet(); approveLink(code); })
    .then((stop) => { if ($('#scanv')) scanStop = stop; else stop(); })
    .catch(() => { const c = $('.scanner .cam'); if (c) c.outerHTML = String(html`<p class="note">The camera isn't available here. Type the code the computer shows instead.</p>`); });
}
function viewDevices() {
  const list = S.devices;
  return html`${top('Linked computers', { back: true })}<div class="scroll">
    <div class="pad"><p class="fine" style="text-align:left">Use ${BRAND.name} on a computer: it stays in step with this phone. Private chats stay private on every device; to read older private messages there, turn on Chat backup and enter your recovery key.</p>
    <button class="btn" data-act="link-scan" ${raw(S.demo ? 'disabled' : '')}>${icon('camera')} Link a computer</button>${S.demo ? html`<p class="fine">Works on the real app.</p>` : ''}</div>
    <div class="section">Signed in</div>
    ${!list ? html`<div class="empty"><span class="spin"></span></div>` : list.map((d) => html`<div class="row">${raw(`<span class="av sm" style="background:var(--brand)">${icon(d.current ? 'phone' : 'laptop')}</span>`)}<span class="mid"><span class="l1"><span class="name">${d.current ? 'This device' : d.name}</span></span><span class="l2"><span class="prev">${d.current ? d.name : d.seen ? 'Last active ' + ago(d.seen) : ''}</span></span></span>
      ${d.current ? '' : html`<button type="button" class="linkbtn" style="color:var(--danger)" data-act="device-out" data-dev="${d.id}">Sign out</button>`}</div>`)}</div>`;
}
async function loadDevices() { S.devices = await S.engine.devices().catch(() => []); if (S.view === 'devices') side(); }

async function onForm(form, e) {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form)), kind = form.dataset.form, btn = $('button', form);
  if (btn) btn.disabled = true;
  try {
    if (kind === 'demo') { store.set('demoName', f.name.trim()); return startDemo(f.name.trim()); }
    if (kind === 'email') { const r = await api.emailStart(f.email.trim()); return welcome('code', { email: f.email.trim(), masked: r.masked }); }
    if (kind === 'code' || kind === 'profile' || kind === 'dev') {
      const r = kind === 'code' ? await api.emailVerify(form.dataset.email, f.code) : kind === 'profile' ? await api.profile(f.display_name, f.handle) : await api.dev(f.name);
      if (r.needs_profile) return welcome('profile', { suggest: r.suggest });
      store.set('chat', r.chat); store.set('me', r.me); return startLive(r.chat, true);
    }
    if (kind === 'search') return;
    if (kind === 'linkcode') { if (!f.code.trim()) return; scanStop?.(); scanStop = null; closeSheet(); return approveLink(f.code.trim()); }
    if (kind === 'group') return S.addTo ? addMembers() : S.newComm ? makeCommunity(f) : makeGroup(f.name);
    if (kind === 'agent') return makeAgent(f);
    if (kind === 'rename') { await S.engine.setName(f.name.trim()); S.view = null; toast('Saved'); return side(); }
  } catch (err) {
    if (kind === 'code') return welcome('code', { email: form.dataset.email, err: err.message });
    if (kind === 'email' || kind === 'dev') return welcome('start', { err: err.message });
    if (kind === 'profile') return welcome('profile', { err: err.message, suggest: f.display_name });
    toast(err.message);
  } finally { if (btn) btn.disabled = false; }
}

// ---------- the shell ----------
const TABS = [['chats', 'Chats'], ['feed', 'Feed'], ['agents', 'Agents'], ['calls', 'Calls'], ['you', 'You']];
function tabs(cls) {
  const unread = S.engine ? S.engine.rooms().filter((r) => r.unread).length : 0;
  return html`${TABS.map(([id, label]) => html`<button class="tab" data-tab="${id}" aria-current="${S.tab === id && !S.view ? 'page' : 'false'}" aria-label="${label}">${icon(id)}<span>${label}</span>${id === 'chats' && unread ? html`<i class="dot">${unread}</i>` : ''}</button>`)}`;
}
function shell() {
  app.innerHTML = String(html`${demoBar()}<div class="shell" id="shell"><nav class="rail" aria-label="Sections"><div class="mark" style="width:44px;height:44px;border-radius:14px;font-size:24px;margin-bottom:10px">J</div><div id="railtabs"></div><div class="grow"></div></nav>
    <section class="side" id="side"></section><section class="main" id="main"></section></div><nav class="tabbar" id="tabbar" aria-label="Sections"></nav>`);
  side(); main();
}
function update() {
  if (!S.engine || !$('#shell')) return;
  side(true);
  if (S.room) chatUpdate();
  ringCheck();
}
// ---------- a call is ringing in one of your chats ----------
const rung = new Set();
function ringCheck() {
  if (CALLS.active() || $('.ring')) return;
  for (const r of S.engine.rooms()) {
    const tl = S.engine.timeline(r.id), live = callStates(tl).live;
    const m = [...tl].reverse().find((x) => x.call && !x.mine && x.call.state === 'started' && Date.now() - x.ts < 45e3 && live(x) && !rung.has(x.call.id));
    if (!m) continue;
    rung.add(m.call.id);
    const el = document.createElement('div');
    el.className = 'ring'; el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-label', 'Incoming call');
    el.innerHTML = String(html`${avatar({ id: r.other || r.id, name: r.name, group: !r.dm })}<div class="rt"><b>${r.dm ? m.senderName : r.name}</b><small>${m.call.video ? 'Video call' : 'Voice call'}${r.dm ? '' : ' · ' + m.senderName.split(' ')[0]}</small></div>
      <button type="button" class="no" data-ring="no" aria-label="Decline">${icon('hangup')}</button><button type="button" class="yes" data-ring="yes" aria-label="Answer">${icon(m.call.video ? 'video' : 'calls')}</button>`);
    el.dataset.room = r.id; el.dataset.mid = m.id;
    document.body.append(el);
    setTimeout(() => el.remove(), Math.max(1000, 45e3 - (Date.now() - m.ts)));
    if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') try { new Notification(r.name, { body: 'Incoming call', tag: m.call.id, icon: 'icons/icon-192.png' }); } catch {}
    return;
  }
}
function setTabs() { const t = tabs(); $('#railtabs').innerHTML = String(t); $('#tabbar').innerHTML = String(t); $('#tabbar').hidden = !!S.room && innerWidth < 900 || !!S.view; }

const v0 = () => S.view;
// ---------- the side column: one tab, or a screen opened from it ----------
function side(soft = false) {
  const el = $('#side'); if (!el) return;
  setTabs();
  $('#shell').classList.toggle('in-chat', !!S.room);
  if (soft && (S.view || ['feed', 'calls', 'you', 'agents'].includes(S.tab))) { if (S.view === 'info') el.innerHTML = String(viewInfo()); else if (S.view === 'community' || S.view === 'communities') el.innerHTML = String(S.view === 'community' ? viewCommunity() : viewCommunities()); else if (!S.view && S.tab === 'agents') el.innerHTML = String(tabAgents()); return; }
  if (soft && v0() === 'archived') { const list = $('#chatlist'); if (list) { list.innerHTML = String(chatRows()); return; } }
  if (soft && S.tab === 'chats') { const list = $('#chatlist'); if (list) { list.innerHTML = String(chatRows()); return; } }
  const v = S.view;
  el.innerHTML = String(v === 'archived' ? html`${top('Archived', { back: true })}<div class="scroll" id="chatlist">${chatRows()}</div>` : v === 'blocked' ? viewBlocked() : v === 'starred' ? viewStarred() : v === 'new' ? viewNew() : v === 'group' ? viewGroup() : v === 'communities' ? viewCommunities() : v === 'devices' ? viewDevices() : v === 'community' ? viewCommunity() : v === 'info' ? viewInfo() : v === 'make-agent' ? viewMakeAgent() : v === 'rename' ? viewRename()
    : S.tab === 'chats' ? tabChats() : S.tab === 'feed' ? tabFeed() : S.tab === 'agents' ? tabAgents() : S.tab === 'calls' ? tabCalls() : tabYou());
  if (S.tab === 'feed' && !v && !S.feed && !S.feedErr) loadFeed();
}
function top(title, { back = false, actions = '', brand = false } = {}) {
  return html`<header class="top">${back ? html`<button class="iconbtn" data-act="back" aria-label="Back">${icon('back')}</button>` : ''}<h1 class="${brand ? 'brand' : ''}">${title}</h1>${actions}</header>`;
}

const FILTERS = [['all', 'All'], ['unread', 'Unread'], ['fav', 'Favorites'], ['groups', 'Groups'], ['agents', 'Agents']];
const FILTER_TEST = { all: () => true, unread: (r) => r.unread > 0, fav: (r) => r.favorite, groups: (r) => !r.dm, agents: (r) => !!r.agentId };
function chatRows() {
  const q = S.q.toLowerCase(), f = S.filter || 'all';
  const showArch = S.view === 'archived';
  const all = S.engine.rooms().filter((r) => (!q || r.name.toLowerCase().includes(q)) && FILTER_TEST[f](r));
  const rooms = all.filter((r) => !!r.archived === showArch).sort((a, b) => (b.pinned ?? -1) - (a.pinned ?? -1) || b.ts - a.ts);
  const nArch = showArch ? 0 : all.filter((r) => r.archived).length;
  const archRow = nArch && !q ? html`<button class="row archrow" data-act="archived">${icon('archive')}<span class="mid"><span class="l1"><span class="name">Archived</span><span class="time">${nArch}</span></span></span></button>` : '';
  const nComm = !showArch && !q && f === 'all' ? S.engine.communities?.().length || 0 : 0;
  const commRow = nComm ? html`<button class="row archrow" data-act="communities">${icon('community')}<span class="mid"><span class="l1"><span class="name">Communities</span><span class="time">${nComm}</span></span></span></button>` : '';
  if (!rooms.length && !showArch && !q && f === 'all') return html`${storyStrip()}${commRow}${archRow}<div class="empty"><div class="big">${icon('chats')}</div><h2>No chats yet</h2><p>Start one with the pencil button, or add an agent from the Agents tab.</p></div>`;
  if (showArch && !rooms.length) return html`<div class="empty"><p>No archived chats. Press and hold a chat (or right-click it), then Archive, to tuck it away here.</p></div>`;
  if (!rooms.length && nArch) return archRow;
  if (!rooms.length && f !== 'all' && !q) return html`<div class="empty"><p>${f === 'unread' ? "You're all caught up." : f === 'fav' ? 'No favorites yet. Open a chat, tap its name, then Add to favorites.' : f === 'groups' ? 'No groups yet.' : 'No agents yet. Add one from the Agents tab.'}</p></div>`;
  if (!rooms.length) return q ? html`<div class="empty"><p>No chats match "${S.q}".</p></div>` : html`<div class="empty"><div class="big">${icon('chats')}</div><h2>No chats yet</h2><p>Start one with the pencil button, or add an agent from the Agents tab.</p></div>`;
  return html`${!showArch && !q && f === 'all' ? storyStrip() : ''}${commRow}${archRow}${rooms.map((r) => {
    const ag = r.agentId ? agentOf(r.other) : null, l = r.last;
    const prev = r.typing.length ? html`<span class="prev typing">${r.dm ? 'typing…' : r.typing[0] + ' is typing…'}</span>`
      : l ? html`<span class="prev">${l.mine && !l.notice ? ticks(l.status) : ''}${!r.dm && !l.mine && !l.notice ? l.sender.split(' ')[0] + ': ' : ''}${l.text}</span>` : html`<span class="prev">No messages yet</span>`;
    return html`<button class="row" data-room="${r.id}" aria-current="${S.room === r.id}">${avatar({ id: r.other || r.id, name: r.name, agent: ag, group: !r.dm })}
      <span class="mid"><span class="l1"><span class="name">${r.announce && r.community ? r.community.name + ' · Announcements' : r.name}</span>${r.favorite ? html`<span class="favt" aria-label="Favorite">${icon('star')}</span>` : ''}${ag ? html`<span class="tag">Agent</span>` : ''}<span class="time ${r.unread && !r.muted ? 'new' : ''}">${r.ts ? when(r.ts) : ''}</span></span>
      <span class="l2">${prev}${r.muted ? html`<span class="rowi" aria-label="Muted">${icon('mute')}</span>` : ''}${r.pinned != null ? html`<span class="rowi" aria-label="Pinned">${icon('pin')}</span>` : ''}${r.unread ? html`<span class="badge ${r.muted ? 'quiet' : ''}">${r.unread}</span>` : ''}</span></span></button>`;
  })}`;
}
const ticks = (st) => html`<span class="ticks ${st === 'read' ? 'read' : ''}" aria-label="${st}">${icon(st === 'sending' ? 'clock' : st === 'read' ? 'ticks' : 'tick')}</span>`;

function tabChats() {
  return html`${top(BRAND.name, { brand: true, actions: html`<button class="iconbtn" data-act="new" aria-label="New chat">${icon('pencil')}</button>` })}
    <label class="search">${icon('search')}<input id="q" placeholder="Search chats" value="${S.q}" autocomplete="off"></label>
    <div class="chips filters">${FILTERS.map(([id, label]) => html`<button class="chip" data-filter="${id}" aria-pressed="${(S.filter || 'all') === id}">${label}</button>`)}</div>
    <div class="sidebody"><div class="scroll" id="chatlist">${chatRows()}</div><button class="fab" data-act="new" aria-label="New chat">${icon('plus')}</button></div>`;
}

// ---------- new chat, new group ----------
let peopleFound = [];
function contactRow(p, mode) {
  const picked = S.pick.some((x) => x.mxid === p.mxid), ag = agentOf(p.mxid);
  return html`<button class="row" data-${mode}="${p.mxid}" data-name="${p.name}">${avatar({ id: p.mxid, name: p.name, agent: ag, size: 'sm' })}
    <span class="mid"><span class="l1"><span class="name">${p.name}</span>${ag ? html`<span class="tag">Agent</span>` : ''}</span><span class="l2"><span class="prev">${ag ? ag.about : p.handle ? '@' + p.handle : ''}</span></span></span>
    ${mode === 'pick' ? html`<span class="check ${picked ? 'on' : ''}">${picked ? icon('tick') : ''}</span>` : ''}</button>`;
}
function knownPeople() {
  const seen = new Map();
  for (const r of S.engine.rooms()) for (const m of r.members) if (m.id !== S.engine.me.user_id && !agentOf(m.id)) seen.set(m.id, { mxid: m.id, name: m.name, handle: '' });
  return [...seen.values()];
}
function peopleList(mode) {
  const q = S.q.trim().toLowerCase();
  const found = q.length >= 2 ? peopleFound : [];
  const known = knownPeople().filter((p) => !q || p.name.toLowerCase().includes(q));
  const all = [...known, ...found.filter((f) => !known.some((k) => k.mxid === f.mxid))];
  const agents = (S.agents?.agents || []).filter((a) => !q || a.name.toLowerCase().includes(q)).map((a) => ({ mxid: a.mxid, name: a.name }));
  return html`${all.length ? html`<div class="section">People</div>${all.map((p) => contactRow(p, mode))}` : q.length >= 2 ? html`<div class="empty"><p>No one on ${BRAND.name} called "${S.q}" yet. Invite them from You → Invite a friend.</p></div>` : ''}
    <div class="section">Agents</div>${agents.map((p) => contactRow(p, mode))}`;
}
function viewNew() {
  return html`${top('New chat', { back: true })}<label class="search">${icon('search')}<input id="pq" placeholder="Search by name or @handle" value="${S.q}" autocomplete="off"></label>
    <div class="scroll"><button class="row" data-act="group">${raw(`<span class="av sm" style="background:var(--brand)">${icon('group')}</span>`)}<span class="mid"><span class="name">New group</span></span></button>
    <button class="row" data-act="community-new">${raw(`<span class="av sm" style="background:var(--brand)">${icon('community')}</span>`)}<span class="mid"><span class="name">New community</span></span></button>
    <div id="plist">${peopleList('person')}</div></div>`;
}
function viewGroup() {
  const adding = !!S.addTo, comm = S.newComm;
  return html`${top(adding ? (S.addToComm ? 'Add to community' : 'Add to group') : comm ? 'New community' : 'New group', { back: true })}
    <form data-form="group" class="pad" style="padding-top:4px">${adding ? '' : comm ? html`<p class="fine">A community brings groups together under one name, with an announcements channel only its admins post in.</p>
      <div class="field"><label for="gn">Community name</label><input id="gn" name="name" maxlength="60" placeholder="Lagos Racers" required></div>
      <div class="field"><label for="ga">What it's about</label><input id="ga" name="about" maxlength="140" placeholder="Weekend races and meetups"></div>`
      : html`<div class="field"><label for="gn">Group name</label><input id="gn" name="name" maxlength="60" placeholder="Race crew" required></div>`}
    <div class="picked">${S.pick.map((p) => html`<button type="button" data-pick="${p.mxid}" data-name="${p.name}">${avatar({ id: p.mxid, name: p.name, agent: agentOf(p.mxid), size: 'xs' })}${p.name} ✕</button>`)}</div>
    <button class="btn" ${raw(S.pick.length || comm ? '' : 'disabled')}>${adding ? 'Add' : comm ? 'Create community' : 'Create group'}${S.pick.length ? ` ${adding ? '' : 'with '}${S.pick.length}` : ''}</button></form>
    <label class="search">${icon('search')}<input id="pq" placeholder="Add people and agents" value="${S.q}" autocomplete="off"></label>
    <div class="scroll" id="plist">${peopleList('pick')}</div>`;
}
async function searchPeople() {
  const q = S.q.trim();
  if (q.length < 2) { peopleFound = []; return; }
  peopleFound = S.demo ? S.engine.people(q.replace(/^@/, '')) : (await api.people(q).catch(() => ({ people: [] }))).people;
  const pl = $('#plist'); if (pl) pl.innerHTML = String(peopleList(S.view === 'group' ? 'pick' : 'person'));
}
async function openWith(mxid) {
  try { const id = await S.engine.openDirect(mxid); S.view = null; S.q = ''; openSoon(id); }
  catch (e) { toast(e.message); }
}
async function makeGroup(name) {
  try { const id = await S.engine.createGroup(name.trim(), S.pick.map((p) => p.mxid)); S.pick = []; S.view = null; S.q = ''; S.tab = 'chats'; openSoon(id); }
  catch (e) { toast(e.message); }
}
async function makeCommunity(f) {
  try { const id = await S.engine.createCommunity(f.name.trim(), (f.about || '').trim(), S.pick.map((p) => p.mxid)); S.pick = []; S.newComm = false; S.q = ''; S.comm = id; S.view = 'community'; openCommunitySoon(id); }
  catch (e) { toast(e.message); }
}
function openCommunitySoon(id, tries = 30) { if (S.engine.community(id)?.announce || tries <= 0) return side(); setTimeout(() => openCommunitySoon(id, tries - 1), 200); }
async function addMembers() {
  if (S.addToComm) { const id = S.addToComm; S.addToComm = null; S.addTo = null; for (const p of S.pick) await S.engine.inviteToCommunity(id, p.mxid).catch((e) => toast(e.message)); S.pick = []; S.view = 'community'; S.comm = id; toast('Added'); return side(); }
  const id = S.addTo; S.addTo = null;
  for (const p of S.pick) await S.engine.invite(id, p.mxid).catch((e) => toast(e.message));
  S.pick = []; S.view = null; S.infoFor = null; openSoon(id);
}

// ---------- status updates (24 hours) ----------
const STATUS_BG = ['#0f7b5f', '#b4472d', '#3b4fb8', '#6b3fa0', '#b07d12', '#1d1b26'];
function storyStrip() {
  const list = S.engine.statuses?.(); if (!list) return '';
  return html`<div class="stories" aria-label="Status updates">${list.map((st, i) => {
    const empty = st.mine && !st.items.length;
    return html`<button type="button" class="story ${st.unseen ? 'new' : ''} ${empty ? 'add' : ''}" ${raw(empty ? 'data-act="status-new"' : `data-story="${i}"`)} aria-label="${empty ? 'Add a status' : st.name + "'s status"}">
      <span class="sring">${avatar({ id: st.user, name: st.mine ? S.engine.me.name : st.name, size: 'sm' })}${st.mine ? html`<i class="plus">${icon('plus')}</i>` : ''}</span><small>${st.mine ? 'My status' : st.name.split(' ')[0]}</small></button>`;
  })}</div>`;
}
function openStatusForm() {
  const bg = STATUS_BG[Math.floor(Math.random() * STATUS_BG.length)];
  const el = sheet(html`<form class="pollform" data-form="status"><h3>New status</h3><p class="fine">Your chats see it for 24 hours, then it goes.</p>
    <textarea name="text" id="sttext" maxlength="700" rows="4" placeholder="Type a status" style="background:${bg}" class="sttext"></textarea>
    <div class="swatches">${STATUS_BG.map((c) => html`<button type="button" data-bg="${c}" aria-label="Colour" aria-pressed="${c === bg}" style="background:${c}"></button>`)}</div>
    <input type="hidden" name="bg" value="${bg}">
    <div class="row2"><label class="btn ghost">${icon('camera')} Photo or video<input type="file" accept="image/*,video/*" id="stfile" hidden></label><button class="btn">Post</button></div></form>`, 'New status');
  el.querySelector('#sttext').focus();
}
let story = null;   // { list, who, i, t }
function openStory(who, i = -1) {
  const list = S.engine.statuses(); const st = list[who]; if (!st || !st.items.length) return;
  if (i < 0) { i = st.items.findIndex((x) => !x.seen); if (i < 0) i = 0; }
  story = { who, i, list }; drawStory();
}
function closeStory() { clearTimeout(story?.t); story = null; $('#story')?.remove(); side(true); }
function stepStory(d) {
  if (!story) return; clearTimeout(story.t);
  const st = story.list[story.who]; story.i += d;
  if (story.i >= st.items.length) { story.who++; story.i = 0; while (story.list[story.who] && !story.list[story.who].items.length) story.who++; if (!story.list[story.who]) return closeStory(); }
  if (story.i < 0) { story.who--; while (story.who >= 0 && !story.list[story.who].items.length) story.who--; if (story.who < 0) { story.who = 0; story.i = 0; } else story.i = story.list[story.who].items.length - 1; }
  drawStory();
}
function drawStory() {
  const st = story.list[story.who], it = st.items[story.i];
  if (!st.mine) S.engine.seeStatus(st.roomId, it.id);
  let el = $('#story'); if (!el) { el = document.createElement('div'); el.id = 'story'; el.className = 'story-view'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Status'); document.body.append(el); }
  const media = it.kind === 'image' ? html`<img alt="Status photo" ${raw(it.local || (it.url && !it.url.startsWith('mxc:')) ? `src="${esc(it.local || it.url)}"` : `data-mxc="${esc(it.url || '')}"`)} class="${!st.mine && store.get('safePhotos', true) ? 'checking' : ''}">`
    : it.kind === 'video' ? html`<video playsinline autoplay ${raw(it.local || (it.url && !it.url.startsWith('mxc:')) ? `src="${esc(it.local || it.url)}"` : `data-mxc="${esc(it.url || '')}"`)}></video>`
    : html`<p class="sttextview">${it.text}</p>`;
  el.style.background = it.kind === 'text' ? it.bg || STATUS_BG[0] : '#000';
  el.innerHTML = String(html`<div class="bars">${st.items.map((x, k) => html`<i class="${k < story.i ? 'done' : k === story.i ? 'now' : ''}"></i>`)}</div>
    <header>${avatar({ id: st.user, name: st.mine ? S.engine.me.name : st.name, size: 'sm' })}<span class="who"><b>${st.name}</b><small>${ago(it.ts)}</small></span>
      ${st.mine ? html`<button type="button" class="iconbtn" data-act="story-del" aria-label="Delete this status">${icon('trash')}</button>` : ''}<button type="button" class="iconbtn" data-act="story-close" aria-label="Close">${icon('close')}</button></header>
    <button type="button" class="tap prev" data-act="story-prev" aria-label="Previous"></button><button type="button" class="tap next" data-act="story-next" aria-label="Next"></button>
    <div class="stbody">${media}</div>
    ${st.mine ? html`<footer>${icon('eye')} ${it.seenBy.length ? `Seen by ${it.seenBy.length}: ${it.seenBy.slice(0, 6).join(', ')}${it.seenBy.length > 6 ? '…' : ''}` : 'No views yet'}<button type="button" class="linkbtn" data-act="status-new">Add another</button></footer>` : ''}`);
  for (const m of el.querySelectorAll('[data-mxc]')) if (m.dataset.mxc) S.engine.media(m.dataset.mxc).then((u) => { m.src = u; }).catch(() => {});
  const img = el.querySelector('img.checking');
  if (img) judge(img, it.url || it.id).then((v) => { if (v === 'ok') img.classList.remove('checking'); else img.classList.replace('checking', 'hidden'); });
  const vid = el.querySelector('video');
  if (vid) vid.addEventListener('ended', () => stepStory(1), { once: true });
  else story.t = setTimeout(() => stepStory(1), matchMedia('(prefers-reduced-motion: reduce)').matches ? 8000 : 5000);
}

// ---------- chat backup ----------
async function openBackup() {
  const st = await S.engine.backup().catch(() => 'off');
  if (st === 'none') return sheet(html`<div class="picker"><h3>Chat backup</h3><p class="fine">Private chats need a newer browser, so there is nothing to back up here.</p></div>`, 'Chat backup');
  if (st === 'locked') return sheet(html`<form class="picker" data-form="restore"><h3>Enter your recovery key</h3><p class="fine">Your chats are backed up. Enter the recovery key you saved to read your older private messages on this phone.</p>
    <div class="field"><label for="rk">Recovery key</label><input id="rk" name="key" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="EsT… …" required></div>
    <button class="btn">Unlock my messages</button><p class="fine">Lost it? <button type="button" class="linkbtn" data-act="backup-make" data-again="1">Make a new key</button> (older messages on new phones stay locked).</p></form>`, 'Chat backup');
  sheet(html`<div class="picker"><h3>Chat backup</h3>${st === 'on'
    ? html`<p class="fine">On. The keys to your private chats are backed up, locked with your recovery key. The server keeps them but can't read them.</p><button type="button" class="btn ghost" data-act="backup-make" data-again="1">Make a new recovery key</button>`
    : html`<p class="fine">Keep a locked copy of your private chat keys on the server, so a new phone can read your old messages. Only your recovery key opens it.</p><button type="button" class="btn" data-act="backup-make">Turn on and make my recovery key</button>`}</div>`, 'Chat backup');
}

// ---------- communities ----------
function commRoomRow(id, announce) {
  const r = S.engine.room(id); if (!r) return '';
  const l = r.last;
  return html`<button class="row" data-room="${r.id}" aria-current="${S.room === r.id}">${announce ? raw(`<span class="av" style="background:var(--brand)">${icon('megaphone')}</span>`) : avatar({ id: r.id, name: r.name, group: true })}
    <span class="mid"><span class="l1"><span class="name">${r.name}</span><span class="time ${r.unread && !r.muted ? 'new' : ''}">${r.ts ? when(r.ts) : ''}</span></span>
    <span class="l2"><span class="prev">${l ? (!l.mine && !l.notice ? l.sender.split(' ')[0] + ': ' : '') + l.text : announce ? 'Only admins post here' : 'No messages yet'}</span>${r.unread ? html`<span class="badge ${r.muted ? 'quiet' : ''}">${r.unread}</span>` : ''}</span></span></button>`;
}
function viewCommunities() {
  const list = S.engine.communities();
  return html`${top('Communities', { back: true })}<div class="scroll">
    <button class="row" data-act="community-new">${raw(`<span class="av" style="background:var(--brand)">${icon('community')}</span>`)}<span class="mid"><span class="name">New community</span><span class="l2"><span class="prev">Groups under one name, with announcements</span></span></span></button>
    ${list.map((c) => html`<button class="row" data-comm="${c.id}">${avatar({ id: c.id, name: c.name, group: true })}<span class="mid"><span class="l1"><span class="name">${c.name}</span></span><span class="l2"><span class="prev">${c.about || `${c.members} members`}</span></span></span></button>`)}
    ${list.length ? '' : html`<div class="empty"><p>No communities yet. Make one for your street, your school, your team or your family.</p></div>`}</div>`;
}
function viewCommunity() {
  const c = S.engine.community(S.comm); if (!c) return viewCommunities();
  return html`${top(c.name, { back: true })}<div class="scroll">
    <div class="me">${avatar({ id: c.id, name: c.name, group: true, size: 'lg' })}<h2>${c.name}</h2><p>${c.about ? c.about + ' · ' : ''}${c.members} members</p></div>
    ${c.announce ? html`<div class="section">Announcements</div>${commRoomRow(c.announce, true)}` : ''}
    <div class="section">Groups</div>${c.groups.map((id) => commRoomRow(id))}
    ${c.groups.length ? '' : html`<div class="empty"><p>No groups yet.${c.admin ? ' Add the first one below.' : ''}</p></div>`}
    ${c.admin ? html`<button class="set" data-act="comm-group">${icon('plus')}<span class="mid">New group in ${c.name}</span></button>
      <button class="set" data-act="comm-invite">${icon('group')}<span class="mid">Add people<small>They join the announcements and every group</small></span></button>` : ''}</div>`;
}

// ---------- chat info ----------
function viewInfo() {
  const r = S.engine.room(S.infoFor || S.room); if (!r) return html`${top('Chat', { back: true })}`;
  const ag = r.agentId ? agentOf(r.other) : null;
  return html`${top(r.dm ? 'Contact' : 'Group', { back: true })}<div class="scroll">
    <div class="me">${avatar({ id: r.other || r.id, name: r.name, agent: ag, group: !r.dm, size: 'lg' })}<h2>${r.name}</h2><p>${ag ? `Agent · ${ag.kind}` : r.dm ? '' : `Group · ${r.members.length} members`}</p></div>
    ${ag ? html`<div class="pad"><div class="note">${ag.about}</div>${ag.commands?.length ? html`<div class="section" style="padding-left:0">Try saying</div><div class="btns">${ag.commands.map((c) => html`<button data-say="${c.replace(/ <[^>]+>| …/g, '')}">${c}</button>`)}</div>` : ''}</div>` : ''}
    ${!r.dm ? html`<div class="section">Members</div>${r.members.map((m) => html`<div class="row">${avatar({ id: m.id, name: m.name, agent: agentOf(m.id), size: 'sm' })}<span class="mid"><span class="l1"><span class="name">${m.id === S.engine.me.user_id ? 'You' : m.name}</span>${agentOf(m.id) ? html`<span class="tag">Agent</span>` : ''}</span></span></div>`)}
      <button class="set" data-act="add-member">${icon('plus')}<span class="mid">Add people or agents</span></button>` : ''}
    <button class="set" data-act="find-info">${icon('search')}<span class="mid">Search this chat</span></button>
    <div class="set">${icon('mute')}<span class="mid">Mute alerts<small>${r.muted ? 'No alerts from this chat' : 'Alerts are on'}</small></span><button class="switch" role="switch" aria-checked="${!!r.muted}" aria-label="Mute alerts" data-act="mute-info"></button></div>
    ${r.agentId ? '' : html`<button class="set" data-act="disappear">${icon('timer')}<span class="mid">Disappearing messages<small>${r.disappear ? 'New messages go after ' + spanLabel(r.disappear) : 'Off'}</small></span></button>`}
    <button class="set" data-act="fav">${icon('star')}<span class="mid">${r.favorite ? 'Remove from favorites' : 'Add to favorites'}</span></button>
    ${r.dm && !r.agentId ? html`<button class="set" data-act="block-info" style="color:var(--danger)">${icon('block')}<span class="mid">${r.blocked ? 'Unblock ' : 'Block '}${r.name}</span></button>` : ''}
    <button class="set" data-act="report-chat" style="color:var(--danger)">${icon('flag')}<span class="mid">Report ${r.dm ? r.name : 'this group'}</span></button>
    <button class="set" data-act="leave" style="color:var(--danger)">${icon('out')}<span class="mid">${r.dm ? 'Delete chat' : 'Leave group'}</span></button></div>`;
}

// ---------- Feed ----------
const SPACES = [['', 'All'], ['grand-prix', 'Grand Prix'], ['palasora-town', 'Palasora'], ['faliga', 'FALIGA']];
async function loadFeed() {
  try { S.feed = S.demo ? await S.engine.feed(S.space) : await api.feed(S.space); S.feedErr = false; }
  catch { S.feedErr = true; S.feed = null; }
  if (S.tab === 'feed' && !S.view) side();
}
function tabFeed() {
  const items = S.feed?.items;
  const list = S.feedErr ? html`<div class="empty"><p>The feed isn't answering right now. Pull down or come back in a minute.</p><button class="btn ghost" data-act="feed-retry" style="width:auto">Try again</button></div>`
    : !S.feed ? html`<div class="empty"><p>Loading…</p></div>`
    : S.feed.on === false ? html`<div class="empty"><div class="big">${icon('feed')}</div><h2>The feed opens soon</h2><p>Race reports, town news and the talk around them will appear here.</p></div>`
    : !items.length ? html`<div class="empty"><p>Nothing here yet.</p></div>`
    : html`${S.demo ? html`<div class="note">Example posts. On the real app this is the ${BRAND.name} social network, where every game's agents and players post.</div>` : ''}${items.map((p) => html`
      <a class="post" ${p.url ? raw(`href="${esc(p.url)}" target="_blank" rel="noopener"`) : ''}><div class="ph"><span>${p.icon}</span><b>${p.space || BRAND.name}</b>${p.agent ? html`<span class="tag">Agent</span>` : ''}<span style="margin-left:auto">${ago(p.at)}</span></div>
      <h3>${p.title}</h3>${p.text ? html`<p>${p.text}</p>` : ''}<div class="pf"><span>▲ ${p.votes}</span><span>${p.replies} repl${p.replies === 1 ? 'y' : 'ies'}</span></div></a>`)}`;
  return html`${top('Feed')}<div class="chips">${SPACES.map(([id, label]) => html`<button class="chip" data-space="${id}" aria-pressed="${S.space === id}">${label}</button>`)}</div><div class="scroll pad">${list}</div>`;
}

// ---------- Agents ----------
function tabAgents() {
  const mine = S.engine.rooms().filter((r) => r.agentId);
  const have = new Set(mine.map((r) => r.other));
  const card = (a, soon = false) => html`<div class="row">${avatar({ id: a.id, name: a.name, agent: a, size: 'sm' })}<span class="mid"><span class="l1"><span class="name">${a.name}</span><span class="tag ${soon ? 'soon' : ''}">${soon ? 'Soon' : a.kind}</span></span><span class="l2"><span class="prev" style="white-space:normal">${a.about}</span></span></span>
    ${soon ? '' : html`<button class="chip" data-agent="${a.mxid}" style="background:var(--brand-soft);color:var(--brand)">${have.has(a.mxid) ? 'Open' : 'Add'}</button>`}</div>`;
  return html`${top('Agents')}<div class="scroll">
    <div class="pad" style="padding-bottom:0"><div class="note">Add as many agents as you like. They answer straight away, and in a group they only speak when you name them.</div></div>
    <div class="section">${BRAND.name} agents</div>${(S.agents?.agents || []).map((a) => card(a))}
    ${S.agents?.community?.length ? html`<div class="section">Made by people</div>${S.agents.community.map((a) => card(a))}` : ''}
    <div class="section">Coming soon</div>${(S.agents?.soon || SOON).map((a) => card(a, true))}
    <div class="section">Build your own</div><button class="set" data-act="make-agent">${icon('code')}<span class="mid">Make your own agent<small>Get a key and connect any bot or AI with the open Matrix chat standard</small></span></button>
  </div>`;
}
function viewMakeAgent() {
  const made = S.madeAgent;
  return html`${top('Make an agent', { back: true })}<div class="scroll pad">
    ${made ? html`<div class="note"><b>${made.agent.name}</b> is ready. Copy its key now: it is shown once.</div><div class="field"><label>Chat address</label><div class="keybox">${made.agent.mxid}</div></div>
      <div class="field"><label>Server</label><div class="keybox">${made.homeserver}</div></div><div class="field"><label>Key (keep it secret)</label><div class="keybox" id="agentkey">${made.key}</div></div>
      <button class="btn ghost" data-act="copy-key">Copy key</button><p class="fine" style="color:var(--muted);font-size:13px">Your program signs in with this key and uses the standard Matrix client API (any Matrix bot library works). People add it from the Agents tab${made.agent.public ? '' : ' once you make it public'}.</p>`
    : S.demo ? html`<div class="empty"><p>In the real app you get a key here and connect your own bot or AI. The demo can't make agents.</p></div>`
    : html`<form data-form="agent"><div class="field"><label for="an">Agent name</label><input id="an" name="name" maxlength="40" placeholder="Jollof Recipes" required></div>
      <div class="field"><label for="ab">What it does</label><textarea id="ab" name="about" rows="3" maxlength="300" placeholder="Answers with a recipe for whatever you have in the kitchen."></textarea></div>
      <label class="set" style="padding-left:0"><span class="mid">List it in the Agents tab for everyone</span><input type="checkbox" name="public" value="1"></label>
      <button class="btn">Make agent</button></form>`}
  </div>`;
}
async function makeAgent(f) {
  try { S.madeAgent = await api.makeAgent(f.name, f.about || '', !!f.public); learnAgents(await api.agents()); side(); }
  catch (e) { toast(e.message); }
}

// ---------- Calls, You ----------
function tabCalls() {
  const me = S.engine.me.user_id, list = [];
  for (const r of S.engine.rooms()) {
    const tl = S.engine.timeline(r.id), st = callStates(tl);
    for (const m of tl) if (m.call && m.call.state !== 'ended') list.push({ r, m, live: st.live(m) });
  }
  list.sort((a, b) => b.m.ts - a.m.ts);
  return html`${top('Calls')}<div class="scroll">
    <p class="fine pad" style="text-align:left;padding-bottom:0">Free voice and video calls, and screen sharing. Private chats get private calls. To start one, open a chat and tap the phone or camera.</p>
    ${list.length ? html`<div class="section">Recent</div>${list.slice(0, 60).map(({ r, m, live }) => html`<div class="row">${avatar({ id: r.other || r.id, name: r.name, group: !r.dm, size: 'sm' })}
      <span class="mid"><span class="l1"><span class="name">${r.name}</span></span><span class="l2"><span class="prev callline ${m.mine ? '' : 'in'}">${icon(m.mine ? 'callout' : 'callin')}${m.mine ? 'Outgoing' : 'Incoming'} ${m.call.video ? 'video' : 'voice'} call · ${when(m.ts)}${live ? ' · going on now' : ''}</span></span></span>
      ${live ? html`<button type="button" class="pill" data-joinroom="${r.id}" data-joinid="${m.id}">Join</button>` : html`<button type="button" class="iconbtn" data-callback="${r.id}" data-video="${m.call.video ? 1 : ''}" aria-label="Call ${r.name} again">${icon(m.call.video ? 'video' : 'calls')}</button>`}</div>`)}`
      : html`<div class="empty"><div class="big">${icon('calls')}</div><h2>No calls yet</h2><p>Your calls show up here.</p></div>`}</div>`;
}
function tabYou() {
  const me = S.engine.me, theme = store.get('theme', 'system'), handle = store.get('me')?.handle;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return html`${top('You')}<div class="scroll">
    <div class="me">${avatar({ id: me.user_id, name: me.name, size: 'lg' })}<h2>${me.name || 'You'}</h2><p>${handle ? '@' + handle : S.demo ? 'Demo account' : ''}</p></div>
    <button class="set" data-act="rename">${icon('pencil')}<span class="mid">Edit your name</span></button>
    <button class="set" data-act="starred">${icon('star')}<span class="mid">Starred messages</span></button>
    <button class="set" data-act="blocked">${icon('block')}<span class="mid">Blocked people</span></button>
    <button class="set" data-act="devices">${icon('laptop')}<span class="mid">Linked computers<small>Use ${BRAND.name} on a computer too</small></span></button>
    <button class="set" data-act="backup">${icon('key')}<span class="mid">Chat backup<small>A recovery key lets a new phone read your old private messages</small></span></button>
    ${standalone ? '' : html`<button class="set" data-act="install">${icon('download')}<span class="mid">Install ${BRAND.name}<small>${ios ? 'In Safari: Share, then Add to Home Screen' : 'Put it on your home screen like any app'}</small></span></button>`}
    <div class="set">${icon('clock')}<span class="mid">Last seen and online<small>Off: nobody sees when you're on, and you don't see theirs</small></span><button class="switch" role="switch" aria-checked="${S.engine.privacy().lastSeen}" aria-label="Last seen and online" data-act="priv-seen"></button></div>
    <div class="set">${icon('ticks')}<span class="mid">Read ticks<small>Off: people don't see when you've read, and you don't see theirs</small></span><button class="switch" role="switch" aria-checked="${S.engine.privacy().readTicks}" aria-label="Read ticks" data-act="priv-ticks"></button></div>
    <div class="set">${icon('eye')}<span class="mid">Blur explicit photos<small>Checked on this phone, so private chats stay private</small></span><button class="switch" role="switch" aria-checked="${store.get('safePhotos', true)}" aria-label="Blur explicit photos" data-act="safe-photos"></button></div>
    <div class="set">${icon('bell')}<span class="mid">Message alerts<small>${S.demo ? 'Works on the real app' : 'Get a notice when a message arrives'}</small></span><button class="switch" role="switch" aria-checked="${S.pushOn && !S.demo}" aria-label="Message alerts" data-act="push" ${S.demo ? 'disabled' : ''}></button></div>
    <div class="set">${icon('moon')}<span class="mid">Appearance</span><span class="seg">${['system', 'light', 'dark'].map((t) => html`<button data-theme="${t}" aria-pressed="${theme === t}">${t[0].toUpperCase() + t.slice(1)}</button>`)}</span></div>
    <button class="set" data-act="invite">${icon('link')}<span class="mid">Invite a friend<small>${BRAND.site.replace('https://', '')}</small></span></button>
    <button class="set" data-act="privacy">${icon('lock')}<span class="mid">Privacy<small>How your chats are kept</small></span></button>
    <button class="set" data-act="${S.demo ? 'leave-demo' : 'signout'}" style="color:var(--danger)">${icon('out')}<span class="mid">${S.demo ? 'Leave the demo' : 'Sign out'}</span></button>
    <p class="fine" style="color:var(--muted);font-size:12.5px;text-align:center;padding:12px 20px 24px">${BRAND.name} by Noveniqe · built on open source: Matrix and Tuwunel</p></div>`;
}
function viewRename() {
  return html`${top('Your name', { back: true })}<form data-form="rename" class="pad"><div class="field"><label for="rn">Name</label><input id="rn" name="name" maxlength="40" value="${S.engine.me.name}" required></div><button class="btn">Save</button></form>`;
}
async function enablePush(quiet = false) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { if (!quiet) toast(/iphone|ipad/i.test(navigator.userAgent) ? 'On iPhone, install the app first (Share → Add to Home Screen), then turn alerts on.' : "This browser can't show message alerts."); return false; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { if (!quiet) toast('Alerts are blocked in your browser settings.'); return false; }
  const reg = await navigator.serviceWorker.ready, { key } = await api.pushKey();
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - key.length % 4) % 4)), (c) => c.charCodeAt(0)) });
  const p = await api.pushSubscribe(sub.toJSON());
  await S.engine.setPusher(p, true);
  store.set('pusher', p);
  return true;
}

// ---------- the open chat ----------
let rec = null;
function main() {
  const el = $('#main'); if (!el) return;
  if (!S.room) { el.innerHTML = String(html`<div class="placeholder"><div><div class="mark">J</div><h2>${BRAND.name}</h2><p>Pick a chat, or start one with the pencil button.</p></div></div>`); return; }
  el.innerHTML = String(html`<div class="chat" id="chat"><header class="top" id="chathead"></header>
    <div class="findbar" id="findbar" hidden><div class="fb"><label class="search">${icon('search')}<input id="findq" placeholder="Search this chat" autocomplete="off"></label><button type="button" class="iconbtn" data-act="find-close" aria-label="Close search">${icon('close')}</button></div><div class="hits" id="hits"></div></div>
    <div class="wall" id="wall" role="log" aria-label="Messages"></div>
    <div class="composebar" id="composebar" hidden></div>
    <form class="composer" id="composer" data-form="send"><div class="box"><button type="button" class="iconbtn" data-act="emoji" aria-label="Emoji" title="Emoji">${icon('smile')}</button><textarea id="msg" rows="1" placeholder="Message" aria-label="Message" enterkeyhint="send"></textarea>
    <button type="button" class="iconbtn" data-act="attach" aria-label="Attach" title="Attach">${icon('clip')}</button>
    <label class="iconbtn" aria-label="Send a photo or video" title="Send a photo or video">${icon('camera')}<input type="file" accept="image/*,video/*" id="photo" hidden></label>
    <input type="file" id="docfile" hidden></div>
    <button type="button" class="send" id="sendbtn" aria-label="Record a voice message">${icon('mic')}</button></form></div>`);
  chatUpdate(true);
  const rr = S.engine.room(S.room);
  if (rr && !rr.canPost) $('#composer').outerHTML = String(html`<div class="blockedbar">${icon('megaphone')} Only ${rr.community ? rr.community.name : 'community'} admins can send messages here.</div>`);
  if (rr?.blocked) $('#composer').outerHTML = String(html`<div class="blockedbar">You blocked ${rr.name}. <button type="button" class="linkbtn" data-act="unblock" data-uid="${rr.other}">Unblock</button></div>`);
  const ta = $('#msg');
  if (innerWidth >= 900) ta?.focus();
}
function seenText(p) {
  if (!p) return '';
  if (p.online) return 'online';
  return p.at ? `last seen ${dayLabel(p.at) === 'Today' ? 'today' : dayLabel(p.at) === 'Yesterday' ? 'yesterday' : new Date(p.at).toLocaleDateString([], { day: 'numeric', month: 'short' })} at ${hhmm(p.at)}` : '';
}
function chatHead(r) {
  const ag = r.agentId ? agentOf(r.other) : null;
  const sub = r.typing.length ? html`<small class="typing">${r.dm ? 'typing…' : r.typing[0] + ' is typing…'}</small>` : html`<small>${r.encrypted ? html`<span class="lockt">${icon('lock')}</span>` : ''}${ag ? `Agent · ${ag.kind}` : r.dm ? seenText(S.engine.presenceOf?.(r.other)) || (r.encrypted ? 'Private chat' : 'tap for info') : (r.announce ? 'Announcements · ' : r.community ? r.community.name + ' · ' : '') + r.members.map((m) => (m.id === S.engine.me.user_id ? 'You' : m.name.split(' ')[0])).join(', ')}</small>`;
  return html`<button class="iconbtn" data-act="close-chat" aria-label="Back to chats">${icon('back')}</button>
    <button class="who" data-act="info">${avatar({ id: r.other || r.id, name: r.name, agent: ag, group: !r.dm, size: 'sm' })}<span class="t"><b>${r.announce && r.community ? r.community.name : r.name}</b>${sub}</span></button>
    ${r.agentId || r.announce ? '' : html`<button class="iconbtn" data-act="call-voice" aria-label="Voice call" title="Voice call">${icon('calls')}</button><button class="iconbtn" data-act="call-video" aria-label="Video call" title="Video call">${icon('video')}</button>`}
    <button class="iconbtn" data-act="find" aria-label="Search this chat" title="Search this chat">${icon('search')}</button>
    <button class="iconbtn" data-act="info" aria-label="Chat info">${icon('more')}</button>`;
}
function bubble(m, prev, r) {
  const first = !prev || prev.sender !== m.sender || prev.kind === 'notice' || m.ts - prev.ts > 10 * 60e3;
  const ag = m.agent ? agentOf(m.sender) : null;
  const from = !r.dm && !m.mine && first ? html`<div class="from" style="color:${ag?.color || 'var(--brand)'}">${m.senderName}${ag ? html`<span class="tag">Agent</span>` : ''}</div>` : '';
  const meta = html`<span class="meta">${m.starred ? html`<span class="mstar" aria-label="Starred">${icon('star')}</span>` : ''}${m.edited ? html`<span class="edited">edited</span>` : ''}${hhmm(m.ts)}${m.mine ? ticks(m.status) : ''}</span>`;
  let content;
  if (m.kind === 'image') {
    const key = m.url || m.local || m.id, check = !m.mine && store.get('safePhotos', true), v = check ? known(key) : 'ok';
    content = html`<div class="photobox ${v === 'ok' ? '' : v === 'hide' ? 'hidden' : 'checking'}" data-key="${key}"><img class="photo" data-mxc="${m.url || ''}" src="${m.local || ''}" alt="Photo" ${v ? '' : raw('data-check="1"')}>${v === 'hide' ? html`<button type="button" class="showphoto" data-act="show-photo">This photo may be explicit. Show it</button>` : ''}</div>${meta}`;
  }
  else if (m.kind === 'video') content = html`<video class="photo" controls playsinline preload="metadata" data-mxc="${m.url || ''}" src="${m.local || ''}"></video>${meta}`;
  else if (m.kind === 'file') content = html`<button type="button" class="filecard" data-file="${m.url || m.local || ''}" data-name="${m.file.name}">${icon('doc')}<span><b>${m.file.name}</b><small>${fileSize(m.file.size)}${m.file.mimetype ? ' · ' + (m.file.mimetype.split('/')[1] || '').toUpperCase().slice(0, 8) : ''}</small></span>${icon('download')}</button>${meta}`;
  else if (m.kind === 'contact') content = html`<div class="contactcard">${avatar({ id: m.contact.mxid, name: m.contact.name, size: 'sm' })}<span><b>${m.contact.name}</b><small>${m.contact.mxid}</small></span></div><button type="button" class="cardbtn" data-chatwith="${m.contact.mxid}">Message</button>${meta}`;
  else if (m.kind === 'poll' && m.poll) content = html`<div class="poll"><b class="pq">${icon('poll')} ${m.poll.question}</b>${m.poll.options.map((o, i) => html`<button type="button" class="opt ${m.poll.mine === i ? 'on' : ''}" data-vote="${i}" data-mid="${m.id}"><span class="bar" style="width:${m.poll.total ? Math.round(100 * o.count / m.poll.total) : 0}%"></span><span class="ot">${o.text}</span><span class="oc">${o.count || ''}</span></button>`)}<small>${m.poll.total === 1 ? '1 vote' : m.poll.total + ' votes'}${m.poll.mine >= 0 ? ' · tap your choice again to take it back' : ''}</small></div>${meta}`;
  else if (m.kind === 'location' && m.location) content = html`<div class="place"><div class="map" data-lat="${m.location.lat}" data-lon="${m.location.lon}" aria-label="Map"></div><span class="pl">${icon('pin')} ${m.location.label || `${m.location.lat.toFixed(4)}, ${m.location.lon.toFixed(4)}`}</span><a href="https://www.openstreetmap.org/?mlat=${m.location.lat}&mlon=${m.location.lon}#map=16/${m.location.lat}/${m.location.lon}" target="_blank" rel="noopener">Open the map</a></div>${meta}`;
  else if (m.kind === 'voice') content = html`<div class="voice"><button type="button" data-voice="${m.url || ''}" data-local="${m.local || ''}" aria-label="Play voice message">${icon('play')}</button><span class="bar"><i></i></span><small>${m.info?.duration ? fmtDur(m.info.duration / 1000) : ''}</small>${meta}</div>`;
  else content = html`<div class="txt">${linkify(m.text)}${meta}</div>`;
  const c = m.card;
  const cardHtml = c && (c.title || c.lines?.length || c.fields?.length) ? html`<div class="card">${c.title ? html`<div class="ct">${c.title}</div>` : ''}${c.lines?.length ? html`<ul class="cl">${c.lines.map((l) => html`<li>${l}</li>`)}</ul>` : ''}${c.fields?.length ? html`<dl>${c.fields.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>` : ''}</div>` : '';
  const buttons = c && (c.buttons?.length || c.link) ? html`<div class="btns ${(c.buttons?.length || 0) + (c.link ? 1 : 0) >= 4 ? 'two' : ''}">${(c.buttons || []).map((b) => html`<button type="button" data-say="${b.say}">${b.label}</button>`)}${c.link ? (c.link.url === '#feed' ? html`<button type="button" data-tab="feed">${c.link.label}</button>` : html`<a href="${c.link.url}" target="_blank" rel="noopener">${icon('link')}${c.link.label}</a>`) : ''}</div>` : '';
  const reacts = m.reactions?.length ? html`<div class="reacts">${m.reactions.map((x) => html`<button type="button" class="react ${x.mine ? 'on' : ''}" data-react="${x.key}" data-mid="${m.id}" title="${x.names.filter(Boolean).join(', ')}">${x.key}${x.count > 1 ? html`<b>${x.count}</b>` : ''}</button>`)}</div>` : '';
  const more = m.deleted || m.status === 'sending' ? '' : html`<button type="button" class="msgmore" data-msgmenu="${m.id}" aria-label="React or more">${icon('smile')}</button>`;
  const tr = S.tr[m.id] ? html`<div class="trans ${S.tr[m.id].busy ? 'busy' : ''}" dir="auto"><small>${icon('translate')} ${S.tr[m.id].busy ? '' : 'Translated'}</small>${S.tr[m.id].text}</div>` : '';
  const fwd = m.forwarded ? html`<div class="fwd">${icon('forward')} Forwarded</div>` : '';
  const quote = m.replyTo ? html`<button type="button" class="quote" data-hit="${m.replyTo.id}"><b>${m.replyTo.senderName}</b><span>${m.replyTo.text}</span></button>` : '';
  return html`<div class="msg ${m.mine ? 'mine' : ''} ${first ? 'first' : ''} ${m.deleted ? 'deleted' : ''}" data-mid="${m.id}"><div class="bubble">${from}${fwd}${quote}${m.call ? callBubble(m, S.callLive?.(m)) : content}${tr}${cardHtml}</div>${more}${reacts}${buttons}</div>`;
}
const fileSize = (b) => (!b ? '' : b < 1e3 ? b + ' B' : b < 1e6 ? Math.round(b / 1e3) + ' KB' : (b / 1e6).toFixed(1) + ' MB');
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function chatUpdate(initial = false) {
  const r = S.engine.room(S.room);
  if (!r) { if (S.engine.ready()) { S.room = null; side(); main(); } return; }
  $('#chathead').innerHTML = String(chatHead(r));
  const wall = $('#wall'), near = initial || wall.scrollHeight - wall.scrollTop - wall.clientHeight < 120;
  const msgs = S.engine.timeline(S.room);
  S.callLive = callStates(msgs).live;
  let out = [], lastDay = '';
  out.push(r.agentId ? html`<div class="safe">${agentOf(r.other)?.name || 'This agent'} is an AI agent. It reads this chat to answer you, and only this chat.</div>`
    : r.encrypted ? html`<div class="safe">${icon('lock')} Messages in this chat are private. Only the people in it can read them, not even ${BRAND.name}.</div>`
    : html`<div class="safe">This group has an agent in it, so it isn't private: the agent reads messages here.</div>`);
  if (r.disappear) out.push(html`<div class="safe">${icon('timer')} Disappearing messages are on: new messages go after ${spanLabel(r.disappear)}.</div>`);
  msgs.forEach((m, i) => {
    const d = dayLabel(m.ts); if (d !== lastDay) { out.push(html`<div class="day">${d}</div>`); lastDay = d; }
    out.push(m.kind === 'notice' ? html`<div class="notice">${m.text}</div>` : bubble(m, msgs[i - 1], r));
  });
  wall.innerHTML = out.join('');
  for (const v of wall.querySelectorAll('video[data-mxc]')) if (v.dataset.mxc && !v.getAttribute('src')) S.engine.media(v.dataset.mxc).then((u) => { v.src = u; }).catch(() => {});
  if (wall.querySelector('.map')) maps(wall);
  for (const img of wall.querySelectorAll('img[data-mxc]')) if (img.dataset.mxc && !img.getAttribute('src')) S.engine.media(img.dataset.mxc).then((u) => { img.src = u; }).catch(() => {});
  for (const img of wall.querySelectorAll('img[data-check]')) {
    const box = img.closest('.photobox'), key = box.dataset.key;
    const go = () => judge(img, key).then((v) => { const b = $(`.photobox[data-key="${CSS.escape(key)}"]`); if (!b) return; b.classList.remove('checking'); if (v === 'hide') { b.classList.add('hidden'); b.insertAdjacentHTML('beforeend', String(html`<button type="button" class="showphoto" data-act="show-photo">This photo may be explicit. Show it</button>`)); } });
    img.getAttribute('src') ? go() : img.addEventListener('load', go, { once: true });
  }
  if (near) wall.scrollTop = wall.scrollHeight;
  if (document.visibilityState === 'visible') S.engine.markRead(S.room);
}
function openRoom(id) {
  if (!S.room) history.pushState({ jisst: 'room' }, '');
  S.room = id; S.tab = 'chats'; side(); main();
}
function closeRoom() { S.room = null; side(); main(); }

// ---------- sending ----------
function composerState() { const has = $('#msg')?.value.trim(); const b = $('#sendbtn'); if (!b) return; b.innerHTML = String(icon(has ? 'send' : 'mic')); b.setAttribute('aria-label', has ? 'Send' : 'Record a voice message'); b.dataset.mode = has ? 'send' : 'mic'; }
let typingT = 0;
async function sendText(text, opts = {}) {
  text = text.trim(); if (!text || !S.room) return;
  if (typingT) { typingT = 0; S.engine.typing(S.room, false); }
  try { await S.engine.send(S.room, text, opts); } catch (e) { toast("Couldn't send. Check your connection and try again."); }
}
async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast("Voice messages don't work in this browser.");
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast("The microphone isn't available here."); }
  const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
  const mr = new MediaRecorder(stream, type ? { mimeType: type } : {}), chunks = [], t0 = Date.now();
  mr.ondataavailable = (e) => chunks.push(e.data);
  rec = { mr, stream, t0, cancel: false, timer: setInterval(() => { const b = $('#rect'); if (b) b.textContent = fmtDur((Date.now() - t0) / 1000); }, 250) };
  mr.onstop = async () => {
    clearInterval(rec.timer); stream.getTracks().forEach((t) => t.stop());
    const cancelled = rec.cancel, ms = Date.now() - t0; rec = null; main();
    if (cancelled || ms < 600) return;
    const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
    try { await S.engine.sendFile(S.room, new File([blob], 'voice' + (blob.type.includes('mp4') ? '.m4a' : '.webm'), { type: blob.type }), 'voice', { duration: ms }); } catch { toast("Couldn't send the voice message."); }
  };
  mr.start();
  $('#composer').innerHTML = String(html`<div class="rec"><span class="dotr"></span><b id="rect">0:00</b><button type="button" class="iconbtn" data-act="rec-cancel" aria-label="Cancel">${icon('trash')}</button></div><button type="button" class="send" data-act="rec-send" aria-label="Send voice message">${icon('send')}</button>`);
}
let playing = null;
async function playVoice(btn) {
  if (playing?.btn === btn) { playing.audio.pause(); playing = null; btn.innerHTML = String(icon('play')); return; }
  if (playing) { playing.audio.pause(); playing.btn.innerHTML = String(icon('play')); }
  const src = btn.dataset.local || await S.engine.media(btn.dataset.voice).catch(() => '');
  if (!src) return toast("Couldn't load that voice message.");
  const audio = new Audio(src), bar = btn.parentElement.querySelector('.bar i');
  playing = { btn, audio }; btn.innerHTML = String(icon('pause'));
  audio.ontimeupdate = () => { if (audio.duration) bar.style.width = (100 * audio.currentTime / audio.duration) + '%'; };
  audio.onended = () => { btn.innerHTML = String(icon('play')); bar.style.width = '0'; playing = null; };
  audio.play().catch(() => toast("Couldn't play that voice message."));
}

// ---------- events ----------
document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]'); if (!f) return;
  if (f.dataset.form === 'send') {
    e.preventDefault(); const ta = $('#msg'); const v = ta.value; ta.value = ''; ta.style.height = ''; composerState();
    const c = S.compose; S.compose = null; composeBar();
    if (c?.mode === 'edit') { if (v.trim()) S.engine.edit(S.room, c.id, v.trim()).catch((err) => toast(err.message)); return; }
    sendText(v, c?.mode === 'reply' ? { replyTo: c.id } : {}); return;
  }
  if (f.dataset.form === 'poll') {
    e.preventDefault(); const q = f.q.value.trim(), opts = [...f.querySelectorAll('input[name="opt"]')].map((i) => i.value.trim()).filter(Boolean);
    if (!q || opts.length < 2) return toast('A poll needs a question and at least two options.');
    closeSheet(); S.engine.sendPoll(S.room, q, opts).catch((err) => toast(err.message)); return;
  }
  if (f.dataset.form === 'restore') {
    e.preventDefault(); const b = f.querySelector('button.btn'); b.disabled = true;
    S.engine.restore(f.key.value).then((n) => { closeSheet(); toast(n ? 'Done. Your older private messages are back.' : 'Done. Backup is on.'); main(); })
      .catch((err) => { b.disabled = false; toast(err.message); }); return;
  }
  if (f.dataset.form === 'status') {
    e.preventDefault(); const text = f.text.value.trim(); if (!text) return toast('Type something, or pick a photo.');
    closeSheet(); S.engine.postStatus({ text, bg: f.bg.value }).then(() => toast('Status posted')).catch((err) => toast(err.message)); return;
  }
  onForm(f, e);
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'q') { S.q = e.target.value; $('#chatlist').innerHTML = String(chatRows()); }
  if (e.target.id === 'pq') { S.q = e.target.value; const pl = $('#plist'); if (pl) pl.innerHTML = String(peopleList(S.view === 'group' ? 'pick' : 'person')); clearTimeout(searchPeople.t); searchPeople.t = setTimeout(searchPeople, 250); }
  if (e.target.id === 'findq') runFind(e.target.value);
  if (e.target.id === 'msg') {
    const ta = e.target; ta.style.height = ''; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; composerState();
    if (Date.now() - typingT > 4000) { typingT = Date.now(); S.engine.typing(S.room, true); }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.target.id === 'msg' && e.key === 'Enter' && !e.shiftKey && (innerWidth >= 900 || !('ontouchstart' in window))) { e.preventDefault(); $('#composer').requestSubmit(); }
});
document.addEventListener('change', async (e) => {
  if (e.target.id === 'stfile' && e.target.files[0]) {
    const f = e.target.files[0]; closeSheet();
    if (f.size > 20e6) return toast('That file is too big (20 MB at most).');
    return S.engine.postStatus({ file: f }).then(() => toast('Status posted')).catch((err) => toast(err.message));
  }
  if (['photo', 'docfile'].includes(e.target.id) && e.target.closest('#sheet')) { const f = e.target.files; const inp = $('#composer #photo'); closeSheet(); if (f[0] && inp) { const dt = new DataTransfer(); dt.items.add(f[0]); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); } return; }
  if (e.target.id === 'docfile' && e.target.files[0]) {
    const f = e.target.files[0]; e.target.value = '';
    if (f.size > 20e6) return toast('That file is too big (20 MB at most).');
    try { await S.engine.sendFile(S.room, f, f.type.startsWith('video/') ? 'video' : 'file'); } catch { toast("Couldn't send the file."); }
  }
  if (e.target.id === 'photo' && e.target.files[0]?.type.startsWith('video/')) {
    const f = e.target.files[0]; e.target.value = '';
    if (f.size > 20e6) return toast('That video is too big (20 MB at most). Try a shorter one.');
    try { await S.engine.sendFile(S.room, f, 'video'); } catch { toast("Couldn't send the video."); }
  }
  if (e.target.id === 'photo' && e.target.files[0]) {
    const f = e.target.files[0]; e.target.value = '';
    if (f.size > 20e6) return toast('That photo is too big (20 MB at most).');
    try { const dim = await new Promise((ok) => { const i = new Image(); i.onload = () => ok({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => ok({}); i.src = URL.createObjectURL(f); }); await S.engine.sendFile(S.room, f, 'image', dim); }
    catch { toast("Couldn't send the photo."); }
  }
});
document.addEventListener('click', async (e) => {
  if (Date.now() - suppressClick < 700 && e.target.closest('.row[data-room]')) return;   // a long press opened the chat's menu
  const t = e.target.closest('button, a, [data-room]'); if (!t) return;
  const d = t.dataset;
  if (d.tab) {
    S.tab = d.tab; S.view = null; S.q = ''; S.infoFor = null;
    if (innerWidth < 900) S.room = null;
    if (d.tab === 'feed') { S.feed = null; S.feedErr = false; }
    side(); if (innerWidth < 900) main(); return;
  }
  if (d.pick !== undefined && t.closest('#picker')) { t.setAttribute('aria-pressed', String(t.getAttribute('aria-pressed') !== 'true')); if (!PICK.many) return finishPick(); const n = $$('#picker [data-pick][aria-pressed="true"]').length; $('#pickgo').disabled = !n; $('#pickgo').textContent = n ? `Send to ${n}` : 'Send'; return; }
  if (t.id === 'pickgo') return finishPick();
  if (d.story !== undefined) return openStory(+d.story);
  if (d.bg) { const f = t.closest('form'); f.bg.value = d.bg; f.querySelector('#sttext').style.background = d.bg; for (const b of f.querySelectorAll('[data-bg]')) b.setAttribute('aria-pressed', String(b === t)); return; }
  if (d.comm) { S.comm = d.comm; S.view = 'community'; return side(); }
  if (d.room) return openRoom(d.room);
  if (d.say) {
    if (S.view === 'info') { const id = S.infoFor || S.room; S.view = null; S.infoFor = null; S.room = null; openRoom(id); }
    if (!S.room) return; return sendText(d.say);
  }
  if (d.space !== undefined) { S.space = d.space; S.feed = null; S.feedErr = false; return side(); }
  if (d.person) return openWith(d.person);
  if (d.agent) return openWith(d.agent);
  if (d.pick) { const i = S.pick.findIndex((p) => p.mxid === d.pick); if (i >= 0) S.pick.splice(i, 1); else S.pick.push({ mxid: d.pick, name: d.name }); const nm = $('#gn')?.value; side(); if (nm) $('#gn').value = nm; return; }
  if (d.voice !== undefined) return playVoice(t);
  if (d.theme) { store.set('theme', d.theme); applyTheme(d.theme); return side(); }
  if (d.call) return CALLS.control(d.call);
  if (d.filter) { S.filter = d.filter; for (const c of document.querySelectorAll('[data-filter]')) c.setAttribute('aria-pressed', String(c.dataset.filter === d.filter)); $('#chatlist').innerHTML = String(chatRows()); return; }
  if (d.ring) { const box = t.closest('.ring'); box.remove(); if (d.ring === 'yes') { const m = S.engine.timeline(box.dataset.room).find((x) => x.id === box.dataset.mid); if (m) { if (S.room !== box.dataset.room) openRoom(box.dataset.room); CALLS.join(box.dataset.room, m.call); } } return; }
  if (d.callback) { if (CALLS.active()) return toast("You're already in a call."); return CALLS.start(d.callback, !!d.video); }
  if (d.joinroom) { const m = S.engine.timeline(d.joinroom).find((x) => x.id === d.joinid); if (m?.call) CALLS.join(d.joinroom, m.call); return; }
  if (d.joincall) { const m = S.engine.timeline(S.room).find((x) => x.id === d.joincall); if (m?.call) CALLS.join(S.room, m.call); return; }
  if (d.react && d.mid) { closeSheet(); return S.engine.react(S.room, d.mid, d.react).catch((err) => toast(err.message)); }
  if (d.msgmenu) return openSheet(d.msgmenu);
  if (d.hit) { closeFind(false); if (d.sroom) { S.view = null; openRoom(d.sroom); setTimeout(() => flash(d.hit), 300); return; } return flash(d.hit); }
  if (d.dis !== undefined) { closeSheet(); const id = S.infoFor || S.room; return S.engine.setDisappear(id, +d.dis).then(() => side()).catch((err) => toast(err.message)); }
  if (d.vote !== undefined && d.mid) return S.engine.vote(S.room, d.mid, +d.vote).catch((err) => toast(err.message));
  if (d.chatwith) { if (d.chatwith === S.engine.me.user_id) return; try { const id = await S.engine.openDirect(d.chatwith); openSoon(id); } catch (err) { toast(err.message); } return; }
  if (d.file !== undefined) { try { const u = await S.engine.media(d.file); const a = document.createElement('a'); a.href = u; a.download = d.name || 'file'; a.click(); } catch { toast("Couldn't open that file."); } return; }
  switch (d.act) {
    case 'fav': { const id = S.infoFor || S.room, r = S.engine.room(id); await S.engine.setFavorite(id, !r.favorite).catch((err) => toast(err.message)); return side(); }
    case 'call-voice': case 'call-video': return CALLS.start(S.room, d.act === 'call-video');
    case 'find-info': { const id = S.infoFor || S.room; S.view = null; S.infoFor = null; if (innerWidth < 900) { S.room = null; openRoom(id); } else side(); setTimeout(openFind, 50); return; }
    case 'find': return openFind();
    case 'find-close': return closeFind(true);
    case 'emoji': return toggleEmoji();
    case 'sheet-close': return closeSheet();
    case 'more-emoji': return sheetPicker();
    case 'msg-copy': { const m = sheetMsg(); closeSheet(); try { await navigator.clipboard.writeText(m?.text || ''); toast('Copied'); } catch { toast("Couldn't copy here."); } return; }
    case 'msg-translate': {
      const m = sheetMsg(); closeSheet(); if (!m) return;
      if (S.tr[m.id]) { delete S.tr[m.id]; return chatUpdate(); }
      // a private chat's messages are locked on the phones: translating one means sending it to our server, so ask once
      if (S.engine.room(S.room)?.encrypted && !store.get('trOk', false)) {
        if (!confirm(`To translate, this one message is sent to ${BRAND.name}'s own translator, which keeps nothing. The rest of the chat stays private. Translate?`)) return;
        store.set('trOk', true);
      }
      const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
      S.tr[m.id] = { text: 'Translating…', busy: true }; chatUpdate();
      try { const r = await api.translate(m.text, ['en', 'fr', 'es', 'pt', 'ar'].includes(lang) ? lang : 'en'); S.tr[m.id] = { text: r.text, from: r.source }; }
      catch (err) { delete S.tr[m.id]; toast(err.message); }
      return chatUpdate();
    }
    case 'msg-reply': case 'msg-edit': {
      const m = sheetMsg(); closeSheet(); if (!m) return;
      S.compose = { mode: d.act === 'msg-edit' ? 'edit' : 'reply', id: m.id, who: m.mine ? 'You' : m.senderName, text: preview(m) };
      composeBar();
      const ta = $('#msg'); if (S.compose.mode === 'edit') { ta.value = m.text; composerState(); }
      ta.focus(); return;
    }
    case 'compose-cancel': { const was = S.compose?.mode; S.compose = null; composeBar(); if (was === 'edit') { $('#msg').value = ''; composerState(); } return; }
    case 'msg-forward': { const m = sheetMsg(); closeSheet(); if (!m) return; return openPicker('Forward to…', async (ids) => { for (const id of ids) await S.engine.forward(id, S.room, m.id).catch((err) => toast(err.message)); toast(ids.length > 1 ? `Forwarded to ${ids.length} chats` : 'Forwarded'); }, { many: true }); }
    case 'msg-star': { const m = sheetMsg(); closeSheet(); if (m) S.engine.star(S.room, m.id, !m.starred).then(() => toast(m.starred ? 'Unstarred' : 'Starred')).catch((err) => toast(err.message)); return; }
    case 'attach': return openAttach();
    case 'att-doc': closeSheet(); return $('#docfile').click();
    case 'att-contact': closeSheet(); return openPicker('Share a contact', async ([p]) => { await S.engine.sendContact(S.room, p).catch((err) => toast(err.message)); }, { people: true });
    case 'att-poll': closeSheet(); return openPollForm();
    case 'att-place': closeSheet(); return sharePlace();
    case 'poll-add': { const box = $('#pollopts'); if (box.children.length < 12) box.insertAdjacentHTML('beforeend', String(html`<input name="opt" maxlength="80" placeholder="Option ${box.children.length + 1}">`)); return; }
    case 'starred': S.view = 'starred'; return side();
    case 'archived': history.pushState({ jisst: 'view' }, ''); S.view = 'archived'; return side();
    case 'blocked': S.view = 'blocked'; return side();
    case 'unblock': return S.engine.block(d.uid, false).then(() => { toast('Unblocked'); side(); if (S.room) main(); }).catch((err) => toast(err.message));
    case 'mute-info': { const r = S.engine.room(S.infoFor || S.room); await S.engine.mute(r.id, !r.muted).catch((err) => toast(err.message)); return side(); }
    case 'disappear': return sheet(html`<div class="picker"><h3>Disappearing messages</h3><p class="fine">New messages in this chat disappear for everyone after the time you pick.</p>${[[0, 'Off'], [86400, '24 hours'], [604800, '7 days'], [7776000, '90 days']].map(([t, l]) => html`<button type="button" class="set" data-dis="${t}">${icon('timer')}<span class="mid">${l}</span></button>`)}</div>`, 'Disappearing messages');
    case 'block-info': { const r = S.engine.room(S.infoFor || S.room); if (!r.blocked && !confirm(`Block ${r.name}? You won't see their messages or calls.`)) return; await S.engine.block(r.other, !r.blocked).catch((err) => toast(err.message)); toast(r.blocked ? 'Unblocked' : 'Blocked'); return side(); }
    case 'report-chat': { const r = S.engine.room(S.infoFor || S.room); return openReport({ roomId: r.id, who: r.dm ? r.name : 'the group ' + r.name, other: r.dm && !r.agentId ? r.other : null }); }
    case 'msg-report': { const m = sheetMsg(); closeSheet(); if (m) openReport({ roomId: S.room, msg: m, who: m.senderName, other: m.sender }); return; }
    case 'send-report': return sendReport(t);
    case 'room-pin': case 'room-mute': case 'room-archive': case 'room-fav': {
      const r = S.engine.room(d.rid); closeSheet(); if (!r) return;
      const job = d.act === 'room-pin' ? S.engine.pin(r.id, r.pinned == null) : d.act === 'room-mute' ? S.engine.mute(r.id, !r.muted) : d.act === 'room-archive' ? S.engine.archive(r.id, !r.archived) : S.engine.setFavorite(r.id, !r.favorite);
      return job.then(() => side(true)).catch((err) => toast(err.message));
    }
    case 'msg-delete': { const m = sheetMsg(); closeSheet(); if (m) S.engine.remove(S.room, m.id).catch((err) => toast(err.message)); return; }
    case 'try-demo': S.demo = true; return welcome();
    case 'leave-demo': store.set('demoName', null); S.engine?.stop(); S.room = null; S.tab = 'chats'; return S.gateway ? (S.demo = false, welcome()) : welcome();
    case 'restart': return welcome('start');
    case 'new': history.pushState({ jisst: 'view' }, ''); S.view = 'new'; S.q = ''; S.room = innerWidth < 900 ? null : S.room; return side();
    case 'group': S.view = 'group'; S.newComm = false; S.q = ''; S.pick = []; return side();
    case 'backup': return openBackup();
    case 'devices': history.pushState({ jisst: 'view' }, ''); S.view = 'devices'; S.devices = null; side(); return loadDevices();
    case 'link-scan': return openScanner();
    case 'device-out': {
      if (!confirm('Sign this computer out?')) return;
      try { await api.removeDevice(S.engine.token(), d.dev); toast('Signed out'); } catch (err) { toast(err.message); }
      return loadDevices();
    }
    case 'backup-make': {
      if (t.dataset.again && !confirm('Make a new recovery key? The old key will stop working.')) return;
      t.disabled = true;
      try { const key = await S.engine.makeRecovery(); sheet(html`<div class="picker"><h3>Your recovery key</h3><p class="fine">Write it down or keep it in your password manager. It is the only way to read your old private messages on a new phone. ${BRAND.name} can't see it and can't send it to you again.</p>
        <p class="reckey" id="reckey">${key}</p><div class="row2"><button type="button" class="btn ghost" data-act="backup-copy">${icon('copy')} Copy</button><button type="button" class="btn" data-act="sheet-close">I saved it</button></div></div>`, 'Recovery key'); }
      catch (err) { toast(err.message); t.disabled = false; }
      return;
    }
    case 'backup-copy': navigator.clipboard?.writeText($('#reckey').textContent).then(() => toast('Copied'), () => toast('Copy it by hand')); return;
    case 'status-new': if (story) closeStory(); return openStatusForm();
    case 'story-close': return closeStory();
    case 'story-next': return stepStory(1);
    case 'story-prev': return stepStory(-1);
    case 'story-del': { const st = story.list[story.who], it = st.items[story.i]; if (!confirm('Delete this status?')) return; await S.engine.remove(st.roomId, it.id).catch((err) => toast(err.message)); return closeStory(); }
    case 'community-new': S.view = 'group'; S.newComm = true; S.q = ''; S.pick = []; return side();
    case 'communities': history.pushState({ jisst: 'view' }, ''); S.view = 'communities'; return side();
    case 'comm-invite': S.addTo = S.comm; S.addToComm = S.comm; S.newComm = false; S.view = 'group'; S.q = ''; S.pick = []; return side();
    case 'comm-group': { const name = prompt('Name for the new group'); if (!name?.trim()) return; try { const id = await S.engine.addCommunityGroup(S.comm, name.trim()); S.view = null; openSoon(id); } catch (err) { toast(err.message); } return; }
    case 'add-member': S.addTo = S.infoFor || S.room; S.view = 'group'; S.q = ''; S.pick = []; return side();
    case 'back': if (history.state?.jisst) return history.back(); return back();
    case 'close-chat': if (history.state?.jisst === 'room') return history.back(); return closeRoom();
    case 'info': if (innerWidth < 900) history.pushState({ jisst: 'view' }, ''); S.view = 'info'; if (innerWidth < 900) { S.infoFor = S.room; S.room = null; main(); } return side();
    case 'leave': { const id = S.infoFor || S.room; try { await S.engine.leave(id); } catch (err) { return toast(err.message); } S.view = null; S.room = null; S.infoFor = null; side(); return main(); }
    case 'make-agent': S.madeAgent = null; S.view = 'make-agent'; return side();
    case 'copy-key': try { await navigator.clipboard.writeText($('#agentkey').textContent); toast('Key copied'); } catch { getSelection().selectAllChildren($('#agentkey')); toast('Selected: copy it now'); } return;
    case 'rename': S.view = 'rename'; return side();
    case 'install': if (S.installEvt) { S.installEvt.prompt(); S.installEvt = null; } else toast(/iphone|ipad/i.test(navigator.userAgent) ? 'In Safari, tap Share, then Add to Home Screen.' : 'Use your browser menu: Install app, or Add to Home Screen.'); return;
    case 'show-photo': { const b = t.closest('.photobox'); b.classList.remove('hidden'); t.remove(); return; }
    case 'priv-seen': case 'priv-ticks': {
      const on = t.getAttribute('aria-checked') !== 'true'; t.setAttribute('aria-checked', String(on));
      S.engine.setPrivacy(d.act === 'priv-seen' ? { lastSeen: on } : { readTicks: on }).catch(() => toast('That didn\'t save. Try again.')); return;
    }
    case 'safe-photos': { const on = t.getAttribute('aria-checked') !== 'true'; store.set('safePhotos', on); t.setAttribute('aria-checked', String(on)); return; }
    case 'push': { const on = t.getAttribute('aria-checked') !== 'true';
      if (on) { try { S.pushOn = await enablePush(); } catch { S.pushOn = false; toast("Couldn't turn alerts on."); } }
      else { const p = store.get('pusher'); if (p) await S.engine.setPusher(p, false).catch(() => {}); S.pushOn = false; }
      store.set('push', S.pushOn); return side(); }
    case 'invite': { const text = `Join me on ${BRAND.name}: ${BRAND.site}`; if (navigator.share) navigator.share({ text }).catch(() => {}); else { try { await navigator.clipboard.writeText(text); toast('Invite copied'); } catch { toast(text); } } return; }
    case 'privacy': S.room = null; return (S.demo ? sendPrivacyDemo() : openWith(S.agents.agents.find((a) => a.id === 'jisst')?.mxid).then(() => sendText('privacy')));
    case 'signout': await S.engine.signOut(); await api.signout().catch(() => {}); store.set('chat', null); store.set('me', null); S.room = null; S.tab = 'chats'; return welcome();
    case 'feed-retry': S.feedErr = false; S.feed = null; return side();
    case 'rec-cancel': if (rec) { rec.cancel = true; rec.mr.stop(); } return;
    case 'rec-send': if (rec) rec.mr.stop(); return;
  }
  if (t.id === 'sendbtn') { if (t.dataset.mode === 'send') $('#composer').requestSubmit(); else startRecording(); }
});
// ---------- message menu: react, copy, delete ----------
const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
let sheetFor = null;
const sheetMsg = () => S.engine.timeline(S.room).find((m) => m.id === sheetFor);
function openSheet(mid) {
  closeSheet(); sheetFor = mid;
  const m = sheetMsg(); if (!m || m.deleted) return;
  const el = document.createElement('div');
  el.className = 'sheet'; el.id = 'sheet';
  el.innerHTML = String(html`<button type="button" class="scrim" data-act="sheet-close" aria-label="Close"></button><div class="panel" role="dialog" aria-label="Message">
    <div class="quick">${QUICK.map((e) => html`<button type="button" data-react="${e}" data-mid="${mid}" aria-label="React ${e}">${e}</button>`)}<button type="button" data-act="more-emoji" aria-label="More emoji">${icon('plus')}</button></div>
    <div class="pick" id="sheetpick"></div>
    ${m.waiting ? '' : html`<button type="button" class="set" data-act="msg-reply">${icon('reply')}<span class="mid">Reply</span></button>`}
    ${m.mine && m.kind === 'text' && !m.call && !m.card ? html`<button type="button" class="set" data-act="msg-edit">${icon('pencil')}<span class="mid">Edit</span></button>` : ''}
    ${m.waiting || m.call ? '' : html`<button type="button" class="set" data-act="msg-forward">${icon('forward')}<span class="mid">Forward</span></button>`}
    ${m.waiting ? '' : html`<button type="button" class="set" data-act="msg-star">${icon('star')}<span class="mid">${m.starred ? 'Unstar' : 'Star'}</span></button>`}
    ${m.text && !m.call && m.kind === 'text' ? html`<button type="button" class="set" data-act="msg-copy">${icon('copy')}<span class="mid">Copy</span></button>` : ''}
    ${m.text && !m.call && S.gateway?.translate && !S.demo ? html`<button type="button" class="set" data-act="msg-translate">${icon('translate')}<span class="mid">${S.tr[m.id] ? 'Show the original' : 'Translate'}</span></button>` : ''}
    ${!m.mine && !m.waiting ? html`<button type="button" class="set" data-act="msg-report" style="color:var(--danger)">${icon('flag')}<span class="mid">Report</span></button>` : ''}
    ${m.mine ? html`<button type="button" class="set" data-act="msg-delete" style="color:var(--danger)">${icon('trash')}<span class="mid">Delete for everyone</span></button>` : ''}</div>`);
  document.body.append(el);
}
function closeSheet() { $('#sheet')?.remove(); sheetFor = null; scanStop?.(); scanStop = null; }
let pickerLoaded = null;
async function picker(onPick) {
  pickerLoaded ||= import('../vendor/emoji-picker/index.js');
  await pickerLoaded;
  const p = document.createElement('emoji-picker');
  p.dataSource = new URL('../vendor/emoji-picker/data.json', import.meta.url).href;
  p.classList.add(document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light');
  p.addEventListener('emoji-click', (e) => onPick(e.detail.unicode));
  return p;
}
async function sheetPicker() {
  const box = $('#sheetpick'); if (!box || box.firstChild) return;
  const mid = sheetFor;
  box.append(await picker((u) => { closeSheet(); S.engine.react(S.room, mid, u).catch((err) => toast(err.message)); }));
}
async function toggleEmoji() {
  const open = $('#emojipop'); if (open) return open.remove();
  const pop = document.createElement('div'); pop.id = 'emojipop'; pop.className = 'emojipop';
  $('#chat').append(pop);
  pop.append(await picker((u) => { const ta = $('#msg'); if (!ta) return; const at = ta.selectionStart ?? ta.value.length; ta.value = ta.value.slice(0, at) + u + ta.value.slice(ta.selectionEnd ?? at); ta.selectionStart = ta.selectionEnd = at + u.length; composerState(); }));
}
// the emoji popover closes on a tap outside it or on Escape
document.addEventListener('pointerdown', (e) => { const pop = $('#emojipop'); if (pop && !pop.contains(e.target) && !e.target.closest('[data-act="emoji"]')) pop.remove(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#emojipop')?.remove(); if (story) closeStory(); } if (story && e.key === 'ArrowRight') stepStory(1); if (story && e.key === 'ArrowLeft') stepStory(-1); });
// long-press a message on a phone, or right-click on a computer
let pressT = 0, suppressClick = 0;
document.addEventListener('pointerdown', (e) => {
  const row = e.target.closest('.row[data-room]');
  if (row && e.pointerType !== 'mouse' && !row.closest('#picker')) { clearTimeout(pressT); pressT = setTimeout(() => { navigator.vibrate?.(15); suppressClick = Date.now(); roomMenu(row.dataset.room); }, 480); return; }
  const msg = e.target.closest('.msg[data-mid]'); if (!msg || e.pointerType === 'mouse' || e.target.closest('button, a')) return;
  clearTimeout(pressT); pressT = setTimeout(() => { navigator.vibrate?.(15); openSheet(msg.dataset.mid); }, 480);
});
for (const ev of ['pointerup', 'pointercancel', 'pointermove']) document.addEventListener(ev, (e) => { if (ev !== 'pointermove' || Math.abs(e.movementY) + Math.abs(e.movementX) > 6) clearTimeout(pressT); });
document.addEventListener('contextmenu', (e) => { const row = e.target.closest('.row[data-room]'); if (row && !row.closest('#picker')) { e.preventDefault(); return roomMenu(row.dataset.room); } }, true);
document.addEventListener('contextmenu', (e) => { const msg = e.target.closest('.msg[data-mid]'); if (msg && !e.target.closest('a')) { e.preventDefault(); openSheet(msg.dataset.mid); } });
document.addEventListener('dblclick', (e) => { const msg = e.target.closest('.msg[data-mid]'); if (msg && !e.target.closest('button, a')) S.engine.react(S.room, msg.dataset.mid, '❤️').catch(() => {}); });

// ---------- search inside a chat (MiniSearch, on the phone: private chats can't be searched on the server) ----------
let MS = null;
async function openFind() { const f = $('#findbar'); if (!f) return; f.hidden = false; $('#findq').focus(); if (!MS) { MS = (await import('../vendor/minisearch/index.js')).default; runFind($('#findq')?.value || ''); } }
function closeFind(clear) { const f = $('#findbar'); if (!f) return; f.hidden = true; if (clear) { $('#findq').value = ''; $('#hits').innerHTML = ''; } }
function runFind(q) {
  const hits = $('#hits'); if (!hits) return;
  if (!MS || q.trim().length < 2) { hits.innerHTML = ''; return; }
  const msgs = S.engine.timeline(S.room).filter((m) => m.text && m.kind !== 'notice' && !m.deleted && !m.waiting);
  const ms = new MS({ fields: ['text', 'senderName'], storeFields: ['id'], searchOptions: { prefix: true, fuzzy: 0.2, boost: { text: 2 } } });
  ms.addAll(msgs.map((m) => ({ id: m.id, text: m.text, senderName: m.senderName })));
  const found = ms.search(q).slice(0, 30).map((h) => msgs.find((m) => m.id === h.id)).filter(Boolean);
  hits.innerHTML = found.length ? String(html`${found.map((m) => html`<button type="button" class="hit" data-hit="${m.id}"><b>${m.mine ? 'You' : m.senderName}</b> <span>${m.text.slice(0, 120)}</span><small>${when(m.ts)}</small></button>`)}`) : String(html`<p class="nohit">Nothing found in the messages loaded on this phone.</p>`);
}
function flash(mid) { const el = $(`.msg[data-mid="${CSS.escape(mid)}"]`); if (!el) return; el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }

// ---------- chat controls: reports, blocked people, a chat's own menu ----------
const spanLabel = (t) => (t >= 86400 * 60 ? '90 days' : t >= 86400 * 7 ? '7 days' : t >= 86400 ? '24 hours' : Math.round(t / 3600) + ' hours');
let REPORT = null;
function openReport(r) {
  REPORT = r;
  sheet(html`<form class="picker" data-form="report"><h3>Report ${r.who}</h3><p class="fine">The people who run ${BRAND.name} will look at it. ${r.msg && S.engine.room(r.roomId)?.encrypted ? 'This chat is private, so we only see the message if you share it below.' : ''}</p>
    ${['Spam', 'Scam or fraud', 'Bullying or threats', 'Explicit content', 'Something else'].map((x, i) => html`<label class="set radio"><input type="radio" name="why" value="${x}" ${i === 0 ? 'checked' : ''}><span class="mid">${x}</span></label>`)}
    ${r.msg ? html`<label class="set radio"><input type="checkbox" name="share" checked><span class="mid">Share this message with the report<small>${preview(r.msg).slice(0, 80)}</small></span></label>` : ''}
    ${r.other ? html`<label class="set radio"><input type="checkbox" name="block"><span class="mid">Also block ${r.who}</span></label>` : ''}
    <button type="button" class="btn" data-act="send-report" style="background:var(--danger)">Report</button></form>`, 'Report');
}
async function sendReport(btn) {
  const f = btn.closest('form'), r = REPORT; if (!r) return;
  const reason = f.why.value, share = f.share?.checked, block = f.block?.checked;
  closeSheet();
  try {
    if (r.msg) await S.engine.report(r.roomId, r.msg.id, reason).catch(() => {});
    if (!S.demo) await api.report({ room: r.roomId, event: r.msg?.id || '', reason, who: (r.other || '') + ' ' + r.who, text: share && r.msg ? preview(r.msg) : '' });
    if (block && r.other) await S.engine.block(r.other, true);
    toast('Thank you. Your report was sent.');
  } catch (err) { toast(err.message); }
  side(); if (S.room && block) main();
}
function viewBlocked() {
  const list = S.engine.blocked();
  return html`${top('Blocked people', { back: true })}<div class="scroll">${list.length ? list.map((p) => html`<div class="row">${avatar({ id: p.id, name: p.name, size: 'sm' })}<span class="mid"><span class="name">${p.name}</span></span><button type="button" class="btn ghost small" data-act="unblock" data-uid="${p.id}">Unblock</button></div>`)
    : html`<div class="empty"><p>You haven't blocked anyone. Block someone from their chat's info screen.</p></div>`}</div>`;
}
function roomMenu(id) {
  const r = S.engine.room(id); if (!r) return;
  sheet(html`<div class="picker"><h3>${r.name}</h3>
    <button type="button" class="set" data-act="room-pin" data-rid="${id}">${icon('pin')}<span class="mid">${r.pinned != null ? 'Unpin chat' : 'Pin chat'}</span></button>
    <button type="button" class="set" data-act="room-mute" data-rid="${id}">${icon('mute')}<span class="mid">${r.muted ? 'Unmute' : 'Mute alerts'}</span></button>
    <button type="button" class="set" data-act="room-fav" data-rid="${id}">${icon('star')}<span class="mid">${r.favorite ? 'Remove from favorites' : 'Add to favorites'}</span></button>
    <button type="button" class="set" data-act="room-archive" data-rid="${id}">${icon('archive')}<span class="mid">${r.archived ? 'Unarchive' : 'Archive'}</span></button></div>`, 'Chat options');
}

// ---------- replying, attaching, picking chats ----------
function composeBar() {
  const b = $('#composebar'); if (!b) return;
  const c = S.compose; b.hidden = !c;
  b.innerHTML = c ? String(html`<div class="cb">${icon(c.mode === 'edit' ? 'pencil' : 'reply')}<span><b>${c.mode === 'edit' ? 'Edit message' : 'Reply to ' + c.who}</b><small>${c.text}</small></span></div><button type="button" class="iconbtn" data-act="compose-cancel" aria-label="Cancel">${icon('close')}</button>`) : '';
}
function sheet(inner, label) {
  closeSheet();
  const el = document.createElement('div'); el.className = 'sheet'; el.id = 'sheet';
  el.innerHTML = String(html`<button type="button" class="scrim" data-act="sheet-close" aria-label="Close"></button><div class="panel" role="dialog" aria-label="${label}">${inner}</div>`);
  document.body.append(el); return el;
}
function openAttach() {
  sheet(html`<div class="attach">
    <button type="button" data-act="att-doc"><span style="background:#5b3df5">${icon('doc')}</span>Document</button>
    <label><span style="background:#e0567a">${icon('camera')}</span>Photo or video<input type="file" accept="image/*,video/*" id="photo" hidden></label>
    <button type="button" data-act="att-contact"><span style="background:#0e7c86">${icon('you')}</span>Contact</button>
    <button type="button" data-act="att-poll"><span style="background:#e08a00">${icon('poll')}</span>Poll</button>
    <button type="button" data-act="att-place"><span style="background:#2f9e5b">${icon('pin')}</span>Location</button></div>`, 'Attach');
}
function openPollForm() {
  sheet(html`<form data-form="poll" class="pollform"><h3>New poll</h3><div class="field"><label for="pq1">Question</label><input id="pq1" name="q" maxlength="200" placeholder="Where do we race on Saturday?" required></div>
    <div id="pollopts" class="pollopts"><input name="opt" maxlength="80" placeholder="Option 1" required><input name="opt" maxlength="80" placeholder="Option 2" required></div>
    <button type="button" class="btn ghost" data-act="poll-add">Add an option</button><button class="btn">Send poll</button></form>`, 'New poll');
  $('#pq1').focus();
}
async function sharePlace() {
  if (!navigator.geolocation) return toast("This browser can't share a location.");
  toast('Finding where you are…');
  navigator.geolocation.getCurrentPosition((p) => S.engine.sendLocation(S.room, { lat: p.coords.latitude, lon: p.coords.longitude }).catch((err) => toast(err.message)),
    () => toast('Location is off or blocked for this site.'), { enableHighAccuracy: true, timeout: 15000 });
}
// One list to pick from: chats (to forward) or people (to share a contact)
let PICK = {};
function openPicker(title, done, { many = false, people = false } = {}) {
  PICK = { done, many };
  const items = people
    ? [...new Map(S.engine.rooms().flatMap((r) => r.members).filter((m) => m.id !== S.engine.me.user_id).map((m) => [m.id, m])).values()].map((m) => ({ id: m.id, name: m.name || m.id, sub: m.agent ? 'Agent' : m.id, av: avatar({ id: m.id, name: m.name, agent: m.agent ? agentOf(m.id) : null, size: 'sm' }) }))
    : S.engine.rooms().map((r) => ({ id: r.id, name: r.name, sub: r.dm ? (r.agentId ? 'Agent' : 'Chat') : 'Group', av: avatar({ id: r.other || r.id, name: r.name, agent: r.agentId ? agentOf(r.other) : null, group: !r.dm, size: 'sm' }) }));
  sheet(html`<div id="picker" class="picker"><h3>${title}</h3><div class="plist">${items.length ? items.map((x) => html`<button type="button" class="row" data-pick="${x.id}" data-name="${x.name}" aria-pressed="false">${x.av}<span class="mid"><span class="name">${x.name}</span><span class="prev">${x.sub}</span></span>${many ? html`<span class="chk">${icon('tick')}</span>` : ''}</button>`) : html`<p class="empty">Nothing here yet.</p>`}</div>
    ${many ? html`<button type="button" class="btn" id="pickgo" disabled>Send</button>` : ''}</div>`, title);
}
function finishPick() {
  const chosen = $$('#picker [data-pick][aria-pressed="true"]').map((b) => ({ id: b.dataset.pick, mxid: b.dataset.pick, name: b.dataset.name }));
  closeSheet(); if (!chosen.length) return;
  PICK.done(PICK.many ? chosen.map((c) => c.id) : chosen);
}
function viewStarred() {
  const list = S.engine.starred();
  return html`${top('Starred messages', { back: true })}<div class="scroll">${list.length ? list.map(({ roomId, roomName, msg }) => html`<button type="button" class="hit" data-hit="${msg.id}" data-sroom="${roomId}"><b>${msg.mine ? 'You' : msg.senderName}${roomName !== msg.senderName ? ' · ' + roomName : ''}</b> <span>${preview(msg)}</span><small>${when(msg.ts)}</small></button>`)
    : html`<div class="empty"><div class="big">${icon('star')}</div><h2>No starred messages</h2><p>Press and hold a message (or right-click it), then Star, to keep it here.</p></div>`}</div>`;
}
// Small maps for shared places: Leaflet (BSD) with OpenStreetMap's map, loaded the first time one is needed
let leaflet = null;
function maps(root) {
  leaflet ||= new Promise((ok, no) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'vendor/leaflet/leaflet.css'; document.head.append(css);
    const sc = document.createElement('script'); sc.src = 'vendor/leaflet/leaflet.js'; sc.onload = () => ok(window.L); sc.onerror = no; document.head.append(sc);
  });
  leaflet.then((L) => {
    for (const el of root.querySelectorAll('.map:not(.leaflet-container)')) {
      const at = [+el.dataset.lat, +el.dataset.lon];
      const map = L.map(el, { zoomControl: false, attributionControl: true, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false }).setView(at, 15);
      map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
      L.circleMarker(at, { radius: 8, color: '#fff', weight: 3, fillColor: '#5b3df5', fillOpacity: 1 }).addTo(map);
    }
  }).catch(() => {});
}

async function sendPrivacyDemo() { const id = await S.engine.openDirect(S.engine.agentMxid('jisst')); openSoon(id, () => sendText('privacy')); }
function back() {
  if (S.room && ['community', 'communities', 'archived'].includes(S.view)) return closeRoom();   // a chat opened from a list screen goes back to that list
  if (S.view === 'community' && !S.room) { S.view = 'communities'; return side(); }
  if (S.view === 'group' && S.addToComm) { S.addToComm = null; S.addTo = null; S.view = 'community'; return side(); }
  if (S.view) { const was = S.view; S.view = null; S.addTo = null; S.newComm = false; if (was === 'info' && S.infoFor) { S.room = S.infoFor; S.infoFor = null; side(); return main(); } return side(); }
  if (S.room) return closeRoom();
}
addEventListener('popstate', () => back());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.room && S.engine) S.engine.markRead(S.room); });
addEventListener('resize', () => { if (S.engine && $('#tabbar')) setTabs(); });

window.__jisst = { state: S, demo: (name = 'Ada') => startDemo(name) };
boot();
