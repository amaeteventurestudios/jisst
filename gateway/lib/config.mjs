// Settings for the Jisste gateway. On the server they come from /etc/jisst.env (made by server/install.sh); secrets are
// made there once and never sit in the repo.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function config(env = process.env) {
  const dir = env.JISST_DATA || '/var/lib/jisst';
  fs.mkdirSync(dir, { recursive: true });
  // A key for signing cookies and deriving the chat server passwords. Made once and kept in the data folder when not given.
  let key = env.JISST_KEY || '';
  if (!key) {
    const f = path.join(dir, 'key');
    try { key = fs.readFileSync(f, 'utf8').trim(); } catch { key = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, key, { mode: 0o600 }); }
  }
  const url = (v, d = '') => String(v || d).replace(/\/$/, '');
  return {
    port: +(env.JISST_PORT || 8300),
    dir,
    key: Buffer.from(key, 'hex').length >= 16 ? Buffer.from(key, 'hex') : Buffer.from(key),
    publicUrl: url(env.JISST_PUBLIC_URL, 'http://localhost:8300'),     // where people open Jisste
    hs: url(env.JISST_HS_URL, 'http://127.0.0.1:8008'),                // the chat server (Tuwunel), loopback only
    serverName: env.JISST_SERVER_NAME || 'jisste.com',                  // the end of every chat address (@name:jisste.com); never changes
    regToken: env.JISST_REGISTRATION_TOKEN || '',                      // only the gateway may make chat accounts
    core: { url: url(env.NOVENIQE_URL, 'http://127.0.0.1:8200'), id: env.NOVENIQE_CLIENT_ID || 'jisst', secret: env.NOVENIQE_CLIENT_SECRET || '' },
    feedUrl: url(env.JISST_FEED_URL, ''),                              // the Jisste social network (Palasora's social site on its own address)
    agpUrl: url(env.JISST_AGP_URL, 'https://agentgrandprix.com'),
    secureCookies: env.JISST_INSECURE_COOKIES !== '1',
    devSignin: env.JISST_DEV_SIGNIN === '1',                           // tests only: sign in without Noveniqe Core
    bots: env.JISST_BOTS !== '0',
    // calls (LiveKit on this server); the key and secret are made by server/install.sh
    localAi: url(env.JISST_LOCAL_AI_URL, ''),                          // llama.cpp's server, only when the owner switched it on
    owners: String(env.JISST_OWNERS || '').split(/[\s,]+/).filter(Boolean),   // who gets reports: @handles or chat addresses
    translateUrl: url(env.JISST_TRANSLATE_URL, ''),                    // the translator on this server (server/translate.py)
    // visitor stats (Umami, on the shared server): where its tracker lives and Jisste's site id; empty means none
    stats: { url: (env.JISST_STATS_URL || '').replace(/\/+$/, ''), site: env.JISST_STATS_SITE || '' },
    livekit: { url: env.JISST_LIVEKIT_URL || url(env.JISST_PUBLIC_URL, 'http://localhost:8300').replace(/^http/, 'ws') + '/livekit', key: env.JISST_LIVEKIT_KEY || 'jisst', secret: env.JISST_LIVEKIT_SECRET || '' },
  };
}
