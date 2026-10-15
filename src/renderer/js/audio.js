'use strict';

/**
 * Plays the phone's microphone into a chosen output device. With a virtual audio cable
 * (e.g. VB-CABLE) as that device, the cable's other end shows up as a microphone in
 * every application. A second, silent-by-default chain on the default device provides
 * the level meter and the optional "listen on this PC" monitor.
 */
class AudioBridge extends EventTarget {
  constructor() {
    super();
    this.cfg = { enabled: true, gain: 1, delayMs: 0, outputDeviceId: '', monitor: false };
    this.stream = null;
    this.el = null;
    this.mon = null;
    this.out = null;
    this.outId = null;
    this.gen = 0;
    this.error = '';
    this.level = 0;
    this.peak = 0;
    this._buf = null;
  }

  get active() { return !!this.stream; }

  configure(partial) {
    Object.assign(this.cfg, partial);
    this._apply();
  }

  async attach(stream) {
    this.detach();
    const gen = ++this.gen;
    this.stream = stream;

    // Chromium only feeds remote WebRTC audio into Web Audio when it is also attached to a media element.
    this.el = new Audio();
    this.el.muted = true;
    this.el.srcObject = stream;
    this.el.play().catch(() => {});

    this.mon = await this._buildChain(null, true);
    if (gen !== this.gen) return this._destroy(this.mon);
    await this._syncOutput(gen);
    this._apply();
  }

  detach() {
    this.gen++;
    this._destroy(this.mon);
    this._destroy(this.out);
    this.mon = null;
    this.out = null;
    this.outId = null;
    if (this.el) { this.el.srcObject = null; this.el = null; }
    this.stream = null;
    this.level = 0;
    this.peak = 0;
  }

  async _buildChain(sinkId, withMeter) {
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      if (sinkId && typeof ctx.setSinkId === 'function') await ctx.setSinkId(sinkId);
      await ctx.resume();
      const src = ctx.createMediaStreamSource(this.stream);
      const delay = ctx.createDelay(1);
      const main = ctx.createGain();
      src.connect(delay);
      delay.connect(main);
      const chain = { ctx, src, delay, main };
      if (withMeter) {
        chain.analyser = ctx.createAnalyser();
        chain.analyser.fftSize = 1024;
        chain.monitor = ctx.createGain();
        main.connect(chain.analyser);
        main.connect(chain.monitor);
        chain.monitor.connect(ctx.destination);
      } else {
        main.connect(ctx.destination);
      }
      this.error = '';
      return chain;
    } catch (err) {
      this.error = err.message;
      this.dispatchEvent(new CustomEvent('error', { detail: err.message }));
      return null;
    }
  }

  _destroy(chain) {
    if (!chain) return;
    try { chain.src.disconnect(); } catch { /* ignore */ }
    chain.ctx.close().catch(() => {});
  }

  /** (Re)creates the virtual-microphone chain when the selected output changed. */
  async _syncOutput(gen = this.gen) {
    const wanted = this.cfg.outputDeviceId || '';
    if (!this.stream || this.outId === wanted) return;
    this._destroy(this.out);
    this.out = null;
    this.outId = wanted;
    if (!wanted) return;
    const chain = await this._buildChain(wanted, false);
    if (gen !== this.gen || this.outId !== wanted) return this._destroy(chain);
    this.out = chain;
  }

  _apply() {
    const gain = this.cfg.enabled ? this.cfg.gain : 0;
    const delay = Math.max(0, Math.min(1, this.cfg.delayMs / 1000));
    for (const chain of [this.mon, this.out]) {
      if (!chain) continue;
      chain.main.gain.value = gain;
      chain.delay.delayTime.value = delay;
    }
    if (this.mon) this.mon.monitor.gain.value = this.cfg.monitor ? 1 : 0;
    if (this.stream && (this.cfg.outputDeviceId || '') !== (this.outId || '')) {
      this._syncOutput().then(() => this._apply());
    }
  }

  /** Smoothed level (0..1) and peak marker (0..1) on a -60..0 dBFS scale. */
  sample() {
    const analyser = this.mon && this.mon.analyser;
    if (!analyser) {
      this.level *= 0.8;
      this.peak *= 0.95;
      return { level: this.level, peak: this.peak, db: -Infinity };
    }
    if (!this._buf) this._buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(this._buf);
    let sum = 0;
    for (let i = 0; i < this._buf.length; i++) sum += this._buf[i] * this._buf[i];
    const rms = Math.sqrt(sum / this._buf.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    const norm = Math.max(0, Math.min(1, (db + 60) / 60));
    this.level = norm > this.level ? norm : this.level * 0.82 + norm * 0.18;
    this.peak = Math.max(this.level, this.peak - 0.012);
    return { level: this.level, peak: this.peak, db };
  }

  /** Audio output devices, as Chromium exposes them. */
  async listOutputs() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Sortie audio ${i + 1}` }));
    } catch {
      return [];
    }
  }
}

module.exports = { AudioBridge };
