'use strict';

const koffi = require('koffi');
const { FrameSmoother } = require('./smooth');

/** Output sizes of the virtual camera (width and height must be multiples of four). */
const QUALITIES = {
  '480p': { w: 848, h: 480 },
  '720p': { w: 1280, h: 720 },
  '1080p': { w: 1920, h: 1080 }
};

/** Bitrate asked from the phone for each quality / frame rate. */
function targetBitrate(quality, fps, factor = 0.08) {
  const { w, h } = QUALITIES[quality] || QUALITIES['720p'];
  return Math.round(w * h * fps * factor);
}

/** Quality / frame rate / bitrate really used: the battery saver caps them (720p, 24 fps, lighter bitrate). */
function effectiveCamera(settings, softEncoder = false) {
  let { quality, fps } = settings.camera;
  const asked = fps;
  let capReason = ''; // why EvCam itself asks the phone for less than the chosen frame rate: 'soft' | 'vp8' | 'eco'
  // bits per pixel and frame: a phone's hardware encoder + the Wi-Fi radio are what make it hot, so stay modest
  let factor = 0.08;
  // VP8 (or any software encoder) runs on the phone's CPU: 1080p / 60 would make it boiling hot, so stay at 720p / 30
  if (softEncoder || (settings.power && settings.power.codec === 'vp8')) {
    if (quality === '1080p') quality = '720p';
    // "force the frame rate" keeps what was asked: the phone then gives up sharpness before it gives up frames,
    // and its own heat protection (which lowers everything when it gets hot) stays in charge
    if (!settings.camera.force && fps > 30) { fps = 30; capReason = softEncoder ? 'soft' : 'vp8'; }
    factor = 0.1;
  }
  if (settings.power && settings.power.eco) {
    if (quality === '1080p') quality = '720p';
    if (fps > 24) { fps = 24; capReason = 'eco'; }
    factor = 0.05;
  }
  const size = QUALITIES[quality] || QUALITIES['720p'];
  // "wide" captures the whole 4:3 sensor (a 16:9 video crops the top and bottom of the scene)
  const wide = !!settings.camera.wide;
  const capture = wide ? { w: Math.round((size.h * 4) / 3 / 4) * 4, h: size.h } : size;
  return { quality, fps, asked, capReason, size, capture, wide, bitrate: Math.max(1000000, Math.round(capture.w * capture.h * fps * factor)) };
}

// ---------------------------------------------------------------------------
// Native virtual camera (DirectShow filter shipped as evcam_vcam.dll)
// ---------------------------------------------------------------------------
class VirtualCamera {
  constructor() {
    this.lib = null;
    this.fn = null;
    this.handle = null;
    this.width = 0;
    this.height = 0;
    this.dllPath = '';
    this.error = '';
  }

  load(dllPath) {
    if (this.lib && this.dllPath === dllPath) return true;
    try {
      this.lib = koffi.load(dllPath);
      this.fn = {
        create: this.lib.func('void *scCreateCamera(int width, int height, float framerate)'),
        remove: this.lib.func('void scDeleteCamera(void *camera)'),
        send: this.lib.func('void scSendFrameRGBA(void *camera, const void *rgba)'),
        connected: this.lib.func('bool scIsConnected(void *camera)')
      };
      this.dllPath = dllPath;
      this.error = '';
      return true;
    } catch (err) {
      this.lib = null;
      this.error = `Chargement impossible : ${err.message}`;
      return false;
    }
  }

  open(width, height, fps) {
    this.close();
    if (!this.fn) return false;
    try {
      const handle = this.fn.create(width, height, fps);
      if (!handle) {
        this.error = 'La caméra virtuelle est déjà utilisée par une autre instance d’EvCam.';
        return false;
      }
      this.handle = handle;
      this.width = width;
      this.height = height;
      this.error = '';
      return true;
    } catch (err) {
      this.error = err.message;
      return false;
    }
  }

