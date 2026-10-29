// Jisste's own agents: the contacts that answer you in a chat. Each one is plain JavaScript with no
// dependencies, so the same brain runs on the server (gateway/, for real chats) and in the browser
// (the app's demo mode). An agent answers commands from what it can look up (a game's results, the
// Jisste feed, your reminders). No AI model is called, so an answer costs nothing.
//
// An agent is { id, name, about, glyph, color, kind, commands, hello(ctx), reply(text, ctx) }.
//   reply() returns { text, card? } or null (null: stay quiet, for example in a group where it wasn't named).
//   A card is { title?, lines?: [string], fields?: [[label, value]], buttons?: [{ label, say }], link?: { label, url } }.
//   Tapping a button sends its `say` text back as your message, so every button is also a command you could type.
// ctx gives what the agent may use: { fetchJson(url), now(), user: { name }, group, remind(at, text), reminders(), forget(id), urls }.
import jisst from './jisst.js';
import grandprix from './grandprix.js';
import wire from './wire.js';
import reminders from './reminders.js';

export const AGENTS = [jisst, grandprix, wire, reminders];
export const byId = (id) => AGENTS.find((a) => a.id === id) || null;

// Agents on the way: shown in the directory, not yet in chats.
export const SOON = [
  { id: 'teague', name: 'Teague', glyph: 'TG', color: '#E10600', kind: 'Agent Grand Prix', about: 'Your race engineer. Today he lives on WhatsApp; he moves into Jisste next.' },
  { id: 'palasora', name: 'Palasora Town Hall', glyph: 'PT', color: '#C34218', kind: 'Palasora', about: 'News, plots and your business in Palasora, once the town opens.' },
];

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Does this message talk to this agent? In a one-to-one chat always; in a group only when it names the agent. */
export function addressed(agent, text, group) {
  if (!group) return clean(text);
  const t = clean(text), names = [agent.id, agent.name, ...(agent.aliases || [])].map((n) => n.toLowerCase());
  const low = t.toLowerCase();
  for (const n of names) {
    for (const p of ['@' + n, n]) {
      if (low.startsWith(p + ' ') || low.startsWith(p + ',') || low.startsWith(p + ':') || low === p) return clean(t.slice(p.length).replace(/^[\s,:]+/, '')) || 'help';
      if (low.includes('@' + n)) return clean(t.replace(new RegExp('@' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ''));
    }
  }
  return null;
}

/** One answer from one agent, with a safe fallback when its source is down. */
export async function answer(agent, text, ctx) {
  const said = addressed(agent, text, !!ctx.group);
  if (said == null) return null;
  try { return await agent.reply(said, ctx); }
  catch (e) { return { text: `${agent.name} couldn't get that just now. Please try again in a minute.` }; }
}

/** Plain-text version of an answer, for chat apps that can't show cards. */
export function plain(r) {
  if (!r) return '';
  const c = r.card;
  const parts = [r.text];
  if (c) {
    if (c.title) parts.push(c.title);
    for (const l of c.lines || []) parts.push(l);
    for (const [k, v] of c.fields || []) parts.push(`${k}: ${v}`);
    if (c.buttons?.length) parts.push('Reply: ' + c.buttons.map((b) => b.say).join(' · '));
    if (c.link) parts.push(`${c.link.label}: ${c.link.url}`);
  }
  return parts.filter(Boolean).join('\n');
}
