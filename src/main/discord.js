'use strict';

const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

/** Discord variants (Squirrel installs under %LOCALAPPDATA%\<Name>\app-x.y.z\<Name>.exe). */
const VARIANTS = ['Discord', 'DiscordPTB', 'DiscordCanary'];

function powershell(script, timeout = 15000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout || '').trim() }));
  });
}

/** Which Discord variants are running, and since when. */
async function status() {
  const script =
    `$r = Get-Process -Name ${VARIANTS.join(',')} -ErrorAction SilentlyContinue | ` +
    `Select-Object Name, Id, Path, @{n='Start';e={$_.StartTime.ToString('o')}}; ` +
    `if ($r) { @($r) | ConvertTo-Json -Compress } else { '[]' }`;
  const res = await powershell(script);
  let list = [];
  try { list = JSON.parse(res.stdout || '[]'); } catch { list = []; }
  const byName = new Map();
  for (const p of list) {
    const cur = byName.get(p.Name);
    if (!cur || p.Start < cur.startedAt) byName.set(p.Name, { name: p.Name, path: p.Path, startedAt: p.Start });
  }
  const running = [...byName.values()];
  return { running: running.length > 0, variants: running, startedAt: running.map((v) => v.startedAt).sort()[0] || null };
}

/** Closes and relaunches every running Discord so it re-reads the camera list (Discord only does it at startup). */
async function restart() {
  const st = await status();
  if (!st.running) return { ok: true, restarted: [] };
  const restarted = [];
  for (const v of st.variants) {
    const updater = v.path ? path.resolve(path.dirname(v.path), '..', 'Update.exe') : '';
    await new Promise((resolve) => execFile('taskkill', ['/F', '/T', '/IM', `${v.name}.exe`], { windowsHide: true }, () => resolve()));
    await new Promise((r) => setTimeout(r, 1800));
    if (updater && fs.existsSync(updater)) {
      spawn(updater, ['--processStart', `${v.name}.exe`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      restarted.push(v.name);
    }
  }
  return { ok: true, restarted };
}

module.exports = { status, restart };
