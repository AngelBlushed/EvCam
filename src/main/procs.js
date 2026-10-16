'use strict';

// Lists running processes WITHOUT starting any child process (no PowerShell, no tasklist): the Windows
// process snapshot API is called in-process. Starting powershell.exe over and over is what made hard disks
// spike (each launch reads dozens of files and writes entries to the Windows event log).

const koffi = require('koffi');

const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const EPOCH_DIFF_100NS = 116444736000000000n; // 1601-01-01 -> 1970-01-01 in 100 ns units
const INVALID_HANDLE = 0xffffffffffffffffn;

let api = null;

function load() {
  if (api) return api;
  const k32 = koffi.load('kernel32.dll');
  const ENTRY = koffi.struct('EVCAM_PROCESSENTRY32W', {
    dwSize: 'uint32',
    cntUsage: 'uint32',
    th32ProcessID: 'uint32',
    th32DefaultHeapID: 'uintptr_t',
    th32ModuleID: 'uint32',
    cntThreads: 'uint32',
    th32ParentProcessID: 'uint32',
    pcPriClassBase: 'int32',
    dwFlags: 'uint32',
    szExeFile: koffi.array('char16', 260, 'String')
  });
  api = {
    ENTRY,
    snapshot: k32.func('intptr_t __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)'),
    first: k32.func('bool __stdcall Process32FirstW(intptr_t snapshot, _Inout_ EVCAM_PROCESSENTRY32W *entry)'),
    next: k32.func('bool __stdcall Process32NextW(intptr_t snapshot, _Inout_ EVCAM_PROCESSENTRY32W *entry)'),
    open: k32.func('intptr_t __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
    times: k32.func('bool __stdcall GetProcessTimes(intptr_t process, _Out_ uint64_t *created, _Out_ uint64_t *exited, _Out_ uint64_t *kernel, _Out_ uint64_t *user)'),
    imagePath: k32.func('bool __stdcall QueryFullProcessImageNameW(intptr_t process, uint32 flags, void *buffer, _Inout_ uint32_t *size)'),
    close: k32.func('bool __stdcall CloseHandle(intptr_t handle)')
  };
  return api;
}

/** Start time (ISO string) and full path of one process, when Windows lets us read them. */
function details(a, pid) {
  const out = { startedAt: null, path: '' };
  const handle = a.open(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!handle) return out;
  try {
    const created = [0n];
    if (a.times(handle, created, [0n], [0n], [0n])) {
      const ms = (BigInt(created[0]) - EPOCH_DIFF_100NS) / 10000n;
      out.startedAt = new Date(Number(ms)).toISOString();
    }
    const buf = Buffer.alloc(1040);
    const size = [520];
    if (a.imagePath(handle, 0, buf, size)) out.path = buf.toString('utf16le', 0, size[0] * 2);
  } finally {
    a.close(handle);
  }
  return out;
}

/**
 * Running processes whose image name (without ".exe", any case) is in `names`.
 * Resolves to [{ name, pid, path, startedAt }].
 */
function find(names) {
  const a = load();
  const wanted = new Set(names.map((n) => String(n).toLowerCase()));
  const snap = a.snapshot(TH32CS_SNAPPROCESS, 0);
  if (BigInt.asUintN(64, BigInt(snap)) === INVALID_HANDLE || !snap) throw new Error('process snapshot unavailable');
  const found = [];
  try {
    const entry = { dwSize: koffi.sizeof(a.ENTRY) };
    let ok = a.first(snap, entry);
    while (ok) {
      const exe = String(entry.szExeFile || '');
      const base = exe.replace(/\.exe$/i, '');
      if (wanted.has(base.toLowerCase())) found.push({ name: base, exe, pid: entry.th32ProcessID });
      ok = a.next(snap, entry);
    }
  } finally {
    a.close(snap);
  }
  return found.map((p) => ({ ...p, ...details(a, p.pid) }));
}

module.exports = { find };
