// Private chats: end-to-end encryption with matrix-sdk-crypto-wasm (Apache 2.0, in app/vendor/matrix-crypto). Only the
// phones in a chat hold the keys, so the server keeps messages it cannot read. The library does the cryptography; this
// file passes its requests to the chat server and back. Works in the browser (keys kept in IndexedDB) and in Node (tests).
//
// cryptoEngine({ call, user_id, device_id, load, store }) -> { sync(s), track(ids), encrypt(roomId, ids, type, content),
//   decrypt(roomId, ev), encryptFile(bytes), decryptFile(bytes, file) }
const C = '/_matrix/client/v3';

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
      default: return;   // key backup comes later
    }
    if (req.id) await machine.markRequestAsSent(req.id, req.type, JSON.stringify(res ?? {}));
  }
  // One request at a time, in order: the library expects each answer before the next round.
  const serial = (f) => (busy = busy.then(f, f));
  const flush = () => serial(async () => { for (const r of await machine.outgoingRequests()) await send(r).catch(() => {}); });
  const ids = (list) => list.map((u) => new W.UserId(u));

  return {
    /** Feed one /sync answer to the library (keys and messages sent to this phone), then answer its requests. */
    async sync(s) {
      const counts = new Map(Object.entries(s.device_one_time_keys_count || {}));
      const fallback = new Set(s.device_unused_fallback_key_types || s['org.matrix.msc2732.device_unused_fallback_key_types'] || []);
      await serial(() => machine.receiveSyncChanges(JSON.stringify(s.to_device?.events || []), new W.DeviceLists(ids(s.device_lists?.changed || []), ids(s.device_lists?.left || [])), counts, fallback));
      await flush();
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
    close() { try { machine.close(); } catch {} },
  };
}
