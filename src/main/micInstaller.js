'use strict';

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

// A virtual microphone needs a kernel audio driver signed by Microsoft; EvCam cannot ship one of its own.
// For users who do not have the free VB-CABLE driver yet, this module installs it WITH their consent:
//   1. downloads the official package from vb-audio.com (never bundled, never from another host),
//   2. extracts it and checks the Authenticode signatures (publisher = VB-Audio's author, drivers = Microsoft/author),
//   3. copies it into an administrator-only folder, checks the signatures AGAIN there and runs the vendor setup
//      in an elevated PowerShell (the user sees the standard Windows UAC prompt),
//   4. waits for the two audio endpoints, which the caller then renames "EvCam Micro".

const PAGE_URL = 'https://vb-audio.com/Cable/';
const FALLBACK_ZIP = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip';
const MAX_ZIP_BYTES = 12 * 1024 * 1024;
const PUBLISHER = /VINCENT BUREL|BUREL VINCENT|VB-?AUDIO/i;        // setup programs and the author's own signatures
const DRIVER_SIGNER = /VINCENT BUREL|BUREL VINCENT|VB-?AUDIO|Microsoft Windows Hardware Compatibility Publisher/i;

const hostAllowed = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'vb-audio.com' || u.hostname.endsWith('.vb-audio.com'));
  } catch { return false; }
};