  close() {
    if (this.handle && this.fn) {
      try { this.fn.remove(this.handle); } catch { /* ignore */ }
    }
    this.handle = null;
  }

  send(rgba) {
    if (this.handle) this.fn.send(this.handle, rgba);
  }

  isConnected() {
    try { return this.handle ? !!this.fn.connected(this.handle) : false; } catch { return false; }
  }
}

// ---------------------------------------------------------------------------
// Compositor: phone video -> (rotate / mirror / fit) -> preview canvas + virtual camera
// ---------------------------------------------------------------------------
class Compositor extends EventTarget {
  /**
   * @param {HTMLCanvasElement} canvas preview canvas, also the render target of the virtual camera
   * @param {() => {rotation:number, mirror:boolean, fit:string}} getCamSettings
   */
  constructor(canvas, getCamSettings) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    this.getCam = getCamSettings;
    this.vcam = new VirtualCamera();

    this.w = 1280;
    this.h = 720;
    this.fps = 30;

    this.frame = null;
    this.reader = null;
    this.gen = 0;
    this.video = null; // fallback when MediaStreamTrackProcessor is unavailable

    this.consumer = false;       // some application is reading the virtual camera
    this.previewVisible = false; // the preview canvas is on screen
    this.testMode = false;
    this.started = false;

    this.srcFrames = 0;
    this.srcSeq = 0;        // increments for every frame received from the phone
    this.lastFrameAt = 0;   // performance.now() of the last frame received
    this.prevFrameAt = 0;   // ... and of the one before it
    this.srcInterval = 0;   // smoothed time between two frames from the phone (ms)

    // frame smoothing (see smooth.js): allowed by the user, and only used while the phone sends clearly fewer frames
    // per second than the virtual camera outputs
    this.smoothAllowed = false;
    this.smoother = null;
    this.smoothActive = false;
    this.smoothError = '';
    this.smoothWorkerUrl = 'js/mvworker.js';
    this._smPushAt = 0;
    this.outFrames = 0;
    this._lastKey = '';
    this._rgba = null;
    this._rgbaStale = true;
    this.stats = { srcFps: 0, outFps: 0, srcW: 0, srcH: 0, drawMs: 0, sendMs: 0 };

    this.cameraOff = false; // microphone-only: show a "camera off" picture instead of the phone's frames
    this.cameraReason = ''; // '' (chosen) | 'sleep' (the phone's screen is off)
    this.bg = document.createElement('canvas');
    this.bg.width = 96;
    this.bg.height = 54;
    this.bgCtx = this.bg.getContext('2d');
    this.thumb = document.createElement('canvas');
    this.thumbCtx = this.thumb.getContext('2d');
    this.placeholder = null;
    this._phKey = '';
    this.logo = new Image();
    this.logo.onload = () => { this.placeholder = null; };
    this.logo.src = 'assets/logo.svg';

