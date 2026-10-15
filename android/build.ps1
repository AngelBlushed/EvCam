# Builds the EvCam Android app (APK) without Gradle: aapt2 + javac + d8 + zipalign + apksigner.
#   powershell -ExecutionPolicy Bypass -File android\build.ps1
# Requirements: JDK 17+, Android SDK (platform android-34 or newer, build-tools 34+).
param(
  [string]$VersionName = '',
  [int]$VersionCode = 0
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path $here -Parent

if (-not $VersionName) { $VersionName = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version }
if (-not $VersionCode) { $p = $VersionName.Split('.'); $VersionCode = [int]$p[0] * 10000 + [int]$p[1] * 100 + [int]$p[2] }

# --- locate the SDK -----------------------------------------------------------------
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not (Test-Path $sdk)) { throw "Android SDK not found ($sdk). Set ANDROID_HOME." }

$bt = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'aapt2.exe') } | Sort-Object { [version]($_.Name -replace '[^\d.].*$', '') } | Select-Object -Last 1
if (-not $bt) { throw 'No Android build-tools with aapt2 found.' }
$platform = Get-ChildItem (Join-Path $sdk 'platforms') -Directory | Where-Object { $_.Name -match '^android-(\d+)$' -and [int]$Matches[1] -ge 34 -and (Test-Path (Join-Path $_.FullName 'android.jar')) } | Sort-Object { [int]($_.Name -replace 'android-', '') } | Select-Object -First 1
if (-not $platform) { throw 'No Android platform (>= 34) with android.jar found.' }
$androidJar = Join-Path $platform.FullName 'android.jar'
$aapt2 = Join-Path $bt.FullName 'aapt2.exe'
$aapt = Join-Path $bt.FullName 'aapt.exe'
$d8 = Join-Path $bt.FullName 'd8.bat'
$zipalign = Join-Path $bt.FullName 'zipalign.exe'
$apksigner = Join-Path $bt.FullName 'apksigner.bat'
$javac = (Get-Command javac -ErrorAction Stop).Source
$keytool = (Get-Command keytool -ErrorAction Stop).Source
Write-Host "build-tools $($bt.Name) | $($platform.Name) | version $VersionName ($VersionCode)"

$build = Join-Path $here 'build'
if (Test-Path $build) { Remove-Item -Recurse -Force $build }
New-Item -ItemType Directory -Force $build, "$build\gen", "$build\classes", "$build\dex" | Out-Null

function Run($exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "$([IO.Path]::GetFileName($exe)) failed ($LASTEXITCODE)" }
}

# --- 1. resources + manifest -> unsigned.apk (+ R.java) ------------------------------------
Run $aapt2 @('compile', '--dir', "$here\res", '-o', "$build\res.zip")
Run $aapt2 @('link', '-o', "$build\unsigned.apk", '-I', $androidJar,
  '--manifest', "$here\AndroidManifest.xml", '--min-sdk-version', '26', '--target-sdk-version', '34',
  '--version-code', $VersionCode, '--version-name', $VersionName,
  '-A', "$here\assets", '--java', "$build\gen", "$build\res.zip")

# --- 2. Java -> classes -> classes.dex -------------------------------------------------------
$sources = @(Get-ChildItem "$here\src" -Recurse -Filter *.java) + @(Get-ChildItem "$build\gen" -Recurse -Filter *.java)
Run $javac (@('-encoding', 'UTF-8', '-source', '8', '-target', '8', '-Xlint:-options', '-classpath', $androidJar, '-d', "$build\classes") + ($sources | ForEach-Object { $_.FullName }))
$classes = Get-ChildItem "$build\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName }
Run $d8 (@('--release', '--min-api', '26', '--lib', $androidJar, '--output', "$build\dex") + $classes)

# --- 3. add classes.dex, align, sign ---------------------------------------------------------
Push-Location "$build\dex"
Run $aapt @('add', "$build\unsigned.apk", 'classes.dex')
Pop-Location
Run $zipalign @('-f', '-p', '4', "$build\unsigned.apk", "$build\aligned.apk")

$keystore = Join-Path $here 'evcam.keystore'
$pass = 'evcam-sideload'
if (-not (Test-Path $keystore)) {
  Write-Host 'creating signing key (keep android\evcam.keystore: it is needed to update the app later)'
  Run $keytool @('-genkeypair', '-keystore', $keystore, '-alias', 'evcam', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '36500',
    '-storepass', $pass, '-keypass', $pass, '-dname', 'CN=EvCam, O=EvCam, C=FR')
}
$apk = Join-Path $build 'EvCam.apk'
Run $apksigner @('sign', '--ks', $keystore, '--ks-key-alias', 'evcam', '--ks-pass', "pass:$pass", '--key-pass', "pass:$pass", '--out', $apk, "$build\aligned.apk")
Run $apksigner @('verify', '--verbose', $apk)

# keep only the deliverable
Remove-Item -Recurse -Force "$build\gen", "$build\classes", "$build\dex", "$build\res.zip", "$build\unsigned.apk", "$build\aligned.apk" -ErrorAction SilentlyContinue
Remove-Item -Force "$apk.idsig" -ErrorAction SilentlyContinue
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
Copy-Item $apk (Join-Path $dist "EvCam-$VersionName.apk") -Force
Write-Host "APK ready: $apk ($([math]::Round((Get-Item $apk).Length / 1KB)) KB) -> dist\EvCam-$VersionName.apk"
