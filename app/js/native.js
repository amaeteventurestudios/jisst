// Jisste on a phone feels like a phone app: screens slide in and out, a swipe from the left edge goes back, chats swipe
// sideways for quick actions, sheets drag down to close, titles shrink as lists scroll, and a phone browser gets a
// one-time "add it to your home screen" nudge. The look is in css/phone.css; this file adds the touch.
//   native.init({ back, rowActions, closeSheet, installEvt })   once
//   native.screen(kind, el)   after a screen renders: kind is 'push', 'reveal' or 'tab'
const $ = (s, el = document) => el.querySelector(s);
const root = document.documentElement;
const ua = navigator.userAgent;
const ios = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const narrow = matchMedia('(max-width: 899px)'), coarse = matchMedia('(pointer: coarse)');
const forced = /[?&]phone\b/.test(location.search);
export const isPhone = () => root.classList.contains('phone');
const buzz = (ms = 8) => { try { navigator.vibrate?.(ms); } catch {} };
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function classes() {
  const on = forced || (narrow.matches && (coarse.matches || navigator.maxTouchPoints > 0));
  root.classList.toggle('phone', on);
  root.classList.toggle('ios', ios);
  root.classList.toggle('android', /android/i.test(ua));
  root.classList.toggle('standalone', standalone());
}

let opts = {};
export function init(o) {
  opts = o;
  classes();
  narrow.addEventListener?.('change', classes); coarse.addEventListener?.('change', classes);
  // titles shrink once a list scrolls
  document.addEventListener('scroll', (e) => {
    const sc = e.target; if (!(sc instanceof Element) || !isPhone() || !sc.classList.contains('scroll')) return;
    const side = sc.closest('.side'); if (side) side.classList.toggle('scrolled', sc.scrollTop > 12);
  }, true);
  document.addEventListener('touchstart', start, { passive: true });
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
  // a tap after a swipe is not a tap
  document.addEventListener('click', (e) => {
    if (Date.now() - swallowUntil < 0) { e.stopPropagation(); e.preventDefault(); return; }
    const a = e.target.closest('.acts button');
    if (a) { e.stopPropagation(); e.preventDefault(); const id = a.closest('.acts').dataset.room; closeRow(); buzz(); opts.rowActions?.run(id, a.dataset.do); return; }
    if (openRow && !e.target.closest('.acts')) { e.stopPropagation(); e.preventDefault(); closeRow(); }
  }, true);
  document.addEventListener('click', (e) => { if (isPhone() && e.target.closest('.tab')) buzz(6); });
  setTimeout(nudge, 25000);
}

/** After a screen renders: slide it in like an app. */
export function screen(kind, el) {
  if (!isPhone() || !el || still()) return;
  const cls = kind === 'push' ? 'push-in' : kind === 'reveal' ? 'reveal-in' : 'tab-in';
  el.classList.remove('push-in', 'reveal-in', 'tab-in'); void el.offsetWidth; el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
  if (kind !== 'push') el.classList.remove('scrolled');
}

