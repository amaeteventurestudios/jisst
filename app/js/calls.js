// Voice calls, video calls and screen sharing, on LiveKit (Apache 2.0: the server runs next to the chat server, the
// browser part is app/vendor/livekit). A call is announced in the chat as a message carrying `io.jisst.call`
// { id, video, key?, state }, so everyone in the chat can join, and it rings for whoever has Jisste open.
// In a private chat the call is private too: the caller makes a key, it travels inside the locked call message, and
// LiveKit encrypts the sound and pictures with it, so even our call server can't see or hear them.
import { api } from './api.js';
import { html, icon, avatar, toast, esc } from './ui.js';

let LK = null;
function loadLiveKit() {
  if (LK) return Promise.resolve(LK);
  return new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/livekit/livekit-client.umd.js', import.meta.url).href;
    s.onload = () => { LK = window.LivekitClient; LK ? ok(LK) : no(new Error('Calls failed to load')); };
    s.onerror = () => no(new Error('Calls failed to load. Check your connection.'));
    document.head.append(s);
  });
}
const canShare = () => !!navigator.mediaDevices?.getDisplayMedia;
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Calls in this chat's messages: which have ended. A started call stays joinable for 3 hours unless ended. */
export function callStates(timeline) {
  const ended = new Set();
  for (const m of timeline) if (m.call?.state === 'ended') ended.add(m.call.id);
  return { live: (m) => m.call && m.call.state !== 'ended' && !ended.has(m.call.id) && Date.now() - m.ts < 3 * 3600e3, ended };
}

