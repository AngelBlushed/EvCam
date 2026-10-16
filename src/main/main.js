'use strict';

const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, session, powerSaveBlocker
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Installer helpers (`--mic-present`, `--setup-mic`): no window, no single-instance lock, nothing else starts.
const micCliMode = process.argv.includes('--setup-mic') ? 'setup' : process.argv.includes('--mic-present') ? 'present' : '';
if (micCliMode) {
  require('./micCli').run(micCliMode);
  return;
}

// Chromium switches: must be set before the app is ready.
// - real LAN addresses in WebRTC candidates (phones often cannot resolve mDNS names)
// - keep the (possibly hidden) window fully alive so the virtual camera never stalls
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const { Settings } = require('./settings');
const { listAddresses, pickAddress } = require('./network');
const { ensureCertificate } = require('./cert');
const { PairingServer } = require('./server');
const vcam = require('./vcam');
const firewall = require('./firewall');
const discord = require('./discord');
const audioDefault = require('./audioDefault');
const micInstaller = require('./micInstaller');
const { createVirtualMic } = require('./virtualMic');

const APP_ID = 'com.evcam.app';
const startHidden = process.argv.includes('--hidden');
const EXTERNAL_HOSTS = new Set(['vb-audio.com', 'www.vb-audio.com', 'github.com']);

app.setAppUserModelId(APP_ID);
require('./log').install();

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let settings;
let win = null;
let tray = null;
let server = null;
let quitting = false;
let rendererReady = false;
let addresses = [];
let firewallOk = null; // null = unknown
let liveState = { live: false, device: '', camInUse: false };
let powerBlockId = null;
let certFingerprint = ''; // SHA-256 of the HTTPS certificate (hex), pinned by the Android app

const pending = new Map();
let seq = 0;

const iconPath = () => (app.isPackaged ? path.join(process.resourcesPath, 'icon.ico') : path.join(app.getAppPath(), 'build', 'icon.ico'));
const phoneDir = () => path.join(__dirname, '..', 'phone');
const apkPath = () => (app.isPackaged ? path.join(process.resourcesPath, 'android', 'EvCam.apk') : path.join(app.getAppPath(), 'android', 'build', 'EvCam.apk'));

// ---------------------------------------------------------------------------
// Renderer RPC (signaling answers come from the renderer, which owns WebRTC)
// ---------------------------------------------------------------------------

function askRenderer(channel, payload, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!rendererReady || !win || win.isDestroyed()) {
      return reject(Object.assign(new Error('EvCam démarre, réessayez dans un instant.'), { status: 503 }));
    }
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error('EvCam ne répond pas.'), { status: 504 }));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    win.webContents.send(channel, { id, ...payload });
  });
}

ipcMain.on('signal:answer', (_e, { id, answer, error }) => {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  if (error) entry.reject(Object.assign(new Error(error), { status: 500 }));
  else entry.resolve(answer);
});

// ---------------------------------------------------------------------------
// Server + network
// ---------------------------------------------------------------------------

function connectionInfo() {
  const s = settings.get();
  const selected = pickAddress(addresses, s.preferredIp);
  const host = selected ? selected.address : 'localhost';
  const port = server ? server.port : s.port;
  return {
    addresses,
    selectedIp: selected ? selected.address : '',
    port,
    token: s.token,
    // the "f" parameter lets the Android app verify it is talking to this very PC
    url: `https://${host}:${port}/?t=${s.token}&f=${certFingerprint.slice(0, 24)}`,
    apkUrl: `https://${host}:${port}/evcam.apk`,
    apkAvailable: fs.existsSync(apkPath())
  };
}

