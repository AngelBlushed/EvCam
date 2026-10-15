/* EvCam for Android: pairing screen (runs inside the app's WebView). */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const app = $('#app');

  // In a plain browser (design preview / tests) there is no native bridge: use a stand-in.
  const params = new URLSearchParams(location.search);
  const N = window.EvCamNative || {
    version: () => 'preview',
    hasPermissions: () => !params.has('noperm'),
    requestPermissions: () => {},
    openSettings: () => {},
    getSaved: () => (params.has('saved') ? JSON.stringify({ host: '192.168.1.161', port: 4733, pinned: true }) : ''),
    connect: (url) => { console.log('connect', url); return ''; },
    connectSaved: () => console.log('connectSaved'),
    home: (s) => { location.hash = s === 'pair' || !s ? '#pair' : `#err=${s}`; },
    forget: () => {},
    setStreaming: () => {},
    exit: () => {}
  };

  const MESSAGES = {
    unreachable: 'Impossible de joindre votre PC. Vérifiez qu’EvCam est ouvert sur le PC et que le téléphone est sur le même Wi-Fi.',
    cert: 'L’identité de ce PC a changé (ou ce n’est pas le bon PC). Scannez à nouveau le QR code affiché dans EvCam.',
    token: 'Le code d’appairage n’est plus valide. Scannez à nouveau le QR code affiché dans EvCam.',
    badqr: 'Ce QR code n’est pas un QR code EvCam. Utilisez celui affiché dans l’application EvCam du PC.',
    denied: 'Action refusée.'
  };

  const view = (name) => { app.dataset.view = name; };
  const parseSaved = () => { try { return JSON.parse(N.getSaved() || 'null'); } catch { return null; } };

  // ---------------------------------------------------------------------------
  // routing
  // ---------------------------------------------------------------------------
  let connectTimer = 0;

  function route() {
    stopScan();
    clearTimeout(connectTimer);
    const hash = location.hash.slice(1);
    const err = /(?:^|&)err=([^&]*)/.exec(hash);
    const forcePair = hash === 'pair';
    const saved = parseSaved();
    $('#version').textContent = `EvCam pour Android · v${N.version()}`;

    if (!N.hasPermissions()) { view('perm'); return; }

    if (saved && !err && !forcePair) {
      $('#connectingText').textContent = `${saved.host}:${saved.port}`;
      view('connecting');
      connectTimer = setTimeout(() => N.connectSaved(), 600);
      return;
    }

    // home screen
    const notice = $('#notice');
    notice.hidden = !err;
    if (err) notice.textContent = MESSAGES[err[1]] || 'Connexion impossible.';
    const savedBtn = $('#btnSaved');
    // after a code / identity error the saved PC would fail again: pairing must be redone
    savedBtn.hidden = !saved || !!(err && (err[1] === 'token' || err[1] === 'cert'));
    if (saved) $('#savedName').textContent = `${saved.host}:${saved.port}`;
    view('home');
  }

  window.addEventListener('hashchange', route);
  window.evcamPermissions = () => route();

  // Called by the native back button; returns true when the page handled it.
  window.evcamBack = () => {
    const v = app.dataset.view;
    if (v === 'scan' || v === 'manual') { view('home'); stopScan(); return true; }
    if (v === 'connecting') { cancelConnect(); return true; }
    return false;
  };

  function cancelConnect() {
    clearTimeout(connectTimer);
    N.home('pair');
    if (location.hash !== '#pair') location.hash = '#pair';
    route();
  }

  // ---------------------------------------------------------------------------
  // QR scanner (jsQR on camera frames)
  // ---------------------------------------------------------------------------
  let scanStream = null;
  let scanning = false;

  function scanMessage(text) {
    const box = $('#scanMsg');
    box.hidden = !text;
    box.textContent = text || '';
  }

  function stopScan() {
    scanning = false;
    if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
    const video = $('#video');
    if (video) video.srcObject = null;
  }

  async function startScan() {
    scanMessage('');
    view('scan');
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) {
      view('perm');
      return;
    }
    const video = $('#video');
    video.srcObject = scanStream;
    try { await video.play(); } catch { /* autoplay */ }
    scanning = true;

    const canvas = $('#canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let last = 0;
    const tick = (now) => {
      if (!scanning) return;
      if (now - last > 120 && video.videoWidth) {
        last = now;
        const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code && code.data) {
          if (/^https:\/\/[^/]+\/\?.*\bt=/.test(code.data)) {
            scanning = false;
            const error = N.connect(code.data);
            if (error) { scanMessage(MESSAGES[error] || 'QR code refusé.'); scanning = true; }
            else { stopScan(); view('connecting'); $('#connectingText').textContent = 'Appairage…'; }
            return;
          }
          scanMessage(MESSAGES.badqr);
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------------------
  // manual entry
  // ---------------------------------------------------------------------------
  function manualConnect() {
    const err = $('#manualErr');
    err.hidden = true;
    let addr = $('#inAddr').value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    const code = $('#inCode').value.trim();
    if (!addr || !code) { err.textContent = 'Renseignez l’adresse du PC et le code d’appairage.'; err.hidden = false; return; }
    if (!addr.includes(':')) addr += ':4733';
    const error = N.connect(`https://${addr}/?t=${encodeURIComponent(code)}`);
    if (error) { err.textContent = MESSAGES[error] || 'Adresse invalide.'; err.hidden = false; return; }
    view('connecting');
    $('#connectingText').textContent = addr;
  }

  // ---------------------------------------------------------------------------
  // wiring
  // ---------------------------------------------------------------------------
  $('#btnScan').addEventListener('click', startScan);
  $('#btnScanBack').addEventListener('click', () => { stopScan(); route(); });
  $('#btnManual').addEventListener('click', () => { view('manual'); });
  $('#btnManualBack').addEventListener('click', () => view('home'));
  $('#btnManualGo').addEventListener('click', manualConnect);
  $('#btnSaved').addEventListener('click', () => { view('connecting'); $('#connectingText').textContent = $('#savedName').textContent; N.connectSaved(); });
  $('#btnCancel').addEventListener('click', cancelConnect);
  $('#btnPerm').addEventListener('click', () => { N.requestPermissions(); });
  $('#btnPermSettings').addEventListener('click', () => N.openSettings());

  const requestedView = params.get('view');
  route();
  if (requestedView && ['home', 'connecting', 'scan', 'manual', 'perm'].includes(requestedView)) view(requestedView);
})();
