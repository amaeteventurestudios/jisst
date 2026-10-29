// Jisste, the app's own helper: says hello, explains how things work and points to the other agents.
const HELP = { title: 'What I can help with', buttons: [
  { label: 'How Jisste works', say: 'how' }, { label: 'Find agents', say: 'agents' },
  { label: 'Privacy', say: 'privacy' }, { label: 'Invite a friend', say: 'invite' },
] };

export default {
  id: 'jisst', name: 'Jisste', glyph: 'J', color: '#5B3DF5', kind: 'Jisste',
  about: 'Your guide to Jisste. Ask how things work, find agents, or invite friends.',
  commands: ['how', 'agents', 'privacy', 'invite', 'tips'],
  hello(ctx) {
    const first = (ctx.user?.name || '').split(' ')[0];
    return { text: `Welcome to Jisste${first ? ', ' + first : ''}! Chat with friends, family and as many agents as you like, all in one place.`, card: HELP };
  },
  reply(t) {
    const s = t.toLowerCase();
    if (/^(hi|hello|hey|start|menu|help|\?)\b/.test(s) || !s) return { text: 'Hi! Tap one of these, or type it.', card: HELP };
    if (/how|work/.test(s)) return { text: 'Jisste works like the chat apps you know.', card: {
      lines: ['Chats: your friends, family, groups and agents in one list.', 'Feed: news from the games and the people and agents in them.',
        'Agents: add as many as you like. They answer straight away, and their buttons save typing.', 'In a group, start a message with an agent\'s name ("Grand Prix today") to ask it.'],
      buttons: [{ label: 'Find agents', say: 'agents' }, { label: 'Tips', say: 'tips' }] } };
    if (/agent|bot|find/.test(s)) return { text: 'Open the Agents tab to add any of these. Each one is free.', card: {
      fields: [['Grand Prix', 'Daily results and the weekly league'], ['Wire', 'The latest from the Jisste feed'], ['Reminders', 'Remind me in 10 minutes to call Mum']],
      buttons: [{ label: 'Tips', say: 'tips' }] } };
    if (/privacy|private|safe|data/.test(s)) return { text: 'Your chats are yours.', card: {
      lines: ['Every agent is marked as an agent. Agents only answer in a group when someone names them.', 'Messages travel encrypted to our server and are kept there so your chats follow you to any phone.',
        'End-to-end encryption (only you and the other person can read a chat) is the next step we are building.', 'You can leave any chat or remove any agent at any time.'] } };
    if (/invite|friend|share/.test(s)) return { text: 'Send your friends this link. When they join, find them by name or @handle with the pencil button on Chats.', card: { link: { label: 'Get Jisste', url: 'https://jisste.com' } } };
    if (/tip/.test(s)) return { text: 'A few tips:', card: { lines: ["Tap a button under an agent's answer instead of typing.", 'Add Jisste to your home screen from You → Install Jisste.', 'Mix people and agents in one group: your race team and the Grand Prix agent, for example.'] } };
    return { text: "I didn't catch that. Here's what I can do:", card: HELP };
  },
};
