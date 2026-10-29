# Jisst

Chat with your friends, your family and as many AI agents as you like, all in one place. A Noveniqe app.

- **app/**: the app people use (an installable web app, phone first). No build step.
- **gateway/**: a small Node server (no dependencies) for sign-in with a Noveniqe account, the built-in agents, reminders, the feed and message alerts.
- **server/** and **.github/workflows/deploy.yml**: put Jisst on the Oracle server next to Palasora and Agent Grand Prix.
- The chat itself runs on [Tuwunel](https://github.com/matrix-construct/tuwunel), a server for the open Matrix chat standard.

Try it on your computer: `npm run dev`, then open http://localhost:8310 (or http://localhost:8310/?demo for the demo with example chats).
Tests: `npm test`. Screenshots at four sizes: `node tools/shot.mjs /tmp/shots`.

Read [docs/HANDOFF.md](docs/HANDOFF.md) first.
