# Open source in Jisst

| Part | What it does | Licence | How we use it |
|---|---|---|---|
| Tuwunel (matrix-construct/tuwunel) | Matrix chat server | Apache 2.0 | runs unchanged on the server, from its official image |
| Matrix client-server API | the open chat standard | Apache 2.0 (spec) | the app and agents speak it |
| Node.js | runs the gateway | MIT | runtime only; the gateway uses Node built-ins |
| Caddy | web server and HTTPS | Apache 2.0 | shared on the server |
| Playwright | screenshots and icons (development only) | Apache 2.0 | not shipped |

Planned: matrix-sdk-crypto-wasm (Apache 2.0) for end-to-end encryption, LiveKit (Apache 2.0) for calls, Expo (MIT) for store apps.
Everything else in this repo is our own code. No GPL or AGPL parts.
