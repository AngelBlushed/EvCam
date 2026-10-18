'use strict';

const { ipcRenderer } = require('electron');

async function main() {
  // required here (not at the top) so that a failure is reported on screen by the catch below
  const { Store } = require('./js/store');
  const { Compositor, effectiveCamera } = require('./js/vcam');
  const { AudioBridge } = require('./js/audio');
  const { Engine } = require('./js/engine');
  const { UI, pickVirtualOutput } = require('./js/ui');

  const store = new Store();
  const info = await store.init();

  const compositor = new Compositor(document.getElementById('preview'), () => store.settings.camera);
  const audio = new AudioBridge();
  const engine = new Engine({ compositor, audio, getSettings: () => store.settings });
  const ui = new UI({ store, engine, compositor, audio });
  ui.init();

  const applyCamera = () => {
    const eff = effectiveCamera(store.settings, engine.phone.encoderHw === false); // battery saver / software encoder may lower resolution / frame rate
    compositor.configure({ w: eff.size.w, h: eff.size.h, fps: eff.fps });
  };
  const applyAudio = () => audio.configure({
    enabled: store.get('audio.enabled'),
    gain: store.get('audio.gain'),
    delayMs: store.get('audio.delayMs'),
    outputDeviceId: store.get('audio.outputDeviceId'),
    monitor: store.get('audio.monitor')
  });

  applyCamera();
  applyAudio();
  // test profile (EVCAM_TEST_PROFILE=1, developer only): never touch the real virtual camera of an installed EvCam
  compositor.start(info.testProfile ? '' : info.vcam.dllPath);
  ui.renderAll();

  // ---- settings reactions ------------------------------------------------------
  store.onChange((path) => {
    if (path === 'camera.quality' || path === 'camera.fps' || path === 'camera.wide' || path === 'power.eco') { applyCamera(); engine.pushConfig(); }
    else if (path === 'camera.enabled') engine.pushConfig(true);
    else if (path === 'power.codec') { applyCamera(); engine.pushConfig(); }
    else if (path === 'phone.facing' || path === 'phone.noiseSuppression') engine.pushConfig();
    else if (path.startsWith('audio.')) applyAudio();
  });
  engine.addEventListener('phone-facing', (e) => store.set('phone.facing', e.detail));
  // the phone told us its video encoder is software (it would overheat at 1080p / 60): lower the quality asked from it
  engine.addEventListener('phone-encoder', () => { applyCamera(); engine.pushConfig(); });
  engine.addEventListener('codec-fallback', () => {
    store.set('power.codec', 'vp8');
    ui.toast('L’encodage matériel H.264 ne fonctionne pas sur ce téléphone : passage en VP8.', 'warn', 'alert');
  });

  // the camera was switched on/off from the phone itself
  engine.addEventListener('phone-camera', (e) => store.set('camera.enabled', e.detail));
  // microphone-only: the virtual camera shows a "camera off" picture
  engine.addEventListener('change', () => compositor.setCameraOff(engine.live && !!engine.phone.standby, engine.phone.standbyReason));
  engine.addEventListener('ended', () => compositor.setCameraOff(false));

  // ---- signaling from the main process (phone -> HTTPS server -> here) ----------
  ipcRenderer.on('signal:offer', async (_e, { id, sdp, device }) => {
    try {
      if (compositor.testMode) compositor.setTestMode(false);
      const answer = await engine.handleOffer({ sdp, device });
      ipcRenderer.send('signal:answer', { id, answer });
    } catch (err) {
      console.error('[engine] offer failed', err);
      engine.closeSession('error', false);
      ipcRenderer.send('signal:answer', { id, error: err.message || 'Échec de la connexion' });
    }
  });
  ipcRenderer.on('signal:bye', (_e, { id }) => {
    if (id) {
      engine.closeSession('phone-left', false);
      ipcRenderer.send('signal:answer', { id, answer: { ok: true } });
    } else {
      engine.disconnect(); // asked from the tray menu
    }
  });

  ipcRenderer.on('net:changed', (_e, connection) => { store.info.connection = connection; ui.renderConnection(); ui.renderChecks(); ui.renderSettingsPane(); });
  ipcRenderer.on('vcam:changed', (_e, status) => {
    ui.setVcamStatus(status);
    if (status.ok && !compositor.cameraReady) compositor.reload(status.dllPath);
  });
  ipcRenderer.on('firewall:changed', (_e, ok) => ui.setFirewall(ok));
  ipcRenderer.on('app:visible', (_e, visible) => ui.setWindowVisible(visible));
  ipcRenderer.on('update:available', (_e, info) => ui.setUpdate(info));
  ui.setUpdate(store.info.update);

  // ---- tray / main-process status --------------------------------------------------
  const report = () => ipcRenderer.send('status:report', { live: engine.live, device: engine.device, camInUse: compositor.consumer });
  engine.addEventListener('change', () => {
    report();
    if (engine.live && compositor.testMode) compositor.setTestMode(false);
  });
  compositor.addEventListener('consumer', report);

  // ---- virtual microphone output --------------------------------------------------
  const autoPickOutput = async () => {
    const outputs = await ui.refreshOutputs();
    const chosen = store.get('audio.outputDeviceId');
    if (chosen && outputs.some((o) => o.deviceId === chosen)) return;

    const savedLabel = store.get('audio.outputLabel');
    const sameLabel = savedLabel && outputs.find((o) => o.label === savedLabel);
    if (sameLabel) { store.set('audio.outputDeviceId', sameLabel.deviceId); return; }

    if (store.get('audio.outputAuto')) {
      const hit = pickVirtualOutput(outputs);
      if (hit) {
        store.set('audio.outputLabel', hit.label);
        store.set('audio.outputDeviceId', hit.deviceId);
        ui.toast(`Micro virtuel détecté : ${hit.label.replace(/\s*\(.*\)/, '')}`, 'ok', 'mic');
      }
    }
  };
  await autoPickOutput();
  navigator.mediaDevices.addEventListener('devicechange', () => autoPickOutput());

  window.addEventListener('beforeunload', () => { store.flush(); compositor.vcam.close(); });
  ipcRenderer.send('renderer:ready');

  // handy for diagnostics from the devtools console
  window.evcam = { store, engine, compositor, audio, ui };
}

main().catch((err) => {
  console.error('[evcam] fatal', err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;inset:20px;z-index:99;padding:20px;border-radius:14px;background:#220a10;color:#ffb4c0;white-space:pre-wrap;user-select:text">EvCam n’a pas pu démarrer :\n${String(err && err.stack || err)}</pre>`);
});
