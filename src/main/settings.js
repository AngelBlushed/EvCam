'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const DEFAULT_PORT = 4733;

const DEFAULTS = {
  port: DEFAULT_PORT,
  token: '',
  preferredIp: '',
  autoStart: false,
  startMinimized: true,
  closeAction: 'ask',     // the window's cross: 'ask' (minimise or quit?) | 'tray' | 'quit'
  checkUpdates: true,     // look (once a day) for a newer release on GitHub and say so in the window
  firstRunDone: false,
  settingsVersion: 2,     // 2: H.264 given back once (a wrong "H.264 does not work" verdict used to be saved for good)
  camera: {
    enabled: true,        // false = microphone only: the phone camera is switched off
    dezoom: 0,            // 0..90 %: shrink the picture inside the frame (digital zoom-out)
    dezoomBg: 'blur',     // what fills the frame around it: 'blur' | 'mirror' | 'black'
    wide: false,          // capture the full 4:3 sensor (more scene than the 16:9 crop)
    quality: '720p',      // '480p' | '720p' | '1080p'
    fps: 30,              // 24 | 30 | 60
    fit: 'contain',       // 'cover' | 'contain'
    mirror: false,
    rotation: 0           // 0 | 90 | 180 | 270
  },
  audio: {
    enabled: true,
    gain: 1,              // 0..2
    delayMs: 0,           // 0..500
    outputDeviceId: '',   // '' = no virtual output selected
    outputLabel: '',
    outputAuto: true,     // pick a virtual cable automatically until the user chooses
    monitor: false,
    previousMicId: '',    // Windows default microphone before an older EvCam replaced it (to restore it)
    virtualMicId: '',     // capture end of the virtual cable (renamed "EvCam Micro")
    virtualRenderId: '',  // its playback end
    origNames: ''         // JSON: original names of both ends, to give them back
  },
  phone: {
    facing: 'user',       // 'user' | 'environment'
    noiseSuppression: true
  },
  power: {
    eco: false,           // battery saver: 720p max, 24 fps, lower bitrate, black screen on the phone
    codec: 'h264'         // 'h264' (phone hardware encoder, efficient) | 'vp8' (compatible)
  }
};

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const clamp = (v, lo, hi, fallback) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : fallback);

function merge(base, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in base)) continue; // ignore unknown keys
    if (isObject(base[key]) && isObject(value)) merge(base[key], value);
    else if (typeof base[key] === typeof value) base[key] = value;
  }
  return base;
}

function sanitize(s) {
  s.port = Math.round(clamp(s.port, 1024, 65535, DEFAULT_PORT));
  if (!['480p', '720p', '1080p'].includes(s.camera.quality)) s.camera.quality = '720p';
  if (![24, 30, 60].includes(s.camera.fps)) s.camera.fps = 30;
  if (!['cover', 'contain'].includes(s.camera.fit)) s.camera.fit = 'contain';
  if (![0, 90, 180, 270].includes(s.camera.rotation)) s.camera.rotation = 0;
  s.audio.gain = clamp(s.audio.gain, 0, 2, 1);
  s.audio.delayMs = Math.round(clamp(s.audio.delayMs, 0, 500, 0));
  if (!['user', 'environment'].includes(s.phone.facing)) s.phone.facing = 'user';
  if (!['h264', 'vp8'].includes(s.power.codec)) s.power.codec = 'h264';
  if (!['ask', 'tray', 'quit'].includes(s.closeAction)) s.closeAction = 'ask';
  s.camera.dezoom = Math.round(clamp(s.camera.dezoom, 0, 90, 0));
  if (!['blur', 'mirror', 'black'].includes(s.camera.dezoomBg)) s.camera.dezoomBg = 'blur';
  if (!s.token || typeof s.token !== 'string') s.token = newToken();
  return s;
}

function newToken() {
  return crypto.randomBytes(6).toString('base64url');
}

class Settings extends EventEmitter {
  constructor() {
    super();
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.data = this._load();
    this._timer = null;
  }

  _load() {
    let data = clone(DEFAULTS);
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      merge(data, saved);
      // before 1.4 the cross was a simple on/off ("minimise to tray"): keep an explicit "quit" choice
      if (saved.closeAction === undefined && saved.closeToTray === false) data.closeAction = 'quit';
      if ((saved.settingsVersion || 1) < 2) { data.power.codec = 'h264'; data.settingsVersion = 2; }
    } catch { /* first run or corrupt file: use defaults */ }
    return sanitize(data);
  }

  _save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
      } catch (err) {
        console.error('[settings] save failed:', err.message);
      }
    }, 150);
  }

  flush() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch { /* ignore */ }
  }

  get() {
    return this.data;
  }

  patch(patch) {
    merge(this.data, patch);
    sanitize(this.data);
    this._save();
    this.emit('change', this.data, patch);
    return this.data;
  }

  regenerateToken() {
    this.data.token = newToken();
    this._save();
    this.emit('change', this.data, { token: this.data.token });
    return this.data.token;
  }
}

module.exports = { Settings, DEFAULT_PORT };
