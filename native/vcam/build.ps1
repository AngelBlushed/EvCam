# Builds the EvCam virtual camera DLL and its setup helper (MSVC required).
# Usage: powershell -File build.ps1 [-Arch x64|x86] [-Test] [-OutDir <dir>]
#   Default output: resources\vcam\<arch>  (evcam_vcam.dll + evcam-vcam-setup.exe)
#   -Test builds the TEST variant (/DEVCAM_TEST): different CLSID ("EvCamTest"), filter
#   name and shared memory / mutex names, so it can be registered and run next to an
#   installed EvCam without touching it. It defaults to $env:TEMP\evcam-vcam-test\<arch>,
#   never to resources\.
param(
    [ValidateSet('x64','x86')][string]$Arch = 'x64',
    [switch]$Test,
    [string]$OutDir
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Visual Studio Build Tools (C++) not found' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvarsall.bat'
if ($OutDir) { $out = $OutDir }
elseif ($Test) { $out = Join-Path $env:TEMP "evcam-vcam-test\$Arch" }
else { $out = Join-Path $here "..\..\resources\vcam\$Arch" }
$variant = if ($Test) { "test-$Arch" } else { $Arch }
$obj = Join-Path $here "obj\$variant"
New-Item -ItemType Directory -Force $out, $obj | Out-Null
$out = (Resolve-Path $out).Path
$src = Join-Path $here 'src'
$def = if ($Test) { '/DEVCAM_TEST ' } else { '' }

$files = @(Get-ChildItem "$src\baseclasses\*.cpp") + @(Get-ChildItem "$src\softcamcore\*.cpp") + @(Get-Item "$src\softcam\softcam.cpp")
$list = ($files | ForEach-Object { '"' + $_.FullName + '"' }) -join ' '
$cl = "cl /nologo /O2 /MT /EHsc /std:c++17 /W3 /DWIN32 /DNDEBUG /D_CRT_SECURE_NO_WARNINGS /DUNICODE /D_UNICODE ${def}" +
      "/I`"$src`" /I`"$src\baseclasses`" /Fo`"$obj\\`" $list /LD /Fe`"$out\evcam_vcam.dll`" " +
      "/link /DEF:`"$src\softcam\softcam.def`" /INCREMENTAL:NO winmm.lib kernel32.lib user32.lib gdi32.lib advapi32.lib shell32.lib ole32.lib oleaut32.lib uuid.lib strmiids.lib"
$setup = "cl /nologo /O2 /MT /EHsc /DUNICODE /D_UNICODE `"$here\setup\evcam-vcam-setup.cpp`" /Fo`"$obj\\`" /Fe`"$out\evcam-vcam-setup.exe`" /link /INCREMENTAL:NO /MANIFEST:EMBED `"/MANIFESTUAC:level='asInvoker' uiAccess='false'`" advapi32.lib ole32.lib"
$bat = Join-Path $obj 'build.cmd'
# The setup exe carries an asInvoker manifest: without one, Windows' installer detection
# (32-bit exe named *setup*) demands elevation, although per-user registration needs none.
# vcvarsall picks the right cross/native toolset for the target ('x86' works from an x64 host).
Set-Content $bat "@echo off`r`ncall `"$vcvars`" $Arch >nul`r`nif errorlevel 1 exit /b 1`r`n$cl`r`nif errorlevel 1 exit /b 1`r`n$setup`r`nexit /b %errorlevel%" -Encoding ASCII
& cmd /c "`"$bat`""
if ($LASTEXITCODE -ne 0) { throw "build failed ($LASTEXITCODE)" }
# The linker leaves an import library and export file next to the DLL; they are not needed.
Remove-Item "$out\evcam_vcam.lib", "$out\evcam_vcam.exp" -ErrorAction SilentlyContinue
Get-ChildItem $out | Select-Object Name, Length
