'use strict';

const { ipcRenderer, clipboard } = require('electron');
const QRCode = require('qrcode');
const { svg, mountIcons } = require('./icons');
const { Extras } = require('./extras');

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Output devices that behave like a virtual cable, best match first. */
const CABLE_PATTERNS = [/^EvCam Micro/i, /^CABLE Input/i, /CABLE Input/i, /Hi-?Fi Cable Input/i, /Virtual Cable/i];

function pickVirtualOutput(outputs) {
  for (const pattern of CABLE_PATTERNS) {
    const hit = outputs.find((o) => pattern.test(o.label) && !/16ch/i.test(o.label));
    if (hit) return hit;
  }
  return null;
}

const isCableLike = (label) => CABLE_PATTERNS.some((p) => p.test(label || ''));

/** "CABLE Input (VB-Audio Virtual Cable)" is heard as "CABLE Output (...)" by applications. */
const micNameFor = (label) => (label || '').replace(/Input/i, 'Output');

function sparkPath(values) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * 100).toFixed(1)},${(27 - ((v - min) / span) * 22).toFixed(1)}`)
    .join(' ');
}

class UI {
  constructor({ store, engine, compositor, audio }) {
    this.store = store;
    this.engine = engine;
    this.compositor = compositor;
    this.audio = audio;
    this.vcamStatus = store.info.vcam || null;
    this.firewallOk = store.info.firewallOk;
    this.outputs = [];
    this.mode = 'empty';
    this.qrUrl = '';
    this.tab = 'camera';
  }

  init() {
    mountIcons();
    this.el = {
      stage: $('.stage'),
      card: $('#previewCard'),
      pill: $('#statusPill'),
      pillLabel: $('#statusLabel'),
      qrBox: $('#qrBox'),
      urlText: $('#urlText'),
      chipDevice: $('#chipDevice'),
      chipRes: $('#chipRes'),
      chipUse: $('#chipUse'),
      chipStall: $('#chipStall'),
      checks: $('#checks'),
      ctlTorch: $('#ctlTorch'),
      ctlMute: $('#ctlMute'),
      ctlMirror: $('#ctlMirror'),
      ctlFit: $('#ctlFit')
    };
    this._bindTabs();
    this._bindSettings();
    this._bindButtons();
    this._bindWelcome();
    this.extras = new Extras(this);
    this.extras.init();

    const { store, engine, compositor } = this;
    store.onChange((path) => this._onSettingChanged(path));
    for (const name of ['change', 'stats', 'ended']) engine.addEventListener(name, () => this.renderLive());
    compositor.addEventListener('consumer', () => { this.renderLive(); this.renderVcam(); });
    compositor.addEventListener('mode', () => this.renderLive());
    compositor.addEventListener('camera', () => this.renderVcam());
    document.addEventListener('visibilitychange', () => this._updateVisibility());

    $('#verText').textContent = `v${store.info.version}`;
    this.renderAll();
    this._meterLoop();
  }

  // ---------------------------------------------------------------- toasts
  toast(message, tone = 'info', icon = 'info') {
    const box = $('#toasts');
    const node = document.createElement('div');
    node.className = 'toast';
    node.dataset.tone = tone;
    node.innerHTML = svg(icon);
    const text = document.createElement('span');
    text.textContent = message;
    node.appendChild(text);
    box.appendChild(node);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(() => {
      node.classList.add('out');
      setTimeout(() => node.remove(), 320);
    }, 3600);
  }

  // ---------------------------------------------------------------- bindings
  _bindTabs() {
    const tabs = $$('#tabs [data-tab]');
    tabs.forEach((btn) => btn.addEventListener('click', () => this.showTab(btn.dataset.tab)));
    this.showTab('camera');
  }

  showTab(name) {
    this.tab = name;
    const tabs = $$('#tabs [data-tab]');
    tabs.forEach((btn, i) => {
      const on = btn.dataset.tab === name;
      btn.setAttribute('aria-selected', String(on));
      if (on) $('#tabInd').style.transform = `translateX(${i * 100}%)`;
    });
    $$('.tabpane').forEach((pane) => { pane.hidden = pane.dataset.pane !== name; });
    if (name === 'audio') { this.refreshOutputs(); if (this.extras) this.extras.refreshMic(); }
    if (name === 'camera' && this.extras) this.extras.refreshDiscord();
  }

  _bindSettings() {
    const { store } = this;
    // segmented controls
    $$('.seg[data-setting]').forEach((seg) => {
      seg.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-value]');
        if (!btn) return;
        const value = seg.dataset.type === 'number' ? Number(btn.dataset.value) : btn.dataset.value;
        store.set(seg.dataset.setting, value);
      });
    });
    // switches
    $$('input[type="checkbox"][data-setting]').forEach((input) => {
      input.addEventListener('change', () => store.set(input.dataset.setting, input.checked));
    });
    // sliders
    $$('input[type="range"][data-setting]').forEach((input) => {
      input.addEventListener('input', () => {
        const scale = Number(input.dataset.scale || 1);
        store.set(input.dataset.setting, Number(input.value) / scale);
        this._paintRange(input);
      });
    });
  }

  _paintRange(input) {
    const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--p', `${pct}%`);
  }

  _bindButtons() {
    const { store, engine, compositor } = this;
    const copyUrl = () => {
      clipboard.writeText(store.info.connection.url);
      this.toast('Adresse copiée', 'ok', 'check');
    };
    $('#btnCopy').addEventListener('click', copyUrl);
    $('#qrBox').addEventListener('dblclick', copyUrl);

    $('#ctlCam').addEventListener('click', () => store.set('camera.enabled', !store.get('camera.enabled')));
    $('#ctlFlip').addEventListener('click', () => store.set('phone.facing', store.get('phone.facing') === 'user' ? 'environment' : 'user'));
    $('#ctlRotate').addEventListener('click', () => store.set('camera.rotation', (store.get('camera.rotation') + 90) % 360));
    $('#ctlMirror').addEventListener('click', () => store.set('camera.mirror', !store.get('camera.mirror')));
    $('#ctlFit').addEventListener('click', () => store.set('camera.fit', store.get('camera.fit') === 'contain' ? 'cover' : 'contain'));
    $('#ctlTorch').addEventListener('click', () => engine.send({ t: 'config', torch: !engine.phone.torch }));
    $('#ctlMute').addEventListener('click', () => engine.send({ t: 'config', mute: !engine.phone.micMuted }));
    $('#ctlDisconnect').addEventListener('click', () => engine.disconnect());
    $('#muteSwitch').addEventListener('change', (e) => engine.send({ t: 'config', mute: e.target.checked }));

    $('#btnApkCopy').addEventListener('click', () => {
      clipboard.writeText(store.info.connection.apkUrl);
      this.toast('Lien de l’application copié', 'ok', 'check');
    });
    $('#btnApkReveal').addEventListener('click', async () => {
      if (!(await ipcRenderer.invoke('apk:reveal'))) this.toast('Fichier APK introuvable.', 'warn', 'alert');
    });
    $('#btnVcamFix').addEventListener('click', () => this.repairCamera());
    $('#btnRepair').addEventListener('click', () => this.repairCamera());
    this._bindCloseAsk();
    $('#btnCable').addEventListener('click', () => ipcRenderer.invoke('open:external', 'https://vb-audio.com/Cable/'));

    $('#outSelect').addEventListener('change', (e) => {
      const deviceId = e.target.value;
      const out = this.outputs.find((o) => o.deviceId === deviceId);
      store.set('audio.outputAuto', false);
      store.set('audio.outputLabel', out ? out.label : '');
      store.set('audio.outputDeviceId', deviceId);
    });

    $('#ipSelect').addEventListener('change', async (e) => {
      await ipcRenderer.invoke('settings:patch', { preferredIp: e.target.value });
    });
    $('#btnPort').addEventListener('click', async () => {
      const port = Number($('#portInput').value);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return this.toast('Port invalide (1024 – 65535).', 'warn', 'alert');
      await ipcRenderer.invoke('settings:patch', { port });
      this.toast(`Port ${store.info.connection.port} appliqué : rescannez le QR code.`, 'ok', 'check');
    });
    $('#btnToken').addEventListener('click', async () => {
      store.info.connection = await ipcRenderer.invoke('token:regenerate');
      this.renderConnection();
      this.toast('Nouveau code généré : les anciens QR codes ne fonctionnent plus.', 'ok', 'check');
    });
    $('#btnFirewall').addEventListener('click', async () => {
      const btn = $('#btnFirewall');
      btn.disabled = true;
      const res = await ipcRenderer.invoke('firewall:allow');
      btn.disabled = false;
      if (res.cancelled) this.toast('Autorisation annulée.', 'warn', 'alert');
      else if (res.ok) { this.setFirewall(true); this.toast('EvCam est autorisé dans le pare-feu.', 'ok', 'check'); }
      else this.toast('Impossible d’ajouter la règle de pare-feu.', 'bad', 'alert');
    });
    $('#testSwitch').addEventListener('change', (e) => compositor.setTestMode(e.target.checked));
  }

  /** First launch: explain what EvCam does and offer to start with Windows. */
  _bindWelcome() {
    const { store } = this;
    const modal = $('#welcome');
    const auto = $('#welcomeAuto');
    if (store.get('firstRunDone')) return;
    auto.disabled = !store.info.packaged;
    auto.checked = !!store.info.packaged;
    modal.hidden = false;
    $('#welcomeGo').addEventListener('click', () => {
      if (store.info.packaged) store.set('autoStart', auto.checked);
      store.set('firstRunDone', true);
      modal.hidden = true;
    });
  }

  /** The cross was clicked: "Réduire" (tray) or "Fermer" (quit); Escape or a click outside cancels. */
  _bindCloseAsk() {
    const modal = $('#closeAsk');
    const answer = (choice) => {
      if (modal.hidden) return;
      modal.hidden = true;
      ipcRenderer.send('close:choice', choice);
    };
    $('#closeAskTray').addEventListener('click', () => answer('tray'));
    $('#closeAskQuit').addEventListener('click', () => answer('quit'));
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) answer('cancel'); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) answer('cancel'); });
    ipcRenderer.on('app:ask-close', (_e, { live }) => {
      $('#closeAskText').textContent = live
        ? 'Un téléphone est connecté : fermer coupe la caméra et le micro virtuels. Réduit, EvCam continue près de l’horloge.'
        : 'Réduit, EvCam continue près de l’horloge : la caméra et le micro restent disponibles pour vos applications.';
      modal.hidden = false;
      $('#closeAskTray').focus();
    });
  }

  async repairCamera() {
    const btns = ['#btnRepair', '#btnVcamFix'].map((s) => $(s));
    btns.forEach((b) => { b.disabled = true; });
    const res = await ipcRenderer.invoke('vcam:repair');
    btns.forEach((b) => { b.disabled = false; });
    this.vcamStatus = res.status;
    this.store.info.vcam = res.status;
    if (res.ok) {
      this.compositor.reload(res.status.dllPath);
      this.toast('Caméra virtuelle réparée.', 'ok', 'check');
    } else {
      this.toast(res.error || 'La réparation a échoué.', 'bad', 'alert');
    }
    this.renderAll();
  }

  _onSettingChanged(path) {
    if (path === 'connection') { this.renderConnection(); this.renderChecks(); this.renderSettingsPane(); return; }
    this.renderControls();
    if (path.startsWith('audio.')) { this.renderAudio(); if (path === 'audio.outputDeviceId') this.renderChecks(); }
    if (path.startsWith('camera.') || path.startsWith('phone.')) this.renderCameraPane();
    if (path === 'autoStart' || path === 'startMinimized' || path === 'closeAction') this.renderControls();
  }

  // ---------------------------------------------------------------- external state
  setVcamStatus(status) {
    this.vcamStatus = status;
    this.store.info.vcam = status;
    this.renderVcam();
    this.renderChecks();
  }

  setFirewall(ok) {
    this.firewallOk = ok;
    this.renderChecks();
    this.renderSettingsPane();
  }

  async refreshOutputs() {
    this.outputs = await this.audio.listOutputs();
    this.renderAudio();
    this.renderChecks();
    return this.outputs;
  }

  // ---------------------------------------------------------------- rendering
  renderAll() {
    this.renderControls();
    this.renderConnection();
    this.renderLive();
    this.renderVcam();
    this.renderAudio();
    this.renderCameraPane();
    this.renderSettingsPane();
    this.renderChecks();
  }

  /** Syncs every data-setting control with the stored value. */
  renderControls() {
    const { store } = this;
    $$('.seg[data-setting]').forEach((seg) => {
      const value = String(store.get(seg.dataset.setting));
      $$('button', seg).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)));
    });
    $$('input[type="checkbox"][data-setting]').forEach((input) => {
      let value = store.get(input.dataset.setting);
      if (input.dataset.setting === 'autoStart') {
        input.disabled = !store.info.packaged;
        input.title = store.info.packaged ? '' : 'Disponible une fois EvCam installé';
      }
      input.checked = !!value;
    });
    $$('input[type="range"][data-setting]').forEach((input) => {
      const scale = Number(input.dataset.scale || 1);
      input.value = Math.round(store.get(input.dataset.setting) * scale);
      this._paintRange(input);
    });
    $('#gainVal').textContent = `${Math.round(store.get('audio.gain') * 100)} %`;
    $('#delayVal').textContent = `${store.get('audio.delayMs')} ms`;
    this.el.ctlMirror.classList.toggle('on', !!store.get('camera.mirror'));
    this.el.ctlFit.classList.toggle('on', store.get('camera.fit') === 'cover');
    this.el.ctlFit.title = store.get('camera.fit') === 'cover' ? 'Cadrage : remplir (rogne les bords)' : 'Cadrage : ajuster (bandes floutées)';
  }

  renderCameraPane() {
    this.renderControls();
  }

  renderConnection() {
    const info = this.store.info.connection;
    if (!info) return;
    const display = `${info.selectedIp || 'localhost'}:${info.port}`;
    this.el.urlText.textContent = `https://${display}`;
    this.el.urlText.title = info.url;
    $('#codeText').textContent = info.token || '—';
    this._renderApk(info);
    if (info.url !== this.qrUrl) {
      this.qrUrl = info.url;
      QRCode.toString(info.url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#0a0b1c', light: '#ffffff' } })
        .then((markup) => { if (this.qrUrl === info.url) this.el.qrBox.innerHTML = markup; })
        .catch(() => { this.el.qrBox.textContent = 'QR indisponible'; });
    }
  }

  /** "Application Android" card: QR code that downloads the APK from this PC. */
  _renderApk(info) {
    const card = $('#apkCard');
    card.dataset.available = String(!!info.apkAvailable);
    $('#apkHint').textContent = info.apkAvailable ? info.apkUrl.replace('https://', '') : 'Non incluse dans cette version';
    if (!info.apkAvailable || info.apkUrl === this.apkQrUrl) return;
    this.apkQrUrl = info.apkUrl;
    QRCode.toString(info.apkUrl, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#0a0b1c', light: '#ffffff' } })
      .then((markup) => { if (this.apkQrUrl === info.apkUrl) $('#apkQr').innerHTML = markup; })
      .catch(() => {});
  }

  renderSettingsPane() {
    const info = this.store.info.connection || { addresses: [], port: 0 };
    const select = $('#ipSelect');
    const sig = JSON.stringify([info.addresses.map((a) => a.address), info.selectedIp]);
    if (select.dataset.sig !== sig) {
      select.dataset.sig = sig;
      select.innerHTML = '';
      if (!info.addresses.length) select.add(new Option('Aucun réseau détecté', ''));
      for (const a of info.addresses) {
        select.add(new Option(`${a.address} — ${a.name}${a.virtual ? ' (virtuel)' : ''}`, a.address, false, a.address === info.selectedIp));
      }
    }
    const port = $('#portInput');
    if (document.activeElement !== port) port.value = info.port || this.store.get('port');

    const fwText = $('#fwText');
    const btn = $('#btnFirewall');
    if (this.firewallOk === true) {
      fwText.textContent = 'Autorisé : le téléphone peut se connecter.';
      btn.textContent = 'Autorisé';
      btn.disabled = true;
    } else if (this.firewallOk === false) {
      fwText.textContent = 'Non autorisé : le téléphone risque de ne pas pouvoir se connecter.';
      btn.textContent = 'Autoriser';
      btn.disabled = false;
    } else {
      fwText.textContent = 'Vérification…';
      btn.textContent = 'Autoriser';
      btn.disabled = false;
    }
  }

  renderVcam() {
    const st = this.vcamStatus;
    const cam = this.compositor;
    const badge = $('#vcamBadge');
    const callout = $('#vcamCallout');
    const sub = $('#vcamSub');
    let tone = 'ok';
    let text = 'Prête';
    let message = '';
    let title = 'Caméra virtuelle non installée';

    if (!st || !st.dllExists) { tone = 'bad'; text = 'Introuvable'; title = 'Fichiers manquants'; message = 'Les fichiers de la caméra virtuelle sont manquants. Réinstallez EvCam.'; }
    else if (!st.ok) { tone = 'warn'; text = 'À installer'; message = 'Windows ne connaît pas encore « EvCam ». Un clic suffit, sans droits administrateur.'; }
    else if (!cam.cameraReady) { tone = 'bad'; text = 'Occupée'; title = 'Caméra virtuelle indisponible'; message = cam.error || 'La caméra virtuelle n’a pas pu démarrer.'; }
    else if (cam.consumer) { tone = 'info'; text = 'Utilisée'; }

    badge.dataset.tone = tone;
    badge.textContent = text;
    callout.hidden = !message;
    $('#vcamCalloutTitle').textContent = title;
    $('#vcamCalloutText').textContent = message;
    sub.textContent = cam.cameraReady ? `« EvCam » · ${cam.w}×${cam.h} · ${cam.fps} i/s` : 'Visible sous le nom « EvCam »';
    $('#repairText').textContent = st && st.ok ? 'Tout est en ordre : « EvCam » est enregistrée.' : 'Ré-enregistre « EvCam » auprès de Windows';
  }

  renderAudio() {
    const { engine, audio, store } = this;
    const live = engine.live && audio.active;
    const muted = engine.phone.micMuted;
    const badge = $('#micBadge');
    badge.dataset.tone = live ? (muted ? 'warn' : 'ok') : 'muted';
    badge.textContent = live ? (muted ? 'Coupé' : 'En direct') : '—';
    $('#micSub').textContent = live ? `Reçu de ${engine.device}` : engine.live && !engine.phone.hasMic ? 'Le téléphone n’envoie pas de micro' : 'En attente du téléphone';
    $('#muteSwitch').checked = !!muted;

    // output select
    const select = $('#outSelect');
    const chosen = store.get('audio.outputDeviceId');
    const sig = JSON.stringify([this.outputs.map((o) => o.deviceId + o.label), chosen]);
    if (select.dataset.sig !== sig) {
      select.dataset.sig = sig;
      select.innerHTML = '';
      select.add(new Option('Aucun (ne pas créer de micro virtuel)', ''));
      for (const o of this.outputs) select.add(new Option(o.label, o.deviceId));
      select.value = this.outputs.some((o) => o.deviceId === chosen) ? chosen : '';
    }

    const selected = this.outputs.find((o) => o.deviceId === chosen);
    const hasCable = !!pickVirtualOutput(this.outputs);
    const outBadge = $('#outBadge');
    if (selected && isCableLike(selected.label)) {
      outBadge.dataset.tone = 'ok';
      outBadge.textContent = 'Prêt';
    } else if (selected) {
      outBadge.dataset.tone = 'info';
      outBadge.textContent = 'Personnalisé';
    } else {
      outBadge.dataset.tone = 'muted';
      outBadge.textContent = 'Désactivé';
    }
    const noMic = this.extras && this.extras.mic && this.extras.mic.ok && !this.extras.mic.virtual.capture;
    $('#cableCallout').hidden = !noMic || hasCable;
    const micName = selected && isCableLike(selected.label) ? (this.extras && this.extras.micLabel()) || micNameFor(selected.label) : '';
    $('#outHint').textContent = micName
      ? `Dans vos applications, choisissez « ${micName.replace(/\s*\(.*\)/, '')} » comme micro.`
      : 'Choisissez un câble audio virtuel pour que le son devienne un micro.';
  }

  /** Shown under the select once a virtual cable is selected. */
  virtualMicName() {
    const chosen = this.store.get('audio.outputDeviceId');
    const out = this.outputs.find((o) => o.deviceId === chosen);
    return out && isCableLike(out.label) ? micNameFor(out.label) : '';
  }

  renderLive() {
    const { engine, compositor, store } = this;

    // mode
    if (engine.status !== 'connecting') {
      this.mode = engine.live ? 'live' : compositor.testMode ? 'test' : 'empty';
    }
    const live = this.mode === 'live';
    this.el.card.dataset.mode = this.mode;
    this.el.stage.dataset.live = String(live);
    $('#testSwitch').checked = compositor.testMode;
    this._updateVisibility();

    // status pill
    let state = 'idle';
    let label = 'En attente du téléphone';
    if (engine.status === 'live') { state = 'live'; label = `${engine.device} connecté`; }
    else if (engine.status === 'reconnecting') { state = 'warn'; label = 'Reconnexion…'; }
    else if (engine.status === 'connecting') { state = 'warn'; label = 'Connexion…'; }
    else if (compositor.testMode) { state = 'warn'; label = 'Mire de test active'; }
    this.el.pill.dataset.state = state;
    this.el.pillLabel.textContent = label;

    // chips
    const { stats, phone } = engine;
    this.el.chipDevice.textContent = this.mode === 'test' ? 'Mire de test' : engine.device || 'Téléphone';
    this.el.chipRes.textContent = stats.width ? `${stats.width}×${stats.height} · ${stats.fps} i/s` : this.mode === 'test' ? `${compositor.w}×${compositor.h}` : '—';
    this.el.chipUse.classList.toggle('on', compositor.consumer);
    const stalled = engine.status === 'live' && !phone.standby && compositor.lastFrameAt > 0 &&
      performance.now() - compositor.lastFrameAt > 2500 && performance.now() - engine.wakeAt > 8000;
    this.el.chipStall.classList.toggle('on', stalled);

    // metrics
    if (live) {
      $('#mLatency').innerHTML = stats.latency ? `${stats.latency}<small>ms</small>` : '—';
      $('#mBitrate').innerHTML = stats.bitrate ? `${(stats.bitrate / 1e6).toFixed(1)}<small>Mb/s</small>` : '—';
      $('#mRes').textContent = stats.width ? `${stats.width}×${stats.height}` : '—';
      $('#mCodec').textContent = stats.width ? `${stats.fps} i/s · ${(stats.codec || 'vidéo').toUpperCase()}${stats.loss > 0.5 ? ` · ${stats.loss.toFixed(1)} % perdus` : ''}` : '—';
      $('#mPhone').textContent = engine.device || '—';
      $('#mBattery').textContent = this.extras.batteryText();
      $('#sparkLat').setAttribute('d', sparkPath(engine.history.latency));
      $('#sparkBit').setAttribute('d', sparkPath(engine.history.bitrate));
    }

    // controls
    this.el.ctlTorch.hidden = false; // always offered: web torch, native torch or screen light
    this.el.ctlTorch.classList.toggle('on', !!phone.torch);
    this.el.ctlMute.hidden = !phone.hasMic;
    this.el.ctlMute.classList.toggle('on', !!phone.micMuted);
    this.el.ctlMute.innerHTML = svg(phone.micMuted ? 'micoff' : 'mic');
    const camOn = !!store.get('camera.enabled');
    const ctlCam = $('#ctlCam');
    ctlCam.classList.toggle('on', !camOn);
    ctlCam.innerHTML = svg(camOn ? 'video' : 'videooff');
    ctlCam.title = camOn ? 'Désactiver la caméra (micro seul)' : 'Activer la caméra';

    this.renderAudio();
    this.renderChecks();
    if (this.extras) this.extras.render();
    void store;
  }

  setWindowVisible(visible) {
    const reappeared = visible && this.windowVisible === false;
    this.windowVisible = visible;
    this._updateVisibility();
    if (reappeared && this.extras) { // back from the tray (or first time on screen after a hidden start): refresh once
      if (this.tab === 'camera') this.extras.refreshDiscord();
      if (!this.extras.mic) this.extras.refreshMic();
    }
  }

  _updateVisibility() {
    this.compositor.previewVisible = this.mode !== 'empty' && this.windowVisible !== false && document.visibilityState === 'visible';
  }

  renderChecks() {
    const st = this.vcamStatus;
    const info = this.store.info.connection || { addresses: [] };
    const camOk = !!(st && st.ok && this.compositor.cameraReady);
    const chosen = this.store.get('audio.outputDeviceId');
    const out = this.outputs.find((o) => o.deviceId === chosen);
    const micOk = !!(out && isCableLike(out.label));
    const items = [
      { key: 'cam', ok: camOk, icon: 'video', text: camOk ? 'Caméra virtuelle prête' : 'Caméra virtuelle à réparer', tab: 'camera' },
      {
        key: 'mic', ok: micOk, icon: 'mic', tab: 'audio',
        text: micOk ? `Micro virtuel : ${(this.extras && this.extras.micLabel()) || micNameFor(out.label).replace(/\s*\(.*\)/, '')}` : 'Micro virtuel à configurer'
      },
      {
        key: 'fw', ok: this.firewallOk == null ? 'unknown' : this.firewallOk, icon: 'shield', tab: 'settings',
        text: this.firewallOk === true ? 'Pare-feu autorisé' : this.firewallOk === false ? 'Pare-feu à autoriser' : 'Pare-feu…'
      },
      {
        key: 'net', ok: info.addresses.length > 0, icon: 'wifi', tab: 'settings',
        text: info.addresses.length ? `Réseau ${info.selectedIp}` : 'Aucun réseau détecté'
      }
    ];
    const sig = JSON.stringify(items);
    if (this.el.checks.dataset.sig === sig) return;
    this.el.checks.dataset.sig = sig;
    this.el.checks.innerHTML = '';
    for (const item of items) {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'check';
      node.dataset.ok = String(item.ok);
      node.innerHTML = svg(item.ok === true ? 'check' : item.ok === 'unknown' ? item.icon : 'alert');
      const span = document.createElement('span');
      span.textContent = item.text;
      node.appendChild(span);
      node.addEventListener('click', () => this.showTab(item.tab));
      this.el.checks.appendChild(node);
    }
  }

  // ---------------------------------------------------------------- meter
  _meterLoop() {
    const fill = $('#meterFill');
    const peak = $('#meterPeak');
    const db = $('#meterDb');
    const frame = () => {
      const m = this.audio.sample();
      fill.style.width = `${(m.level * 100).toFixed(1)}%`;
      peak.style.left = `calc(${(m.peak * 100).toFixed(1)}% - 1px)`;
      db.textContent = Number.isFinite(m.db) && this.audio.active ? `${Math.round(m.db)} dB` : '—';
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
}

module.exports = { UI, pickVirtualOutput, isCableLike, micNameFor };