export function calls({ getEngine, isDemo, roomInfo }) {
  let cur = null;           // the call on screen

  function screen(r, video) {
    const el = document.createElement('div');
    el.className = 'callscreen'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Call');
    el.innerHTML = String(html`<header><div><b>${r.name}</b><small id="cstate">Connecting…</small></div>${r.encrypted ? html`<span class="ctag">${icon('lock')} Private call</span>` : ''}</header>
      <div class="tiles" id="tiles"></div>
      <div class="cctl">
        <button type="button" data-call="mic" aria-pressed="true" aria-label="Microphone">${icon('mic')}</button>
        <button type="button" data-call="cam" aria-pressed="${video}" aria-label="Camera">${icon('video')}</button>
        ${canShare() ? html`<button type="button" data-call="share" aria-pressed="false" aria-label="Share your screen" title="Share your screen">${icon('screen')}</button>` : ''}
        <button type="button" data-call="flip" aria-label="Switch camera" title="Switch camera" class="flip">${icon('flip')}</button>
        <button type="button" data-call="end" class="end" aria-label="Leave the call">${icon('hangup')}</button>
      </div>`);
    document.body.append(el);
    return el;
  }
  function setState(text) { const s = cur?.el.querySelector('#cstate'); if (s) s.textContent = text; }
  function tick() { if (cur?.connectedAt && !cur.demo) setState(fmt((Date.now() - cur.connectedAt) / 1000)); }

  // ---- drawing the people in the call ----
  function tile(id, name, isMe) {
    let t = cur.el.querySelector(`[data-tile="${CSS.escape(id)}"]`);
    if (!t) {
      t = document.createElement('div'); t.className = 'tile'; t.dataset.tile = id;
      t.innerHTML = String(html`${avatar({ id, name, size: 'lg' })}<span class="tname">${isMe ? 'You' : name}</span>`);
      cur.el.querySelector('#tiles').append(t);
    }
    return t;
  }
  function render() {
    if (!cur?.room) return;
    const room = cur.room, all = [room.localParticipant, ...room.remoteParticipants.values()];
    const keep = new Set();
    for (const p of all) {
      const isMe = p === room.localParticipant, name = p.name || p.identity.slice(1).split(':')[0];
      for (const source of ['camera', 'screen']) {
        const pub = [...p.trackPublications.values()].find((x) => x.kind === 'video' && x.source === (source === 'screen' ? LK.Track.Source.ScreenShare : LK.Track.Source.Camera));
        const id = p.identity + (source === 'screen' ? '#screen' : '');
        if (source === 'screen' && !(pub?.track && !pub.isMuted)) continue;
        keep.add(id);
        const t = tile(id, source === 'screen' ? `${isMe ? 'Your' : name + "'s"} screen` : name, isMe && source === 'camera');
        t.classList.toggle('screen', source === 'screen');
        t.classList.toggle('speaking', !!p.isSpeaking);
        let v = t.querySelector('video');
        if (pub?.track && !pub.isMuted) {
          if (!v || v.dataset.sid !== pub.trackSid) { v?.remove(); v = pub.track.attach(); v.dataset.sid = pub.trackSid; v.muted = true; v.playsInline = true; if (isMe && source === 'camera') v.classList.add('mirror'); t.prepend(v); }
        } else v?.remove();
        t.classList.toggle('live', !!t.querySelector('video'));
      }
    }
    for (const t of cur.el.querySelectorAll('[data-tile]')) if (!keep.has(t.dataset.tile)) t.remove();
    const n = cur.el.querySelectorAll('[data-tile]').length;
    cur.el.querySelector('#tiles').dataset.n = Math.min(n, 9);
    if (cur.connectedAt && room.remoteParticipants.size === 0) setState(cur.started ? 'Ringing…' : 'Waiting for others…');
  }

  async function connect(roomId, info) {
    const engine = getEngine(), r = roomInfo(roomId);
    if (cur) return toast("You're already in a call.");
    const video = !!info.video;
    cur = { roomId, id: info.id, video: !!video, el: screen(r, video), started: !!info.started };
    cur.timer = setInterval(tick, 1000);
    if (isDemo()) return demoCall(r, video);
    try {
      const [lk, t] = await Promise.all([loadLiveKit(), api.callToken(roomId, engine.token())]);
      let e2ee;
      if (info.key) {
        const keyProvider = new lk.ExternalE2EEKeyProvider();
        await keyProvider.setKey(info.key);
        e2ee = { keyProvider, worker: new Worker(new URL('../vendor/livekit/livekit-client.e2ee.worker.mjs', import.meta.url), { type: 'module' }) };
      }
      const room = new lk.Room({ adaptiveStream: true, dynacast: true, ...(e2ee ? { e2ee } : {}) });
      cur.room = room;
      const E = lk.RoomEvent;
      for (const ev of [E.TrackSubscribed, E.TrackUnsubscribed, E.TrackMuted, E.TrackUnmuted, E.LocalTrackPublished, E.LocalTrackUnpublished, E.ParticipantConnected, E.ParticipantDisconnected, E.ActiveSpeakersChanged]) room.on(ev, render);
      room.on(E.TrackSubscribed, (track) => { if (track.kind === 'audio') { const a = track.attach(); a.hidden = true; cur?.el.append(a); } });
      room.on(E.ParticipantConnected, () => { if (!cur.connectedAt) return; cur.started = false; });
      room.on(E.Disconnected, () => { if (cur?.room === room) hangup(false); });
      if (e2ee) await room.setE2EEEnabled(true);
      await room.connect(t.url, t.token);
      cur.connectedAt = Date.now();
      await room.localParticipant.setMicrophoneEnabled(true).catch(() => toast("The microphone isn't available."));
      if (video) await room.localParticipant.setCameraEnabled(true).catch(() => { toast("The camera isn't available."); press('cam', false); });
      render(); tick();
    } catch (e) {
      toast(e.status === 503 ? "Calls aren't switched on on this server yet." : e.message || "Couldn't connect the call.");
      hangup(false);
    }
  }

  // The demo has no call server: it shows your own camera and the others ringing.
  async function demoCall(r, video) {
    cur.connectedAt = Date.now(); cur.demo = true;
    const me = getEngine().me, meTile = tile(me.user_id, me.name || 'You', true);
    for (const m of r.members.filter((x) => x.id !== me.user_id && !x.agent).slice(0, 5)) tile(m.id, m.name, false).classList.add('ringing');
    cur.el.querySelector('#tiles').dataset.n = Math.min(cur.el.querySelectorAll('[data-tile]').length, 9);
    setState('Ringing… (demo: calls connect on the real app)');
    if (video && navigator.mediaDevices?.getUserMedia) {
      try { cur.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); const v = document.createElement('video'); v.autoplay = true; v.muted = true; v.playsInline = true; v.className = 'mirror'; v.srcObject = cur.stream; meTile.prepend(v); meTile.classList.add('live'); } catch {}
    }
  }

  function press(what, on) { const b = cur?.el.querySelector(`[data-call="${what}"]`); if (b) b.setAttribute('aria-pressed', String(on)); }
  async function control(what) {
    if (!cur) return;
    if (what === 'end') return hangup(true);
    const lp = cur.room?.localParticipant;
    if (!lp) { if (what !== 'flip') press(what, cur.el.querySelector(`[data-call="${what}"]`).getAttribute('aria-pressed') !== 'true'); return; }
    try {
      if (what === 'mic') { const on = !lp.isMicrophoneEnabled; await lp.setMicrophoneEnabled(on); press('mic', on); }
      if (what === 'cam') { const on = !lp.isCameraEnabled; await lp.setCameraEnabled(on); press('cam', on); }
      if (what === 'share') { const on = !lp.isScreenShareEnabled; await lp.setScreenShareEnabled(on, { audio: true, selfBrowserSurface: 'include' }); press('share', on); }
      if (what === 'flip') {
        const pub = lp.getTrackPublication(LK.Track.Source.Camera), track = pub?.track;
        if (!track) return;
        cur.facing = cur.facing === 'environment' ? 'user' : 'environment';
        await track.restartTrack({ facingMode: cur.facing });
      }
      render();
    } catch (e) { if (e?.name !== 'NotAllowedError') toast(what === 'share' ? "Couldn't share your screen." : "That didn't work on this device."); }
  }

  async function hangup(byMe) {
    if (!cur) return;
    const c = cur; cur = null;
    clearInterval(c.timer);
    const alone = c.room ? c.room.remoteParticipants.size === 0 : true;
    try { await c.room?.disconnect(); } catch {}
    c.stream?.getTracks().forEach((t) => t.stop());
    c.el.remove();
    // the last one out marks the call as over in the chat
    if (byMe && alone && c.id) {
      getEngine()?.sendRaw(c.roomId, { msgtype: 'm.text', body: 'Call ended', 'io.jisst.call': { id: c.id, state: 'ended' } }).catch(() => {});
      // stop the others' phones ringing (they get a missed call alert instead)
      if (!isDemo()) api.ringCall({ room: c.roomId, token: getEngine().token(), id: c.id, state: 'ended', video: !!c.video }).catch(() => {});
    }
  }

  return {
    /** Start a call in a chat: announce it in the chat, then join it. */
    async start(roomId, video) {
      const r = roomInfo(roomId), id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const key = r.encrypted ? b64(crypto.getRandomValues(new Uint8Array(32))) : undefined;
      const call = { id, video, state: 'started', ...(key ? { key } : {}) };
      getEngine().sendRaw(roomId, { msgtype: 'm.text', body: video ? '🎥 Video call' : '📞 Voice call', 'io.jisst.call': call }).catch(() => toast("Couldn't start the call."));
      // ring the others' phones through alerts, even when Jisste is closed
      if (!isDemo()) api.ringCall({ room: roomId, token: getEngine().token(), id, video, name: r.name }).catch(() => {});
      return connect(roomId, { ...call, started: true });
    },
    join: (roomId, call) => connect(roomId, call),
    control,
    hangup: () => hangup(true),
    active: () => !!cur,
  };
}

/** What a call looks like in the chat. */
export function callBubble(m, live) {
  const ended = m.call.state === 'ended';
  return html`<div class="callmsg ${ended ? 'over' : ''}"><span class="ci">${icon(m.call.video ? 'video' : 'calls')}</span><span class="ct">${ended ? 'Call ended' : m.call.video ? 'Video call' : 'Voice call'}<small>${ended ? '' : live ? (m.mine ? 'You started a call' : `${esc(m.senderName.split(' ')[0])} started a call`) : 'Ended'}</small></span>${!ended && live ? html`<button type="button" class="join" data-joincall="${m.id}">Join</button>` : ''}</div>`;
}
