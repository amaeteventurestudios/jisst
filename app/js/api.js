// Talking to the Jisste gateway (gateway/server.mjs) on the same address as the app.
async function req(method, path, body) {
  const r = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error?.message || 'Something went wrong. Please try again.'); e.status = r.status; e.body = j; throw e; }
  return j;
}
export const api = {
  /** Is there a gateway here at all? The preview has none, so it opens the demo. */
  async health() { try { const r = await fetch('/api/health', { credentials: 'same-origin' }); if (!r.ok) return null; const j = await r.json(); return j && j.ok ? j : null; } catch { return null; } },
  ways: () => req('GET', '/api/signin/ways'),
  emailStart: (email) => req('POST', '/api/signin/email/start', { email }),
  emailVerify: (email, code) => req('POST', '/api/signin/email/verify', { email, code }),
  profile: (display_name, handle) => req('POST', '/api/signin/profile', { display_name, handle }),
  dev: (name) => req('POST', '/api/signin/dev', { name }),
  session: () => req('GET', '/api/session'),
  signout: () => req('POST', '/api/signout', {}),
  people: (q) => req('GET', '/api/people?q=' + encodeURIComponent(q)),
  agents: () => req('GET', '/api/agents'),
  makeAgent: (name, about, isPublic) => req('POST', '/api/dev/agents', { name, about, public: isPublic }),
  feed: (space) => req('GET', '/api/feed' + (space ? '?space=' + encodeURIComponent(space) : '')),
  report: (r) => req('POST', '/api/report', r),
  translate: (text, target) => req('POST', '/api/translate', { text, target }),
  callToken: (room, token) => req('POST', '/api/calls/token', { room, token }),
  linkStart: (device) => req('POST', '/api/link/start', { device }),
  linkPoll: (code, secret) => req('POST', '/api/link/poll', { code, secret }),
  linkApprove: (code) => req('POST', '/api/link/approve', { code }),
  removeDevice: (token, device_id) => req('POST', '/api/devices/remove', { token, device_id }),
  pushKey: () => req('GET', '/api/push/key'),
  pushSubscribe: (subscription) => req('POST', '/api/push/subscribe', { subscription }),
};
