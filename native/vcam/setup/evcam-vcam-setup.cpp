// evcam-vcam-setup: registers / unregisters the EvCam DirectShow virtual camera.
//
//   evcam-vcam-setup --register   [--machine] [path\to\evcam_vcam.dll]
//   evcam-vcam-setup --unregister [--machine] [path\to\evcam_vcam.dll]
//
// Without --machine the filter is registered for the current user only
// (HKEY_CURRENT_USER\Software\Classes), so no administrator rights are needed.
// With --machine it is registered system-wide (requires an elevated process).
// Exit code 0 on success, otherwise the failing HRESULT / Win32 error.

#include <windows.h>
#include <objbase.h>
#include <string>
#include <cstdio>
#include <cwchar>

typedef HRESULT (STDAPICALLTYPE *RegFn)();

static std::wstring DefaultDllPath()
{
    wchar_t self[MAX_PATH];
    GetModuleFileNameW(nullptr, self, MAX_PATH);
    std::wstring p(self);
    size_t slash = p.find_last_of(L"\\/");
    p = (slash == std::wstring::npos) ? L"" : p.substr(0, slash + 1);
    return p + L"evcam_vcam.dll";
}

int wmain(int argc, wchar_t** argv)
{
    bool doRegister = false, doUnregister = false, machine = false;
    std::wstring dll;
    for (int i = 1; i < argc; i++)
    {
        if (!_wcsicmp(argv[i], L"--register")) doRegister = true;
        else if (!_wcsicmp(argv[i], L"--unregister")) doUnregister = true;
        else if (!_wcsicmp(argv[i], L"--machine")) machine = true;
        else dll = argv[i];
    }
    if (doRegister == doUnregister)
    {
        fwprintf(stderr, L"usage: evcam-vcam-setup --register|--unregister [--machine] [dll]\n");
        return 2;
    }
    if (dll.empty()) dll = DefaultDllPath();

    HKEY classes = nullptr;
    if (!machine)
    {
        LONG r = RegCreateKeyExW(HKEY_CURRENT_USER, L"Software\\Classes", 0, nullptr, 0,
                                 KEY_ALL_ACCESS, nullptr, &classes, nullptr);
        if (r != ERROR_SUCCESS) { fwprintf(stderr, L"cannot open HKCU classes: %ld\n", r); return (int)r; }
        r = RegOverridePredefKey(HKEY_CLASSES_ROOT, classes);
        if (r != ERROR_SUCCESS) { fwprintf(stderr, L"RegOverridePredefKey failed: %ld\n", r); return (int)r; }
    }

    HRESULT hr = CoInitialize(nullptr);
    if (FAILED(hr)) { fwprintf(stderr, L"CoInitialize failed: 0x%08lx\n", hr); return (int)hr; }

    HMODULE mod = LoadLibraryW(dll.c_str());
    if (!mod)
    {
        DWORD e = GetLastError();
        fwprintf(stderr, L"cannot load %ls (error %lu)\n", dll.c_str(), e);
        return (int)e;
    }
    RegFn fn = (RegFn)GetProcAddress(mod, doRegister ? "DllRegisterServer" : "DllUnregisterServer");
    if (!fn) { fwprintf(stderr, L"entry point not found\n"); return 3; }

    hr = fn();
    if (FAILED(hr)) fwprintf(stderr, L"%ls failed: 0x%08lx\n", doRegister ? L"register" : L"unregister", hr);
    else wprintf(L"ok (%ls, %ls)\n", doRegister ? L"registered" : L"unregistered", machine ? L"machine" : L"user");

    FreeLibrary(mod);
    CoUninitialize();
    if (classes)
    {
        RegOverridePredefKey(HKEY_CLASSES_ROOT, nullptr);
        RegCloseKey(classes);
    }
    return FAILED(hr) ? (int)hr : 0;
}
