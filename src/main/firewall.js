'use strict';

const { execFile } = require('child_process');

const RULE_NAME = 'EvCam';

function powershell(script, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout },
      (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() })
    );
  });
}

/** True when an enabled inbound "allow" rule exists for this executable. */
async function isAllowed(exePath) {
  const safe = exePath.replace(/'/g, "''");
  const script =
    `$p='${safe}'; $n=0; ` +
    `Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True -ErrorAction SilentlyContinue | ` +
    `Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.Program -ieq $p } | ForEach-Object { $n++ }; Write-Output $n`;
  const res = await powershell(script, 30000);
  return res.ok && parseInt(res.stdout, 10) > 0;
}

/**
 * Adds an inbound allow rule for this executable. Needs administrator rights, so the
 * rule is created by an elevated PowerShell (the user sees the standard UAC prompt).
 */
async function allow(exePath) {
  const inner =
    `netsh advfirewall firewall delete rule name='${RULE_NAME}' | Out-Null; ` +
    `netsh advfirewall firewall add rule name='${RULE_NAME}' dir=in action=allow program='${exePath.replace(/'/g, "''")}' enable=yes profile=any | Out-Null`;
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const script =
    `try { Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden ` +
    `-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; Write-Output 'done' } catch { Write-Output 'cancelled' }`;
  const res = await powershell(script, 120000);
  if (!res.stdout.includes('done')) return { ok: false, cancelled: true };
  return { ok: await isAllowed(exePath) };
}

module.exports = { isAllowed, allow };
