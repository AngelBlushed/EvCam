'use strict';

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Windows cannot create an audio device without a signed kernel driver, so EvCam builds its "EvCam Micro"
// on the free VB-CABLE virtual cable (already installed by many users): the cable's capture end is
// RENAMED to "EvCam Micro" (reversible, needs one administrator approval). EvCam never changes the
// user's default microphone. The default-device helpers below only remain to undo that older behaviour.

const CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
  int RegisterEndpointNotificationCallback(IntPtr client);
  int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  int OpenPropertyStore(int access, out IPropertyStore properties);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetState(out int state);
}

[StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public uint pid; }
[StructLayout(LayoutKind.Sequential)] struct PROPVARIANT { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p; public IntPtr p2; }

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
  int GetCount(out uint count);
  int GetAt(uint index, out PROPERTYKEY key);
  int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
  int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
  int Commit();
}

[ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")] class PolicyConfigClient {}

[ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPolicyConfig {
  [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr format);
  [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string name, bool defaultFormat, IntPtr format);
  [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string name);
  [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr endpointFormat, IntPtr mixFormat);
  [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string name, bool defaultPeriod, IntPtr defaultTime, IntPtr minimumTime);
  [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr period);
  [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr mode);
  [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr mode);
  [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string name, bool fxStore, IntPtr key, IntPtr value);
  [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string name, bool fxStore, IntPtr key, IntPtr value);
  [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string name, int role);
  [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string name, bool visible);
}

public static class EvAudio {
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pv);

  static PROPERTYKEY Key(string guid, uint pid) { PROPERTYKEY k; k.fmtid = new Guid(guid); k.pid = pid; return k; }
  static PROPERTYKEY DeviceDesc() { return Key("a45c254e-df1c-4efd-8020-67d146a850e0", 2); }
  static PROPERTYKEY InterfaceName() { return Key("b3f8fa53-0004-438e-9003-51a46e139bfc", 6); }

  public static string GetDefault(int role) {
    try {
      var e = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
      IMMDevice d; if (e.GetDefaultAudioEndpoint(1, role, out d) != 0) return "";
      string id; d.GetId(out id); return id ?? "";
    } catch { return ""; }
  }
  public static int SetDefault(string id, int role) {
    var pc = (IPolicyConfig)new PolicyConfigClient();
    return pc.SetDefaultEndpoint(id, role);
  }

  static string ReadString(IPropertyStore ps, PROPERTYKEY key) {
    PROPVARIANT pv; ps.GetValue(ref key, out pv);
    string s = (pv.vt == 31 && pv.p != IntPtr.Zero) ? Marshal.PtrToStringUni(pv.p) : "";
    PropVariantClear(ref pv);
    return s;
  }
  static int WriteString(IPropertyStore ps, PROPERTYKEY key, string value) {
    PROPVARIANT pv = new PROPVARIANT(); pv.vt = 31; pv.p = Marshal.StringToCoTaskMemUni(value);
    int hr = ps.SetValue(ref key, ref pv);
    PropVariantClear(ref pv);
    return hr;
  }

  /** "description|interface" of an endpoint, read-only. */
  public static string GetNames(string id) {
    try {
      var e = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
      IMMDevice d; int hr = e.GetDevice(id, out d); if (hr != 0) return "ERR GetDevice 0x" + hr.ToString("x8");
      IPropertyStore ps; hr = d.OpenPropertyStore(0, out ps); if (hr != 0) return "ERR OpenPropertyStore 0x" + hr.ToString("x8");
      return ReadString(ps, DeviceDesc()) + "|" + ReadString(ps, InterfaceName());
    } catch (Exception ex) { return "ERR " + ex.Message; }
  }

  /** Changes how an endpoint is named in Windows (needs an elevated process). Returns "ok" or an error. */
  public static string Rename(string id, string desc, string iface) {
    try {
      var e = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
      IMMDevice d; int hr = e.GetDevice(id, out d); if (hr != 0) return "GetDevice 0x" + hr.ToString("x8");
      IPropertyStore ps; hr = d.OpenPropertyStore(1, out ps); if (hr != 0) return "OpenPropertyStore(write) 0x" + hr.ToString("x8");
      hr = WriteString(ps, DeviceDesc(), desc); if (hr != 0) return "SetValue(desc) 0x" + hr.ToString("x8");
      hr = WriteString(ps, InterfaceName(), iface); if (hr != 0) return "SetValue(interface) 0x" + hr.ToString("x8");
      hr = ps.Commit(); if (hr != 0) return "Commit 0x" + hr.ToString("x8");
      return "ok";
    } catch (Exception ex) { return ex.Message; }
  }
}
`;

// Reading the endpoints only needs the registry: no C# is compiled here (Add-Type starts the compiler, which is heavy on a slow disk).
const READ_SCRIPT = String.raw`
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Read-Endpoints($flow, $prefix) {
  $base = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\$flow"
  $out = @()
  foreach ($k in Get-ChildItem $base -ErrorAction SilentlyContinue) {
    $state = (Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue).DeviceState
    if ($state -ne 1) { continue }
    $p = Get-ItemProperty "$($k.PSPath)\Properties" -ErrorAction SilentlyContinue
    $desc = $p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
    $iface = $p.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
    if (-not $desc) { continue }
    $name = if ($iface) { "$desc ($iface)" } else { "$desc" }
    $out += [pscustomobject]@{ id = "$prefix.$($k.PSChildName)"; name = $name; desc = "$desc"; iface = "$iface" }
  }
  return $out
}
[pscustomobject]@{
  devices = @(Read-Endpoints 'Capture' '{0.0.1.00000000}')
  renderDevices = @(Read-Endpoints 'Render' '{0.0.0.00000000}')
} | ConvertTo-Json -Compress -Depth 5
`;

function runPowershell(args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
      { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() }));
  });
}

const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');
const withCode = (body) => `[Console]::OutputEncoding = [Text.Encoding]::UTF8\nAdd-Type -TypeDefinition @'\n${CSHARP}\n'@\n${body}`;
const ID_OK = /^\{0\.0\.[01]\.00000000\}\.\{[0-9A-Fa-f-]{36}\}$/;

const CABLE_OUT = /^CABLE Output/i;
const CABLE_IN = /^CABLE Input/i;
const EVCAM_OUT = /^EvCam Micro(?! - )/i;
const EVCAM_IN = /^EvCam Micro - /i;

/** Names given to the cable's two ends once "EvCam Micro" is created. */
const NAMES = {
  capture: { desc: 'EvCam Micro', iface: 'téléphone' },
  render: { desc: 'EvCam Micro - entrée', iface: 'câble virtuel' }
};

/**
 * Active microphones, the current Windows default, and the two ends of the virtual cable
 * (found by id once known, otherwise by their VB-CABLE / EvCam names).
 */
let statusRun = null;

function status(known = {}) {
  // one PowerShell at a time: concurrent callers share the running one
  if (!statusRun) statusRun = readStatus(known).finally(() => { statusRun = null; });
  return statusRun;
}

async function readStatus(known) {
  const res = await runPowershell(['-EncodedCommand', encode(READ_SCRIPT)]);
  try {
    const data = JSON.parse(res.stdout);
    const devices = [].concat(data.devices || []);
    const renders = [].concat(data.renderDevices || []);
    const pick = (list, id, ...patterns) => {
      const byId = id && list.find((d) => d.id === id);
      if (byId) return byId;
      for (const p of patterns) { const hit = list.find((d) => p.test(d.desc) && !/16ch/i.test(d.desc)); if (hit) return hit; }
      return null;
    };
    const capture = pick(devices, known.captureId, EVCAM_OUT, CABLE_OUT);
    const render = pick(renders, known.renderId, EVCAM_IN, CABLE_IN);
    const current = devices.find((d) => d.id === data.defaultConsole) || null;
    return {
      ok: true,
      devices,
      defaultId: data.defaultConsole || '',
      defaultName: current ? current.name : '',
      defaultCommId: data.defaultComm || '',
      virtual: { capture, render, renamed: !!(capture && EVCAM_OUT.test(capture.desc)) }
    };
  } catch {
    return { ok: false, error: res.stderr || 'Lecture des micros impossible.', devices: [], virtual: { capture: null, render: null, renamed: false } };
  }
}

/** Makes a capture device the Windows default (only used to undo the previous behaviour). */
async function setDefault(id) {
  if (!ID_OK.test(id || '')) return { ok: false, error: 'Identifiant de micro invalide.' };
  const body = `$bad = @(); foreach ($role in 0,1,2) { $hr = [EvAudio]::SetDefault('${id}', $role); if ($hr -ne 0) { $bad += ('0x{0:x8}' -f $hr) } }\n` +
    `if ($bad.Count) { [pscustomobject]@{ ok = $false; error = ('Windows a refusé le changement (' + ($bad -join ',') + ')') } | ConvertTo-Json -Compress } else { '{"ok":true}' }`;
  const res = await runPowershell(['-EncodedCommand', encode(withCode(body))]);
  try { return JSON.parse(res.stdout); } catch { return { ok: false, error: res.stderr || 'Changement du micro par défaut impossible.' }; }
}

/**
 * Renames endpoints: [{ id, desc, iface }]. Administrator rights are required, so the work is done by an
 * elevated PowerShell (the user sees the standard UAC prompt). The script travels in the command line
 * (never through a file another program could replace) and answers through a one-off result file.
 * `elevate: false` is for tests only.
 */
async function rename(ops, { elevate = true } = {}) {
  for (const op of ops) if (!ID_OK.test(op.id || '')) return { ok: false, error: 'Identifiant de périphérique invalide.' };
  const resultFile = path.join(os.tmpdir(), `evcam-mic-${crypto.randomBytes(8).toString('hex')}.json`);
  const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const calls = ops.map((op) => `$r += [pscustomobject]@{ id = ${quote(op.id)}; result = [EvAudio]::Rename(${quote(op.id)}, ${quote(op.desc)}, ${quote(op.iface)}) }`).join('\n');
  const inner = withCode(`$r = @()\n${calls}\n[IO.File]::WriteAllText(${quote(resultFile)}, ($r | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))`);
  const encoded = encode(inner);

  const launcher = elevate
    ? `try { Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'; 'launched' } catch { 'cancelled' }`
    : `& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '${encoded}'; 'launched'`;
  const res = await runPowershell(['-Command', launcher], 120000);
  if (!res.stdout.includes('launched')) return { ok: false, cancelled: true, error: 'Autorisation administrateur refusée.' };

  let results = [];
  try { results = [].concat(JSON.parse(fs.readFileSync(resultFile, 'utf8'))); } catch { /* script produced nothing */ }
  try { fs.unlinkSync(resultFile); } catch { /* ignore */ }
  const failed = results.filter((r) => r.result !== 'ok');
  if (!results.length) return { ok: false, error: 'Le changement de nom n’a pas abouti.' };
  if (failed.length) return { ok: false, error: failed.map((f) => f.result).join(' · '), results };
  return { ok: true, results };
}

/** Renames without administrator rights when Windows allows it, otherwise asks for them (UAC prompt). */
async function renameAuto(ops) {
  const first = await rename(ops, { elevate: false });
  if (first.ok) return first;
  return rename(ops, { elevate: true });
}

/** Read-only names of one endpoint (for tests and to remember the originals). */
async function readNames(id) {
  if (!ID_OK.test(id || '')) return null;
  const res = await runPowershell(['-EncodedCommand', encode(withCode(`[EvAudio]::GetNames('${id}')`))]);
  const [desc, iface] = res.stdout.split('|');
  return res.stdout.startsWith('ERR') ? { error: res.stdout } : { desc, iface };
}

module.exports = { status, setDefault, rename, renameAuto, readNames, NAMES };
