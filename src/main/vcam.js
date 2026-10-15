'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

/** CLSID of the EvCam DirectShow source filter (see native/vcam/src/softcam/softcam.cpp). */
const CLSID = '{EB8037B2-DA3F-40C5-8131-86910834479F}';

/** x64 is mandatory; x86 (32-bit applications) is registered too when its files are shipped. */
const ARCHS = ['x64', 'x86'];

function archDir(arch) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'vcam', arch)
    : path.join(app.getAppPath(), 'resources', 'vcam', arch);
}

const dllPath = (arch = 'x64') => path.join(archDir(arch), 'evcam_vcam.dll');
const setupPath = (arch = 'x64') => path.join(archDir(arch), 'evcam-vcam-setup.exe');
const hasArch = (arch) => fs.existsSync(dllPath(arch)) && fs.existsSync(setupPath(arch));

function run(file, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** Where the virtual camera is registered for this architecture (merged HKCU + HKLM view), if anywhere. */
async function registeredPath(arch) {
  const key = arch === 'x86'
    ? `HKCR\\WOW6432Node\\CLSID\\${CLSID}\\InprocServer32`
    : `HKCR\\CLSID\\${CLSID}\\InprocServer32`;
  const { code, stdout } = await run('reg', ['query', key, '/ve']);
  if (code !== 0) return '';
  const m = /REG_SZ\s+(.+?)\s*$/m.exec(stdout);
  return m ? m[1].trim() : '';
}

async function status() {
  const archs = {};
  for (const arch of ARCHS) {
    if (arch === 'x86' && !hasArch('x86')) continue; // optional
    const expected = dllPath(arch);
    const dllExists = fs.existsSync(expected);
    const current = await registeredPath(arch);
    archs[arch] = { dll: expected, dllExists, registeredPath: current, ok: dllExists && current.toLowerCase() === expected.toLowerCase() };
  }
  const x64 = archs.x64;
  return {
    dllExists: x64.dllExists,
    dllPath: dllPath('x64'),
    registeredPath: x64.registeredPath,
    registered: !!x64.registeredPath,
    ok: x64.ok, // what the UI warns about: 64-bit applications
    allOk: Object.values(archs).every((a) => a.ok), // what the automatic repair checks (adds 32-bit applications)
    archs
  };
}

/** Registers the camera for the current user (no administrator rights needed), for every shipped architecture. */
async function register() {
  const errors = [];
  let done = 0;
  for (const arch of ARCHS) {
    if (!hasArch(arch)) {
      if (arch === 'x64') errors.push('Fichiers de la caméra virtuelle introuvables.');
      continue;
    }
    const res = await run(setupPath(arch), ['--register', dllPath(arch)]);
    if (res.code !== 0) errors.push(`${arch} : ${(res.stderr || res.stdout || `code ${res.code}`).trim()}`);
    else done++;
  }
  return errors.length ? { ok: false, error: errors.join(' · '), done } : { ok: true, done };
}

async function unregister() {
  for (const arch of ARCHS) if (hasArch(arch)) await run(setupPath(arch), ['--unregister', dllPath(arch)]);
  return { ok: true };
}

/** Registers the camera if it is missing or points to another location (moved/updated app). */
async function ensureRegistered() {
  let st = await status();
  if (!st.dllExists) return { ...st, repaired: false };
  if (!st.allOk) {
    const res = await register();
    st = await status();
    broadcastDeviceChange();
    return { ...st, repaired: res.ok, error: res.error };
  }
  return { ...st, repaired: false };
}

/**
 * Tells every top-level window that the device list changed (WM_DEVICECHANGE / DBT_DEVNODES_CHANGED):
 * Chromium-based applications (Chrome, Edge, Teams, Zoom...) then refresh their camera list.
 */
function broadcastDeviceChange() {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const SendMessageTimeoutW = user32.func(
      'intptr_t __stdcall SendMessageTimeoutW(intptr_t hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam, uint32_t fuFlags, uint32_t uTimeout, _Out_ uintptr_t *lpdwResult)'
    );
    const HWND_BROADCAST = 0xffff;
    const WM_DEVICECHANGE = 0x0219;
    const DBT_DEVNODES_CHANGED = 0x0007;
    const SMTO_ABORTIFHUNG = 0x0002;
    SendMessageTimeoutW.async(HWND_BROADCAST, WM_DEVICECHANGE, DBT_DEVNODES_CHANGED, 0, SMTO_ABORTIFHUNG, 1000, [0], () => {});
    return true;
  } catch (err) {
    console.error('[vcam] device-change broadcast failed:', err.message);
    return false;
  }
}

/** "Force detection": register again (all architectures) and ask running applications to refresh their device list. */
async function forceDetect() {
  const res = await register();
  const broadcast = broadcastDeviceChange();
  return { ...res, broadcast };
}

module.exports = { CLSID, dllPath, setupPath, status, register, unregister, ensureRegistered, forceDetect, broadcastDeviceChange, run };
