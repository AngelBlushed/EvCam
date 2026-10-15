'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const { Settings } = require('./settings');
const audioDefault = require('./audioDefault');
const micInstaller = require('./micInstaller');
const { createVirtualMic } = require('./virtualMic');

// Command-line modes used by the Windows installer (they never open the main window and never touch the
// single-instance lock, so they work even while EvCam is running):
//   EvCam.exe --mic-present   exit code 0 when a virtual microphone cable is already installed, 1 otherwise
//   EvCam.exe --setup-mic     installs the free VB-CABLE driver (consent was asked by the installer) and
//                             creates "EvCam Micro"; shows a small progress window

const iconPath = () => (app.isPackaged ? path.join(process.resourcesPath, 'icon.ico') : path.join(app.getAppPath(), 'build', 'icon.ico'));

const PAGE = `<!doctype html><html lang="fr"><meta charset="utf-8"><title>EvCam</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 26px 28px; background: #0a0b14; color: #e8eaff; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; display: flex; flex-direction: column; gap: 14px; height: 100vh; box-sizing: border-box; }
  h1 { margin: 0; font-size: 18px; font-weight: 650; }
  p { margin: 0; color: #aab0d6; }
  #msg { color: #e8eaff; min-height: 44px; }
  .bar { height: 6px; border-radius: 99px; background: #1a1c33; overflow: hidden; }
  .bar i { display: block; height: 100%; width: 0%; background: linear-gradient(90deg, #7c5cff, #35c8ff); transition: width .25s; }
  .bar.busy i { width: 40%; animation: slide 1.4s ease-in-out infinite; }
  @keyframes slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
  button { align-self: flex-end; margin-top: auto; background: #7c5cff; color: #fff; border: 0; border-radius: 10px; padding: 8px 20px; font: inherit; cursor: pointer; }
  button[hidden] { display: none; }
  .ok { color: #5dffb0 } .err { color: #ff8fa3 }
</style>
<h1>Micro virtuel EvCam</h1>
<p>Installation du pilote audio gratuit VB-CABLE (VB-Audio) pour créer le micro « EvCam Micro ».</p>
<div id="msg">Préparation…</div>
<div class="bar busy" id="bar"><i></i></div>
<button id="close" hidden onclick="window.close()">Fermer</button>
<script>
  function step(text, progress) {
    document.getElementById('msg').textContent = text;
    const bar = document.getElementById('bar');
    if (progress > 0) { bar.classList.remove('busy'); bar.firstElementChild.style.width = Math.round(progress * 100) + '%'; }
    else { bar.classList.add('busy'); bar.firstElementChild.style.width = ''; }
  }
  function done(text, ok) {
    const msg = document.getElementById('msg');
    msg.textContent = text; msg.className = ok ? 'ok' : 'err';
    const bar = document.getElementById('bar'); bar.classList.remove('busy'); bar.firstElementChild.style.width = ok ? '100%' : '0%';
    document.getElementById('close').hidden = false;
  }
</script></html>`;

async function hasCable() {
  const st = await audioDefault.status();
  return !!(st.ok && st.virtual.capture && st.virtual.render);
}

function run(mode) {
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    if (mode === 'present') {
      app.exit((await hasCable()) ? 0 : 1);
      return;
    }

    const settings = new Settings();
    const mic = createVirtualMic(settings);
    let exitCode = 2;
    const win = new BrowserWindow({
      width: 520, height: 280, resizable: false, minimizable: false, maximizable: false, autoHideMenuBar: true,
      title: 'EvCam — Micro virtuel', icon: iconPath(), backgroundColor: '#0a0b14', show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    win.setMenuBarVisibility(false);
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => { settings.flush(); app.exit(exitCode); });
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
    win.show();

    const js = (code) => { if (!win.isDestroyed()) win.webContents.executeJavaScript(code).catch(() => {}); };
    const test = !!process.env.EVCAM_TEST_PROFILE;
    const res = await micInstaller.ensureMic({
      audio: audioDefault,
      known: mic.known,
      createMic: mic.create,
      zipPath: test && process.env.EVCAM_MIC_ZIP ? process.env.EVCAM_MIC_ZIP : undefined,
      dryRun: test && process.env.EVCAM_MIC_DRYRUN === '1',
      assumeAbsent: test && process.env.EVCAM_MIC_ASSUME_ABSENT === '1',
      onStep: (step, progress) => js(`step(${JSON.stringify(micInstaller.stepText(step, progress))}, ${Number(progress) || 0})`)
    });

    exitCode = res.ok ? 0 : 2;
    const text = res.ok
      ? (res.dryRun ? 'Test : pilote téléchargé et signature vérifiée.' : 'Le micro « EvCam Micro » est prêt. Choisissez-le dans Discord, Zoom, OBS…')
      : (res.error || 'Installation impossible.') + ' Vous pourrez réessayer depuis EvCam, onglet Micro.';
    js(`done(${JSON.stringify(text)}, ${!!res.ok})`);
    console.log('[evcam] setup-mic:', JSON.stringify({ ok: res.ok, installed: res.installed, error: res.error }));
    // success closes by itself; a failure stays on screen until read
    if (res.ok) setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 3500);
  });
}

module.exports = { run };
