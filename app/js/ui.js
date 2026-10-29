// Small helpers for the screens: safe HTML, icons, avatars, times.
export const BRAND = { name: 'Jisste', site: 'https://jisste.com' };   // the one place the app's name and address live

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
/** html`...` escapes every value unless it is raw() or an array of html`` results. */
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += (v instanceof Raw ? v.s : Array.isArray(v) ? v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('') : v == null || v === false ? '' : esc(v)) + strings[i + 1]; });
  return raw(out);
}

const P = {
  chats: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z"/>',
  feed: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M7.5 8.5h9M7.5 12h9M7.5 15.5h5"/>',
  agents: '<rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 7V4M9 12h.01M15 12h.01M9.5 15.2c1.4.9 3.6.9 5 0M3 11.5v3M21 11.5v3"/>',
  calls: '<path d="M6.5 3.5h2.8l1.4 4-2 1.4a11 11 0 0 0 6.4 6.4l1.4-2 4 1.4v2.8a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z"/>',
  you: '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  back: '<path d="M15 5l-7 7 7 7"/>', pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>', search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/><path d="M11.5 13.5L20 4"/>', mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  clip: '<path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7-7L13 4.5a3.3 3.3 0 0 1 4.7 4.7l-7.6 7.6a1.7 1.7 0 0 1-2.4-2.4l7-7"/>', camera: '<rect x="3" y="6.5" width="18" height="13" rx="3"/><circle cx="12" cy="13" r="3.5"/><path d="M8.5 6.5l1.5-2.5h4l1.5 2.5"/>',
  tick: '<path d="M4 12.5l4.5 4.5L19 6.5"/>', ticks: '<path d="M2 12.5l4.5 4.5L17 6.5"/><path d="M11.5 15.5l1.5 1.5L23 6.5"/>', clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  community: '<path d="M3 10.5 12 4l9 6.5"/><path d="M5 9.5V20h14V9.5"/><circle cx="9.5" cy="13" r="1.8"/><circle cx="14.5" cy="13" r="1.8"/><path d="M7 18a2.6 2.6 0 0 1 5 0M12 18a2.6 2.6 0 0 1 5 0"/>',
  megaphone: '<path d="M4 10v4h3l7 4V6l-7 4H4z"/><path d="M17.5 9a4 4 0 0 1 0 6"/>',
  group: '<circle cx="9" cy="9" r="3.5"/><path d="M2.5 19.5a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="8" r="2.8"/><path d="M16.5 13.2a5.5 5.5 0 0 1 5 5.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>', more: '<circle cx="12" cy="5.5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="18.5" r="1.2"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>', moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>', lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>', out: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
  code: '<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>', link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>', pause: '<path d="M8.5 5v14M15.5 5v14"/>', trash: '<path d="M5 7h14M9.5 7V4.5h5V7M7 7l1 13h8l1-13"/>', heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7.5 3c0 5.4-7.5 10-7.5 10z"/>',
  smile: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14.2c1.8 2 5.2 2 7 0M9.3 9.6h.01M14.7 9.6h.01"/>', video: '<rect x="2.5" y="6.5" width="13" height="11" rx="2.5"/><path d="M15.5 10.5l6-3.5v10l-6-3.5"/>',
  screen: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4M12 13.5V8M9.5 10.5L12 8l2.5 2.5"/>', flip: '<path d="M4 9a8 8 0 0 1 14-3l2 2M20 4v4h-4M20 15a8 8 0 0 1-14 3l-2-2M4 20v-4h4"/>',
  hangup: '<path d="M3 14.5c5-5 13-5 18 0l-2.2 2.6-3.6-1.4v-2.4a10 10 0 0 0-6.4 0v2.4l-3.6 1.4z"/>', star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
  mute: '<path d="M9 17v1a3 3 0 0 0 6 0v-1M6 9a6 6 0 0 1 9.5-4.9M18 10.5V13l2 4H7"/><path d="M3 3l18 18"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M10 2h4"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  doc: '<path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  poll: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  forward: '<path d="M14 8l6 5-6 5M20 13H10a6 6 0 0 0-6 6"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  translate: '<path d="M4 5h9M8.5 3v2M6 5c.7 3 2.6 5.4 5.5 6.8M11 5c-.8 3.6-3.3 6.5-7 8"/><path d="M12.5 21l4-9 4 9M14 17.6h5"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
  laptop: '<rect x="4.5" y="5" width="15" height="10" rx="1.5"/><path d="M2.5 18.5h19"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l9-9M16 6l3 3M14 8l2 2"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  reply: '<path d="M10 8L4 13l6 5M4 13h10a6 6 0 0 1 6 6"/>', mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M4 7l8 6 8-6"/>', spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
};
export const icon = (name, cls = '') => raw(`<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`);

const COLORS = ['#5b3df5', '#e0567a', '#0e7c86', '#e08a00', '#2f7d32', '#7b4bd1', '#c4302b', '#2465c9', '#a0522d', '#6d6875'];
export function colorFor(id) { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }
export function initials(name) { const w = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/); return ((w[0]?.[0] || '?') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase(); }
export function avatar({ id, name, agent = null, group = false, size = '' }) {
  const color = agent?.color || colorFor(id || name), text = agent?.glyph || initials(name);
  return html`<span class="av ${size} ${agent ? 'agent' : ''} ${group ? 'group' : ''}" style="background:${color}" aria-hidden="true">${group ? icon('group') : text}</span>`;
}

export function hhmm(ts) { const d = new Date(ts); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
export function when(ts) {
  const d = new Date(ts), n = new Date(), day = 86400e3;
  const start = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  if (ts >= start) return hhmm(ts);
  if (ts >= start - day) return 'Yesterday';
  if (ts >= start - 6 * day) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === n.getFullYear() ? undefined : 'numeric' });
}
export function dayLabel(ts) {
  const n = new Date(), start = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  if (ts >= start) return 'Today'; if (ts >= start - 86400e3) return 'Yesterday';
  return new Date(ts).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}
export function ago(ts) {
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 90) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
/** Text with web addresses turned into links (everything else stays escaped). */
export function linkify(text) {
  return raw(esc(text).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`));
}
let toastT;
export function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3200); }
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem('jisst.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { v == null ? localStorage.removeItem('jisst.' + k) : localStorage.setItem('jisst.' + k, JSON.stringify(v)); } catch {} },
};
