// Settings for the Jisst gateway. On the server they come from /etc/jisst.env (made by server/install.sh); secrets are
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
    publicUrl: url(env.JISST_PUBLIC_URL, 'http://localhost:8300'),     // where people open Jisst
    hs: url(env.JISST_HS_URL, 'http://127.0.0.1:8008'),                // the chat server (Tuwunel), loopback only
    serverName: env.JISST_SERVER_NAME || 'jisst.app',                  // the end of every chat address (@name:jisst.app); never changes
    regToken: env.JISST_REGISTRATION_TOKEN || '',                      // only the gateway may make chat accounts
    core: { url: url(env.NOVENIQE_URL, 'http://127.0.0.1:8200'), id: env.NOVENIQE_CLIENT_ID || 'jisst', secret: env.NOVENIQE_CLIENT_SECRET || '' },
    feedUrl: url(env.JISST_FEED_URL, ''),                              // the Jisst social network (Palasora's social site on its own address)
    agpUrl: url(env.JISST_AGP_URL, 'https://agentgrandprix.com'),
    secureCookies: env.JISST_INSECURE_COOKIES !== '1',
    devSignin: env.JISST_DEV_SIGNIN === '1',                           // tests only: sign in without Noveniqe Core
    bots: env.JISST_BOTS !== '0',
    // calls (LiveKit on this server); the key and secret are made by server/install.sh
    livekit: { url: env.JISST_LIVEKIT_URL || url(env.JISST_PUBLIC_URL, 'http://localhost:8300').replace(/^http/, 'ws') + '/livekit', key: env.JISST_LIVEKIT_KEY || 'jisst', secret: env.JISST_LIVEKIT_SECRET || '' },
  };
}
