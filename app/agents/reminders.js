// Reminders: "remind me in 10 minutes to call Mum". A small, everyday agent that shows Jisste is more than games.
// Times are read in the sender's own time zone (the app sends its offset with each message).
const MENU = [{ label: 'My reminders', say: 'list' }, { label: 'In 10 minutes…', say: 'remind me in 10 minutes to stretch' }];
const UNITS = { min: 60e3, mins: 60e3, minute: 60e3, minutes: 60e3, m: 60e3, hour: 3600e3, hours: 3600e3, hr: 3600e3, hrs: 3600e3, h: 3600e3, day: 86400e3, days: 86400e3 };

/** When and what, from a sentence. Returns { at, what } or null. tz = minutes east of UTC. */
export function parse(text, now = new Date(), tz = 0) {
  const s = String(text).trim().replace(/^remind me\s*/i, '').replace(/^(to\s+)/i, '');
  let at = null, rest = s;
  let m = s.match(/\bin\s+(an?|\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?)\b/i);
  if (m) { at = now.getTime() + (/^an?$/i.test(m[1]) ? 1 : +m[1]) * UNITS[m[2].toLowerCase()]; rest = s.replace(m[0], ''); }
  if (!at) {
    m = s.match(/\b(tomorrow\s+)?at\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/i) || s.match(/\b(tomorrow)\b/i);
    if (m) {
      const tomorrow = !!(m[1] || /^tomorrow$/i.test(m[0]));
      let h = m[2] != null ? +m[2] : 9; const min = m[3] != null ? +m[3] : 0, ap = (m[4] || '').toLowerCase();
      if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
      if (h > 23 || min > 59) return null;
      const local = new Date(now.getTime() + tz * 60e3);                 // the sender's wall clock, read as UTC
      let t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, min) - tz * 60e3;
      if (tomorrow) t += 86400e3; else if (t <= now.getTime()) t += 86400e3;
      at = t; rest = s.replace(m[0], '');
    }
  }
  if (!at) return null;
  const what = rest.replace(/^\s*(to|that|about)\s+/i, '').replace(/\s+(to|that|about)\s*$/i, '').replace(/\s+/g, ' ').trim();
  return { at, what: what.replace(/^(to|that|about)\s+/i, '').slice(0, 200) || 'your reminder' };
}

export function when(at, now, tz = 0) {
  const d = new Date(at + tz * 60e3), mins = Math.round((at - now) / 60e3);
  const hhmm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  if (mins < 60) return `in ${Math.max(1, mins)} minute${mins === 1 ? '' : 's'} (${hhmm})`;
  const today = new Date(now + tz * 60e3).getUTCDate() === d.getUTCDate();
  return `${today ? 'today' : 'tomorrow'} at ${hhmm}`.replace(/^tomorrow/, (Math.abs(at - now) > 2 * 86400e3) ? d.toISOString().slice(0, 10) : 'tomorrow');
}

export default {
  id: 'reminders', name: 'Reminders', glyph: 'R', color: '#E08A00', kind: 'Everyday',
  about: 'Tell it what and when: "remind me in 10 minutes to call Mum" or "at 6pm to buy bread". It messages you on time.',
  commands: ['remind me in 10 minutes to …', 'remind me at 6pm to …', 'list', 'clear'],
  hello() { return { text: 'Tell me what to remind you about, and when. For example: "remind me at 6pm to buy bread".', card: { buttons: MENU } }; },
  async reply(t, ctx) {
    const s = t.toLowerCase(), now = ctx.now().getTime(), tz = ctx.tz || 0;
    if (/^(hi|hello|hey|help|menu|\?)/.test(s) || !s) return { text: 'Try "remind me in 20 minutes to check the rice".', card: { buttons: MENU } };
    if (/^(list|my reminders|show)/.test(s)) {
      const all = (await ctx.reminders()).sort((a, b) => a.at - b.at);
      if (!all.length) return { text: 'You have no reminders waiting.', card: { buttons: MENU.slice(1) } };
      return { text: `You have ${all.length} reminder${all.length === 1 ? '' : 's'}:`, card: { fields: all.slice(0, 8).map((r) => [when(r.at, now, tz), r.what]), buttons: [{ label: 'Clear all', say: 'clear' }] } };
    }
    if (/^(clear|cancel|delete)/.test(s)) { const all = await ctx.reminders(); for (const r of all) await ctx.forget(r.id); return { text: all.length ? `Done. I cleared ${all.length} reminder${all.length === 1 ? '' : 's'}.` : 'There was nothing to clear.' }; }
    const p = parse(t, ctx.now(), tz);
    if (!p) return { text: 'I need a time. Try "in 10 minutes", "in 2 hours", "at 6pm" or "tomorrow at 9".', card: { buttons: MENU } };
    if (p.at - now > 30 * 86400e3) return { text: 'I can remind you up to 30 days ahead.' };
    if ((await ctx.reminders()).length >= 50) return { text: 'You have 50 reminders waiting, which is the most I keep. Clear some first.', card: { buttons: [{ label: 'My reminders', say: 'list' }] } };
    await ctx.remind(p.at, p.what);
    return { text: `Got it. I'll remind you ${when(p.at, now, tz)}: ${p.what}.`, card: { buttons: [{ label: 'My reminders', say: 'list' }] } };
  },
};
