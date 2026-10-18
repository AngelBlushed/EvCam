'use strict';

const { effectiveCamera } = require('./vcam');

const VIDEO_JITTER_TARGET_MS = 60;
const AUDIO_JITTER_TARGET_MS = 80;
const HISTORY = 60;

function waitIce(pc, ms = 2500) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

/**
 * Receives the phone's camera/microphone over WebRTC and hands the tracks to the
 * compositor (video) and the audio bridge (audio). Also drives the phone through
 * a data channel (camera, quality, torch, mute...).
 */
/**
 * Ceiling for the phone's video encoder ("b=AS" in our answer: the sender must stay under it, whatever its own
 * settings say). A phone's hardware encoder was seen sending 21 Mb/s: that is what heats the phone and the radio.
 * 12.5 Mb/s is a bit above the most the app ever asks for (1080p / 60, about 10 Mb/s).
 */
const MAX_VIDEO_KBPS = 12500;

function capVideoBitrate(sdp, kbps) {
  const lines = sdp.split('\r\n');
  const out = [];
  let inVideo = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
    out.push(line);
    if (inVideo && line.startsWith('c=') && !(lines[i + 1] || '').startsWith('b=')) out.push(`b=AS:${kbps}`);
  }
  return out.join('\r\n');
}

class Engine extends EventTarget {
  constructor({ compositor, audio, getSettings }) {
    super();
    this.compositor = compositor;
    this.audio = audio;
    this.getSettings = getSettings;
    this.session = null;
    this.seq = 0;
    this.status = 'idle'; // idle | connecting | live | reconnecting
    this.device = '';
    this.phone = {
      facing: 'user', hasMic: true, micMuted: false, torch: false, torchSupported: false, torchMode: 'torch',
      zoom: { supported: false, min: 1, max: 1, value: 1 }, lensId: '', lenses: [], standby: false, standbyReason: '', thermal: 0, tempC: null, encoder: '', encoderHw: null, codec: '', fluid: null,
      battery: null, charging: null
    };
    this.batteryLog = [];
    this.wakeAt = 0;
    this._cfgSentAt = 0;
    this.stats = { width: 0, height: 0, fps: 0, bitrate: 0, rtt: 0, loss: 0, jitter: 0, latency: 0, codec: '' };
    this.history = { latency: [], bitrate: [] };
    this._statsTimer = 0;
    this._cfgTimer = 0;
  }

  get live() { return this.status === 'live' || this.status === 'reconnecting'; }

