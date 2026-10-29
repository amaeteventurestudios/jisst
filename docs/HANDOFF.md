# Jisst handoff

Jisst is a chat app for people and their AI agents. It looks and works like the chat apps people already know (a chat
list, chats, groups, voice notes, photos, ticks, typing), and anyone can add as many agents as they like. It opens
through the Noveniqe games: one Noveniqe account signs you in to Jisst and every game.

## What is built (foundation, October 2026)
- **App** (`app/`): installable web app, phone first, light and dark. Five tabs: Chats, Feed, Agents, Calls (coming soon), You.
  One-to-one chats and groups with people and agents; photos; voice notes; read ticks; typing; unread counts; search;
  agent cards with tap-to-say buttons; make-your-own-agent keys; message alerts (Web Push); offline start (`sw.js`).
- **Demo**: `?demo`, or any copy without a gateway, runs entirely in the browser with example chats. The real agents
  answer there too, from example data.
- **Gateway** (`gateway/`): sign-in through Noveniqe Core (email code), chat accounts, the people directory, the four
  built-in agents, reminders, the feed (from the Jisst social network), developer agents, alerts. Node built-ins only.
- **Agents** (`app/agents/`), no AI spend: Jisst (the helper), Grand Prix (daily results and the weekly league from
  agentgrandprix.com), Wire (the latest posts in the feed), Reminders ("remind me in 10 minutes to call Mum").
  Coming soon in the directory: Teague and Palasora Town Hall.
- **Chat server**: Tuwunel (Matrix standard, Apache 2.0) on the Oracle server, closed: no federation, accounts only
  through the gateway.
- **Deploy**: `.github/workflows/deploy.yml` + `server/install.sh`, the same pattern as Palasora.

## The owner's steps to go live (no terminal)
1. In this repo: Settings > Secrets and variables > Actions > New repository secret. Add the same three secrets the
   palasora repo has: `SERVER_HOST`, `SERVER_USER`, `SERVER_SSH_KEY`.
2. Merge the noveniqe pull request that adds the `jisst` sign-in client, and let its deploy run (it makes Jisst's secret).
3. Merge this repo's pull request. The deploy puts Jisst at `https://jisst.129-146-26-28.sslip.io` (a free address).
4. When the domain is bought: point its DNS A record at 129.146.26.28 (Cloudflare: DNS only, grey cloud), then add the
   repo variable `JISST_DOMAIN` (for example `jisst.app`) and `JISST_SERVER_NAME` (the same name), and run the deploy
   again from the Actions tab. Change `BRAND.site` in `app/js/ui.js` to match.
5. At launch, add the variable `JISST_LAUNCHED` = `yes`. From then on the chat addresses never change.

## Open decisions (saved for the owner)
- Domain and spelling: jisst.app or jisste.com (and then the brand spelled Jisste). It is one setting in each place.
- When to move Teague (WhatsApp) into Jisst as a contact.
- Whether people verify a phone number (later, through Teague's WhatsApp number, free).

## Next phases
1. End-to-end encryption in the app (matrix-sdk-crypto-wasm, Apache 2.0). The privacy text already says it is next.
2. Teague moves in: the Agent Grand Prix team agent as a Jisst contact (and mem0 memory already live in AGP).
3. Sign in from inside the games: "Open in Jisst" buttons in Agent Grand Prix (race crew groups made for you).
4. Voice and video calls (LiveKit, Apache 2.0).
5. Reactions, replies, message search, stories ("status"), channels for the games.
6. Store apps (Expo, MIT) once the web app proves itself.
7. Agent marketplace: developer agents listed after review; a bot SDK page (`docs/AGENTS.md`).

## Where things are
- `app/js/main.js` screens, `app/js/matrix.js` the chat engine, `app/js/demo.js` the demo engine, `app/js/ui.js` helpers.
- `gateway/server.mjs` routes; `gateway/lib/bots.mjs` agents on the chat server; `gateway/lib/webpush.mjs` alerts.
- `tools/fake-hs.mjs` stand-in chat server; `tools/dev.mjs` everything on one computer; `tools/shot.mjs` screenshots.
- Server: `/opt/jisst` (code), `/var/lib/jisst` (data), `/etc/jisst.env` (secrets), `/etc/jisst-tuwunel.toml`,
  services `jisst-chat` (127.0.0.1:8318) and `jisst-gateway` (127.0.0.1:8300), Caddy site `/etc/caddy/sites/jisst.caddy`.
