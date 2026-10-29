// Private chats: end-to-end encryption with matrix-sdk-crypto-wasm (Apache 2.0, in app/vendor/matrix-crypto). Only the
// phones in a chat hold the keys, so the server keeps messages it cannot read. The library does the cryptography; this
// file passes its requests to the chat server and back. Works in the browser (keys kept in IndexedDB) and in Node (tests).
//
// cryptoEngine({ call, user_id, device_id, load, store }) -> { sync(s), track(ids), encrypt(roomId, ids, type, content),
//   decrypt(roomId, ev), encryptFile(bytes), decryptFile(bytes, file), backup(), makeRecovery(), restore(key) }
//
// Chat backup: the phone keeps a copy of its chat keys on the chat server, locked with a recovery key only the person holds
// (the standard Matrix key backup, m.megolm_backup.v1). A new phone that is given the recovery key can read old messages.
const C = '/_matrix/client/v3';
const ALGO = 'm.megolm_backup.v1.curve25519-aes-sha2';

// The recovery key is written the standard Matrix way: 0x8B 0x01, the 32 key bytes and a parity byte, in base58, in groups of 4.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b64 = { to: (u8) => btoa(String.fromCharCode(...u8)).replace(/=+$/, ''), from: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)) };
export function encodeRecoveryKey(keyBase64) {
  const key = b64.from(keyBase64), buf = new Uint8Array([0x8b, 0x01, ...key, 0]);
  buf[buf.length - 1] = buf.slice(0, -1).reduce((a, x) => a ^ x, 0);
  let n = 0n; for (const x of buf) n = n * 256n + BigInt(x);
  let out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const x of buf) { if (x) break; out = '1' + out; }
  return out.match(/.{1,4}/g).join(' ');
}
export function decodeRecoveryKey(text) {
  const s = String(text).replace(/\s+/g, '');
  let n = 0n; for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) throw new Error("That isn't a recovery key. Check the letters and try again."); n = n * 58n + BigInt(i); }
  const bytes = []; while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of s) { if (ch !== '1') break; bytes.unshift(0); }
  const buf = Uint8Array.from(bytes);
  if (buf.length !== 35 || buf[0] !== 0x8b || buf[1] !== 0x01 || buf.reduce((a, x) => a ^ x, 0) !== 0) throw new Error("That isn't a recovery key. Check the letters and try again.");
  return b64.to(buf.slice(2, 34));
}

