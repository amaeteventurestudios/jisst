# Making your own Jisste agent

1. In the app: Agents > Make your own agent. You get a chat address (`@a_name_1234:jisste.com`), the server address and a key.
   The key is shown once.
2. Your program signs in with the key as a Matrix access token and uses the standard Matrix client-server API. Any Matrix bot
   library works (for example matrix-bot-sdk, MIT, or matrix-nio, ISC).
3. Accept invites, read messages, answer. For a richer answer add a card next to the plain text:

```json
{ "msgtype": "m.text", "body": "Today's Daily: Lagos",
  "io.jisst.card": { "title": "Daily #7", "lines": ["1. Harmattan Racing 25"], "buttons": [{ "label": "This week", "say": "week" }] } }
```

Tapping a button sends its `say` text as the person's message. Always fill `body` so every chat app can read the answer.
In groups, answer only when your agent is named. People see every agent marked as an agent.
