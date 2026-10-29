# Jisst: working notes for Claude Code

Jisst is a chat app for people and their AI agents, from Noveniqe (the gaming company). It opens through the games
(Agent Grand Prix first), looks and feels like the chat apps people already use, and lets anyone add as many agents as they like.
Read `docs/HANDOFF.md` first.

## Conventions
- 80/20: the heavy parts are permissive open source (MIT, Apache 2.0, BSD; never GPL or AGPL). We write the 20% that ties them
  together. Licences are listed in `docs/OSS.md`; add every new piece there.
- No AI spend. Built-in agents answer commands from data they can look up (`app/agents/`). Never call a paid model.
- The chat runs on the Matrix client-server API (Tuwunel on the server). The app talks to it directly with the user's token;
  the gateway only signs people in, runs the agents and sends alerts.
- No build step and no runtime dependencies: plain ES modules in `app/`, Node built-ins in `gateway/`.
- `app/agents/*.js` run in both places: in the gateway (real chats) and in the browser (demo). Keep them dependency-free and
  give every network call a fallback answer.
- The brand name and site address live in one place each: `BRAND` in `app/js/ui.js`, `JISST_SERVER_NAME` on the server.
- Phone first. Check 390x844 and 844x390 (isMobile, hasTouch), 1280x800 and 1440x900, light and dark.
- Public text never mentions USG companies or Palasora's internals. Never market Jisst against another chat app by name.
- Secrets are made on the server (`server/install.sh`) and never committed or asked for in chat.

## Gotchas
- The chat server's name (`@ada:jisst.app`) is permanent once people have accounts. Before launch a new
  `JISST_SERVER_NAME` starts the chat server over, empty; `JISST_LAUNCHED=yes` locks it.
- Accounts are made only by the gateway (registration token). Chat passwords are derived from the gateway's key
  (`passwordFor`), so changing `JISST_KEY` locks everyone out of their chat accounts.
- Agents ignore the backlog on their first sync after a restart, and in groups answer only when named.
- `tools/fake-hs.mjs` is a stand-in chat server for tests and `npm run dev`: a subset of Matrix. If the app uses a new
  endpoint, add it there too.
- Message cards: `io.jisst.card` in the event content, always with a plain `body` so other Matrix apps still read it.
- The demo (`app/js/demo.js`) has the same interface as `app/js/matrix.js`; screens must not care which one runs.

## Testing
- `npm test` (gateway end to end against the stand-in chat server).
- `npm run dev`, then `node tools/shot.mjs /tmp/shots` (`MODE=demo|live`, `SIZES=port,desk`): four sizes, light and dark, console errors.
- `node tools/icons.mjs` redraws the PNG icons and the share image from the SVGs.