export async function cryptoEngine({ call, user_id, device_id, load, store = true }) {
  const W = await load();
  await W.initAsync();
  const machine = await W.OlmMachine.initialize(new W.UserId(user_id), new W.DeviceId(device_id), store ? 'jisst-crypto-' + device_id : undefined);
  const T = W.RequestType;
  let busy = Promise.resolve(), txn = 0;

  async function send(req) {
    let res;
    switch (req.type) {
      case T.KeysUpload: res = await call('POST', `${C}/keys/upload`, JSON.parse(req.body)); break;
      case T.KeysQuery: res = await call('POST', `${C}/keys/query`, JSON.parse(req.body)); break;
      case T.KeysClaim: res = await call('POST', `${C}/keys/claim`, JSON.parse(req.body)); break;
      case T.ToDevice: res = await call('PUT', `${C}/sendToDevice/${encodeURIComponent(req.event_type)}/${encodeURIComponent(req.txn_id || 'jc' + Date.now() + '.' + txn++)}`, JSON.parse(req.body)); break;
      case T.SignatureUpload: res = await call('POST', `${C}/keys/signatures/upload`, JSON.parse(req.body)); break;
      case T.RoomMessage: res = await call('PUT', `${C}/rooms/${encodeURIComponent(req.room_id)}/send/${encodeURIComponent(req.event_type)}/${encodeURIComponent(req.txn_id)}`, JSON.parse(req.body)); break;
      case T.KeysBackup: res = await call('PUT', `${C}/room_keys/keys?version=${encodeURIComponent(req.version)}`, JSON.parse(req.body)); break;
      default: return;
    }
    if (req.id) await machine.markRequestAsSent(req.id, req.type, JSON.stringify(res ?? {}));
  }
  // One request at a time, in order: the library expects each answer before the next round.
  const serial = (f) => (busy = busy.then(f, f));
  const flush = () => serial(async () => { for (const r of await machine.outgoingRequests()) await send(r).catch(() => {}); });
  // send new chat keys to the backup, a batch at a time
  const pushBackup = () => serial(async () => { if (!(await machine.isBackupEnabled())) return; for (let i = 0; i < 50; i++) { const r = await machine.backupRoomKeys(); if (!r) break; await send(r); } }).catch(() => {});
  const serverBackup = () => call('GET', `${C}/room_keys/version`).catch((e) => { if (e.status === 404) return null; throw e; });
  async function turnOn(key, version) {
    await serial(async () => { await machine.saveBackupDecryptionKey(key, version); await machine.enableBackupV1(key.megolmV1PublicKey.publicKeyBase64, version); });
    await pushBackup();
  }
  // a phone that already holds the key for the server's current backup keeps it going
  try {
    const saved = await machine.getBackupKeys(), on = saved?.decryptionKey && await serverBackup();
    if (on && on.version === saved.backupVersion && on.auth_data?.public_key === saved.decryptionKey.megolmV1PublicKey.publicKeyBase64) await machine.enableBackupV1(on.auth_data.public_key, on.version);
  } catch {}
  const ids = (list) => list.map((u) => new W.UserId(u));

  return {
    /** Feed one /sync answer to the library (keys and messages sent to this phone), then answer its requests. */
    async sync(s) {
      const counts = new Map(Object.entries(s.device_one_time_keys_count || {}));
      const fallback = new Set(s.device_unused_fallback_key_types || s['org.matrix.msc2732.device_unused_fallback_key_types'] || []);
      await serial(() => machine.receiveSyncChanges(JSON.stringify(s.to_device?.events || []), new W.DeviceLists(ids(s.device_lists?.changed || []), ids(s.device_lists?.left || [])), counts, fallback));
      await flush();
      await pushBackup();
    },
    /** People whose phones we must know about (everyone in a private chat). */
    async track(users) { if (users.length) { await serial(() => machine.updateTrackedUsers(ids(users))); await flush(); } },
    /** Lock one message for everyone now in the room. Returns the m.room.encrypted content. */
    async encrypt(roomId, users, type, content) {
      // the library takes ownership of the id objects it is given, so each call gets fresh ones
      const list = [...new Set([user_id, ...users])], who = () => ids(list), room = () => new W.RoomId(roomId);
      await serial(() => machine.updateTrackedUsers(who()));
      await flush();
      await serial(async () => { const claim = await machine.getMissingSessions(who()); if (claim) await send(claim); });
      await serial(async () => { for (const r of await machine.shareRoomKey(room(), who(), new W.EncryptionSettings())) await send(r); });
      return JSON.parse(await serial(() => machine.encryptRoomEvent(room(), type, JSON.stringify(content))));
    },
    /** Unlock one m.room.encrypted event. Returns { type, content } or null while its key hasn't arrived yet. */
    async decrypt(roomId, ev) {
      try {
        const d = await machine.decryptRoomEvent(JSON.stringify(ev), new W.RoomId(roomId), new W.DecryptionSettings(W.TrustRequirement.Untrusted));
        const plain = JSON.parse(d.event);
        return { type: plain.type, content: plain.content || {} };
      } catch { return null; }
    },
    /** Photos and voice notes in private chats are locked before upload; `file` holds the key for the message. */
    encryptFile(bytes) { const a = W.Attachment.encrypt(bytes); return { data: a.encryptedData, file: JSON.parse(a.mediaEncryptionInfo) }; },
    decryptFile(bytes, file) { const { url, mimetype, ...info } = file; return W.Attachment.decrypt(new W.EncryptedAttachment(bytes, JSON.stringify(info))); },
    /** 'on' (this phone backs up), 'locked' (a backup exists but this phone needs the recovery key) or 'off'. */
    async backup() {
      const on = await serverBackup(); if (!on) return 'off';
      const saved = await machine.getBackupKeys();
      return saved?.decryptionKey && saved.backupVersion === on.version ? 'on' : 'locked';
    },
    /** Start a new backup and return its recovery key (shown once; the person keeps it). Replaces any older backup. */
    async makeRecovery() {
      const key = W.BackupDecryptionKey.createRandomKey();
      const { version } = await call('POST', `${C}/room_keys/version`, { algorithm: ALGO, auth_data: { public_key: key.megolmV1PublicKey.publicKeyBase64 } });
      await serial(() => machine.disableBackup().catch(() => {}));
      await turnOn(key, version);
      return encodeRecoveryKey(key.toBase64());
    },
    /** Unlock the backup with a recovery key: old messages on this phone become readable. Returns how many keys came back. */
    async restore(text) {
      const key = W.BackupDecryptionKey.fromBase64(decodeRecoveryKey(text));
      const on = await serverBackup(); if (!on) throw new Error('There is no chat backup to restore yet.');
      if (on.auth_data?.public_key !== key.megolmV1PublicKey.publicKeyBase64) throw new Error("That recovery key is for a different backup. Check it and try again.");
      const all = await call('GET', `${C}/room_keys/keys?version=${encodeURIComponent(on.version)}`);
      const rooms = new Map();
      for (const [roomId, r] of Object.entries(all.rooms || {})) {
        const sessions = new Map();
        for (const [sid, k] of Object.entries(r.sessions || {})) { try { const d = k.session_data; sessions.set(sid, JSON.parse(key.decryptV1(d.ephemeral, d.mac, d.ciphertext))); } catch {} }
        if (sessions.size) rooms.set(new W.RoomId(roomId), sessions);
      }
      const res = await serial(() => machine.importBackedUpRoomKeys(rooms, undefined, on.version));
      await turnOn(key, on.version);
      return Number(res?.importedCount ?? 0);
    },
    close() { try { machine.close(); } catch {} },
  };
}
