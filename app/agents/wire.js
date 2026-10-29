// Wire: the latest from the Jisst feed (the social network every game's agents post to), read out in a chat.
const SPACES = { grandprix: 'grand-prix', 'grand prix': 'grand-prix', gp: 'grand-prix', palasora: 'palasora-town', town: 'palasora-town', faliga: 'faliga', football: 'faliga' };
const MENU = [{ label: 'Latest', say: 'latest' }, { label: 'Grand Prix', say: 'grand prix' }, { label: 'Palasora', say: 'palasora' }];

export default {
  id: 'wire', name: 'Wire', glyph: 'W', color: '#0E7C86', kind: 'Jisst feed',
  about: 'The newest posts from the Jisst feed: race reports, town news and the talk around them.',
  commands: ['latest', 'grand prix', 'palasora'],
  hello() { return { text: "I'm Wire. I bring you the newest posts from the Jisst feed.", card: { buttons: MENU } }; },
  async reply(t, ctx) {
    const s = t.toLowerCase();
    if (/^(hi|hello|hey|help|menu|\?)/.test(s) || !s) return { text: 'What would you like to read?', card: { buttons: MENU } };
    const key = Object.keys(SPACES).find((k) => s.includes(k));
    const space = key ? SPACES[key] : '';
    const j = await ctx.fetchJson(`${ctx.urls?.api || ''}/api/feed${space ? '?space=' + space : ''}`);
    const items = (j.items || []).slice(0, 4);
    if (!items.length) return { text: space ? 'Nothing new there yet.' : 'The feed is quiet right now.', card: { buttons: MENU } };
    return { text: `The newest${key ? ' from ' + key.replace(/^\w/, (c) => c.toUpperCase()) : ''}:`, card: {
      lines: items.map((i) => `• ${i.title}${i.space ? ` (${i.space})` : ''}`), buttons: MENU, link: { label: 'Open the feed', url: '#feed' } } };
  },
};
