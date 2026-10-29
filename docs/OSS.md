# Open source in Jisste

Everything here is permissive open source (MIT, Apache 2.0, BSD, ISC or similar). No GPL or AGPL parts. Everything else in
this repo is our own code.

## On the server
| Part | What it does | Licence | How we use it |
|---|---|---|---|
| Tuwunel (matrix-construct/tuwunel) | Matrix chat server | Apache 2.0 | runs unchanged, from its official image |
| LiveKit server 1.13.9 | voice and video calls, screen sharing, built-in TURN | Apache 2.0 | binary taken from its official image |
| Argos Translate, CTranslate2, SentencePiece | translation on our own server | MIT, MIT, Apache 2.0 | `server/translate.py` runs them; language models from the Argos index |
| llama.cpp b11983 + Qwen3 1.7B | optional free local AI for the helper agent | MIT, Apache 2.0 | only when `JISST_LOCAL_AI` = yes |
| Node.js | runs the gateway | MIT | runtime only; the gateway uses Node built-ins |
| Caddy | web server and HTTPS | Apache 2.0 | shared on the server |
| Umami 3.4.1 + PostgreSQL | visitor stats (no cookies) | MIT, PostgreSQL licence | in the noveniqe ops setup, shared by every site |
| Uptime Kuma 2.5.8 | uptime checks and alerts | MIT | in the noveniqe ops setup |

## In the app (`app/vendor/`, each with its LICENSE and VERSION)
| Part | What it does | Licence |
|---|---|---|
| matrix-sdk-crypto-wasm 18.9.0 | end-to-end encryption, chat backup | Apache 2.0 |
| livekit-client 2.22.4 | calls in the browser, call encryption | Apache 2.0 |
| emoji-picker-element 1.29.1 (+ emojibase data) | the emoji picker | Apache 2.0 (data MIT) |
| MiniSearch 7.2.0 | message search on the phone | MIT |
| NSFWJS 4.4.0 (with TensorFlow.js, MobileNetV2) | photo safety check on the phone | MIT (TF.js Apache 2.0) |
| Leaflet 1.9.4 | maps for shared places (OpenStreetMap tiles, © OpenStreetMap contributors) | BSD-2-Clause |
| qrcode-generator 1.4.4 | QR code to link a computer | MIT |
| jsQR 1.4.0 | reads QR codes where the browser can't | Apache 2.0 |

## For bots and development
| Part | What it does | Licence |
|---|---|---|
| Matrix client-server API | the open chat standard the app and agents speak | Apache 2.0 (spec) |
| matrix-bot-sdk, matrix-nio | suggested in `docs/AGENTS.md` for people's own agents | MIT, ISC |
| Playwright | screenshots and icons (development only, not shipped) | Apache 2.0 |

Planned: Expo (MIT) for store apps.

Looked at and left out: Mjolnir (moderation bot, Apache 2.0) is in maintenance mode and its image is built for one kind of
processor only, so blocking and reporting are built into the app and gateway instead (Matrix ignore list and report API;
reports reach the owners in a chat).