/** GET with a few redirects, restricted to vb-audio.com, size-limited. Resolves with a Buffer (or writes to `file`). */
function get(url, { limit, onProgress, timeout = 30000, redirects = 4 } = {}) {
  return new Promise((resolve, reject) => {
    if (!hostAllowed(url)) return reject(new Error('Adresse de téléchargement non autorisée.'));
    const req = https.get(url, { headers: { 'User-Agent': 'EvCam' }, timeout }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Trop de redirections.'));
        const next = new URL(res.headers.location, url).toString();
        return get(next, { limit, onProgress, timeout, redirects: redirects - 1 }).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Téléchargement impossible (HTTP ${res.statusCode}).`)); }
      const total = Number(res.headers['content-length'] || 0);
      if (total > limit) { res.destroy(); return reject(new Error('Fichier trop volumineux.')); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > limit) { res.destroy(new Error('Fichier trop volumineux.')); return; }
        chunks.push(c);
        if (onProgress && total) onProgress(size / total);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Le serveur ne répond pas.')));
    req.on('error', reject);
  });
}

/** Official download link: read from the vendor page, fallback to the known one. */
async function findPackageUrl() {
  try {
    const html = (await get(PAGE_URL, { limit: 2 * 1024 * 1024 })).toString('utf8');
    const m = html.match(/href="([^"]*VBCABLE_Driver_Pack\d+\.zip)"/i);
    if (m) {
      const url = new URL(m[1], PAGE_URL).toString();
      if (hostAllowed(url)) return url;
    }
  } catch { /* use the fallback */ }
  return FALLBACK_ZIP;
}

function powershell(script, { timeout = 60000, elevate = false } = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    const args = elevate
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `try { $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'; 'EXIT=' + $p.ExitCode } catch { 'CANCELLED' }`]
      : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
    execFile('powershell.exe', args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() }));
  });
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The signature checks, shared by the pre-check and the elevated script. `fail(kind)` says how each one reports a failure. */
const verifyBody = (dirExpr, fail) => `
$publisher = ${q(PUBLISHER.source)}
$driver = ${q(DRIVER_SIGNER.source)}
if (-not (Test-Path -LiteralPath (Join-Path ${dirExpr} 'VBCABLE_Setup_x64.exe'))) { ${fail('MISSING')} }
$count = 0
foreach ($f in @(Get-ChildItem -LiteralPath ${dirExpr} -Recurse -File | Where-Object { '.exe','.sys','.cat' -contains $_.Extension.ToLower() })) {
  $sig = Get-AuthenticodeSignature -LiteralPath $f.FullName
  $subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '' }
  $rule = if ($f.Extension -eq '.exe') { $publisher } else { $driver }
  if ($sig.Status -ne 'Valid' -or $subject -notmatch $rule) { ${fail('BAD')} }
  $count++
}
if ($count -lt 3) { ${fail('MISSING')} }
`;

/** PowerShell that checks every program / driver file of a folder; prints OK or a reason. */
const verifyScript = (dir) => `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$dir = ${q(dir)}
${verifyBody('$dir', (kind) => (kind === 'BAD' ? "'BAD ' + $f.Name + ' (' + $sig.Status + ')'; exit" : "'MISSING'; exit"))}
'OK'
`;

/** Script run with administrator rights: lock a folder, copy, verify again, install, report through the exit code. */
const elevatedScript = (srcDir) => `
$ErrorActionPreference = 'Stop'
$code = 23
$work = $null
try {
  $work = Join-Path $env:windir ('Temp\\evcam-vbcable-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work | Out-Null
  & icacls.exe $work /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'acl' }
  Copy-Item -Path (Join-Path ${q(srcDir)} '*') -Destination $work -Recurse -Force
  $bad = $null
  & { ${verifyBody('$work', (kind) => (kind === 'BAD' ? '$script:bad = 22; return' : '$script:bad = 21; return'))} }
  if ($bad) { $code = $bad } else {
    $setup = Join-Path $work 'VBCABLE_Setup_x64.exe'
    # silent install first, then the vendor's own window if the device did not appear
    Start-Process -FilePath $setup -ArgumentList '-i','-h' -WorkingDirectory $work -Wait | Out-Null
    $found = 0
    for ($i = 0; $i -lt 10 -and -not $found; $i++) {
      Start-Sleep -Seconds 2
      $found = @(Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'VB-Audio|CABLE' }).Count
    }
    if (-not $found) {
      Start-Process -FilePath $setup -WorkingDirectory $work -Wait | Out-Null
      Start-Sleep -Seconds 4
    }
    $code = 0
  }
} catch { $code = 23 }
if ($work) { Start-Sleep -Seconds 1; Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
exit $code
`;

function newWorkDir() {
  const dir = path.join(os.tmpdir(), `evcam-vbcable-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function extract(zip, dir) {
  return new Promise((resolve) => {
    execFile(path.join(process.env.windir || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir], { windowsHide: true, timeout: 60000 }, (error) => {
      if (!error) return resolve(true);
      powershell(`Expand-Archive -LiteralPath ${q(zip)} -DestinationPath ${q(dir)} -Force`, { timeout: 60000 }).then((r) => resolve(r.ok));
    });
  });
}

/**
 * Downloads (or reuses `zipPath` in tests), extracts and verifies the package.
 * Resolves with { ok, dir } — the folder to hand to install().
 */
async function prepare({ zipPath, onStep = () => {} } = {}) {
  const work = newWorkDir();
  let zip = zipPath;
  if (!zip) {
    onStep('download', 0);
    const url = await findPackageUrl();
    const data = await get(url, { limit: MAX_ZIP_BYTES, timeout: 60000, onProgress: (p) => onStep('download', p) });
    if (data.length < 100000 || data[0] !== 0x50 || data[1] !== 0x4b) throw new Error('Le fichier téléchargé n’est pas une archive valide.');
    zip = path.join(work, 'package.zip');
    fs.writeFileSync(zip, data);
  }
  onStep('verify', 0);
  const dir = path.join(work, 'files');
  fs.mkdirSync(dir);
  if (!(await extract(zip, dir))) throw new Error('Extraction du pilote impossible.');
  const res = await powershell(verifyScript(dir));
  if (!res.stdout.endsWith('OK')) {
    throw new Error(res.stdout.startsWith('BAD') ? `Signature numérique invalide (${res.stdout.slice(4)}) : installation refusée par sécurité.` : 'Paquet du pilote incomplet : installation refusée.');
  }
  return { ok: true, dir, work };
}

/** Runs the vendor setup with administrator rights (UAC prompt). */
async function install(dir) {
  const res = await powershell(elevatedScript(dir), { elevate: true, timeout: 10 * 60 * 1000 });
  if (res.stdout.includes('CANCELLED')) return { ok: false, cancelled: true, error: 'Autorisation administrateur refusée.' };
  const m = res.stdout.match(/EXIT=(\d+)/);
  const code = m ? Number(m[1]) : -1;
  const reasons = { 20: 'Dossier protégé impossible à créer.', 21: 'Paquet du pilote incomplet.', 22: 'Signature numérique invalide : installation refusée.', 23: 'L’installation du pilote a échoué.' };
  return code === 0 ? { ok: true } : { ok: false, error: reasons[code] || 'L’installation du pilote a échoué.' };
}

function cleanup(work) {
  if (!work || !path.basename(work).startsWith('evcam-vbcable-') || path.dirname(work) !== os.tmpdir()) return;
  fs.rm(work, { recursive: true, force: true }, () => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the user reads while each step runs. */
function stepText(step, progress = 0) {
  switch (step) {
    case 'download': return `Téléchargement du pilote audio gratuit depuis vb-audio.com… ${progress > 0 ? `${Math.round(progress * 100)} %` : ''}`.trim();
    case 'verify': return 'Vérification de la signature numérique du pilote…';
    case 'install': return 'Installation du pilote : acceptez la demande d’autorisation de Windows (administrateur).';
    case 'wait': return 'Windows crée le micro virtuel…';
    case 'rename': return 'Création du micro « EvCam Micro »…';
    default: return '';
  }
}

/**
 * Whole flow. `audio` is the audioDefault module, `createMic()` renames the cable to "EvCam Micro".
 * Steps reported to `onStep(step, progress)`: download → verify → install → wait → rename.
 * `dryRun` (tests only) stops after the download / signature check, before anything needs administrator rights;
 * `assumeAbsent` (tests only) pretends no cable is installed.
 */
async function ensureMic({ audio, known, createMic, onStep = () => {}, zipPath, dryRun = false, assumeAbsent = false }) {
  let st = await audio.status(known && known());
  if (!assumeAbsent && st.ok && st.virtual.capture && st.virtual.render) {
    onStep('rename', 0);
    const res = await createMic();
    return { ...res, installed: false, already: true };
  }
  let prepared = null;
  try {
    prepared = await prepare({ zipPath, onStep });
    if (dryRun) return { ok: true, dryRun: true, installed: false };
    onStep('install', 0);
    const inst = await install(prepared.dir);
    if (!inst.ok) return { ...inst, installed: false };
    onStep('wait', 0);
    for (let i = 0; i < 14; i++) {
      st = await audio.status(known && known());
      if (st.ok && st.virtual.capture && st.virtual.render) break;
      await sleep(2000);
    }
    if (!(st.ok && st.virtual.capture && st.virtual.render)) {
      return { ok: false, installed: true, needsRestart: true, error: 'Le pilote est installé mais Windows n’a pas encore créé le micro : redémarrez Windows puis cliquez sur « Créer le micro ».' };
    }
    onStep('rename', 0);
    const res = await createMic();
    return { ...res, installed: true };
  } catch (err) {
    return { ok: false, installed: false, error: err.message || 'Installation impossible.' };
  } finally {
    if (prepared) cleanup(prepared.work);
  }
}

module.exports = { ensureMic, stepText, prepare, install, findPackageUrl, verifyScript, elevatedScript, PUBLISHER, DRIVER_SIGNER };
