# Jisste handoff

Jisste is a chat app for people and their AI agents. It looks and works like the chat apps people already know (a chat
list, chats, groups, voice notes, photos, ticks, typing), and anyone can add as many agents as they like. It opens
through the Noveniqe games: one Noveniqe account signs you in to Jisste and every game.

## What is built (foundation, October 2026)
- **App** (`app/`): installable web app, phone first, light and dark. Five tabs: Chats, Feed, Agents, Calls, You.
  One-to-one chats and groups with people and agents; photos; voice notes; read ticks; typing; unread counts; search;
  agent cards with tap-to-say buttons; make-your-own-agent keys; message alerts (Web Push); offline start (`sw.js`).
- **Demo**: `?demo`, or any copy without a gateway, runs entirely in the browser with example chats. The real agents
  answer there too, from example data.
- **Gateway** (`gateway/`): sign-in through Noveniqe Core (email code), chat accounts, the people directory, the four
  built-in agents, reminders, the feed (from the Jisste social network), developer agents, alerts. Node built-ins only.
- **Agents** (`app/agents/`), no AI spend: Jisste (the helper), Grand Prix (daily results and the weekly league from
  agentgrandprix.com), Wire (the latest posts in the feed), Reminders ("remind me in 10 minutes to call Mum").
  Coming soon in the directory: Teague and Palasora Town Hall.
- **Chat server**: Tuwunel (Matrix standard, Apache 2.0) on the Oracle server, closed: no federation, accounts only
  through the gateway.

## What is built (round 2, 29 October 2026)
- **Private chats**: chats between people are end-to-end encrypted (`app/js/crypto.js`, matrix-sdk-crypto-wasm), photos
  and voice notes too. Chats with agents are not (the agent has to read them) and say so.
- **Chat backup**: You > Chat backup makes a recovery key (standard Matrix key backup). A new phone or computer enters it
  to read older private messages.
- **Calls**: voice, video and screen sharing on LiveKit (`app/js/calls.js`, service `jisst-calls`), encrypted in private
  chats. Calls ring through phone alerts (`/api/calls/ring`), with Answer and Decline; a call that ends unanswered becomes
  a missed call alert. The Calls tab lists recent calls with call-back buttons.
- **Messages**: reactions, emoji picker, reply, edit, forward, star (You > Starred), delete, documents, videos, contact
  cards, polls, places on a map (Leaflet), search in a chat and across chats (MiniSearch), translate (our own Argos
  Translate server, service `jisst-translate`).
- **Chat controls**: pin (up to 3), mute, archive, favorites and unread filters, disappearing messages (24 hours, 7 days,
  90 days), block and report (reports reach the owners in a chat from the "safety" account).
- **Privacy switches**: last seen and online, read ticks (both work both ways). Explicit photos are blurred until a model
  on the phone has checked them (NSFWJS).
- **Communities**: Matrix spaces with an announcements channel only admins post in, groups inside, add people to all of it.
- **Status**: 24-hour updates (text on a colour, photo or video) above the chat list, with who has seen yours.
- **Link a computer**: the computer shows a QR code (and a short code); the phone scans it in You > Linked computers.
  Linked computers can be signed out from the phone.
- **Ops** (noveniqe repo): nightly backups include Jisste; Uptime Kuma checks; Umami visitor stats (no cookies).
- **Local AI** (optional): Qwen3 1.7B on llama.cpp answers the helper agent's open questions when `JISST_LOCAL_AI` = yes.
- **Bot kit**: `docs/AGENTS.md`.
- **Deploy**: `.github/workflows/deploy.yml` + `server/install.sh`, the same pattern as Palasora.

## The phone app look (29 October 2026)
On a touch screen under 900px wide (or with `?phone`), `app/js/native.js` puts `phone` on `<html>` and `app/css/phone.css`
dresses the same app as a phone app: launch screen, large titles that shrink on scroll, see-through bars, screens that
slide in, swipe from the left edge to go back (the list peeks out underneath), swipe a chat left for Mute/Archive and
right for Read/Pin, bottom sheets with a handle that drag down to close, grouped You settings, and a "Get the Jisste app"
card in phone browsers (once every 14 days at most). Every rule is scoped to `html.phone`, so computers are unchanged.
Reduce motion turns the slides off.