    this.canvas.width = this.w;
    this.canvas.height = this.h;
  }

  get error() { return this.vcam.error; }
  get cameraReady() { return !!this.vcam.handle; }

  start(dllPath) {
    this.started = true;
    this.vcam.load(dllPath);
    this._openCamera();
    this._restartTimer();
    // the camera may be busy for a moment (previous instance still closing): keep trying
    clearInterval(this._retry);
    this._retry = setInterval(() => {
      if (this.vcam.fn && !this.vcam.handle) {
        this._openCamera();
        if (this.vcam.handle) this.dispatchEvent(new CustomEvent('camera'));
      }
    }, 3000);
    clearInterval(this._poll);
    this._poll = setInterval(() => {
      const connected = this.vcam.isConnected();
      if (connected !== this.consumer) {
        this.consumer = connected;
        this.dispatchEvent(new CustomEvent('consumer', { detail: connected }));
      }
    }, 250);
    clearInterval(this._statTimer);
    this._statTimer = setInterval(() => {
      this.stats.srcFps = this.srcFrames;
      this.stats.outFps = this.outFrames;
      this.srcFrames = 0;
      this.outFrames = 0;
    }, 1000);
  }

  reload(dllPath) {
    this.vcam.lib = null;
    this.vcam.load(dllPath);
    this._openCamera();
    this.dispatchEvent(new CustomEvent('camera'));
  }

  configure({ w, h, fps }) {
    const sizeChanged = w !== this.w || h !== this.h;
    const fpsChanged = fps !== this.fps;
    this.w = w;
    this.h = h;
    this.fps = fps;
    if (sizeChanged) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.placeholder = null;
      this._rgba = null;
      this._lastKey = '';
    }
    if (this.started && (sizeChanged || fpsChanged)) {
      this._openCamera();
      this._restartTimer();
      this.dispatchEvent(new CustomEvent('camera'));
    }
  }

  _openCamera() {
    if (this.vcam.fn) this.vcam.open(this.w, this.h, this.fps);
  }

  _restartTimer() {
    clearInterval(this._timer);
    this._timer = setInterval(() => this._tick(), Math.round(1000 / this.fps));
  }

  /** Frame smoothing on / off (the user's choice); it only runs while it is useful. */
  setSmoothing(on) {
    on = !!on;
    if (on === this.smoothAllowed) return;
    this.smoothAllowed = on;
    this.smoothActive = false;
    if (!on && this.smoother) { this.smoother.dispose(); this.smoother = null; }
    this._lastKey = '';
  }

  /** Frames per second really arriving from the phone (smoothed). */
  get srcRate() { return this.srcInterval > 0 ? 1000 / this.srcInterval : 0; }

  _smoothWanted() {
    const rate = this.srcRate;
    return rate > 0 && rate < this.fps * (this.smoothActive ? 0.95 : 0.88);
  }

  _smootherInstance() {
    if (!this.smoother && !this.smoothError) {
      const sm = new FrameSmoother(this.smoothWorkerUrl);
      if (sm.ok) this.smoother = sm;
      else { this.smoothError = sm.error || 'indisponible'; this.smoothAllowed = false; this.dispatchEvent(new CustomEvent('smooth-error')); }
    }
    return this.smoother;
  }

  setCameraOff(on, reason = '') {
    on = !!on;
    reason = on ? reason : '';
    if (on === this.cameraOff && reason === this.cameraReason) return;
    this.cameraOff = on;
    this.cameraReason = reason;
    this._lastKey = '';
  }

  setTestMode(on) {
    this.testMode = !!on;
    this.dispatchEvent(new CustomEvent('mode'));
  }

  // ----- source handling -----------------------------------------------------

  setTrack(track) {
    this.gen++;
    this._stopPump();
    if (this.frame) { this.frame.close(); this.frame = null; }
    this.stats.srcW = 0;
    this.stats.srcH = 0;
    if (!track) return;

    if (typeof MediaStreamTrackProcessor === 'function') {
      const processor = new MediaStreamTrackProcessor({ track });
      this.reader = processor.readable.getReader();
      this._pump(this.reader, this.gen);
    } else {
      // Fallback: draw from a hidden <video>
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([track]);
      video.play().catch(() => {});
      this.video = video;
    }
  }

  _stopPump() {
    if (this.reader) {
      const reader = this.reader;
      this.reader = null;
      reader.cancel().catch(() => {});
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
  }

  async _pump(reader, gen) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (gen !== this.gen) { if (value) value.close(); break; }
        this.srcFrames++;
        this.srcSeq++;
        const now = performance.now();
        if (this.lastFrameAt && now - this.lastFrameAt < 1000) {
          const gap = now - this.lastFrameAt;
          this.srcInterval = this.srcInterval ? this.srcInterval * 0.88 + gap * 0.12 : gap;
        } else if (!this.lastFrameAt || now - this.lastFrameAt >= 1000) {
          this.srcInterval = 0; // the stream (re)started: measure again
        }
        this.prevFrameAt = this.lastFrameAt;
        this.lastFrameAt = now;
        if (this.smoothAllowed && (this.consumer || this.previewVisible) && this._smoothWanted()) { // (nobody watching: nothing to compute)
          const sm = this._smootherInstance();
          if (sm) {
            if (now - this._smPushAt > 400) sm.reset(); // frames were not being fed: start a fresh pair
            sm.push(value);
            this._smPushAt = now;
          }
        }
        if (this.frame) this.frame.close();
        this.frame = value; // keep only the latest frame
      }
    } catch { /* track ended */ }
  }

  get hasSource() {
    return this.testMode || !!this.frame || !!(this.video && this.video.videoWidth);
  }

  // ----- rendering -----------------------------------------------------------

  _tick() {
    if (!this.consumer && !this.previewVisible) return; // nobody is watching: save CPU

    const t0 = performance.now();
    const cam = this.getCam();
    const source = this.cameraOff ? null : (this.frame || (this.video && this.video.videoWidth ? this.video : null));

    // Redraw (and read back) only when the picture can differ from the previous one:
    // a new frame from the phone, a changed setting, or an animated test card.
    // smoothing: the picture shown is an in-between one, computed for a moment one frame in the past
    let seq = this.video && !this.frame ? t0 : this.srcSeq;
    let alpha = -1;
    this.smoothActive = false;
    if (source && this.smoothAllowed && this.smoother && this.smoother.ready && !this.testMode && t0 - this._smPushAt < 400 && this._smoothWanted() && this.frame) {
      const interval = Math.min(120, Math.max(15, this.srcInterval));
      const span = Math.max(1, this.lastFrameAt - this.prevFrameAt);
      alpha = Math.min(1, Math.max(0, (t0 - (interval + 6) - this.prevFrameAt) / span));
      this.smoothActive = true;
      seq = `${this.srcSeq}.${Math.round(alpha * 64)}`;
    }
    const kind = this.testMode ? 'test' : source ? 'src' : 'idle';
    const key = `${kind}|${kind === 'src' ? seq : 0}|${cam.rotation}|${cam.mirror}|${cam.fit}|${cam.zoom}|${cam.panX}|${cam.panY}|${cam.dezoomBg}|${cam.wide}|${this.cameraOff}|${this.cameraReason}|${this.w}x${this.h}`;
    if (kind === 'test' || key !== this._lastKey) {
      if (kind === 'test') this._drawTestCard();
      else if (source) this._drawSource(alpha >= 0 ? this.smoother.render(alpha) : source);
      else this._drawPlaceholder();
      this._lastKey = key;
      this._rgbaStale = true;
    }
    const t1 = performance.now();

    if (this.consumer && this.vcam.handle) {
      if (this._rgbaStale || !this._rgba) {
        this._rgba = this.ctx.getImageData(0, 0, this.w, this.h).data;
        this._rgbaStale = false;
      }
      this.vcam.send(this._rgba); // same frame again is cheap: no readback, just a copy into shared memory
      this.stats.sendMs = this.stats.sendMs * 0.9 + (performance.now() - t1) * 0.1;
    }
    this.outFrames++;
    this.stats.drawMs = this.stats.drawMs * 0.9 + (t1 - t0) * 0.1;
  }

  /** How many output pixels the picture can be moved horizontally / vertically from the centre (for dragging on the preview). */
  framing() {
    const cam = this.getCam();
    const sw = this.stats.srcW;
    const sh = this.stats.srcH;
    if (!sw || !sh) return { roomX: 0, roomY: 0 };
    const rot = cam.rotation || 0;
    const swap = rot === 90 || rot === 270;
    const rw = swap ? sh : sw;
    const rh = swap ? sw : sh;
    const contain = cam.fit === 'contain' || !!cam.wide;
    const base = contain ? Math.min(this.w / rw, this.h / rh) : Math.max(this.w / rw, this.h / rh);
    const scale = base * Math.min(4, Math.max(0.25, (cam.zoom || 100) / 100));
    return { roomX: Math.abs(this.w - rw * scale) / 2, roomY: Math.abs(this.h - rh * scale) / 2 };
  }

  _drawSource(source) {
    const { ctx, w: W, h: H } = this;
    const cam = this.getCam();
    const sw = source.displayWidth || source.videoWidth || source.width;
    const sh = source.displayHeight || source.videoHeight || source.height;
    if (!sw || !sh) return;
    this.stats.srcW = sw;
    this.stats.srcH = sh;

    const rot = cam.rotation || 0;
    const swap = rot === 90 || rot === 270;
    const rw = swap ? sh : sw;
    const rh = swap ? sw : sh;
    const contain = cam.fit === 'contain' || !!cam.wide; // the whole 4:3 frame is shown in "wide" mode
    const base = contain ? Math.min(W / rw, H / rh) : Math.max(W / rw, H / rh);
    // digital zoom: below 100 % the picture shrinks inside the frame, above it is enlarged and cropped
    const zoom = Math.min(4, Math.max(0.25, (cam.zoom || 100) / 100));
    const scale = base * zoom;
    // framing: how far the picture is moved, as a fraction of the room it has (the margin around a shrunk picture,
    // or the part of an enlarged one that falls outside the frame). Applied in screen space, after rotation / mirror.
    const clamp1 = (v) => Math.min(1, Math.max(-1, v / 100));
    const ox = clamp1(cam.panX || 0) * (Math.abs(W - rw * scale) / 2);
    const oy = clamp1(cam.panY || 0) * (Math.abs(H - rh * scale) / 2);

    const transform = (c, s, cx, cy) => {
      c.translate(cx, cy);
      if (cam.mirror) c.scale(-1, 1);
      c.rotate((rot * Math.PI) / 180);
      c.scale(s, s);
    };

    // anything of the frame left uncovered (shrunk, letterboxed, or moved away from an edge) gets a background
    if (rw * scale - 2 * Math.abs(ox) < W - 1 || rh * scale - 2 * Math.abs(oy) < H - 1) {
      this._drawSurround(source, { sw, sh, rw, rh, scale, transform, ox, oy, mode: cam.dezoomBg || 'blur' });
    }

    ctx.save();
    transform(ctx, scale, W / 2 + ox, H / 2 + oy);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(source, -sw / 2, -sh / 2, sw, sh);
    ctx.restore();
  }

  /** Fills the frame around a shrunk / letterboxed picture: blurred copy, mirrored copies, or black. */
  _drawSurround(source, { sw, sh, rw, rh, scale, transform, ox = 0, oy = 0, mode }) {
    const { ctx, w: W, h: H } = this;
    if (mode === 'black') {
      ctx.fillStyle = '#06070d';
      ctx.fillRect(0, 0, W, H);
      return;
    }
    const bw = this.bg.width;
    const bh = this.bg.height;
    const b = this.bgCtx;
    b.setTransform(1, 0, 0, 1, 0, 0);
    if (mode === 'mirror') {
      // reflect-tile the picture over the whole frame (on a tiny canvas, then stretched = blurred):
      // it reads as a wider room around the real picture
      const k = bw / W;
      const mw = Math.max(4, rw * scale * k);
      const mh = Math.max(4, rh * scale * k);
      const t = this.thumb;
      t.width = Math.ceil(mw);
      t.height = Math.ceil(mh);
      const tc = this.thumbCtx;
      tc.save();
      transform(tc, t.width / rw, t.width / 2, t.height / 2);
      tc.drawImage(source, -sw / 2, -sh / 2, sw, sh);
      tc.restore();
      b.clearRect(0, 0, bw, bh);
      const nx = Math.ceil(bw / mw / 2) + 1;
      const ny = Math.ceil(bh / mh / 2) + 1;
      for (let iy = -ny; iy <= ny; iy++) {
        for (let ix = -nx; ix <= nx; ix++) {
          b.save();
          b.translate(bw / 2 + ox * k + ix * mw, bh / 2 + oy * k + iy * mh);
          b.scale(Math.abs(ix) % 2 ? -1 : 1, Math.abs(iy) % 2 ? -1 : 1);
          b.drawImage(t, -t.width / 2, -t.height / 2, t.width, t.height);
          b.restore();
        }
      }
    } else {
      // blur: a dimmed, enlarged copy of the picture
      b.save();
      transform(b, Math.max(bw / rw, bh / rh), bw / 2, bh / 2);
      b.drawImage(source, -sw / 2, -sh / 2, sw, sh);
      b.restore();
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.bg, 0, 0, W, H);
    ctx.fillStyle = 'rgba(6, 7, 13, 0.42)';
    ctx.fillRect(0, 0, W, H);
  }

  _drawPlaceholder() {
    const { w: W, h: H } = this;
    const off = this.cameraOff;
    const sleeping = off && this.cameraReason === 'sleep';
    const key = `${W}x${H}|${off}|${sleeping}|${this.logo.complete && this.logo.naturalWidth ? 1 : 0}`;
    if (!this.placeholder || this._phKey !== key) {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      const bg = g.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, '#1b1450');
      bg.addColorStop(0.55, '#0b0c24');
      bg.addColorStop(1, '#06070f');
      g.fillStyle = bg;
      g.fillRect(0, 0, W, H);
      const glow = g.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.42, H * 0.7);
      glow.addColorStop(0, 'rgba(110, 92, 255, 0.45)');
      glow.addColorStop(1, 'rgba(110, 92, 255, 0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, W, H);
      const size = Math.round(H * 0.3);
      if (this.logo.complete && this.logo.naturalWidth) g.drawImage(this.logo, (W - size) / 2, H * 0.42 - size / 2, size, size);
      g.textAlign = 'center';
      g.fillStyle = '#eef0ff';
      g.font = `700 ${Math.round(H * 0.068)}px Inter, "Segoe UI", sans-serif`;
      g.fillText(sleeping ? 'Téléphone en veille' : off ? 'Caméra désactivée' : 'EvCam', W / 2, H * 0.72);
      g.fillStyle = 'rgba(200, 205, 240, 0.75)';
      g.font = `500 ${Math.round(H * 0.037)}px Inter, "Segoe UI", sans-serif`;
      g.fillText(sleeping ? 'Le micro reste actif · l’image revient au réveil' : off ? 'Le micro du téléphone reste actif' : 'En attente du téléphone…', W / 2, H * 0.8);
      this.placeholder = c;
      this._phKey = key;
    }
    this.ctx.drawImage(this.placeholder, 0, 0);
  }

  _drawTestCard() {
    const { ctx, w: W, h: H } = this;
    const t = performance.now() / 1000;
    const bars = ['#ffffff', '#ffd400', '#00e5ff', '#34d058', '#ff4fd8', '#ff3b30', '#2f5bff'];
    ctx.fillStyle = '#0b0c1e';
    ctx.fillRect(0, 0, W, H);
    bars.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(Math.floor((i * W) / 7), 0, Math.ceil(W / 7) + 1, H * 0.6);
    });
    const g = ctx.createLinearGradient(0, H * 0.6, W, H);
    g.addColorStop(0, '#2b1b6e');
    g.addColorStop(1, '#0a6fa3');
    ctx.fillStyle = g;
    ctx.fillRect(0, H * 0.6, W, H * 0.4);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(W / 2 + Math.cos(t * 1.7) * W * 0.32, H * 0.8 + Math.sin(t * 2.6) * H * 0.07, H * 0.045, 0, Math.PI * 2);
    ctx.fill();
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.round(H * 0.07)}px Inter, "Segoe UI", sans-serif`;
    ctx.fillText('EvCam · mire de test', W * 0.04, H * 0.63);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = `500 ${Math.round(H * 0.04)}px Inter, "Segoe UI", sans-serif`;
    ctx.fillText(`${W}×${H} · ${this.fps} i/s · ${t.toFixed(1)} s`, W * 0.04, H * 0.73);
  }
}

module.exports = { QUALITIES, targetBitrate, effectiveCamera, VirtualCamera, Compositor };