async function startServer() {
  addresses = listAddresses();
  const tls = await ensureCertificate(path.join(app.getPath('userData'), 'cert'), addresses.map((a) => a.address));
  try { certFingerprint = new crypto.X509Certificate(tls.cert).fingerprint256.replace(/:/g, '').toLowerCase(); } catch { certFingerprint = ''; }
  server = server || new PairingServer({
    phoneDir: phoneDir(),
    version: app.getVersion(),
    getToken: () => settings.get().token,
    getApkPath: apkPath,
    getPrefs: () => ({ codec: settings.get().power.codec, eco: settings.get().power.eco, camera: settings.get().camera.enabled }),
    handlers: {
      offer: (payload) => askRenderer('signal:offer', payload),
      bye: () => askRenderer('signal:bye', {}).catch(() => ({}))
    }
  });
  const port = await server.start(settings.get().port, tls);
  console.log(`[evcam] server listening on :${port}`);
}

function watchNetwork() {
  setInterval(() => {
    const next = listAddresses();
    if (JSON.stringify(next) !== JSON.stringify(addresses)) {
      addresses = next;
      send('net:changed', connectionInfo());
    }
  }, 4000).unref();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// Auto start with Windows
// ---------------------------------------------------------------------------

const LOGIN_ITEM = () => ({ path: process.execPath, args: ['--hidden'] });

function applyAutoStart(enabled) {
  if (!app.isPackaged) return; // in development process.execPath is electron.exe, not EvCam
  app.setLoginItemSettings({ openAtLogin: !!enabled, ...LOGIN_ITEM() });
}

// ---------------------------------------------------------------------------
// Window + tray
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    backgroundColor: '#07080f',
    title: 'EvCam',
    icon: iconPath(),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0a0b14', symbolColor: '#c9cdf0', height: 44 },
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    if (!startHidden || !settings.get().startMinimized) win.show();
  });

  // The cross: ask (default), always minimise to the tray, or always quit — never a silent half-close
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    const action = settings.get().closeAction;
    if (action === 'quit') quitApp();
    else if (action === 'tray') win.hide();
    else askClose();
  });
  win.on('session-end', () => { quitting = true; });
  const announceVisibility = () => send('app:visible', !!win && win.isVisible() && !win.isMinimized());
  for (const evt of ['show', 'hide', 'minimize', 'restore']) win.on(evt, announceVisibility);
  win.on('closed', () => { win = null; rendererReady = false; });

  // The UI only ever loads local files: refuse every navigation / popup.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function quitApp() {
  quitting = true;
  // leave the current event first (the cross is handled inside the window's "close" event: quitting from
  // inside it would ask a window that is already closing to close again, and EvCam would linger in memory)
  setImmediate(() => app.quit());
}

let closeDialogOpen = false;
let closeResolver = null;