## The owner's steps to go live (no terminal)
1. In this repo: Settings > Secrets and variables > Actions > New repository secret. Add the same three secrets the
   palasora repo has: `SERVER_HOST`, `SERVER_USER`, `SERVER_SSH_KEY`.
2. Merge the noveniqe pull request that adds the `jisst` sign-in client, and let its deploy run (it makes Jisste's secret).
3. Merge this repo's pull request. The deploy puts Jisste at `https://jisste.129-146-26-28.sslip.io` (a free address).
4. When the domain is bought: point its DNS A record at 129.146.26.28 (Cloudflare: DNS only, grey cloud), then add the
   repo variable `JISST_DOMAIN` (for example `jisste.com`) and `JISST_SERVER_NAME` (the same name), and run the deploy
   again from the Actions tab. Change `BRAND.site` in `app/js/ui.js` to match.
5. At launch, add the variable `JISST_LAUNCHED` = `yes`. From then on the chat addresses never change.
6. Calls: in the Oracle Cloud console, open the server's network (Virtual cloud network > Security list) and add three
   ingress rules from 0.0.0.0/0: TCP 7881, UDP 3478, UDP 50000-60000. The deploy opens the server's own firewall.
7. Reports: add the repo variable `JISST_OWNERS` with your @handle in Jisste, so reports of bad messages reach you.
8. Stats and uptime pages (noveniqe repo): add the secret `OWNER_PASSWORD` (any password you choose) before its deploy;
   it guards the stats and status pages.
9. Optional: the repo variable `JISST_LOCAL_AI` = `yes` turns on the free local model (it takes about 2 GB of the server's
   memory and a longer first deploy).

## Open decisions (saved for the owner)
- Domain: jisste.com, chosen on 29 October 2026 (the owner buys it and renames this repo to jisste; GitHub forwards the old name).
- When to move Teague (WhatsApp) into Jisste as a contact.
- Whether people verify a phone number (later, through Teague's WhatsApp number, free).

## Next phases
1. Teague moves in: the Agent Grand Prix team agent as a Jisste contact (and mem0 memory already live in AGP).
2. Sign in from inside the games: "Open in Jisste" buttons in Agent Grand Prix (race crew groups made for you).
3. Store apps (Expo, MIT) once the web app proves itself; they would ring calls like a phone call (CallKit on iPhone).
4. Agent marketplace: developer agents listed after review.

## Known limits
- Calls, translation, stats, uptime and the local model were built and tested against stand-ins here; the first real
  check is after the deploy. Each one switches itself off if it fails to start, and the chat keeps working.
- iPhones show call alerts like message alerts (web apps can't ring like a phone call there), and only once Jisste is
  added to the home screen.
- A status reaches the people you have a one-to-one chat with.

## Where things are
- `app/js/main.js` screens, `app/js/matrix.js` the chat engine, `app/js/demo.js` the demo engine, `app/js/ui.js` helpers.
- `gateway/server.mjs` routes; `gateway/lib/bots.mjs` agents on the chat server; `gateway/lib/webpush.mjs` alerts.
- `tools/fake-hs.mjs` stand-in chat server; `tools/dev.mjs` everything on one computer; `tools/shot.mjs` screenshots.
- Server: `/opt/jisst` (code), `/var/lib/jisst` (data), `/etc/jisst.env` (secrets), `/etc/jisst-tuwunel.toml`,
  services `jisst-chat` (127.0.0.1:8318), `jisst-gateway` (127.0.0.1:8300), `jisst-calls` (LiveKit, 7880 behind Caddy at
  `/livekit`), `jisst-translate` (127.0.0.1:8305), optional `jisst-ai` (127.0.0.1:8306), timer `jisst-snapshot` (03:15 UTC),
  Caddy site `/etc/caddy/sites/jisst.caddy`.
- New app files: `content.js` (message kinds), `safety.js` (photo check), `link.js` (QR codes), `crypto.js` (encryption, backup).
- Tests: `npm test` covers the gateway, private chats, message features, communities, status, backup, linking and ringing.