// ---------- touch: edge swipe back, chat row swipes, sheets ----------
let t = null, swallowUntil = 0, openRow = null;
const EDGE = 26;
function start(e) {
  if (!isPhone() || e.touches.length !== 1) { t = null; return; }
  const p = e.touches[0], target = e.target;
  t = { x: p.clientX, y: p.clientY, dx: 0, dy: 0, mode: null, target, at: Date.now() };
  const sheetPanel = target.closest('.sheet .panel');
  if (sheetPanel) { if (sheetPanel.scrollTop <= 0) t.sheet = sheetPanel; return; }
  if (target.closest('.story-view, .callscreen, emoji-picker, .emojipop, .map, input[type="range"]')) { t = null; return; }
  if (p.clientX <= EDGE && opts.canBack?.()) t.edge = true;
  const row = !t.edge && target.closest('#chatlist .row[data-room]');
  if (row) t.row = row;
}
function move(e) {
  if (!t) return;
  const p = e.touches[0]; t.dx = p.clientX - t.x; t.dy = p.clientY - t.y;
  if (!t.mode) {
    if (Math.abs(t.dx) < 10 && Math.abs(t.dy) < 10) return;
    if (t.sheet && t.dy > 0 && Math.abs(t.dy) > Math.abs(t.dx)) t.mode = 'sheet';
    else if (t.edge && t.dx > 0 && Math.abs(t.dx) > Math.abs(t.dy)) t.mode = 'back';
    else if (t.row && Math.abs(t.dx) > Math.abs(t.dy) * 1.3) t.mode = 'row';
    else { t = null; return; }
    begin();
  }
  e.preventDefault();
  if (t.mode === 'back') t.el.style.transform = `translateX(${Math.max(0, t.dx)}px)`;
  if (t.mode === 'sheet') t.el.style.transform = `translateY(${Math.max(0, t.dy)}px)`;
  if (t.mode === 'row') { const base = t.base || 0, x = Math.max(-170, Math.min(170, base + t.dx)); t.el.style.transform = `translateX(${x}px)`; t.x2 = x; }
}
function begin() {
  if (t.mode === 'sheet') { t.el = t.sheet; t.el.classList.add('dragging'); return; }
  if (t.mode === 'back') {
    const inChat = opts.inChat?.();
    t.el = inChat ? $('#main') : $('#side');
    if (inChat) $('#shell')?.classList.add('peek');
    t.el.classList.add('dragging');
    return;
  }
  if (t.mode === 'row') {
    if (openRow && openRow !== t.row) closeRow();
    t.el = t.row; t.base = openRow === t.row ? +(t.row.dataset.open || 0) : 0;
    if (openRow !== t.row) showActs(t.row);
    t.el.classList.add('dragging');
  }
}
function end() {
  if (!t || !t.mode) { t = null; return; }
  const { mode, el } = t; el.classList.remove('dragging');
  swallowUntil = Date.now() + 350;
  if (mode === 'sheet') {
    if (t.dy > 110 || (t.dy > 40 && Date.now() - t.at < 250)) { el.classList.add('snap'); el.style.transform = 'translateY(100%)'; setTimeout(() => opts.closeSheet?.(), 200); }
    else snap(el);
  }
  if (mode === 'back') {
    const go = t.dx > innerWidth * .33 || (t.dx > 50 && Date.now() - t.at < 250);
    el.classList.add('snap'); el.style.transform = go ? 'translateX(100%)' : '';
    setTimeout(() => { el.classList.remove('snap'); el.style.transform = ''; $('#shell')?.classList.remove('peek'); if (go) { buzz(); opts.back?.(true); } }, 230);
  }
  if (mode === 'row') {
    const x = t.x2 || 0, open = x > 64 ? 156 : x < -64 ? -156 : 0;
    el.classList.add('snap'); el.style.transform = open ? `translateX(${open}px)` : '';
    el.dataset.open = open;
    if (open) { openRow = el; buzz(); } else { setTimeout(() => { if (openRow !== el) hideActs(el); }, 260); if (openRow === el) openRow = null; }
    setTimeout(() => el.classList.remove('snap'), 260);
  }
  t = null;
}
function snap(el) { el.classList.add('snap'); el.style.transform = ''; setTimeout(() => el.classList.remove('snap'), 260); }

function showActs(row) {
  const list = row.closest('#chatlist'); if (!list) return;
  hideActs();
  const id = row.dataset.room, r = opts.rowActions?.room(id) || {};
  const b = (k, icon, label) => `<button type="button" class="a-${k}" data-do="${k}">${opts.rowActions?.icon(icon) || ''}${label}</button>`;
  const acts = document.createElement('div');
  acts.className = 'acts'; acts.dataset.room = id;
  acts.style.cssText = `top:${row.offsetTop}px;height:${row.offsetHeight}px`;
  acts.innerHTML = `<span>${r.unread ? b('read', 'ticks', 'Read') : ''}${b('pin', 'pin', r.pinned != null ? 'Unpin' : 'Pin')}</span>`
    + `<span>${b('mute', 'mute', r.muted ? 'Unmute' : 'Mute')}${b('archive', 'archive', r.archived ? 'Unarchive' : 'Archive')}</span>`;
  list.style.position = 'relative';
  row.classList.add('swiping');
  list.insertBefore(acts, list.firstChild);
}
function hideActs() { document.querySelectorAll('#chatlist .acts').forEach((a) => a.remove()); document.querySelectorAll('#chatlist .swiping').forEach((r) => r.classList.remove('swiping')); }
function closeRow() {
  const el = openRow; openRow = null; if (!el) return;
  el.classList.add('snap'); el.style.transform = ''; el.dataset.open = 0;
  setTimeout(() => { el.classList.remove('snap'); hideActs(el); }, 260);
}

// ---------- "get the app" nudge: in a phone browser, once ----------
function nudge() {
  if (!isPhone() || standalone() || opts.demo?.() || $('.getapp')) return;
  let seen = 0; try { seen = +localStorage.getItem('jisst.getapp') || 0; } catch {}
  if (seen && Date.now() - seen < 14 * 86400e3) return;
  if (!opts.installEvt?.() && !ios) return;   // nothing to offer on this browser
  const el = document.createElement('div'); el.className = 'getapp'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Get the app');
  el.innerHTML = `<div class="mark" aria-hidden="true">J</div><span class="t"><b>Get the Jisste app</b><small>${ios ? 'Tap Share, then Add to Home Screen' : 'Full screen, with call and message alerts'}</small></span>`
    + `${ios ? '' : '<button type="button" class="go">Install</button>'}<button type="button" class="x" aria-label="Not now">${opts.icon?.('close') || '✕'}</button>`;
  document.body.append(el);
  const done = () => { try { localStorage.setItem('jisst.getapp', String(Date.now())); } catch {} el.remove(); };
  el.querySelector('.x').onclick = done;
  const go = el.querySelector('.go');
  if (go) go.onclick = async () => { const ev = opts.installEvt?.(); done(); if (ev) { ev.prompt(); await ev.userChoice.catch(() => {}); } };
}
