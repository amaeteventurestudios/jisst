// What a message is, read from its Matrix content. Shared by the chat engine (matrix.js) and the demo (demo.js), so both
// show files, videos, contact cards, polls, places, replies and forwards the same way. Every kind keeps a plain `body`,
// so other Matrix apps still read it.
//   m.file / m.video / m.location        standard Matrix kinds
//   io.jisst.contact {mxid, name}        a contact card
//   io.jisst.poll {question, options}    a poll; votes are reactions with the key "poll:<n>", one per person
//   io.jisst.forwarded: true             forwarded from another chat
export const POLL = 'poll:';

export function kindOf(c = {}) {
  if (c['io.jisst.poll']) return 'poll';
  if (c['io.jisst.contact']) return 'contact';
  switch (c.msgtype) {
    case 'm.image': return 'image';
    case 'm.audio': return 'voice';
    case 'm.video': return 'video';
    case 'm.file': return 'file';
    case 'm.location': return 'location';
    default: return 'text';
  }
}

/** The extra fields a screen needs for one message's content. */
export function extras(c = {}) {
  const kind = kindOf(c), out = { kind };
  if (kind === 'file' || kind === 'video') out.file = { name: c.body || 'File', size: c.info?.size || 0, mimetype: c.info?.mimetype || '' };
  if (kind === 'contact') out.contact = { mxid: String(c['io.jisst.contact'].mxid || ''), name: String(c['io.jisst.contact'].name || '') };
  if (kind === 'location') { const g = /^geo:(-?[\d.]+),(-?[\d.]+)/.exec(c.geo_uri || ''); out.location = g ? { lat: +g[1], lon: +g[2], label: c['io.jisst.label'] || '' } : null; if (!out.location) out.kind = 'text'; }
  if (kind === 'poll') out.pollDef = { question: String(c['io.jisst.poll'].question || ''), options: (c['io.jisst.poll'].options || []).map(String).slice(0, 12) };
  if (c['io.jisst.forwarded']) out.forwarded = true;
  return out;
}

/** Tally a poll from its reactions: [{ key, list: [{ sender, ts? }] }] -> options with counts, one vote per person (the newest). */
export function tally(def, votes, me) {
  const byPerson = new Map();
  for (const v of votes) { const i = +v.key.slice(POLL.length); if (Number.isInteger(i) && i >= 0 && i < def.options.length) byPerson.set(v.sender, i); }
  const counts = def.options.map(() => 0);
  for (const i of byPerson.values()) counts[i]++;
  return { question: def.question, total: byPerson.size, mine: byPerson.has(me) ? byPerson.get(me) : -1, options: def.options.map((text, i) => ({ text, count: counts[i] })) };
}

// ---- content to send ----
export const contactContent = ({ mxid, name }) => ({ msgtype: 'm.text', body: `Contact: ${name} (${mxid})`, 'io.jisst.contact': { mxid, name } });
export const pollContent = (question, options) => ({ msgtype: 'm.text', body: `Poll: ${question}\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`, 'io.jisst.poll': { question, options } });
export const locationContent = ({ lat, lon, label = '' }) => ({ msgtype: 'm.location', body: label ? `${label}: https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}` : `Location: https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}`,
  geo_uri: `geo:${(+lat).toFixed(6)},${(+lon).toFixed(6)}`, ...(label ? { 'io.jisst.label': label } : {}) });
/** A plain one-line preview, for the chat list and for replies. */
export function preview(m) {
  if (!m) return '';
  return { image: '📷 Photo', voice: '🎤 Voice message', video: '🎬 Video', file: '📄 ' + (m.file?.name || 'File'), contact: '👤 ' + (m.contact?.name || 'Contact'),
    poll: '📊 ' + (m.poll?.question || 'Poll'), location: '📍 ' + (m.location?.label || 'Location') }[m.kind] || m.text || '';
}
