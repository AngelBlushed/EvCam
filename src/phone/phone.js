/* EvCam phone client: streams camera + microphone to the EvCam desktop app over WebRTC. */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const app = $('#app');
  const el = {
    preview: $('#preview'),
    startBtn: $('#startBtn'),
    idleMsg: $('#idleMsg'),
    linkCard: $('#linkCard'),
    linkTitle: $('#linkTitle'),
    linkSub: $('#linkSub'),
    facingSeg: $('#facingSeg'),
    micToggle: $('#micToggle'),
    statusTitle: $('#statusTitle'),
    statusText: $('#statusText'),
    retryBtn: $('#retryBtn'),
    livePill: $('#livePill'),
    liveLabel: $('#liveLabel'),
    liveInfo: $('#liveInfo'),
    batPill: $('#batPill'),
    flipBtn: $('#flipBtn'),
    camBtn: $('#camBtn'),
    lensBtn: $('#lensBtn'),
    sheet: $('#sheet'),
    sheetZoom: $('#sheetZoom'),
    sheetLenses: $('#sheetLenses'),
    sheetNote: $('#sheetNote'),
    sheetClose: $('#sheetClose'),
    screenLight: $('#screenLight'),
    micBtn: $('#micBtn'),
    torchBtn: $('#torchBtn'),
    darkBtn: $('#darkBtn'),
    stopBtn: $('#stopBtn'),
    blackout: $('#blackout'),
    toast: $('#toast')
  };

  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo');
  // Running inside the EvCam Android app (native bridge) or opened with ?app=1
  const NATIVE = window.EvCamNative || null;
  const APP = !!NATIVE || params.has('app');
  if (APP) document.body.classList.add('app');
  const dbg = (...args) => { if (params.has('debug')) console.log('[evcam]', ...args); };
  const native = (fn) => { try { if (NATIVE) fn(NATIVE); } catch { /* bridge unavailable */ } };

  const state = {
    token: loadToken(),
    device: 'Téléphone',
    stream: null,
    pc: null,
    dc: null,
    facing: 'user',
    wantMic: true,
    micMuted: false,
    torch: false,
    torchSupported: false,
    torchMode: 'torch',          // 'torch' (rear LED) or 'screen' (front camera: the screen becomes a light)
    screenLight: false,
    standby: false,              // camera switched off (microphone only), from the PC or from this phone
    standbyReason: '',           // 'user' (chosen) | 'sleep' (screen off / app in the background: the phone stopped the camera)
    camWanted: true,             // the camera is wanted (not switched off by the user): brought back after a sleep
    thermal: { level: 0, tempC: null, status: 0 }, // 0 normal, 1 warm (720p30), 2 hot (480p24): set by checkThermal()
    thermalTimer: 0,
    force: false,                // "force 60 fps": ask the camera for the rate as a requirement, give frame rate priority over sharpness
    fluid: {                     // what the camera / encoder really deliver compared with what was asked (see checkFluid)
      target: 0, capture: null, encoded: null, limit: 'none', reason: '', w: 0, h: 0,
      hist: [], tick: 0, settleUntil: 0, fixing: false, tried: {}, fixed: '', unfixable: false, resCap: 0
    },
    fluidTimer: 0,
    encoder: '',                 // outbound-rtp encoderImplementation, e.g. "libvpx" or a MediaCodec name
    encoderHw: null,             // true hardware, false software, null unknown
    encoderTimer: 0,
    lostAt: 0,                   // when the PC was lost (reconnection attempts are spaced out, then given up)
    dimmed: false,               // screen at its lowest brightness after a while without touch
    camOff: false,               // the PC asked for microphone-only mode before the stream started
    eco: false,
    lensId: '',
    lenses: [],
    zoom: { supported: false, min: 1, max: 1, step: 0.1, value: 1 },
    videoSender: null,
    running: false,
    userStopped: false,
    reconnecting: false,
    attempts: 0,
    wake: null,
    dropTimer: 0,
    statsTimer: 0,
    lastStats: null,
    battery: null,
    demoTimer: 0,
    autoStarted: false,
    cfg: { width: 1280, height: 720, fps: 30, bitrate: 3300000, noiseSuppression: true, codec: 'h264' }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  function loadToken() {
    let token = new URLSearchParams(location.search).get('t') || '';
    try {
      if (token) localStorage.setItem('evcam.t', token);
      else token = localStorage.getItem('evcam.t') || '';
    } catch { /* storage unavailable */ }
    return token;
  }

  function setScreen(name, title, text) {
    app.dataset.state = name;
    document.body.classList.toggle('streaming', name === 'live'); // nothing decorative is drawn while streaming
    if (title !== undefined) el.statusTitle.textContent = title;
    if (text !== undefined) el.statusText.textContent = text;
    el.retryBtn.hidden = name !== 'error';
  }

  let toastTimer = 0;
  function toast(message, ms = 2600) {
    el.toast.textContent = message;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
  }

  function describeError(e) {
    switch (e && e.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Accès refusé.\nAutorisez la caméra et le micro pour cette page dans les réglages du navigateur, puis réessayez.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'Aucune caméra détectée sur ce téléphone.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'La caméra est utilisée par une autre application.\nFermez-la puis réessayez.';
      case 'OverconstrainedError':
        return 'Cette caméra ne prend pas en charge la qualité demandée.';
      default:
        return (e && e.message) || 'Une erreur est survenue.';
    }
  }

  function fail(message, fatal = false) {
    dbg('fail', message, new Error().stack);
    teardown();
    state.userStopped = true;
    if (fatal) native((n) => n.home('token'));
    setScreen('error', fatal ? 'Connexion refusée' : 'Oups…', message);
  }

  async function deviceLabel() {
    try {
      const hv = await navigator.userAgentData?.getHighEntropyValues?.(['model']);
      if (hv && hv.model) return hv.model;
    } catch { /* not available */ }
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Téléphone Android';
    return 'Navigateur';
  }

  // ---------------------------------------------------------------------------
  // media
  // ---------------------------------------------------------------------------

  const videoTrack = () => (state.stream ? state.stream.getVideoTracks()[0] : null);
  const audioTrack = () => (state.stream ? state.stream.getAudioTracks()[0] : null);

  /** Settings really used: the PC's choice, lowered while the phone is hot (see checkThermal). */
  function capPixels(c, maxPx) {
    const px = c.width * c.height;
    if (maxPx && px > maxPx) {
      const k = Math.sqrt(maxPx / px);
      c.width = Math.max(4, Math.round((c.width * k) / 4) * 4);
      c.height = Math.max(4, Math.round((c.height * k) / 4) * 4);
    }
  }

  function effCfg() {
    const c = { ...state.cfg };
    // the camera cannot hold the requested rate at this size (found by fixFps): stay at the size where it can
    capPixels(c, state.fluid.resCap);
    const cap = [null, { px: 1280 * 720, fps: 30, floor: 1500000 }, { px: 848 * 480, fps: 24, floor: 800000 }][state.thermal.level];
    if (!cap) return c;
    capPixels(c, cap.px);
    c.fps = Math.min(c.fps, cap.fps);
    c.bitrate = Math.max(cap.floor, Math.round(Math.min(c.bitrate, c.width * c.height * c.fps * 0.09)));
    return c;
  }

  /** A high frame rate (or "force") is demanded from the camera, not just hoped for: the browser then picks a format that can do it. */
  const wantsRate = () => state.force || effCfg().fps >= 50;

  function rateConstraint(fps, strict = true) {
    return strict && wantsRate() ? { min: Math.max(15, Math.round(fps * 0.9)), ideal: fps } : { ideal: fps };
  }

  function videoConstraints(facing, deviceId, strict = true) {
    const { width, height, fps } = effCfg();
    const base = { width: { ideal: width }, height: { ideal: height }, aspectRatio: { ideal: width / height }, frameRate: rateConstraint(fps, strict) };
    return deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base, facingMode: { ideal: facing } };
  }

  function audioConstraints() {
    return {
      echoCancellation: false,
      noiseSuppression: state.cfg.noiseSuppression,
      autoGainControl: true,
      channelCount: 1
    };
  }

  async function acquire(facing, { videoOnly = false, audioOnly = false, deviceId = '' } = {}) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error('Ce navigateur ne permet pas l’accès à la caméra sur cette page.\nOuvrez l’adresse en https://.'), { name: 'SecurityError' });
    }
    const wantVideo = !audioOnly;
    const wantAudio = audioOnly || (state.wantMic && !videoOnly);
    // the frame rate may be a requirement ({min}): a camera that cannot do it is not refused, it just gets the soft version
    const grab = async (video, audio) => {
      try {
        return await navigator.mediaDevices.getUserMedia({ video: video ? videoConstraints(facing, deviceId, true) : false, audio });
      } catch (err) {
        if (video && err && err.name === 'OverconstrainedError') {
          return navigator.mediaDevices.getUserMedia({ video: videoConstraints(facing, deviceId, false), audio });
        }
        throw err;
      }
    };
    try {
      return await grab(wantVideo, wantAudio ? audioConstraints() : false);
    } catch (err) {
      if (wantVideo && wantAudio && err.name !== 'NotReadableError') {
        // Maybe only the microphone is the problem: continue with video alone.
        const stream = await grab(true, false);
        toast('Micro indisponible : image seule.');
        return stream;
      }
      throw err;
    }
  }

  /** Synthetic source (`?demo=1`): lets you test the whole chain without a camera. */
  function demoStream() {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const g = canvas.getContext('2d');
    const bars = ['#ffffff', '#ffd400', '#00e5ff', '#34d058', '#ff4fd8', '#ff3b30', '#2f5bff'];
    const t0 = performance.now();
    let frame = 0;
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      g.fillStyle = '#10121f';
      g.fillRect(0, 0, 1280, 720);
      bars.forEach((c, i) => { g.fillStyle = c; g.fillRect(i * (1280 / 7), 0, 1280 / 7 + 1, 300); });
      const grad = g.createLinearGradient(0, 300, 1280, 720);
      grad.addColorStop(0, '#2b1b6e'); grad.addColorStop(1, '#0a6fa3');
      g.fillStyle = grad; g.fillRect(0, 300, 1280, 420);
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(640 + Math.cos(t * 2) * 420, 510 + Math.sin(t * 3) * 110, 56, 0, Math.PI * 2); g.fill();
      g.font = '700 54px sans-serif'; g.textBaseline = 'top';
      g.fillText(`EvCam DEMO  ${t.toFixed(2)} s`, 40, 330);
      g.font = '500 30px sans-serif'; g.fillStyle = 'rgba(255,255,255,.75)';
      g.fillText(`image ${frame++}`, 40, 410);
    };
    draw();
    state.demoTimer = setInterval(draw, 1000 / 30);
    const video = canvas.captureStream(30);
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    ac.resume();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    gain.gain.value = 0.08;
    const dest = ac.createMediaStreamDestination();
    osc.frequency.value = 440;
    osc.connect(gain).connect(dest);
    osc.start();
    return new MediaStream([...video.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  }

  function attachPreview() {
    const vt = videoTrack();
    el.preview.srcObject = vt ? new MediaStream([vt]) : null; // video only: never play our own mic
    el.preview.classList.toggle('mirror', state.facing === 'user' && !DEMO);
    el.preview.play().catch(() => {});
  }

  const BACK = /back|rear|arri|environment/i;
  const FRONT = /front|avant|user|selfie/i;

  async function refreshLenses() {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      state.lenses = devices.map((d) => ({ id: d.deviceId, label: d.label || '', facing: BACK.test(d.label) ? 'environment' : FRONT.test(d.label) ? 'user' : '' }));
    } catch {
      state.lenses = [];
    }
  }

  /** Human names for the cameras the browser exposes (several back cameras on most recent phones). */
  function friendlyLenses() {
    let back = 0;
    let front = 0;
    let other = 0;
    return state.lenses.map((l) => {
      let name;
      if (/ultra|wide|0[.,]5/i.test(l.label)) name = 'Ultra grand-angle';
      else if (/tele|zoom/i.test(l.label)) name = 'Téléobjectif';
      else if (l.facing === 'user') name = ++front > 1 ? `Caméra avant ${front}` : 'Caméra avant';
      else if (l.facing === 'environment') name = `Caméra arrière ${++back}`;
      else name = `Caméra ${++other}`;
      return { id: l.id, name, facing: l.facing, current: l.id === state.lensId };
    });
  }

  // Chrome only reports torch / zoom once the photo capabilities were requested.
  async function detectCaps() {
    try { await detectCapsUnsafe(); } catch (err) { dbg('detectCaps failed', err && err.message); }
    sendState();
  }

  async function detectCapsUnsafe() {
    const vt = videoTrack();
    if (vt && typeof ImageCapture === 'function') {
      try { await new ImageCapture(vt).getPhotoCapabilities(); } catch { /* not supported */ }
    }
    const caps = vt && vt.getCapabilities ? vt.getCapabilities() : {};
    const settings = vt && vt.getSettings ? vt.getSettings() : {};
    state.torchSupported = !!caps.torch;
    if (caps.zoom && typeof caps.zoom.max === 'number') {
      // Android reports a ratio (0.5..10); UVC-style cameras report percent (100..400): always expose ratios
      const scale = caps.zoom.min >= 20 ? caps.zoom.min : 1;
      state.zoom = {
        supported: true, scale, min: caps.zoom.min / scale, max: caps.zoom.max / scale, step: (caps.zoom.step || 0.1) / scale,
        value: (typeof settings.zoom === 'number' ? settings.zoom : caps.zoom.min) / scale
      };
    } else {
      state.zoom = { supported: false, min: 1, max: 1, step: 0.1, value: 1 };
    }
    if (settings.deviceId) state.lensId = settings.deviceId;
    if (settings.facingMode === 'user' || settings.facingMode === 'environment') state.facing = settings.facingMode;
    el.torchBtn.setAttribute('aria-pressed', String(state.torch));
    const at = audioTrack();
    if (at) at.enabled = !state.micMuted;
    el.micBtn.hidden = !at;
    await refreshLenses();
    renderSheet();
  }

  /** (Re)opens the camera: another facing, a specific lens (deviceId), or the same one after standby. */
  async function openVideo({ facing = state.facing, deviceId = '' } = {}) {
    if (DEMO || !state.stream) return;
    const previous = { facing: state.facing, lensId: state.lensId };
    if (state.screenLight) await setScreenLight(false);
    const old = videoTrack();
    if (old) { old.stop(); state.stream.removeTrack(old); }
    let fresh;
    try {
      fresh = await acquire(facing, { videoOnly: true, deviceId });
    } catch (err) {
      toast(deviceId ? 'Cet objectif ne peut pas être ouvert.' : 'Impossible de changer de caméra.');
      fresh = await acquire(previous.facing, { videoOnly: true, deviceId: previous.lensId }).catch(() => acquire(previous.facing, { videoOnly: true }));
    }
    const track = fresh.getVideoTracks()[0];
    track.contentHint = 'motion';
    state.stream.addTrack(track);
    if (state.videoSender) await state.videoSender.replaceTrack(track).catch(() => {});
    if (!deviceId) state.facing = facing;
    state.torch = false;
    attachPreview();
    await detectCaps();
    tuneSender();
    resetFluid(true);
  }

  const switchCamera = (facing) => openVideo({ facing });
  const selectLens = (deviceId) => openVideo({ deviceId });

  async function setZoom(value) {
    const vt = videoTrack();
    if (!vt || !state.zoom.supported) return;
    const z = Math.min(state.zoom.max, Math.max(state.zoom.min, Number(value)));
    try {
      await vt.applyConstraints({ advanced: [{ zoom: z * (state.zoom.scale || 1) }] });
      state.zoom.value = z;
    } catch {
      toast('Zoom indisponible sur cet objectif.');
    }
    renderSheet();
    sendState();
  }

  /** The front camera has no flash: light the face with the screen instead (white screen, full brightness). */
  async function setScreenLight(on) {
    if (on && state.dimmed) autoDim(false);
    state.screenLight = !!on;
    el.screenLight.hidden = !on;
    if (on) { el.blackout.hidden = true; clearTimeout(ecoTimer); }
    native((n) => n.setBrightness(on ? 1 : -1));
    if (!on) scheduleEcoBlackout();
  }

  /**
   * Flash: rear LED through the web torch constraint, then through the native Android API,
   * and on the front camera the screen light. Always attempted, even if the browser did not report support.
   */
  async function setTorch(on) {
    on = !!on;
    if (state.standby) return;
    if (state.facing === 'user' && !DEMO) {
      state.torchMode = 'screen';
      await setScreenLight(on);
      state.torch = on;
    } else {
      state.torchMode = 'torch';
      let ok = false;
      const vt = videoTrack();
      if (vt) {
        try {
          await vt.applyConstraints({ advanced: [{ torch: on }] });
          const applied = vt.getSettings && vt.getSettings().torch;
          // unsupported "advanced" constraints are ignored without error: only trust what the track reports
          ok = applied === undefined ? state.torchSupported : applied === on;
        } catch { ok = false; }
      }
      if (!ok) native((n) => { try { ok = !!n.setTorch(on); } catch { ok = false; } });
      if (!ok && on) toast('Flash indisponible sur cet objectif : essayez un autre objectif.');
      state.torch = ok ? on : false;
    }
    el.torchBtn.setAttribute('aria-pressed', String(state.torch));
    sendState();
  }

  /** Battery saver: nobody is using the camera on the PC, so release it (the microphone keeps running). */
  async function setStandby(on, reason = 'user') {
    on = !!on;
    if (reason === 'user') state.camWanted = !on;
    if (DEMO || !state.stream) return;
    if (on === state.standby) {
      const next = on ? reason : '';
      if (next !== state.standbyReason) { state.standbyReason = next; setLiveMode(liveModeNow()); sendState(); }
      return;
    }
    state.standby = on;
    state.standbyReason = on ? reason : '';
    if (on) {
      if (state.screenLight) await setScreenLight(false);
      state.torch = false;
      el.torchBtn.setAttribute('aria-pressed', 'false');
      if (state.videoSender) await state.videoSender.replaceTrack(null).catch(() => {});
      const old = videoTrack();
      if (old) { old.stop(); state.stream.removeTrack(old); }
      el.preview.srcObject = null;
      setLiveMode(liveModeNow());
    } else {
      try {
        await openVideo({ deviceId: state.lensId, facing: state.facing });
      } catch (err) {
        dbg('wake failed', err && err.name, err && err.message);
        const running = videoTrack() && videoTrack().readyState === 'live';
        state.standby = !running;
        state.standbyReason = state.standby ? (document.visibilityState === 'hidden' ? 'sleep' : 'user') : '';
        if (!running && document.visibilityState !== 'hidden') toast('Impossible de rallumer la caméra.');
      }
      setLiveMode(liveModeNow());
    }
    el.camBtn.setAttribute('aria-pressed', String(state.standby));
    applyKeepAwake();
    sendState();
  }

  function setMic(on) {
    state.micMuted = !on;
    const at = audioTrack();
    if (at) at.enabled = on;
    el.micBtn.setAttribute('aria-pressed', String(state.micMuted));
    sendState();
  }

  async function reacquire() {
    // The browser stops the camera when the page is hidden: grab it again.
    const old = state.stream;
    if (old) old.getTracks().forEach((t) => t.stop());
    let stream;
    try {
      stream = await acquire(state.facing, { audioOnly: state.standby, deviceId: state.standby ? '' : state.lensId });
    } catch (err) {
      stream = await acquire(state.facing, { audioOnly: state.standby });
    }
    state.stream = stream;
    if (state.pc) {
      const video = stream.getVideoTracks()[0];
      const audio = stream.getAudioTracks()[0];
      for (const sender of state.pc.getSenders()) {
        const next = sender === state.videoSender ? video : audio;
        if (next) await sender.replaceTrack(next).catch(() => {});
      }
    }
    attachPreview();
    detectCaps();
  }

  // ---------------------------------------------------------------------------
  // WebRTC
  // ---------------------------------------------------------------------------

  function waitIce(pc, ms = 2500) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const done = () => { pc.removeEventListener('icegatheringstatechange', check); clearTimeout(timer); resolve(); };
      const check = () => { if (pc.iceGatheringState === 'complete') done(); };
      const timer = setTimeout(done, ms);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  async function post(path, body) {
    let res;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: state.token, ...body })
      });
    } catch {
      throw new Error('Impossible de joindre EvCam sur votre PC.\nVérifiez que l’application est ouverte et que le téléphone est sur le même Wi-Fi.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Erreur ${res.status}`);
      err.fatal = res.status === 403;
      throw err;
    }
    return data;
  }

  function closePeer() {
    clearTimeout(state.dropTimer);
    const pc = state.pc;
    state.pc = null;
    state.dc = null;
    if (pc) {
      pc.onconnectionstatechange = null;
      try { pc.close(); } catch { /* ignore */ }
    }
  }

  async function connect() {
    closePeer();
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
    state.pc = pc;
    state.videoSender = null;
    for (const track of state.stream.getTracks()) {
      if (track.kind === 'video') track.contentHint = 'motion';
      const sender = pc.addTrack(track, state.stream);
      if (track.kind === 'video') state.videoSender = sender;
    }
    if (!state.videoSender) {
      // standby: no camera right now, but keep a video m-line so it can be switched on later
      state.videoSender = pc.addTransceiver('video', { direction: 'sendonly', streams: [state.stream] }).sender;
    }
    applyCodecPreference(pc);
    const dc = pc.createDataChannel('ctl', { ordered: true });
    state.dc = dc;
    dc.onopen = () => sendState(true);
    dc.onmessage = onControl;
    pc.onconnectionstatechange = () => onConnectionState(pc);

    await pc.setLocalDescription(await pc.createOffer());
    await waitIce(pc);
    if (state.pc !== pc) throw new Error('annulé');

    const answer = await post('/api/offer', { type: 'offer', sdp: pc.localDescription.sdp, device: state.device });
    if (state.pc !== pc) throw new Error('annulé');
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    tuneSender();
  }

  /** H.264 uses the phone's hardware encoder (far less battery than software VP8). */
  function applyCodecPreference(pc) {
    const pref = state.cfg.codec;
    if (!pref || pref === 'auto' || !window.RTCRtpSender || !RTCRtpSender.getCapabilities) return;
    const transceiver = pc.getTransceivers().find((t) => t.sender === state.videoSender);
    if (!transceiver || !transceiver.setCodecPreferences) return;
    try {
      const codecs = RTCRtpSender.getCapabilities('video').codecs;
      const wanted = pref === 'h264' ? /^video\/h264$/i : /^video\/vp8$/i;
      const preferred = codecs.filter((c) => wanted.test(c.mimeType));
      if (!preferred.length) return; // not available here: keep the browser default
      const score = (c) => (/profile-level-id=42e01f/i.test(c.sdpFmtpLine || '') ? 2 : 0) + (/packetization-mode=1/i.test(c.sdpFmtpLine || '') ? 1 : 0);
      preferred.sort((a, b) => score(b) - score(a));
      transceiver.setCodecPreferences([...preferred, ...codecs.filter((c) => !wanted.test(c.mimeType))]);
    } catch { /* keep the default negotiation */ }
  }

  async function tuneSender() {
    const pc = state.pc;
    if (!pc) return;
    const sender = state.videoSender;
    if (!sender) return;
    try {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      const c = effCfg();
      p.encodings[0].maxBitrate = c.bitrate;
      p.encodings[0].maxFramerate = c.fps;
      // When the phone cannot keep up, WebRTC gives something up: with "maintain-resolution" that is the frame rate (a
      // 60 fps request quietly became 20), which is the worst thing for movement. For a high rate it now sacrifices
      // sharpness instead; at 24 / 30 fps it balances both.
      p.degradationPreference = wantsRate() ? 'maintain-framerate' : 'balanced';
      await sender.setParameters(p);
    } catch { /* optional tuning */ }
  }

  const liveModeNow = () => (state.pc && state.pc.connectionState === 'connected' ? (state.standby ? 'standby' : 'live') : 'reconnect');

  function setLiveMode(mode) {
    if (mode === 'live' && state.standby) mode = 'standby';
    el.livePill.dataset.mode = mode;
    el.liveLabel.textContent = mode === 'reconnect' ? 'RECONNEXION' : mode === 'standby' ? 'MICRO SEUL' : 'EN DIRECT';
    if (mode === 'reconnect') el.liveInfo.textContent = '';
    if (mode === 'standby') el.liveInfo.textContent = state.standbyReason === 'sleep' ? 'écran éteint' : 'caméra désactivée';
  }

  function onConnectionState(pc) {
    if (pc !== state.pc) return;
    const s = pc.connectionState;
    dbg('connection', s);
    if (s === 'connected') {
      state.attempts = 0;
      state.lostAt = 0;
      clearTimeout(state.dropTimer);
      setLiveMode('live');
      reportLive();
    } else if (s === 'disconnected') {
      setLiveMode('reconnect');
      reportLive();
      clearTimeout(state.dropTimer);
      state.dropTimer = setTimeout(() => {
        if (state.pc === pc && pc.connectionState !== 'connected') reconnect();
      }, 3000);
    } else if (s === 'failed' || s === 'closed') {
      setLiveMode('reconnect');
      reportLive();
      reconnect();
    }
  }

  /** One tiny request: is the PC there? (no peer connection, no ICE gathering, no radio burst when it is not) */
  async function pcReachable() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3500);
    try {
      const res = await fetch(`/api/info?t=${encodeURIComponent(state.token)}`, { cache: 'no-store', signal: ctl.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function reconnect() {
    if (state.userStopped || state.reconnecting || !state.stream) return;
    state.reconnecting = true;
    if (!state.lostAt) state.lostAt = Date.now();
    setLiveMode('reconnect');
    try {
      while (!state.userStopped) {
        state.attempts++;
        if (!(await pcReachable())) {
          const lostFor = Date.now() - state.lostAt;
          if (lostFor > 30 * 60 * 1000) {
            return fail('Le PC est resté injoignable pendant 30 minutes : la diffusion est arrêtée pour économiser la batterie.\nOuvrez EvCam sur le PC puis touchez Réessayer.');
          }
          await sleep(lostFor > 5 * 60 * 1000 ? 60000 : Math.min(2000 * state.attempts, 30000));
          continue;
        }
        try {
          await connect();
          return;
        } catch (err) {
          if (err.fatal) return fail('Le code de connexion n’est plus valide.\nScannez à nouveau le QR code affiché dans EvCam.', true);
          await sleep(Math.min(800 * state.attempts, 5000));
        }
      }
    } finally {
      state.reconnecting = false;
    }
  }

  // ---------------------------------------------------------------------------
  // control channel (PC -> phone and back)
  // ---------------------------------------------------------------------------

  function dcSend(obj) {
    const dc = state.dc;
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(obj));
  }

  function sendState(hello = false) {
    const b = state.battery;
    dcSend({
      t: hello ? 'hello' : 'state',
      device: state.device,
      facing: state.facing,
      hasMic: !!audioTrack(),
      micMuted: state.micMuted,
      torch: state.torch,
      torchSupported: state.torchSupported,
      torchMode: state.facing === 'user' ? 'screen' : 'torch',
      zoom: state.zoom,
      lensId: state.lensId,
      lenses: friendlyLenses(),
      standby: state.standby,
      standbyReason: state.standbyReason,
      thermal: state.thermal.level,
      tempC: state.thermal.tempC,
      fluid: fluidReport(),
      encoder: state.encoder,
      encoderHw: state.encoderHw,
      codec: state.cfg.codec,
      battery: b ? Math.round(b.level * 100) : null,
      charging: b ? !!b.charging : null
    });
  }

  async function onControl(event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    dbg('control', event.data);
    if (msg.t === 'bye') {
      toast('Déconnecté depuis le PC');
      return stop(false);
    }
    if (msg.t !== 'config') return;

    const asked = `${msg.width}|${msg.height}|${msg.fps}`;
    for (const key of ['width', 'height', 'fps', 'bitrate', 'noiseSuppression']) {
      if (msg[key] !== undefined) state.cfg[key] = msg[key];
    }
    if (msg.force !== undefined && !!msg.force !== state.force) {
      state.force = !!msg.force;
      resetFluid(true); // a different way of asking the camera: look again
    } else if ((msg.width || msg.height || msg.fps) && asked !== state.fluidAsked) {
      resetFluid(true);
    }
    if (msg.width || msg.height || msg.fps) state.fluidAsked = asked;
    if (msg.eco !== undefined) { state.eco = !!msg.eco; scheduleEcoBlackout(); }

    // wake up first: everything below needs the camera
    if (msg.standby !== undefined) state.camWanted = !msg.standby;
    // screen off: the camera cannot be woken now, it comes back by itself when the screen does
    const asleep = state.standby && state.standbyReason === 'sleep' && document.visibilityState === 'hidden';
    if (msg.standby === false && !asleep) await setStandby(false, 'user');

    if (!state.standby) {
      const vt = videoTrack();
      if (msg.lens && msg.lens !== state.lensId) {
        await selectLens(msg.lens);
      } else if (msg.facing && msg.facing !== state.facing) {
        await switchCamera(msg.facing);
      } else if (vt && !DEMO && (msg.width || msg.height || msg.fps)) {
        const c = effCfg();
        await vt.applyConstraints({
          width: { ideal: c.width },
          height: { ideal: c.height },
          aspectRatio: { ideal: c.width / c.height },
          frameRate: rateConstraint(c.fps)
        }).catch(() => {});
      }
      if (msg.zoom !== undefined) await setZoom(msg.zoom);
    }
    tuneSender();
    const at = audioTrack();
    if (at && msg.noiseSuppression !== undefined) at.applyConstraints({ noiseSuppression: msg.noiseSuppression }).catch(() => {});
    if (msg.torch !== undefined) await setTorch(!!msg.torch);
    if (msg.mute !== undefined) setMic(!msg.mute);
    if (msg.standby === true) await setStandby(true, 'user');
    sendState();

    if (msg.codec && msg.codec !== state.cfg.codec) {
      state.cfg.codec = msg.codec;
      if (!state.reconnecting) reconnect(); // new offer with the other codec
    }
  }

  // ---------------------------------------------------------------------------
  // battery: black screen (OLED pixels off, backlight at minimum) and eco auto-blackout
  // ---------------------------------------------------------------------------

  let ecoTimer = 0;

  function showBlackout(on) {
    el.blackout.hidden = !on;
    if (on && state.screenLight) setScreenLight(false);
    state.dimmed = false;
    el.preview.style.visibility = on ? 'hidden' : ''; // a hidden preview is not composited: less work for the GPU
    native((n) => n.setDim(!!on));
    if (!on) scheduleEcoBlackout();
  }

  /** Normal mode in the Android app: after a while without touch the backlight goes to its minimum (a bright screen heats the phone). */
  function autoDim(on) {
    if (state.dimmed === on) return;
    state.dimmed = on;
    el.preview.style.visibility = on ? 'hidden' : '';
    native((n) => n.setDim(!!on));
    if (!on) scheduleEcoBlackout();
  }

  /** In eco mode the screen goes black by itself after a few seconds without touch; the camera keeps running. */
  function scheduleEcoBlackout() {
    clearTimeout(ecoTimer);
    if (!state.running || state.screenLight || !el.blackout.hidden || state.dimmed) return;
    if (state.eco) ecoTimer = setTimeout(() => showBlackout(true), 15000);
    else if (NATIVE) ecoTimer = setTimeout(() => autoDim(true), 25000);
  }

  /** Zoom pills (0,5× ultra grand-angle, 1×, 2×...) and the list of lenses the browser exposes. */
  function renderSheet() {
    const z = state.zoom;
    el.sheetZoom.innerHTML = '';
    if (z.supported) {
      const presets = [];
      if (z.min < 0.95) presets.push(Math.round(z.min * 10) / 10);
      for (const p of [1, 2, 3, 5]) if (p >= z.min - 0.01 && p <= z.max + 0.01 && !presets.includes(p)) presets.push(p);
      for (const p of presets) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pill-btn';
        b.textContent = (p < 1 ? 'Ultra grand-angle ' : '') + String(p).replace('.', ',') + '×';
        b.setAttribute('aria-pressed', String(Math.abs(z.value - p) < 0.06));
        b.addEventListener('click', () => setZoom(p));
        el.sheetZoom.appendChild(b);
      }
    }
    el.sheetLenses.innerHTML = '';
    const lenses = friendlyLenses();
    if (lenses.length > 1) {
      for (const l of lenses) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'lens-btn';
        b.textContent = l.name;
        b.setAttribute('aria-pressed', String(l.current));
        b.addEventListener('click', () => { el.sheet.hidden = true; selectLens(l.id); });
        el.sheetLenses.appendChild(b);
      }
    }
    const hasMulti = lenses.length > 1;
    el.sheetNote.textContent = z.supported || hasMulti
      ? (hasMulti ? 'Chaque objectif du téléphone est listé ci-dessus : essayez-les pour trouver l’ultra grand-angle.' : '')
      : 'Ce téléphone n’expose qu’un seul objectif sans zoom au navigateur.';
  }

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------

  async function requestWake() {
    if (state.standby) return; // microphone only: the screen may switch off
    try {
      if ('wakeLock' in navigator && !state.wake) {
        state.wake = await navigator.wakeLock.request('screen');
        state.wake.addEventListener('release', () => { state.wake = null; });
      }
    } catch { /* not allowed (low battery, etc.) */ }
  }

  /**
   * The screen only has to stay on while the CAMERA runs. In microphone-only mode Android may switch it off by itself
   * (the foreground service keeps the microphone going), which is what makes the battery last: until then the
   * backlight sits at its minimum.
   */
  function applyKeepAwake() {
    const cameraRuns = state.running && !state.standby;
    native((n) => { if (typeof n.setKeepScreenOn === 'function') n.setKeepScreenOn(cameraRuns); });
    if (cameraRuns) requestWake(); else releaseWake();
    if (NATIVE && state.running) autoDim(!cameraRuns);
    reportLive();
  }

  /** Tells the Android service whether the stream really flows (and carries video): it holds CPU / Wi-Fi locks only then. */
  function reportLive() {
    const live = !!state.pc && state.pc.connectionState === 'connected';
    native((n) => { if (typeof n.setLive === 'function') n.setLive(live, live && !state.standby); });
  }

  function releaseWake() {
    if (state.wake) state.wake.release().catch(() => {});
    state.wake = null;
  }

  async function pollStats() {
    const pc = state.pc;
    if (!pc || pc.connectionState !== 'connected' || document.visibilityState !== 'visible' || state.standby || state.dimmed) return;
    try {
      const report = await pc.getStats();
      let out = null;
      report.forEach((r) => { if (r.type === 'outbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) out = r; });
      if (!out || state.standby) return;
      let rate = 0;
      if (state.lastStats && out.timestamp > state.lastStats.t) {
        rate = ((out.bytesSent - state.lastStats.bytes) * 8) / ((out.timestamp - state.lastStats.t) / 1000);
      }
      state.lastStats = { t: out.timestamp, bytes: out.bytesSent };
      if (out.frameWidth) {
        el.liveInfo.textContent = `${out.frameWidth}×${out.frameHeight} · ${Math.round(out.framesPerSecond || 0)} fps · ${(rate / 1e6).toFixed(1)} Mb/s`;
      }
    } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // fluidity: does the picture really flow at the rate that was asked? The camera, the encoder or the Wi-Fi may be
  // delivering far less (a camera that drops to 20 fps in a dim room, a software encoder that cannot keep up...).
  // EvCam measures each stage, says which one limits, and tries to win the rate back before giving up.
  // ---------------------------------------------------------------------------

  function resetFluid(clearCap = false) {
    const f = state.fluid;
    f.hist = [];
    f.settleUntil = performance.now() + 5000;
    f.limit = 'none';
    if (clearCap) { f.resCap = 0; f.fixed = ''; f.unfixable = false; f.tried = {}; }
  }

  function fluidReport() {
    const f = state.fluid;
    const r = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : null);
    return { target: f.target, capture: r(f.capture), encoded: r(f.encoded), limit: f.limit, reason: f.reason, w: f.w, h: f.h, fixing: f.fixing, fixed: f.fixed, unfixable: f.unfixable, resCap: !!f.resCap, force: state.force };
  }

  /** What the camera delivers (media-source), what the encoder sends (outbound-rtp), and why it may be holding back. */
  async function readFluid() {
    const pc = state.pc;
    if (!pc || pc.connectionState !== 'connected') return null;
    const report = await pc.getStats();
    let out = null;
    let src = null;
    report.forEach((r) => {
      if (r.type === 'outbound-rtp' && (r.kind === 'video' || r.mediaType === 'video') && r.framesEncoded > 0) out = r;
      else if (r.type === 'media-source' && (r.kind === 'video' || r.mediaType === 'video')) src = r;
    });
    if (!out && !src) return null;
    return {
      capture: src && typeof src.framesPerSecond === 'number' ? src.framesPerSecond : null,
      encoded: out && typeof out.framesPerSecond === 'number' ? out.framesPerSecond : null,
      reason: out ? out.qualityLimitationReason || 'none' : 'none',
      w: out ? out.frameWidth || 0 : 0,
      h: out ? out.frameHeight || 0 : 0
    };
  }

  const avgOf = (hist, key) => {
    const v = hist.map((h) => h[key]).filter((x) => typeof x === 'number');
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };

  async function checkFluid() {
    if (!state.running || state.standby) return;
    let sample;
    try { sample = await readFluid(); } catch { return; }
    if (!sample) return;
    const f = state.fluid;
    const target = effCfg().fps;
    f.target = target;
    f.w = sample.w;
    f.h = sample.h;
    f.hist.push(sample);
    if (f.hist.length > 3) f.hist.shift();
    f.capture = avgOf(f.hist, 'capture');
    f.encoded = avgOf(f.hist, 'encoded');
    f.reason = sample.reason;
    const settled = performance.now() >= f.settleUntil && f.hist.length >= 2 && !f.fixing;
    let limit = 'none';
    if (settled) {
      const low = (v) => v != null && v < target * 0.85;
      if (low(f.capture)) limit = state.thermal.level > 0 ? 'thermal' : 'camera';
      else if (low(f.encoded)) limit = sample.reason === 'bandwidth' ? 'network' : 'encoder';
    } else if (f.fixing) {
      limit = f.limit; // keep the verdict while the fix is being tried
    }
    const changed = limit !== f.limit;
    f.limit = limit;
    dbg('fluid', JSON.stringify(fluidReport()));
    if (changed || ++f.tick % 3 === 0) sendState();
    if (settled && (limit === 'camera' || limit === 'encoder' || limit === 'network')) fixFps();
  }

  /**
   * The rate is not reached: (1) demand it from the camera (the browser may then pick a format that can do it),
   * then (2) try smaller sizes, which many phones can film at 60 fps although they cannot at 1080p. Each step is
   * measured; if none works the original request is restored and the verdict stays "the camera limits".
   */
  async function fixFps() {
    const f = state.fluid;
    const vt = videoTrack();
    if (!vt || f.fixing || state.standby || DEMO) return;
    const base = effCfg();
    const key = `${state.lensId || state.facing}|${base.fps}|${base.width}x${base.height}`;
    if (f.tried[key]) return; // once per camera and request: no flapping for a camera that simply cannot
    f.tried[key] = true;
    f.fixing = true;
    sendState();
    const target = base.fps;
    const need = target * 0.85;
    const apply = (w, h, strict) => vt.applyConstraints({
      width: { ideal: w }, height: { ideal: h }, aspectRatio: { ideal: w / h }, frameRate: strict ? { min: Math.max(15, Math.round(target * 0.9)), ideal: target } : { ideal: target }
    });
    const measure = async () => {
      await sleep(3000);
      for (let i = 0; i < 2; i++) {
        const sample = await readFluid().catch(() => null);
        if (sample) {
          const worst = Math.min(sample.capture == null ? 1e9 : sample.capture, sample.encoded == null ? 1e9 : sample.encoded);
          if (worst >= need) return true;
        }
        await sleep(900);
      }
      return false;
    };
    let success = false;
    try {
      // 1. same size, rate demanded
      try { await apply(base.width, base.height, true); success = await measure(); } catch { /* format refused */ }
      if (success) f.fixed = 'format';
      // 2. smaller sizes
      if (!success) {
        const ladder = [[1920, 1080], [1280, 720], [960, 540], [848, 480], [640, 360]].filter(([w, h]) => w * h < base.width * base.height * 0.9).slice(0, 2);
        for (const [w, h] of ladder) {
          if (state.standby || videoTrack() !== vt) break;
          try { await apply(w, h, true); } catch { continue; }
          if (await measure()) { f.resCap = w * h; f.fixed = 'size'; success = true; break; }
        }
      }
      if (!success) {
        // nothing helps: give the camera back its original request, and say so
        try { await apply(base.width, base.height, false); } catch { /* keep what it has */ }
        f.unfixable = true;
      }
    } finally {
      f.fixing = false;
      resetFluid(false);
      applyThermal();
      sendState();
    }
  }

  // ---------------------------------------------------------------------------
  // heat: the Android app reports the battery temperature and the system's thermal status; when the phone gets
  // warm EvCam lowers resolution, frame rate and bitrate by itself, and restores them once it has cooled down
  // ---------------------------------------------------------------------------

  const THERMAL_MS = Math.max(1000, Number(params.get('thermalms')) || 15000); // (?thermalms=2000 speeds the check up for tests)

  async function applyThermal() {
    const vt = videoTrack();
    const c = effCfg();
    if (vt && !DEMO && !state.standby) {
      await vt.applyConstraints({ width: { ideal: c.width }, height: { ideal: c.height }, aspectRatio: { ideal: c.width / c.height }, frameRate: rateConstraint(c.fps) }).catch(() => {});
    }
    tuneSender();
  }

  async function checkThermal() {
    if (!NATIVE || typeof NATIVE.thermal !== 'function' || !state.running || state.standby) return; // no camera, no heat
    let info;
    try { info = JSON.parse(NATIVE.thermal() || '{}'); } catch { return; }
    const t = Number(info.tempC);
    const status = Number(info.status) || 0;
    const temp = Number.isFinite(t) ? t : 0;
    state.thermal.tempC = Number.isFinite(t) ? Math.round(t * 10) / 10 : null;
    state.thermal.status = status;
    let level = state.thermal.level;
    if (temp >= 43 || status >= 3) level = 2;
    else if (level < 2 && (temp >= 40 || status >= 2)) level = Math.max(level, 1);
    else if (level === 2 && temp < 41 && status <= 2) level = 1;
    else if (level === 1 && temp < 38 && status <= 1) level = 0;
    if (level !== state.thermal.level) {
      state.thermal.level = level;
      dbg('thermal level', level, state.thermal.tempC, status);
      await applyThermal();
      toast(level ? 'Téléphone chaud : qualité réduite automatiquement' : 'Téléphone refroidi : qualité rétablie');
    }
    sendState();
  }

  /** Which encoder produces the video? A software encoder is what makes a phone boiling hot: the PC then limits the quality. */
  async function checkEncoder() {
    const pc = state.pc;
    if (!pc || pc.connectionState !== 'connected' || state.standby) return;
    try {
      const report = await pc.getStats();
      let out = null;
      report.forEach((r) => { if (r.type === 'outbound-rtp' && (r.kind === 'video' || r.mediaType === 'video') && r.framesEncoded > 0) out = r; });
      if (!out) return;
      const impl = String(out.encoderImplementation || '');
      const hw = typeof out.powerEfficientEncoder === 'boolean'
        ? out.powerEfficientEncoder
        : (impl ? !/libvpx|openh264|software|\bvp8\b|simulcast/i.test(impl) : null);
      if (impl !== state.encoder || hw !== state.encoderHw) {
        state.encoder = impl;
        state.encoderHw = hw;
        dbg('encoder', impl, hw);
        sendState();
      }
    } catch { /* optional */ }
  }

  function updateBattery() {
    const b = state.battery;
    if (!b) return;
    el.batPill.hidden = false;
    el.batPill.textContent = `Batterie ${Math.round(b.level * 100)} %${b.charging ? ' ⚡' : ''}`;
  }

  async function initBattery() {
    try {
      const b = await navigator.getBattery();
      state.battery = b;
      b.addEventListener('levelchange', () => { updateBattery(); sendState(); });
      b.addEventListener('chargingchange', () => { updateBattery(); sendState(); });
      updateBattery();
    } catch { /* Battery API unavailable (iOS) */ }
  }

  function teardown() {
    closePeer();
    clearInterval(state.statsTimer);
    clearInterval(state.demoTimer);
    state.lastStats = null;
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    el.preview.srcObject = null;
    releaseWake();
    el.blackout.hidden = true;
    el.screenLight.hidden = true;
    el.sheet.hidden = true;
    clearTimeout(ecoTimer);
    clearInterval(state.thermalTimer);
    clearInterval(state.encoderTimer);
    clearInterval(state.fluidTimer);
    state.fluid.hist = [];
    state.fluid.limit = 'none';
    state.fluid.fixing = false;
    state.encoder = '';
    state.encoderHw = null;
    state.thermal = { level: 0, tempC: null, status: 0 };
    state.dimmed = false;
    el.preview.style.visibility = '';
    state.running = false;
    state.reconnecting = false;
    state.standby = false;
    state.standbyReason = '';
    state.camWanted = true;
    clearTimeout(bgTimer);
    state.torch = false;
    state.screenLight = false;
    state.videoSender = null;
    state.lostAt = 0;
    native((n) => { n.setStreaming(false); n.setDim(false); n.setBrightness(-1); if (typeof n.setKeepScreenOn === 'function') n.setKeepScreenOn(false); });
  }

  async function start() {
    if (state.running) return;
    if (!state.token) {
      el.idleMsg.hidden = false;
      el.idleMsg.textContent = 'Scannez le QR code affiché dans EvCam sur votre PC pour vous connecter.';
      return;
    }
    state.userStopped = false;
    state.attempts = 0;
    state.micMuted = false;
    el.micBtn.setAttribute('aria-pressed', 'false');
    setScreen('starting', 'Ouverture de la caméra…', 'Autorisez l’accès à la caméra et au micro si le navigateur vous le demande.');
    try {
      // camera disabled on the PC: only ask for the microphone (no camera permission, camera LED off)
      const micOnly = state.camOff && state.wantMic && !DEMO;
      state.stream = DEMO ? demoStream() : await acquire(state.facing, { audioOnly: micOnly });
      state.standby = micOnly;
      state.standbyReason = micOnly ? 'user' : '';
      state.camWanted = !micOnly;
      el.camBtn.setAttribute('aria-pressed', String(state.standby));
    } catch (err) {
      return fail(describeError(err));
    }
    attachPreview();
    detectCaps();
    setScreen('starting', 'Connexion à votre PC…', '');
    try {
      await connect();
    } catch (err) {
      return fail(err.fatal ? 'Le code de connexion est invalide.\nScannez à nouveau le QR code affiché dans EvCam.' : err.message, !!err.fatal);
    }
    state.running = true;
    clearInterval(state.thermalTimer);
    state.thermalTimer = setInterval(checkThermal, THERMAL_MS);
    setTimeout(checkThermal, Math.min(3000, THERMAL_MS));
    clearInterval(state.encoderTimer);
    state.encoderTimer = setInterval(checkEncoder, 20000);
    setTimeout(checkEncoder, 6000);
    clearInterval(state.fluidTimer);
    resetFluid(true);
    state.fluidTimer = setInterval(checkFluid, 2000);
    scheduleEcoBlackout();
    setLiveMode('live');
    setScreen('live');
    native((n) => n.setStreaming(true));
    // keep streaming with the screen off: once, ask Android not to restrict EvCam in the background
    native((n) => { if (n.askBatteryExemption) n.askBatteryExemption(); });
    applyKeepAwake();
    clearInterval(state.statsTimer);
    state.statsTimer = setInterval(pollStats, 2000);
  }

  async function stop(notify = true) {
    state.userStopped = true;
    if (notify) { try { await post('/api/bye', {}); } catch { /* PC may already be gone */ } }
    teardown();
    setScreen('idle');
    checkLink();
  }

  // ---------------------------------------------------------------------------
  // idle screen: is the PC reachable?
  // ---------------------------------------------------------------------------

  let linkTimer = 0;
  async function checkLink() {
    clearTimeout(linkTimer);
    if (app.dataset.state !== 'idle') return;
    const card = el.linkCard;
    try {
      const res = await fetch(`/api/info?t=${encodeURIComponent(state.token)}`, { cache: 'no-store' });
      const info = await res.json();
      if (!info.authorized && NATIVE) { native((n) => n.home('token')); return; }
      if (info.authorized && APP && !state.autoStarted && !state.userStopped) {
        state.autoStarted = true;
        start();
        return;
      }
      if (info.authorized && info.prefs) {
        if (info.prefs.codec) state.cfg.codec = info.prefs.codec;
        state.eco = !!info.prefs.eco;
        state.camOff = info.prefs.camera === false;
      }
      if (info.authorized) {
        card.dataset.ok = 'yes';
        el.linkTitle.textContent = 'EvCam trouvé sur votre PC';
        el.linkSub.textContent = 'Prêt à diffuser';
        el.startBtn.disabled = false;
      } else {
        card.dataset.ok = 'no';
        el.linkTitle.textContent = 'Code de connexion manquant';
        el.linkSub.textContent = 'Scannez le QR code affiché dans EvCam';
      }
    } catch {
      card.dataset.ok = 'no';
      el.linkTitle.textContent = 'PC injoignable';
      el.linkSub.textContent = 'EvCam est-il ouvert ? Même Wi-Fi ?';
    }
    linkTimer = setTimeout(checkLink, document.visibilityState === 'hidden' ? 30000 : APP ? 8000 : 4000);
  }

  // ---------------------------------------------------------------------------
  // wiring
  // ---------------------------------------------------------------------------

  el.startBtn.addEventListener('click', start);
  document.querySelectorAll('.change-pc').forEach((b) => {
    b.hidden = !NATIVE;
    b.addEventListener('click', () => native((n) => n.home('pair')));
  });
  el.retryBtn.addEventListener('click', () => { setScreen('idle'); checkLink(); });
  el.stopBtn.addEventListener('click', () => stop(true));
  el.micToggle.addEventListener('change', () => { state.wantMic = el.micToggle.checked; });
  el.micBtn.addEventListener('click', () => setMic(state.micMuted));
  el.torchBtn.addEventListener('click', () => setTorch(!state.torch));
  el.camBtn.addEventListener('click', async () => {
    await setStandby(!state.standby);
    toast(state.standby ? 'Caméra désactivée : micro seul' : 'Caméra activée');
  });
  el.lensBtn.addEventListener('click', async () => { await detectCaps(); el.sheet.hidden = false; });
  el.sheetClose.addEventListener('click', () => { el.sheet.hidden = true; });
  el.sheet.addEventListener('click', (e) => { if (e.target === el.sheet) el.sheet.hidden = true; });
  el.screenLight.addEventListener('click', () => setTorch(false));
  el.flipBtn.addEventListener('click', () => switchCamera(state.facing === 'user' ? 'environment' : 'user'));
  el.darkBtn.addEventListener('click', () => showBlackout(true));
  el.blackout.addEventListener('click', () => showBlackout(false));
  ['pointerdown', 'touchstart'].forEach((evt) => document.addEventListener(evt, () => {
    if (state.dimmed) autoDim(false);
    else if (el.blackout.hidden) scheduleEcoBlackout();
  }, { passive: true }));

  el.facingSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-facing]');
    if (!btn) return;
    state.facing = btn.dataset.facing;
    el.facingSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
  });

  // Screen off / app in the background: the microphone (and the connection) keep going thanks to the foreground
  // service. Android may stop the camera there: when the video stops flowing, EvCam falls back to microphone only
  // ("sleep" standby, not a user choice) and brings the camera back as soon as the screen is on again.
  let bgTimer = 0;

  async function framesAdvancing() {
    const pc = state.pc;
    if (!pc) return false;
    const read = async () => {
      let n = -1;
      (await pc.getStats()).forEach((r) => { if (r.type === 'outbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) n = r.framesEncoded || r.framesSent || 0; });
      return n;
    };
    try {
      const a = await read();
      await sleep(1500);
      const b = await read();
      return a >= 0 && b > a;
    } catch { return false; }
  }

  async function checkBackground() {
    clearTimeout(bgTimer);
    if (document.visibilityState !== 'hidden' || !state.running || state.userStopped) return;
    if (!state.standby && !DEMO) {
      const vt = videoTrack();
      const alive = !!vt && vt.readyState === 'live' && !vt.muted && (await framesAdvancing());
      if (!alive && document.visibilityState === 'hidden') {
        dbg('background: the phone stopped the camera, microphone only until the screen is back');
        await setStandby(true, 'sleep');
      }
    }
    if (!state.standby) bgTimer = setTimeout(checkBackground, 8000);
  }

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && app.dataset.state === 'idle') checkLink(); // idle screen: look again as soon as it is shown
    if (!state.running || state.userStopped) return;
    if (document.visibilityState === 'hidden') {
      clearTimeout(bgTimer);
      bgTimer = setTimeout(checkBackground, 2500);
      return;
    }
    clearTimeout(bgTimer);
    requestWake();
    const dead = state.stream && state.stream.getTracks().some((t) => t.readyState === 'ended');
    if (dead && !DEMO) {
      try { await reacquire(); } catch (err) { return fail(describeError(err)); }
    }
    const s = state.pc && state.pc.connectionState;
    if (!state.pc || s === 'failed' || s === 'closed' || s === 'disconnected' || dead) reconnect();
    // the screen is back: give the camera back if it was only stopped by the sleep
    if (state.standby && state.standbyReason === 'sleep' && state.camWanted) await setStandby(false, 'sleep');
  });

  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return; // the page is only frozen (screen off), not closed
    if (state.running && !state.userStopped && navigator.sendBeacon) {
      navigator.sendBeacon('/api/bye', new Blob([JSON.stringify({ token: state.token })], { type: 'application/json' }));
    }
  });

  // boot
  deviceLabel().then((label) => { state.device = label; });
  initBattery();
  if (!window.isSecureContext) {
    el.idleMsg.hidden = false;
    el.idleMsg.textContent = 'Cette page doit être ouverte en https:// pour accéder à la caméra.';
  }
  if (DEMO) el.facingSeg.parentElement.querySelector('.label').textContent = 'Caméra (démo)';
  checkLink();
})();
