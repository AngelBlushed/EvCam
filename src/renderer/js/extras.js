'use strict';

const { ipcRenderer } = require('electron');
const { effectiveCamera } = require('./vcam');

const $ = (sel, root = document) => root.querySelector(sel);

const fmtDuration = (minutes) => (minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}` : `${minutes} min`);

/**
 * Lens / zoom / flash card, battery saver card, Discord helper, default-microphone helper
 * and phone battery alerts. Rendered from UI.renderLive() whenever the phone state changes.
 */
class Extras {
  constructor(ui) {
    this.ui = ui;
    this.discord = null;
    this.mic = null;
    this.sig = { zoom: '', lens: '' };
    this.warned = { 20: false, 10: false };
    this.discordArmed = false;
  }

  init() {
    const { engine } = this.ui;
    $('#torchSwitch').addEventListener('change', (e) => engine.send({ t: 'config', torch: e.target.checked }));
    $('#lensSelect').addEventListener('change', (e) => engine.send({ t: 'config', lens: e.target.value }));
    $('#ctlUltra').addEventListener('click', () => this.toggleMaxWide());
    $('#btnMaxWide').addEventListener('click', () => this.maxWide());
    $('#btnResetWide').addEventListener('click', () => this.resetWide());
    $('#btnSmoothOn').addEventListener('click', () => this.ui.store.set('camera.smooth', 'auto'));
    $('#btnSmoothOff').addEventListener('click', () => this.ui.store.set('camera.smooth', 'off'));
    $('#btnForceOn').addEventListener('click', () => this.ui.store.set('camera.force', true));
    $('#chipFluid').addEventListener('click', () => { this.ui.showTab('camera'); $('#fluidCard').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    $('#btnZoomCenter').addEventListener('click', () => { this.ui.store.set('camera.panX', 0); this.ui.store.set('camera.panY', 0); });
    $('#btnZoom1').addEventListener('click', () => { this.ui.store.set('camera.zoom', 100); this.ui.store.set('camera.panX', 0); this.ui.store.set('camera.panY', 0); });
    document.querySelectorAll('.js-force').forEach((b) => b.addEventListener('click', () => this.forceDetect()));
    $('#btnDiscord').addEventListener('click', () => this.restartDiscord());
    $('#btnMicCreate').addEventListener('click', () => (this.mic && this.mic.ok && !this.mic.virtual.capture ? this.installMic() : this.createMic()));
    $('#btnMicInstall').addEventListener('click', () => this.installMic());
    ipcRenderer.on('mic:install-step', (_e, s) => this.onInstallStep(s));
    $('#btnMicRevert').addEventListener('click', () => this.revertMic());
    $('#btnMicRestore').addEventListener('click', () => this.restoreMic());

    this.refreshDiscord();
    // Discord is looked up inside EvCam (no child process), and only while the window is on screen: an app that
    // idles in the tray must not touch the disk. The microphone state (which does start PowerShell) is read once,
    // when the Micro tab opens and after each action: never on a timer.
    setInterval(() => {
      if (this.ui.windowVisible !== false && document.visibilityState === 'visible' && this.ui.tab === 'camera') this.refreshDiscord();
    }, 20000);
    // read once, a few seconds after the start-up burst, and only if the window is on screen
    setTimeout(() => { if (this.ui.windowVisible !== false) this.refreshMic(); }, 6000);
  }

  // ------------------------------------------------------------------ lens / zoom / flash
  zoomPresets(z) {
    const presets = [];
    if (z.min < 0.95) presets.push(Math.round(z.min * 10) / 10);
    for (const p of [1, 2, 3, 5]) if (p >= z.min - 0.01 && p <= z.max + 0.01 && !presets.includes(p)) presets.push(p);
    return presets;
  }

  /** "Dézoom maximal": widest the phone can give (zoom minimum, full 4:3 sensor) plus a digital zoom-out. */
  maxWide() {
    const { engine, store } = this.ui;
    const z = engine.phone.zoom;
    store.set('camera.wide', true);
    store.set('camera.zoom', 65);
    store.set('camera.panX', 0);
    store.set('camera.panY', 0);
    if (engine.live && z && z.supported) engine.send({ t: 'config', zoom: z.min });
    this.ui.toast(z && z.supported && z.min < 0.95
      ? 'Dézoom maximal : ultra grand-angle, capteur 4:3 entier et réduction de l’image.'
      : 'Dézoom maximal : capteur 4:3 entier et réduction de l’image (le zoom du téléphone ne descend pas sous 1×).', 'ok', 'lens');
  }

  resetWide() {
    const { engine, store } = this.ui;
    const z = engine.phone.zoom;
    store.set('camera.wide', false);
    store.set('camera.zoom', 100);
    store.set('camera.panX', 0);
    store.set('camera.panY', 0);
    if (engine.live && z && z.supported) engine.send({ t: 'config', zoom: 1 });
  }

  toggleMaxWide() {
    const { store } = this.ui;
    if (!this.ui.engine.live && !store.get('camera.wide') && store.get('camera.zoom') >= 100) {
      this.ui.toast('Connectez d’abord le téléphone.', 'warn', 'alert');
      return;
    }
    if (store.get('camera.wide') || store.get('camera.zoom') < 100) this.resetWide();
    else this.maxWide();
  }

  renderLens() {
    const { engine } = this.ui;
    const phone = engine.phone;
    const live = engine.live;
    const lenses = phone.lenses || [];
    $('#lensSub').textContent = !live ? 'Connectez le téléphone pour régler l’objectif'
      : phone.standby ? (phone.standbyReason === 'sleep' ? 'Téléphone en veille : micro seul' : 'Caméra désactivée : micro seul')
        : lenses.length > 1 ? `${lenses.length} objectifs détectés` : 'Objectif du téléphone';

    // zoom presets (0,5× = ultra grand-angle when the phone allows a zoom below 1)
    const z = phone.zoom || { supported: false, min: 1, max: 1, value: 1 };
    const zoomSig = JSON.stringify([live, z.supported, z.min, z.max, Math.round(z.value * 10) / 10]);
    if (zoomSig !== this.sig.zoom) {
      this.sig.zoom = zoomSig;
      const box = $('#zoomSeg');
      box.innerHTML = '';
      if (live && z.supported) {
        for (const p of this.zoomPresets(z)) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = `${String(p).replace('.', ',')}×${p < 1 ? ' ultra' : ''}`;
          b.setAttribute('aria-pressed', String(Math.abs(z.value - p) < 0.06));
          b.addEventListener('click', () => engine.send({ t: 'config', zoom: p }));
          box.appendChild(b);
        }
      }
      $('#zoomVal').textContent = live && z.supported ? `${String(Math.round(z.value * 10) / 10).replace('.', ',')}×` : '';
      $('#zoomHint').textContent = !live ? 'Disponible quand le téléphone est connecté.'
        : z.supported ? (z.min < 0.95 ? 'Choisissez 0,5× pour l’ultra grand-angle.' : 'Ce téléphone ne descend pas sous 1× : essayez un autre objectif ci-dessous.')
          : 'Zoom indisponible sur cet objectif : choisissez-en un autre ou utilisez l’appli Android.';
    }

    // lenses exposed by the phone
    const lensSig = JSON.stringify(lenses.map((l) => [l.id, l.name, l.current]));
    if (lensSig !== this.sig.lens) {
      this.sig.lens = lensSig;
      const select = $('#lensSelect');
      select.innerHTML = '';
      for (const l of lenses) select.add(new Option(l.name, l.id, false, l.current));
    }
    $('#lensField').hidden = !(live && lenses.length > 1);

    // flash
    const torch = $('#torchSwitch');
    torch.checked = !!phone.torch;
    torch.disabled = !live || !!phone.standby;
    $('#torchHint').textContent = phone.facing === 'user'
      ? 'Caméra avant : l’écran du téléphone s’allume comme une lumière d’appoint.'
      : 'Lampe du téléphone (caméra arrière).';
  }

  // ------------------------------------------------------------------ battery saver
  autonomyText() {
    const minutes = this.ui.engine.autonomyMinutes();
    return minutes ? `≈ ${fmtDuration(minutes)}` : '';
  }

  batteryText() {
    const { engine } = this.ui;
    const p = engine.phone;
    if (p.battery == null) return p.facing === 'user' ? 'Caméra avant' : 'Caméra arrière';
    let text = `Batterie ${p.battery} %${p.charging ? ' ⚡' : ''}`;
    if (!p.charging) { const eta = this.autonomyText(); if (eta) text += ` · ${eta}`; }
    return text;
  }

  batteryAlerts() {
    const p = this.ui.engine.phone;
    if (p.battery == null) return;
    if (p.charging || p.battery > 25) { this.warned = { 20: false, 10: false }; return; }
    for (const level of [20, 10]) {
      if (p.battery <= level && !this.warned[level]) {
        this.warned[level] = true;
        this.ui.toast(`Batterie du téléphone à ${p.battery} % : branchez-le ou activez le mode économie.`, 'warn', 'alert');
      }
    }
  }

  renderPower() {
    const { store, engine } = this.ui;
    const eco = !!store.get('power.eco');
    const standby = !!engine.phone.standby;
    const badge = $('#powerBadge');
    badge.dataset.tone = standby ? 'info' : eco ? 'ok' : 'muted';
    badge.textContent = standby ? 'Micro seul' : eco ? 'Économie' : 'Normal';
    const encoder = $('#encoderInfo');
    const showEncoder = engine.live && !standby && !!engine.phone.encoder;
    encoder.hidden = !showEncoder;
    if (showEncoder) {
      const hw = engine.phone.encoderHw;
      encoder.textContent = hw === false
        ? `Encodeur du téléphone : logiciel (${engine.phone.encoder}). Il chauffe beaucoup : qualité limitée à 720p / 30 i/s.`
        : hw === true ? `Encodeur du téléphone : matériel (${engine.phone.encoder}).` : `Encodeur du téléphone : ${engine.phone.encoder}.`;
    }
    $('#powerSub').textContent = engine.live && engine.phone.battery != null
      ? `${this.batteryText()}`
      : 'Réduit la consommation du téléphone';
  }

  // ------------------------------------------------------------------ Discord & detection
  async refreshDiscord() {
    try { this.discord = await ipcRenderer.invoke('discord:status'); } catch { this.discord = null; }
    this.renderDiscord();
  }

  renderDiscord() {
    const d = this.discord;
    const badge = $('#discordBadge');
    const sub = $('#discordSub');
    const btn = $('#btnDiscord');
    if (!d || !d.running) {
      badge.dataset.tone = 'muted';
      badge.textContent = 'Fermé';
      sub.textContent = 'Discord est fermé : il verra EvCam à son prochain démarrage.';
      btn.hidden = true;
      return;
    }
    const since = new Date(d.startedAt);
    const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(since).setHours(0, 0, 0, 0)) / 86400000);
    const hhmm = since.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const when = days <= 0 ? `aujourd’hui ${hhmm}` : days === 1 ? `hier ${hhmm}` : `${since.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} ${hhmm}`;
    badge.dataset.tone = 'warn';
    badge.textContent = 'Ouvert';
    sub.textContent = `Ouvert depuis ${when}`;
    btn.hidden = false;
  }

  async restartDiscord() {
    const btn = $('#btnDiscord');
    if (!this.discordArmed) {
      // two clicks: restarting Discord ends a voice call in progress
      this.discordArmed = true;
      btn.textContent = 'Confirmer (coupe un appel en cours)';
      setTimeout(() => { this.discordArmed = false; btn.textContent = 'Redémarrer Discord'; }, 5000);
      return;
    }
    this.discordArmed = false;
    btn.disabled = true;
    btn.textContent = 'Redémarrage…';
    const res = await ipcRenderer.invoke('discord:restart');
    btn.disabled = false;
    btn.textContent = 'Redémarrer Discord';
    this.ui.toast(res.restarted && res.restarted.length ? 'Discord redémarre : EvCam sera détectée à son ouverture.' : 'Discord n’a pas pu être relancé automatiquement : ouvrez-le à la main.', res.restarted && res.restarted.length ? 'ok' : 'warn', 'check');
    setTimeout(() => this.refreshDiscord(), 7000);
  }

  async forceDetect() {
    const buttons = [...document.querySelectorAll('.js-force')];
    buttons.forEach((b) => { b.disabled = true; });
    const res = await ipcRenderer.invoke('vcam:force');
    buttons.forEach((b) => { b.disabled = false; });
    if (res.status) {
      this.ui.vcamStatus = res.status;
      this.ui.store.info.vcam = res.status;
      this.ui.compositor.reload(res.status.dllPath);
    }
    if (res.ok) this.ui.toast('Caméra EvCam enregistrée, liste des périphériques actualisée.', 'ok', 'check');
    else this.ui.toast(res.error || 'L’enregistrement a échoué.', 'bad', 'alert');
    await this.refreshDiscord();
    if (this.discord && this.discord.running) this.ui.toast('Discord est ouvert : redémarrez-le (carte « Discord ») pour qu’il détecte EvCam.', 'warn', 'alert');
    this.ui.renderAll();
  }

  // ------------------------------------------------------------------ virtual microphone ("EvCam Micro")
  /** Short name the other applications see for the phone's microphone ("EvCam Micro" once created, else "CABLE Output"). */
  micLabel() {
    const capture = this.mic && this.mic.virtual && this.mic.virtual.capture;
    return capture ? capture.desc : '';
  }

  async refreshMic() {
    try { this.mic = await ipcRenderer.invoke('mic:status'); } catch { this.mic = null; }
    this.renderMic();
    this.ui.renderAudio();
    this.ui.renderChecks();
  }

  renderMic() {
    const mic = this.mic;
    const text = $('#micDefaultText');
    const create = $('#btnMicCreate');
    const revert = $('#btnMicRevert');
    const v = mic && mic.virtual;
    const name = this.micLabel() || 'CABLE Output';
    $('#discordMicName').textContent = name;
    $('#prevMicRow').hidden = !this.ui.store.get('audio.previousMicId');
    if (!mic || !mic.ok) {
      text.textContent = 'Lecture des micros Windows impossible.';
      create.disabled = true;
      revert.hidden = true;
      return;
    }
    $('#micNameRow').hidden = !v.capture; // without a cable, the orange card above already offers the installation
    if (!v.capture) {
      text.textContent = 'Aucun micro virtuel sur ce PC. EvCam installe pour vous le pilote audio gratuit VB-CABLE (≈ 1,3 Mo, téléchargé depuis vb-audio.com, signature vérifiée) : Windows demandera l’autorisation administrateur.';
      create.textContent = 'Installer le micro virtuel';
      create.disabled = this.installing;
      create.hidden = false;
      revert.hidden = true;
      return;
    }
    create.textContent = 'Créer le micro « EvCam Micro »';
    create.disabled = false;
    create.hidden = v.renamed;
    revert.hidden = !v.renamed;
    text.textContent = v.renamed
      ? `Vos applications voient ce micro sous le nom « ${v.capture.name} ». Choisissez-le dans Discord, Zoom, OBS… Votre micro habituel n’est pas touché.`
      : `Vos applications le voient actuellement sous le nom « ${v.capture.name} ». Un clic le renomme « EvCam Micro » (votre micro habituel n’est pas touché). Si un autre logiciel (Voicemeeter, OBS…) utilise ce câble par son nom, vous pouvez rétablir le nom d’origine à tout moment.`;
  }

  onInstallStep(s) {
    const status = $('#micInstallStatus');
    status.hidden = false;
    status.textContent = s.text;
  }

  /** Downloads, checks and installs the free virtual-cable driver (administrator approval), then names it "EvCam Micro". */
  async installMic() {
    if (this.installing) return;
    this.installing = true;
    const buttons = [$('#btnMicInstall'), $('#btnMicCreate')];
    buttons.forEach((b) => { b.disabled = true; });
    this.onInstallStep({ text: 'Préparation…' });
    let res;
    try { res = await ipcRenderer.invoke('mic:install'); } catch (err) { res = { ok: false, error: err.message }; }
    this.installing = false;
    buttons.forEach((b) => { b.disabled = false; });
    $('#micInstallStatus').hidden = true;
    this.mic = res.status || this.mic;
    if (res.ok) {
      this.ui.toast('Micro « EvCam Micro » prêt. Choisissez-le dans Discord, Zoom, OBS… (relancez-les si besoin).', 'ok', 'mic');
      await this.refreshDiscord();
    } else {
      this.ui.toast(res.cancelled ? 'Autorisation administrateur refusée : le micro virtuel n’a pas été installé.' : res.error || 'Installation impossible.', res.cancelled ? 'warn' : 'bad', 'alert');
    }
    await this.refreshMic();
    this.ui.refreshOutputs();
  }

  async createMic() {
    const btn = $('#btnMicCreate');
    btn.disabled = true;
    btn.textContent = 'Création…';
    const res = await ipcRenderer.invoke('mic:create');
    btn.textContent = 'Créer le micro « EvCam Micro »';
    this.mic = res.status || this.mic;
    if (res.ok) {
      this.ui.toast('Micro « EvCam Micro » créé. Relancez Discord / vos applications pour le voir.', 'ok', 'mic');
      await this.refreshDiscord();
    } else {
      this.ui.toast(res.cancelled ? 'Autorisation administrateur refusée.' : res.error || 'Création impossible.', res.cancelled ? 'warn' : 'bad', 'alert');
    }
    this.renderMic();
    this.ui.refreshOutputs();
  }

  async revertMic() {
    const btn = $('#btnMicRevert');
    btn.disabled = true;
    const res = await ipcRenderer.invoke('mic:revert');
    btn.disabled = false;
    this.mic = res.status || this.mic;
    this.ui.toast(res.ok ? 'Nom d’origine rétabli.' : res.cancelled ? 'Autorisation administrateur refusée.' : res.error || 'Rétablissement impossible.', res.ok ? 'ok' : 'warn', res.ok ? 'mic' : 'alert');
    this.renderMic();
    this.ui.refreshOutputs();
  }

  async restoreMic() {
    $('#btnMicRestore').disabled = true;
    const res = await ipcRenderer.invoke('mic:restore');
    if (typeof res.previousMicId === 'string') this.ui.store.set('audio.previousMicId', res.previousMicId, { save: false });
    $('#btnMicRestore').disabled = false;
    this.ui.toast(res.ok ? 'Votre micro précédent est rétabli.' : res.error || 'Restauration impossible.', res.ok ? 'ok' : 'warn', res.ok ? 'mic' : 'alert');
    await this.refreshMic();
  }

  // ------------------------------------------------------------------ fluidity
  /**
   * Compares what was asked (frames per second) with what really arrives, says which stage limits (the phone's camera,
   * its encoder, the Wi-Fi, this PC) and proposes the frame smoothing when the camera cannot deliver.
   */
  renderFluid() {
    const { engine, store, compositor } = this.ui;
    const live = engine.live && !engine.phone.standby;
    const eff = effectiveCamera(store.settings, engine.phone.encoderHw === false);
    const fl = engine.phone.fluid;
    const asked = eff.asked;                               // the rate the user chose
    const target = fl && fl.target ? fl.target : eff.fps;  // the rate asked from the phone (the phone also knows about heat)
    const rate = compositor.srcRate;                       // what really arrives
    const mode = store.get('camera.smooth');
    const now = performance.now();
    const heat = live && (engine.phone.thermal || 0) > 0;

    const low = live && rate > 0 && rate < target * 0.85;
    if (!low) this.fluidLowSince = 0;
    else if (!this.fluidLowSince) this.fluidLowSince = now;
    const limited = low && now - this.fluidLowSince > 5000; // not a hiccup

    // who limits? the phone measured its own camera and encoder; otherwise it is the Wi-Fi or this PC
    let limit = limited ? (fl && fl.limit && fl.limit !== 'none' ? fl.limit : '') : '';
    if (limited && !limit) limit = compositor.stats.outFps && compositor.stats.outFps < target * 0.85 ? 'pc' : 'network';
    // EvCam itself asks the phone for less than the chosen rate (software encoder, VP8, battery saver, heat)
    const capped = live && !limited && (eff.fps < asked || heat);
    const capWhy = heat ? 'thermal' : eff.capReason;
    const r = (v) => (v == null ? '—' : `${Math.round(v)} i/s`);

    $('#fluidStats').hidden = !live;
    if (live) {
      const cap = $('#fluidCapture');
      cap.textContent = fl && fl.capture != null ? r(fl.capture) : '—';
      cap.className = fl && fl.capture != null && fl.capture < target * 0.85 ? 'low' : '';
      const rec = $('#fluidRecv');
      rec.textContent = rate ? r(rate) : '—';
      rec.className = limited ? 'low' : rate ? 'ok' : '';
      $('#fluidOut').textContent = compositor.smoothActive ? `${r(compositor.stats.outFps || compositor.fps)} · lissé` : r(compositor.stats.outFps);
    }

    const name = { camera: 'la caméra', encoder: 'l’encodeur', network: 'le Wi-Fi', pc: 'ce PC', thermal: 'la chaleur' }[limit] || '';
    const badge = $('#fluidBadge');
    if (!live) { badge.textContent = '—'; badge.dataset.tone = 'muted'; }
    else if (!rate) { badge.textContent = 'Mesure…'; badge.dataset.tone = 'muted'; }
    else if (limited || capped) { badge.textContent = `${Math.round(rate)} sur ${asked} i/s`; badge.dataset.tone = 'warn'; }
    else { badge.textContent = `${Math.round(rate)} i/s`; badge.dataset.tone = 'ok'; }

    const cause = {
      camera: fl && fl.unfixable
        ? `La caméra du téléphone ne fournit que ${r(fl && fl.capture)}, même en lui imposant la cadence et en baissant la résolution (souvent : pièce sombre, la caméra pose plus longtemps).`
        : `La caméra du téléphone ne fournit que ${r(fl && fl.capture)} (souvent : pièce sombre, ou capteur limité à cette résolution).`,
      encoder: 'Le processeur du téléphone n’arrive pas à encoder assez vite : baissez la qualité ou utilisez H.264 matériel.',
      network: 'Le Wi-Fi ne suit pas (débit ou pertes) : rapprochez le téléphone de la box.',
      pc: 'Ce PC n’arrive pas à produire autant d’images : baissez la qualité.',
      thermal: 'Le téléphone chauffe : EvCam a baissé la fluidité pour le protéger.'
    }[limit] || '';
    const capText = {
      soft: `L’encodeur vidéo de ce téléphone est logiciel : à ${asked} i/s il chaufferait beaucoup.`,
      vp8: 'L’encodage VP8 est logiciel : à haute cadence il ferait beaucoup chauffer le téléphone.',
      eco: `Le mode économie limite à ${eff.fps} i/s.`,
      thermal: 'Le téléphone chauffe : EvCam a baissé la fluidité pour le protéger.'
    }[capWhy] || '';

    let sub = 'Le flux suit la cadence demandée';
    if (!live) sub = 'Connectez le téléphone pour la mesurer';
    else if (!rate) sub = 'Mesure en cours…';
    else if (compositor.smoothActive) sub = `Lissage actif : ${Math.round(rate)} → ${compositor.fps} i/s`;
    else if (limited) sub = `Limité par ${name}`;
    else if (capped) sub = `Plafonné à ${eff.fps} i/s par EvCam`;
    else if (fl && fl.fixed === 'format') sub = `${target} i/s obtenus en exigeant la cadence de la caméra`;
    else if (fl && fl.fixed === 'size') sub = `${target} i/s obtenus en baissant la résolution de la caméra`;
    if (fl && fl.fixing) sub = 'Recherche d’un réglage qui tient la cadence…';
    $('#fluidSub').textContent = sub;

    // proposal: smoothing (computed here, the phone stays cool) and, when EvCam is the one capping, forcing the rate
    const callout = $('#fluidCallout');
    const canForce = capped && !heat && (capWhy === 'soft' || capWhy === 'vp8') && !store.get('camera.force');
    const propose = (limited && limit !== 'thermal' && mode === 'ask') || (capped && mode === 'ask' && !compositor.smoothActive);
    callout.hidden = !propose;
    $('#btnForceOn').hidden = !canForce;
    if (propose) {
      const goal = limited ? target : asked;
      $('#fluidCalloutTitle').textContent = limited ? `Limité à ${Math.round(rate)} i/s au lieu de ${target}` : `Limité à ${eff.fps} i/s au lieu de ${asked}`;
      $('#fluidCalloutText').textContent = `${limited ? cause : capText} Le lissage calcule les images manquantes sur ce PC (sortie ${Math.max(goal, asked)} i/s).${canForce ? ` « Forcer » exige ${asked} i/s du téléphone : il chauffera plus, sa protection anti-chauffe reste active.` : ''}`;
    }

    const info = $('#fluidSmoothInfo');
    info.hidden = true;
    if (compositor.smoothError) { info.hidden = false; info.textContent = `Lissage indisponible sur ce PC : ${compositor.smoothError}`; }
    else if (mode === 'auto' && live) {
      info.hidden = false;
      info.textContent = compositor.smoothActive ? `Lissage actif : ${Math.round(rate)} → ${compositor.fps} i/s.` : 'Lissage prêt : il se mettra en route si le téléphone envoie moins d’images que la sortie demandée.';
    } else if ((limited || capped) && mode === 'off') {
      info.hidden = false;
      info.textContent = limited ? `Le téléphone envoie ${Math.round(rate)} i/s au lieu de ${target} (${name}).` : capText;
    }

    // chip on the preview: visible while a proposal is pending
    $('#chipFluid').classList.toggle('on', propose);
    $('#chipFluidText').textContent = limited ? `Caméra limitée à ${Math.round(rate)} i/s · lisser ?` : `Plafonné à ${eff.fps} i/s · lisser à ${asked} ?`;
    $('#fluidTarget').textContent = `${asked} i/s demandés`;
  }

  // ------------------------------------------------------------------ main entry
  render() {
    this.renderFluid();
    this.renderLens();
    this.renderPower();
    this.batteryAlerts();
    const { engine, store } = this.ui;
    const zoom = store.get('camera.zoom');
    $('#dezoomVal').textContent = `${(zoom / 100).toFixed(zoom % 100 === 0 ? 0 : zoom < 100 ? 2 : 1).replace('.', ',')}×`;
    const standby = engine.live && !!engine.phone.standby;
    $('#chipStandby').classList.toggle('on', standby);
    const heat = engine.live ? engine.phone.thermal || 0 : 0;
    $('#chipHot').classList.toggle('on', heat > 0);
    if (heat > 0) {
      const temp = engine.phone.tempC != null ? ` (${engine.phone.tempC} °C)` : '';
      $('#chipHotText').textContent = heat > 1 ? `Téléphone très chaud${temp} · qualité réduite à 480p` : `Téléphone chaud${temp} · qualité réduite à 720p`;
    }
    $('#chipStandbyText').textContent = engine.phone.standbyReason === 'sleep' ? 'Écran du téléphone éteint · micro seul' : 'Caméra désactivée · micro seul';
    $('#previewCard').dataset.standby = String(standby);
  }
}

module.exports = { Extras };
