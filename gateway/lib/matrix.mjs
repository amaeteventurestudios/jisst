// Talking to the chat server (Tuwunel) with the standard Matrix client-server API, from the gateway.
// People never see a chat password: each account's password is worked out from the gateway's key, so only the
// gateway can sign them in, and new accounts need the server's registration token, which only the gateway holds.
import crypto from 'node:crypto';

export const passwordFor = (key, localpart) => crypto.createHmac('sha256', key).update('jisst-chat:' + localpart).digest('base64url');

export function matrix(cfg) {
  async function call(method, path, body, token, timeout = 20000) {
    const r = await fetch(cfg.hs + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    let j = {}; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  }
  async function must(method, path, body, token, timeout) {
    const r = await call(method, path, body, token, timeout);
    if (r.status >= 300) { const e = new Error(`${method} ${path.split('?')[0]} ${r.status} ${r.body.errcode || ''} ${r.body.error || ''}`.trim()); e.status = r.status; e.errcode = r.body.errcode; throw e; }
    return r.body;
  }
  const C = '/_matrix/client/v3';
  const enc = encodeURIComponent;
  const mxid = (localpart) => `@${localpart}:${cfg.serverName}`;

  /** Make the account if it isn't there yet (registration token flow), then sign in. Returns { user_id, access_token, device_id }. */
  async function ensure(localpart, device = 'Jisste') {
    const password = passwordFor(cfg.key, localpart);
    const login = () => call('POST', C + '/login', { type: 'm.login.password', identifier: { type: 'm.id.user', user: localpart }, password, initial_device_display_name: device });
    let r = await login();
    if (r.status === 200) return r.body;
    let reg = await call('POST', C + '/register', { username: localpart, password, inhibit_login: true });
    for (let i = 0; i < 4 && reg.status === 401 && reg.body.flows; i++) {
      const flow = reg.body.flows.find((f) => f.stages.every((s) => ['m.login.registration_token', 'm.login.dummy'].includes(s))) || reg.body.flows[0];
      const done = reg.body.completed || [], next = flow.stages.find((s) => !done.includes(s));
      const auth = next === 'm.login.registration_token' ? { type: next, token: cfg.regToken, session: reg.body.session } : { type: 'm.login.dummy', session: reg.body.session };
      reg = await call('POST', C + '/register', { username: localpart, password, inhibit_login: true, auth });
    }
    if (reg.status !== 200 && reg.body.errcode !== 'M_USER_IN_USE') throw new Error(`register ${localpart}: ${reg.status} ${reg.body.errcode || ''} ${reg.body.error || ''}`);
    r = await login();
    if (r.status !== 200) throw new Error(`login ${localpart}: ${r.status} ${r.body.errcode || ''}`);
    return r.body;
  }

  return {
    call, must, mxid, ensure,
    setName: (token, userId, name) => must('PUT', `${C}/profile/${enc(userId)}/displayname`, { displayname: name }, token),
    join: (token, roomId) => must('POST', `${C}/join/${enc(roomId)}`, {}, token),
    leave: (token, roomId) => call('POST', `${C}/rooms/${enc(roomId)}/leave`, {}, token),
    createRoom: (token, body) => must('POST', `${C}/createRoom`, body, token),
    send: (token, roomId, content, type = 'm.room.message') => must('PUT', `${C}/rooms/${enc(roomId)}/send/${type}/${crypto.randomUUID()}`, content, token),
    typing: (token, userId, roomId, on) => call('PUT', `${C}/rooms/${enc(roomId)}/typing/${enc(userId)}`, on ? { typing: true, timeout: 8000 } : { typing: false }, token),
    sync: (token, since, timeout = 30000) => must('GET', `${C}/sync?timeout=${timeout}${since ? '&since=' + enc(since) : ''}&filter=${enc(JSON.stringify({ room: { timeline: { limit: 20 }, state: { lazy_load_members: true } }, presence: { not_types: ['*'] } }))}`, undefined, token, timeout + 15000),
    whoami: (token) => call('GET', `${C}/account/whoami`, undefined, token),
  };
}