  _emit(name = 'change') { this.dispatchEvent(new CustomEvent(name)); }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this._emit();
  }

  // ----- signaling ------------------------------------------------------------

  /** Called with the phone's SDP offer; resolves with the SDP answer. */
  async handleOffer({ sdp, device }) {
    this._teardown(false);
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
    const session = { id: ++this.seq, pc, dc: null, device: device || 'Téléphone', startedAt: Date.now(), last: null, dropTimer: 0, stream: null };
    this.session = session;
    this.device = session.device;
    this.phone.standby = false;
    this.phone.standbyReason = '';
    this.phone.thermal = 0;
    this.phone.encoder = '';
    this.phone.encoderHw = null;
    this.phone.fluid = null;
    this._setStatus('connecting');

    pc.ontrack = (event) => this._onTrack(session, event);
    pc.ondatachannel = (event) => this._onDataChannel(session, event.channel);
    pc.onconnectionstatechange = () => this._onConnectionState(session);

    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIce(pc);
    return { type: 'answer', sdp: capVideoBitrate(pc.localDescription.sdp, MAX_VIDEO_KBPS) };
  }

  _onTrack(session, { track, receiver, streams }) {
    if (session !== this.session) return;
    if (track.kind === 'video') {
      try { receiver.jitterBufferTarget = VIDEO_JITTER_TARGET_MS; } catch { /* optional */ }
      this.compositor.setTrack(track);
    } else if (track.kind === 'audio') {
      try { receiver.jitterBufferTarget = AUDIO_JITTER_TARGET_MS; } catch { /* optional */ }
      session.stream = streams[0] && streams[0].getAudioTracks().length ? streams[0] : new MediaStream([track]);
      this.audio.attach(session.stream);
    }
  }

  _onDataChannel(session, channel) {
    session.dc = channel;
    channel.onopen = () => this.pushConfig(true);
    channel.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.t === 'hello' || msg.t === 'state') {
        if (msg.device) { session.device = msg.device; this.device = msg.device; }
        const prevHw = this.phone.encoderHw;
        for (const key of ['facing', 'hasMic', 'micMuted', 'torch', 'torchSupported', 'torchMode', 'zoom', 'lensId', 'lenses', 'standby', 'standbyReason', 'thermal', 'tempC', 'encoder', 'encoderHw', 'codec', 'fluid', 'battery', 'charging']) {
          if (msg[key] !== undefined) this.phone[key] = msg[key];
        }
        if (this.phone.encoderHw !== prevHw) this.dispatchEvent(new CustomEvent('phone-encoder'));
        if (msg.battery != null) this._logBattery(msg.battery, !!msg.charging);
        // the camera just started delivering: the health clock restarts here
        if (msg.t === 'state' && msg.standby === false && this._wasStandby) this._camOnAt = performance.now();
        if (msg.standby !== undefined) this._wasStandby = !!msg.standby;
        // the camera was switched on/off from the phone: mirror it in the PC setting (ignore echoes of our own command)
        // (a standby caused by the phone's screen being off is not a choice: the setting is left alone)
        if (msg.t === 'state' && typeof msg.standby === 'boolean' && msg.standbyReason !== 'sleep' && performance.now() - this._cfgSentAt > 2500 &&
            msg.standby === this.getSettings().camera.enabled) {
          this.dispatchEvent(new CustomEvent('phone-camera', { detail: !msg.standby }));
        }
        if (msg.facing && msg.facing !== this.getSettings().phone.facing && msg.t === 'state') {
          this.dispatchEvent(new CustomEvent('phone-facing', { detail: msg.facing }));
        }
        this._emit();
      }
    };
  }

  _onConnectionState(session) {
    if (session !== this.session) return;
    const state = session.pc.connectionState;
    clearTimeout(session.dropTimer);
    if (state === 'connected') {
      session.liveAt = performance.now();
      this._setStatus('live');
      this._startStats();
    } else if (state === 'disconnected') {
      this._setStatus('reconnecting');
      // The phone re-offers by itself; give up if nothing comes back.
      session.dropTimer = setTimeout(() => {
        if (session === this.session && session.pc.connectionState !== 'connected') this.closeSession('lost', false);
      }, 12000);
    } else if (state === 'failed' || state === 'closed') {
      this.closeSession('lost', false);
    }
  }

  // ----- control channel ------------------------------------------------------

  send(obj) {
    const dc = this.session && this.session.dc;
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(obj));
  }

  /** Pushes the quality / camera preferences to the phone. */
  pushConfig(immediate = false) {
    clearTimeout(this._cfgTimer);
    const run = () => {
      const s = this.getSettings();
      const eff = effectiveCamera(s, this.phone.encoderHw === false); // battery saver / software encoder cap resolution, frame rate and bitrate
      if (s.camera.enabled && this.phone.standby) this.wakeAt = performance.now();
      if (!s.camera.enabled) this._camOnAt = 0;
      this._cfgSentAt = performance.now();
      this.send({
        t: 'config',
        width: eff.capture.w,
        height: eff.capture.h,
        fps: eff.fps,
        standby: !s.camera.enabled, // false: video + audio, true: microphone only
        bitrate: eff.bitrate,
        facing: s.phone.facing,
        noiseSuppression: s.phone.noiseSuppression,
        eco: !!s.power.eco,
        force: !!s.camera.force,
        codec: s.power.codec
      });
    };
    if (immediate) run();
    else this._cfgTimer = setTimeout(run, 250);
  }

  _logBattery(level, charging) {
    if (charging) { this.batteryLog = []; return; }
    const last = this.batteryLog[this.batteryLog.length - 1];
    if (last && last.level === level) return;
    this.batteryLog.push({ t: Date.now(), level });
    if (this.batteryLog.length > 80) this.batteryLog.shift();
  }

  /** Remaining phone battery time in minutes, from the drain observed since it was unplugged (null until measurable). */
  autonomyMinutes() {
    const log = this.batteryLog;
    if (log.length < 2) return null;
    const first = log[0];
    const last = log[log.length - 1];
    const dropped = first.level - last.level;
    const minutes = (last.t - first.t) / 60000;
    if (dropped < 2 || minutes < 3) return null;
    return Math.round(last.level / (dropped / minutes));
  }

  /** H.264 negotiated but nothing arrives: tell the app to fall back to VP8 (once per session). */
  _checkHealth(session) {
    if (!session.liveAt || session.fellBack || this.phone.standby) return;
    // count from the moment the camera was (re)started: a session that began without camera has no picture yet
    const since = Math.max(session.liveAt, this.wakeAt || 0, this._camOnAt || 0);
    if (performance.now() - since < 9000) return;
    const noFrames = this.compositor.lastFrameAt < since;
    if (noFrames && this.getSettings().power.codec === 'h264') {
      session.fellBack = true;
      this.dispatchEvent(new CustomEvent('codec-fallback'));
    }
  }

  // ----- lifecycle --------------------------------------------------------------

  /** Phone-side stop (user tapped Stop, closed the tab...) or connection lost. */
  closeSession(reason = 'closed', notifyPhone = false) {
    if (!this.session) return;
    if (notifyPhone) this.send({ t: 'bye' });
    this._teardown(true);
    this._emit('ended');
    this._emit();
  }

  disconnect() {
    this.closeSession('user', true);
  }

  _teardown(resetStatus) {
    clearInterval(this._statsTimer);
    const session = this.session;
    this.session = null;
    if (session) {
      clearTimeout(session.dropTimer);
      session.pc.onconnectionstatechange = null;
      try { session.dc && session.dc.close(); } catch { /* ignore */ }
      try { session.pc.close(); } catch { /* ignore */ }
    }
    this.compositor.setTrack(null);
    this.audio.detach();
    this.stats = { width: 0, height: 0, fps: 0, bitrate: 0, rtt: 0, loss: 0, jitter: 0, latency: 0, codec: '' };
    this.history = { latency: [], bitrate: [] };
    if (resetStatus) { this.status = 'idle'; this.device = ''; }
  }

  // ----- statistics ----------------------------------------------------------------

  _startStats() {
    clearInterval(this._statsTimer);
    this._statsTimer = setInterval(() => this._pollStats(), 1000);
    this._pollStats();
  }

  async _pollStats() {
    const session = this.session;
    if (!session) return;
    let report;
    try { report = await session.pc.getStats(); } catch { return; }
    let video = null;
    let pair = null;
    const codecs = new Map();
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) video = r;
      else if (r.type === 'candidate-pair' && (r.state === 'succeeded' && (r.nominated || r.selected))) pair = r;
      else if (r.type === 'codec') codecs.set(r.id, r);
    });
    if (!video) return;

    const prev = session.last;
    session.last = { t: video.timestamp, bytes: video.bytesReceived, lost: video.packetsLost, recv: video.packetsReceived };
    let bitrate = this.stats.bitrate;
    let loss = this.stats.loss;
    if (prev && video.timestamp > prev.t) {
      bitrate = ((video.bytesReceived - prev.bytes) * 8) / ((video.timestamp - prev.t) / 1000);
      const dRecv = video.packetsReceived - prev.recv;
      const dLost = Math.max(0, video.packetsLost - prev.lost);
      loss = dRecv + dLost > 0 ? (dLost / (dRecv + dLost)) * 100 : 0;
    }

    const rtt = pair && pair.currentRoundTripTime ? pair.currentRoundTripTime * 1000 : this.stats.rtt;
    const jbDelay = video.jitterBufferEmittedCount ? (video.jitterBufferDelay / video.jitterBufferEmittedCount) * 1000 : 0;
    const decode = video.framesDecoded ? (video.totalDecodeTime / video.framesDecoded) * 1000 : 0;
    // rough glass-to-PC latency: network one way + jitter buffer + decode + our frame pacing
    const latency = Math.round(rtt / 2 + jbDelay + decode + 1000 / Math.max(this.compositor.fps, 1) / 2);
    const codec = codecs.get(video.codecId);

    this.stats = {
      width: video.frameWidth || 0,
      height: video.frameHeight || 0,
      fps: Math.round(video.framesPerSecond || 0),
      bitrate,
      rtt,
      loss,
      jitter: (video.jitter || 0) * 1000,
      latency,
      codec: codec ? String(codec.mimeType || '').replace('video/', '') : ''
    };
    this._checkHealth(session);
    this.history.latency.push(latency);
    this.history.bitrate.push(bitrate);
    for (const key of ['latency', 'bitrate']) if (this.history[key].length > HISTORY) this.history[key].shift();
    this._emit('stats');
  }
}

module.exports = { Engine };
