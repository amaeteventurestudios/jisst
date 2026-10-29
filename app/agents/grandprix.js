// Grand Prix: Agent Grand Prix's results in a chat. Every number comes from the game's own checked leaderboards
// (agentgrandprix.com/api/board/*), so it can only report what really happened.
const EPOCH = Date.UTC(2026, 9, 23);              // Daily Grand Prix #1: 23 October 2026 (the game's js/game.js)
export const dayNumber = (d) => Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - EPOCH) / 86400000) + 1;
const weekOf = (day) => Math.floor((day - 1) / 7) + 1;
const P = (n) => (n == null || n >= 99 ? 'DNF' : 'P' + n);
const MENU = [{ label: "Today's Daily", say: 'today' }, { label: 'Yesterday', say: 'results yesterday' }, { label: 'This week', say: 'week' }, { label: 'Play', say: 'play' }];

const site = (ctx) => (ctx.urls?.agp || 'https://agentgrandprix.com').replace(/\/$/, '');
async function board(ctx, day) { return ctx.fetchJson(`${site(ctx)}/api/board/daily?day=${day}`); }

function top(rows, n = 5) { return (rows || []).slice(0, n).map((r) => [`${r.place}. ${r.team}`, `${r.pts} pts · best ${P(r.best)}`]); }

export default {
  id: 'grandprix', name: 'Grand Prix', glyph: 'GP', color: '#E10600', kind: 'Agent Grand Prix', aliases: ['gp'],
  about: "Agent Grand Prix's Daily results and the weekly league, straight from the game's checked leaderboards.",
  commands: ['today', 'results <day>', 'results yesterday', 'week', 'play'],
  hello() { return { text: "I'm the Grand Prix desk. Ask me for today's Daily, yesterday's podium or the weekly league.", card: { buttons: MENU } }; },
  async reply(t, ctx) {
    const s = t.toLowerCase(), today = dayNumber(ctx.now());
    if (/^(hi|hello|hey|help|menu|\?)/.test(s) || !s) return { text: 'What would you like?', card: { buttons: MENU } };
    if (/play|race|link/.test(s) && !/result/.test(s)) return { text: 'Race the Daily yourself. It takes about four minutes.', card: { link: { label: 'Open Agent Grand Prix', url: site(ctx) } } };
    if (/week|league|table|standing/.test(s)) {
      const w = weekOf(today), j = await ctx.fetchJson(`${site(ctx)}/api/board/week?week=${w}&today=${today}`);
      if (!j.human?.length) return { text: `No one has raced week ${w} yet (Dailies #${j.from ?? (w - 1) * 7 + 1} to #${j.to ?? w * 7}). Be the first!`, card: { buttons: [{ label: 'Play', say: 'play' }] } };
      return { text: `Week ${w} league, Dailies #${j.from} to #${j.to}${j.done ? ' (final)' : ' so far'}.`, card: {
        title: `${j.humans} team${j.humans === 1 ? '' : 's'} of people`, fields: (j.human || []).slice(0, 5).map((r) => [`${r.place}. ${r.team}`, `${r.pts} pts${r.prize ? ` · ${r.prize} Sora` : ''}`]),
        buttons: [{ label: "Today's Daily", say: 'today' }, { label: 'Play', say: 'play' }] } };
    }
    let day = today;
    const m = s.match(/#?\s*(\d{1,4})/);
    if (m) day = +m[1]; else if (/yesterday|last/.test(s)) day = today - 1;
    if (!(day >= 1 && day <= today)) return { text: `The Dailies run from #1 to today's #${today}.`, card: { buttons: MENU } };
    if (/today|daily|result|podium|who won|winner|^\d|#/.test(s) || m) {
      const b = await board(ctx, day), city = b.venue?.city || 'the circuit', flag = b.venue?.flag || '';
      if (!b.human?.length) return { text: day === today ? `Today's Daily #${day} is at ${city} ${flag}. No one has finished it yet.` : `No one finished Daily #${day} at ${city}.`, card: { buttons: [{ label: 'Play', say: 'play' }, { label: 'This week', say: 'week' }] } };
      const w = b.human[0];
      return { text: `${day === today ? "Today's" : ''} Daily #${day} at ${city} ${flag}: ${w.team} ${day === today ? 'lead' : 'won'} with ${w.pts} points.`.replace(/^ /, ''), card: {
        title: `${b.humans} team${b.humans === 1 ? '' : 's'} of people raced${b.agents ? `, plus ${b.agents} agent${b.agents === 1 ? '' : 's'}` : ''}`,
        fields: top(b.human), buttons: [day > 1 ? { label: `Daily #${day - 1}`, say: `results ${day - 1}` } : null, { label: 'This week', say: 'week' }, { label: 'Play', say: 'play' }].filter(Boolean) } };
    }
    return { text: 'I know about the Dailies and the weekly league.', card: { buttons: MENU } };
  },
};
