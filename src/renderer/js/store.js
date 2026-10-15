'use strict';

const { ipcRenderer } = require('electron');

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isObject(v)) flatten(v, path, out);
    else out[path] = v;
  }
  return out;
}

/** Local mirror of the persisted settings, with change notifications and debounced saving. */
class Store {
  constructor() {
    this.settings = {};
    this.info = {};
    this.listeners = new Set();
    this._pending = null;
    this._timer = 0;
    this._inflight = 0;
  }

  async init() {
    this.info = await ipcRenderer.invoke('state:get');
    this.settings = this.info.settings;
    ipcRenderer.on('settings:changed', (_e, { settings, connection }) => {
      // our own edits are authoritative while they are being saved
      if (!this._pending && this._inflight === 0) this._adopt(settings);
      if (connection) this.info.connection = connection;
      this._emit('connection', connection);
    });
    return this.info;
  }

  get(path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this.settings);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(path, value) {
    for (const fn of this.listeners) {
      try { fn(path, value); } catch (err) { console.error('[store] listener failed', err); }
    }
  }

  /** Takes settings coming from the main process and notifies only what actually changed. */
  _adopt(next) {
    const before = flatten(this.settings);
    const after = flatten(next);
    this.settings = next;
    this.info.settings = next;
    for (const [path, value] of Object.entries(after)) {
      if (before[path] !== value) this._emit(path, value);
    }
  }

  set(path, value, { save = true } = {}) {
    const keys = path.split('.');
    let target = this.settings;
    for (let i = 0; i < keys.length - 1; i++) target = target[keys[i]];
    const last = keys[keys.length - 1];
    if (target[last] === value) return;
    target[last] = value;
    this._emit(path, value);
    if (!save) return;

    // nested patch, merged while the debounce timer is running
    let node = (this._pending = this._pending || {});
    for (let i = 0; i < keys.length - 1; i++) node = node[keys[i]] = node[keys[i]] || {};
    node[last] = value;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 140);
  }

  flush() {
    clearTimeout(this._timer);
    if (!this._pending) return Promise.resolve();
    const patch = this._pending;
    this._pending = null;
    this._inflight++;
    return ipcRenderer.invoke('settings:patch', patch).finally(() => { this._inflight--; });
  }
}

module.exports = { Store };
