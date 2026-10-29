# The Jisste bot kit: make your own agent

A Jisste agent is a program that chats. It signs in to Jisste with a key and speaks the open Matrix chat standard, so any
Matrix bot library works. People add it like a contact, chat with it one to one, or put it in their groups.

## 1. Get a key
In the app: **Agents > Make your own agent**. Give it a name and a line about what it does. You get:
- its chat address, for example `@a_lagosweather_1234:jisste.com`
- the server address, for example `https://jisste.com`
- a key. It is shown once: keep it secret, like a password. Lost it? Make the agent again.

Tick "List it in the Agents tab for everyone" only when the agent is ready. Without it, people reach your agent by its chat address.

## 2. Answer messages (JavaScript, matrix-bot-sdk, MIT)

```js
// npm install matrix-bot-sdk
import { MatrixClient, SimpleFsStorageProvider, AutojoinRoomsMixin } from 'matrix-bot-sdk';

const client = new MatrixClient(process.env.JISSTE_SERVER, process.env.JISSTE_KEY, new SimpleFsStorageProvider('bot.json'));
AutojoinRoomsMixin.setupOnClient(client);          // join chats people add it to
const me = await client.getUserId();

client.on('room.message', async (roomId, ev) => {
  if (ev.sender === me || ev.content?.msgtype !== 'm.text') return;
  const text = ev.content.body.trim();
  const members = await client.getJoinedRoomMembers(roomId);
  if (members.length > 2 && !/weather/i.test(text)) return;   // in groups, answer only when named
  await client.sendMessage(roomId, {
    msgtype: 'm.text',
    body: 'Lagos: 31°C, light rain after 4pm',
    'io.jisst.card': { title: 'Lagos weather', lines: ['Now 31°C', 'Rain after 4pm'], buttons: [{ label: 'Abuja', say: 'weather Abuja' }] },
  });
});
await client.start();
```

## 3. Or in Python (matrix-nio, ISC)

```python
# pip install matrix-nio
import asyncio, os
from nio import AsyncClient, RoomMessageText, InviteMemberEvent

async def main():
    c = AsyncClient(os.environ["JISSTE_SERVER"]); c.access_token = os.environ["JISSTE_KEY"]
    c.user_id = (await c.whoami()).user_id
    async def on_invite(room, ev): await c.join(room.room_id)
    async def on_text(room, ev):
        if ev.sender == c.user_id: return
        await c.room_send(room.room_id, "m.room.message", {"msgtype": "m.text", "body": "Got it: " + ev.body})
    c.add_event_callback(on_invite, InviteMemberEvent); c.add_event_callback(on_text, RoomMessageText)
    await c.sync(full_state=True); await c.sync_forever(timeout=30000)
asyncio.run(main())
```

## What a Jisste message can carry
Always fill `body` with plain text, so every Matrix app can read the answer. Then add any of these:

| Field | What people see |
|---|---|
| `io.jisst.card` `{ title, lines[], buttons[{label, say}], link{label, url} }` | a card; tapping a button sends its `say` text as the person's message |
| `io.jisst.poll` `{ question, options[] }` | a poll. Votes are reactions with the key `poll:0`, `poll:1`, ... (one per person, the newest counts) |
| `msgtype: m.location`, `geo_uri: "geo:6.45,3.39"`, `io.jisst.label` | a place with a map |
| `io.jisst.contact` `{ mxid, name }` | a contact card with a Message button |
| `m.relates_to` `{ "m.in_reply_to": { event_id } }` | a reply that quotes the earlier message |
| reaction (`m.reaction`, `m.annotation`) | an emoji under a message |

## Rules
- People always see your agent marked as an agent. Never pretend to be a person.
- In groups, answer only when your agent is named or someone replies to it.
- Agents can't join private (end-to-end encrypted) chats: a chat with an agent is not private, and the app says so.
  Send people's data nowhere they didn't ask for, and say in your agent's description what it keeps.
- Don't send alerts or messages nobody asked for. Agents that spam are switched off.
- Jisste's own agents use no paid AI. Yours may, at your own cost; the server owner can also switch on a free local model
  for the built-in helper (`JISST_LOCAL_AI`).
