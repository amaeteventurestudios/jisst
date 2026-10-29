// Jisst's own agents as chat accounts. Each agent (app/agents/) gets an account on the chat server and listens with a
// standard sync loop: it joins chats it is invited to, says hello in a new one-to-one chat, and answers messages
// (in a group only when someone names it). Replies carry a card (`io.jisst.card`) that the Jisst app shows with
// buttons, plus plain text for any other chat app.
import crypto from 'node:crypto';
import { AGENTS, answer, plain } from '../../app/agents/index.js';

const agentContent = (r) => ({ msgtype: 'm.text', body: plain(r), 'io.jisst.text': r.text, ...(r.card ? { 'io.jisst.card': r.card } : {}) });

export function bots(cfg, mx, db, { fetchJson, log = () => {} }) {
  const live = new Map();          // agent id -> { user_id, access_token }
  let stopped = false;

  const reminderCtx = (agentId, sender, roomId) => ({
    remind: async (at, what) => { const id = crypto.randomUUID(); return db.put('reminders', id, { id, agent: agentId, user: sender, room: roomId, at, what }); },
    reminders: async () => db.all('reminders').filter((r) => r.user === sender),
    forget: async (id) => db.del('reminders', id),
  });

  async function handle(agent, me, roomId, ev, group) {
    if (ev.type !== 'm.room.message' || ev.sender === me.user_id || live.has(botId(ev.sender))) return;
    const text = ev.content?.body;
    if (typeof text !== 'string' || !text.trim()) return;
    const ctx = { fetchJson, now: () => new Date(), group, tz: Number.isFinite(+ev.content['io.jisst.tz']) ? +ev.content['io.jisst.tz'] : 0,
      user: { name: '' }, urls: { agp: cfg.agpUrl, api: `http://127.0.0.1:${cfg.port}` }, ...reminderCtx(agent.id, ev.sender, roomId) };
    const typing = (on) => mx.typing(me.access_token, me.user_id, roomId, on).catch(() => {});
    typing(true);
    try {
      const r = await answer(agent, text, ctx);
      if (r) await mx.send(me.access_token, roomId, { ...agentContent(r), 'm.relates_to': group ? { 'm.in_reply_to': { event_id: ev.event_id } } : undefined });
    } finally { typing(false); }
  }
  const botId = (userId) => { for (const [id, b] of live) if (b.user_id === userId) return id; return ''; };

  async function loop(agent) {
    let me, since = null, rooms = new Map();
    while (!stopped) {
      try {
        me ||= await mx.ensure(agent.id, 'Jisst agent');
        if (!live.has(agent.id)) { live.set(agent.id, me); await mx.setName(me.access_token, me.user_id, agent.name).catch(() => {}); log(`agent ${agent.name} is ${me.user_id}`); }
        const s = await mx.sync(me.access_token, since, since ? 30000 : 0);
        const first = !since; since = s.next_batch;
        for (const [roomId, inv] of Object.entries(s.rooms?.invite || {})) {
          const evs = inv.invite_state?.events || [];
          const direct = evs.some((e) => e.type === 'm.room.member' && e.state_key === me.user_id && e.content?.is_direct);
          await mx.join(me.access_token, roomId).catch((e) => log(`join ${roomId}: ${e.message}`));
          const inviter = evs.find((e) => e.type === 'm.room.member' && e.state_key !== me.user_id && e.content?.membership === 'join');
          if (direct && agent.hello) await mx.send(me.access_token, roomId, agentContent(agent.hello({ user: { name: inviter?.content?.displayname || '' } }))).catch(() => {});
        }
        for (const [roomId, room] of Object.entries(s.rooms?.join || {})) {
          const n = room.summary?.['m.joined_member_count'];
          if (n != null) rooms.set(roomId, n + (room.summary['m.invited_member_count'] || 0));
          if (first) continue;                                    // never answer messages from before this start
          for (const ev of room.timeline?.events || []) await handle(agent, me, roomId, ev, (rooms.get(roomId) || 2) > 2).catch((e) => log(`${agent.id}: ${e.message}`));
        }
        for (const roomId of Object.keys(s.rooms?.leave || {})) rooms.delete(roomId);
      } catch (e) {
        log(`agent ${agent.id}: ${e.message}`);
        if (e.status === 401) me = null;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async function tickReminders() {
    const now = Date.now();
    for (const r of db.all('reminders')) {
      const b = live.get(r.agent);
      if (!b || r.at > now) continue;
      try { await mx.send(b.access_token, r.room, { msgtype: 'm.text', body: `Reminder: ${r.what}`, 'io.jisst.text': `Reminder: ${r.what}`, 'io.jisst.card': { buttons: [{ label: 'Again in 10 minutes', say: `remind me in 10 minutes to ${r.what}` }] } }); db.del('reminders', r.id); }
      catch (e) { log(`reminder ${r.id}: ${e.message}`); if (now - r.at > 86400e3) db.del('reminders', r.id); }
    }
  }

  return {
    start() { if (!cfg.bots) return; for (const a of AGENTS) loop(a); setInterval(() => tickReminders().catch(() => {}), 15000).unref(); },
    stop() { stopped = true; },
    who: (id) => live.get(id)?.user_id || `@${id}:${cfg.serverName}`,
    tickReminders,
  };
}