/** "Minimise to the system tray, or quit completely?" — a panel inside the EvCam window, shown when the cross is clicked. */
async function askClose() {
  if (closeDialogOpen || !win || win.isDestroyed()) return;
  closeDialogOpen = true;
  try {
    let choice;
    const forced = process.env.EVCAM_TEST_PROFILE && process.env.EVCAM_TEST_CLOSE_CHOICE; // tests: 'tray' | 'quit' | 'cancel', without the panel
    if (forced) {
      choice = forced;
    } else if (!rendererReady || win.webContents.isCrashed()) {
      choice = 'quit'; // the panel cannot be shown: the cross simply closes
    } else {
      showWindow(); // the cross can come from the taskbar while the window is minimised or in the tray
      choice = await new Promise((resolve) => {
        closeResolver = resolve;
        send('app:ask-close', { live: liveState.live });
      });
    }
    if (choice === 'cancel') return;
    if (choice === 'quit') quitApp();
    else if (win && !win.isDestroyed()) win.hide();
  } finally {
    closeResolver = null;
    closeDialogOpen = false;
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function trayTooltip() {
  if (liveState.live) return `EvCam — ${liveState.device || 'Téléphone'} connecté`;
  return 'EvCam — en attente du téléphone';
}

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(trayTooltip());
  const menu = Menu.buildFromTemplate([
    { label: 'Ouvrir EvCam', click: showWindow },
    { type: 'separator' },
    { label: liveState.live ? `● ${liveState.device || 'Téléphone'} connecté` : '○ En attente du téléphone', enabled: false },
    { label: 'Déconnecter le téléphone', enabled: liveState.live, click: () => send('signal:bye', { id: 0 }) },
    {
      label: 'Caméra du téléphone (sinon micro seul)',
      type: 'checkbox',
      checked: !!settings.get().camera.enabled,
      click: (item) => updateSettings({ camera: { enabled: item.checked } })
    },
    { type: 'separator' },
    {
      label: 'Lancer au démarrage de Windows',
      type: 'checkbox',
      checked: !!settings.get().autoStart,
      enabled: app.isPackaged,
      click: (item) => updateSettings({ autoStart: item.checked })
    },
    { type: 'separator' },
    { label: 'Quitter EvCam', click: quitApp }
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const image = nativeImage.createFromPath(iconPath());
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.on('click', showWindow);
  refreshTray();
}

// ---------------------------------------------------------------------------
// Settings plumbing
// ---------------------------------------------------------------------------

async function updateSettings(patch) {
  const before = settings.get();
  const portChanged = patch.port !== undefined && patch.port !== before.port;
  const next = settings.patch(patch);
  if (patch.autoStart !== undefined) applyAutoStart(next.autoStart);
  if (portChanged) {
    try { await startServer(); } catch (err) { console.error('[evcam] restart server failed:', err.message); }
  }
  send('settings:changed', { settings: next, connection: connectionInfo() });
  refreshTray();
  return next;
}

async function buildState() {
  const s = settings.get();
  return {
    version: app.getVersion(),
    packaged: app.isPackaged,
    settings: s,
    connection: connectionInfo(),
    autoStartActual: app.isPackaged ? app.getLoginItemSettings(LOGIN_ITEM()).openAtLogin : false,
    vcam: { ...(await vcam.status()), setupPath: vcam.setupPath() },
    firewallOk,
    exePath: process.execPath,
    userDataPath: app.getPath('userData'),
    testProfile: !!process.env.EVCAM_TEST_PROFILE
  };
}

function registerIpc() {
  ipcMain.handle('state:get', buildState);
  ipcMain.handle('settings:patch', (_e, patch) => updateSettings(patch));
  ipcMain.handle('token:regenerate', () => {
    settings.regenerateToken();
    return connectionInfo();
  });
  ipcMain.handle('vcam:status', () => vcam.status());
  // "Force detection": register the camera again (64 + 32 bit) and make applications refresh their device list
  ipcMain.handle('vcam:force', async () => {
    const res = await vcam.forceDetect();
    return { ...res, status: await vcam.status() };
  });
  ipcMain.handle('discord:status', () => discord.status());
  ipcMain.handle('discord:restart', () => discord.restart());
  const mic = createVirtualMic(settings);
  ipcMain.handle('mic:status', () => mic.status());
  // "Create the EvCam Micro": the virtual cable is renamed (reversible), the user's default microphone is untouched
  ipcMain.handle('mic:create', () => mic.create());
  ipcMain.handle('mic:revert', () => mic.revert());
  // No virtual cable yet: download + verify + install the free VB-CABLE driver (administrator approval), then name it "EvCam Micro"
  let micInstalling = false;
  ipcMain.handle('mic:install', async () => {
    if (micInstalling) return { ok: false, error: 'Installation déjà en cours.' };
    micInstalling = true;
    try {
      const res = await micInstaller.ensureMic({
        audio: audioDefault,
        known: mic.known,
        createMic: mic.create,
        onStep: (step, progress) => send('mic:install-step', { step, progress, text: micInstaller.stepText(step, progress) })
      });
      return { ...res, status: await mic.status() };
    } finally {
      micInstalling = false;
    }
  });
  ipcMain.handle('mic:restore', async () => {
    const previous = settings.get().audio.previousMicId;
    if (!previous) return { ok: false, error: 'Aucun micro précédent mémorisé.', previousMicId: '', status: await audioDefault.status() };
    const res = await audioDefault.setDefault(previous);
    if (res.ok) settings.patch({ audio: { previousMicId: '' } });
    return { ...res, previousMicId: settings.get().audio.previousMicId, status: await audioDefault.status() };
  });
  ipcMain.handle('vcam:repair', async () => {
    const res = await vcam.register();
    return { ...res, status: await vcam.status() };
  });
  ipcMain.handle('firewall:status', async () => {
    firewallOk = await firewall.isAllowed(process.execPath);
    return firewallOk;
  });
  ipcMain.handle('firewall:allow', async () => {
    const res = await firewall.allow(process.execPath);
    if (res.ok) firewallOk = true;
    return res;
  });
  ipcMain.handle('open:external', (_e, url) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' && EXTERNAL_HOSTS.has(u.hostname)) return shell.openExternal(u.toString()).then(() => true);
    } catch { /* invalid url */ }
    return false;
  });
  ipcMain.on('renderer:ready', () => {
    rendererReady = true;
    // tell the page right away whether it is on screen (an autostart in the tray never fires a show/hide event)
    send('app:visible', !!win && win.isVisible() && !win.isMinimized());
  });
  ipcMain.handle('apk:reveal', () => {
    if (!fs.existsSync(apkPath())) return false;
    shell.showItemInFolder(apkPath());
    return true;
  });
  ipcMain.on('status:report', (_e, report) => {
    const wasLive = liveState.live;
    liveState = { live: !!report.live, device: String(report.device || ''), camInUse: !!report.camInUse };
    if (liveState.live && powerBlockId === null) powerBlockId = powerSaveBlocker.start('prevent-app-suspension');
    if (!liveState.live && powerBlockId !== null) { powerSaveBlocker.stop(powerBlockId); powerBlockId = null; }
    if (wasLive !== liveState.live) refreshTray(); else tray && tray.setToolTip(trayTooltip());
  });
  ipcMain.on('app:quit', quitApp);
  ipcMain.on('close:choice', (_e, choice) => {
    if (closeResolver) closeResolver(choice === 'tray' || choice === 'quit' ? choice : 'cancel');
  });
  ipcMain.on('window:hide', () => win && win.hide());
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.on('second-instance', () => showWindow());
app.on('before-quit', () => { quitting = true; settings && settings.flush(); });
app.on('window-all-closed', () => { /* stay alive in the tray */ });
// kept in evcam.log to diagnose crashes on other people's PCs
app.on('child-process-gone', (_e, details) => console.error('[evcam] child process gone:', JSON.stringify(details)));
app.on('render-process-gone', (_e, _wc, details) => console.error('[evcam] renderer gone:', JSON.stringify(details)));

app.whenReady().then(async () => {
  settings = new Settings();
  registerIpc();

  // The UI never needs device permissions: deny everything by default.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  // Keep the OS login item in sync with the saved choice (e.g. after a reinstall).
  if (app.isPackaged) {
    const actual = app.getLoginItemSettings(LOGIN_ITEM()).openAtLogin;
    if (actual !== settings.get().autoStart) applyAutoStart(settings.get().autoStart);
  }

  try {
    await startServer();
  } catch (err) {
    console.error('[evcam] cannot start server:', err);
  }
  watchNetwork();

  createWindow();
  createTray();

  // developer test profile: leave the registration of an installed EvCam alone
  (process.env.EVCAM_TEST_PROFILE ? Promise.resolve(vcam.status()) : vcam.ensureRegistered()).then((st) => {
    console.log('[evcam] virtual camera:', JSON.stringify(st));
    send('vcam:changed', st);
  });
  firewall.isAllowed(process.execPath).then((ok) => {
    firewallOk = ok;
    send('firewall:changed', ok);
  });
});
