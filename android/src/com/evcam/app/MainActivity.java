package com.evcam.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * EvCam for Android: a thin native shell around the EvCam phone page.
 *
 * - the pairing screen (scan the QR code shown on the PC) is a local web page served from the APK assets;
 * - once paired, the page served by the PC is loaded in the same WebView. The PC uses a self-signed
 *   certificate, so instead of showing a browser warning we pin it: the SHA-256 fingerprint is taken from
 *   the QR code (or learned on first use) and anything else is refused.
 */
public class MainActivity extends Activity {
    static final String ASSET_HOST = "appassets.androidplatform.net";
    static final String HOME_URL = "https://" + ASSET_HOST + "/index.html";
    static final int REQ_PERMISSIONS = 42;
    static final Pattern HOST_OK = Pattern.compile("^[A-Za-z0-9.\\-]{1,253}$");

    private WebView web;
    private SharedPreferences prefs;
    private volatile String currentUrl = "";
    private PermissionRequest pendingRequest;

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("evcam", MODE_PRIVATE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(0xFF07080F);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " EvCamApp/" + versionName());

        web.addJavascriptInterface(new Bridge(), "EvCamNative");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        if (!hasRuntimePermissions()) askPermissions();
        web.loadUrl(HOME_URL);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
    }

    @Override
    protected void onDestroy() {
        setStreaming(false);
        applyBrightness(-1f);
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (isStreamUrl(currentUrl)) {
            showHome("pair");
            return;
        }
        // let the local page close its own sub-screens (scanner, manual form...) first
        web.evaluateJavascript("(window.evcamBack ? window.evcamBack() : false) + ''", value -> {
            if (!"\"true\"".equals(value)) finish();
        });
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "1";
        }
    }

    // ------------------------------------------------------------------ pairing storage

    private String host() { return prefs.getString("host", ""); }
    private int port() { return prefs.getInt("port", 0); }
    private String token() { return prefs.getString("token", ""); }
    private String pinPrefix() { return prefs.getString("pinPrefix", ""); }
    private String pinFull() { return prefs.getString("pinFull", ""); }

    private boolean hasPairing() {
        return !host().isEmpty() && port() > 0 && !token().isEmpty();
    }

    private String streamUrl() {
        return "https://" + host() + ":" + port() + "/?t=" + Uri.encode(token()) + "&app=1";
    }

    private boolean isPairedHost(Uri u) {
        if (u == null || u.getHost() == null || !hasPairing()) return false;
        int p = u.getPort() > 0 ? u.getPort() : 443;
        return "https".equals(u.getScheme()) && u.getHost().equalsIgnoreCase(host()) && p == port();
    }

    private boolean isStreamUrl(String url) {
        return url != null && !url.isEmpty() && isPairedHost(Uri.parse(url));
    }

    private boolean isLocalUrl(String url) {
        if (url == null) return false;
        Uri u = Uri.parse(url);
        return "https".equals(u.getScheme()) && ASSET_HOST.equals(u.getHost());
    }

    private boolean isTrustedOrigin(String origin) {
        return isLocalUrl(origin) || isStreamUrl(origin);
    }

    /** Stores a pairing coming from a QR code or the manual form. Returns an error code or null. */
    private String savePairing(String raw) {
        try {
            Uri u = Uri.parse(raw == null ? "" : raw.trim());
            String token = u.getQueryParameter("t");
            if (!"https".equals(u.getScheme()) || u.getHost() == null || token == null || token.isEmpty()) return "badqr";
            if (!HOST_OK.matcher(u.getHost()).matches()) return "badqr";
            int port = u.getPort() > 0 ? u.getPort() : 443;
            String f = u.getQueryParameter("f");
            prefs.edit()
                    .putString("host", u.getHost())
                    .putInt("port", port)
                    .putString("token", token)
                    .putString("pinPrefix", f == null ? "" : f.toLowerCase(Locale.ROOT))
                    .remove("pinFull")
                    .apply();
            return null;
        } catch (Exception e) {
            return "badqr";
        }
    }

    // ------------------------------------------------------------------ navigation

    private void loadStream() {
        if (hasPairing()) web.loadUrl(streamUrl());
        else showHome("pair");
    }

    /** Back to the local pairing screen. {@code state} is "pair" or an error code. */
    private void showHome(String state) {
        web.stopLoading();
        setStreaming(false);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); // the pairing / scanning screen stays lit
        String hash;
        if (state == null || state.isEmpty()) hash = "";
        else if ("pair".equals(state)) hash = "#pair";
        else hash = "#err=" + state;
        web.loadUrl(HOME_URL + hash);
    }

    // ------------------------------------------------------------------ permissions

    private boolean granted(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasRuntimePermissions() {
        return granted(Manifest.permission.CAMERA) && granted(Manifest.permission.RECORD_AUDIO);
    }

    private void askPermissions() {
        List<String> missing = new ArrayList<>();
        if (!granted(Manifest.permission.CAMERA)) missing.add(Manifest.permission.CAMERA);
        if (!granted(Manifest.permission.RECORD_AUDIO)) missing.add(Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
            missing.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!missing.isEmpty()) requestPermissions(missing.toArray(new String[0]), REQ_PERMISSIONS);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQ_PERMISSIONS) return;
        if (pendingRequest != null) {
            resolvePending();
        }
        if (web != null) web.evaluateJavascript("window.evcamPermissions && window.evcamPermissions()", null);
    }

    private void resolvePending() {
        PermissionRequest request = pendingRequest;
        pendingRequest = null;
        if (request == null) return;
        List<String> allowed = new ArrayList<>();
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && granted(Manifest.permission.CAMERA)) allowed.add(r);
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && granted(Manifest.permission.RECORD_AUDIO)) allowed.add(r);
        }
        if (allowed.isEmpty()) request.deny();
        else request.grant(allowed.toArray(new String[0]));
    }

    // ------------------------------------------------------------------ keep streaming in the background

    private void setStreaming(boolean on) {
        setStreaming(on, true, true);
    }

    /** Starts / updates the foreground service; {@code live} and {@code video} decide which power locks it holds. */
    private void setStreaming(boolean on, boolean live, boolean video) {
        try {
            Intent service = new Intent(this, StreamService.class).putExtra("live", live).putExtra("video", video);
            if (on) {
                if (!hasRuntimePermissions()) return;
                if (Build.VERSION.SDK_INT >= 26) startForegroundService(service);
                else startService(service);
            } else {
                stopService(service);
            }
        } catch (Exception ignored) {
            // the foreground service is a bonus: streaming still works while the app is visible
        }
    }

    private void applyBrightness(float level) {
        WindowManager.LayoutParams params = getWindow().getAttributes();
        params.screenBrightness = level < 0 ? WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE : Math.min(1f, Math.max(0.01f, level));
        getWindow().setAttributes(params);
    }

    // ------------------------------------------------------------------ certificate pinning

    private static byte[] certificateBytes(SslCertificate certificate) throws Exception {
        if (Build.VERSION.SDK_INT >= 29 && certificate.getX509Certificate() != null) {
            return certificate.getX509Certificate().getEncoded();
        }
        Bundle state = SslCertificate.saveState(certificate);
        return state.getByteArray("x509-certificate");
    }

    private static String sha256Hex(byte[] data) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
        StringBuilder sb = new StringBuilder();
        for (byte b : digest) sb.append(String.format(Locale.ROOT, "%02x", b));
        return sb.toString();
    }

    // ------------------------------------------------------------------ WebView clients

    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (!ASSET_HOST.equals(u.getHost())) return null;
            String path = u.getPath() == null ? "" : u.getPath();
            if (path.startsWith("/")) path = path.substring(1);
            if (path.isEmpty()) path = "index.html";
            try {
                // assets are kept flat (aapt2 on Windows would store sub-folders with a backslash)
                if (path.contains("/") || path.contains("\\") || path.contains("..")) throw new IllegalArgumentException("path");
                InputStream in = getAssets().open(path);
                return new WebResourceResponse(mimeFor(path), "utf-8", in);
            } catch (Exception e) {
                return new WebResourceResponse("text/plain", "utf-8", 404, "Not found",
                        new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            boolean allowed = ASSET_HOST.equals(u.getHost()) || isPairedHost(u);
            return !allowed; // true = ignore the navigation (external links never leave the app)
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            currentUrl = url == null ? "" : url;
            if (isLocalUrl(currentUrl)) setStreaming(false);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame() || !isPairedHost(request.getUrl())) return;
            if (String.valueOf(error.getDescription()).contains("ERR_ABORTED")) return; // load cancelled by us
            if (!isStreamUrl(currentUrl)) return; // already back on the pairing screen
            showHome("unreachable");
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            try {
                if (!isPairedHost(Uri.parse(error.getUrl()))) {
                    handler.cancel();
                    return;
                }
                String fingerprint = sha256Hex(certificateBytes(error.getCertificate()));
                String full = pinFull();
                String prefix = pinPrefix();
                boolean ok;
                if (!full.isEmpty()) ok = full.equals(fingerprint);
                else if (!prefix.isEmpty()) ok = fingerprint.startsWith(prefix);
                else ok = true; // first use without a fingerprint in the QR code: trust on first use
                if (ok) {
                    if (full.isEmpty()) prefs.edit().putString("pinFull", fingerprint).apply();
                    handler.proceed();
                } else {
                    handler.cancel();
                    runOnUiThread(() -> showHome("cert"));
                }
            } catch (Exception e) {
                handler.cancel();
            }
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            runOnUiThread(() -> {
                if (!isTrustedOrigin(request.getOrigin().toString())) {
                    request.deny();
                    return;
                }
                if (hasRuntimePermissions()) {
                    pendingRequest = request;
                    resolvePending();
                } else {
                    pendingRequest = request;
                    askPermissions();
                }
            });
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (pendingRequest == request) pendingRequest = null;
        }
    }

    private static String mimeFor(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    // ------------------------------------------------------------------ JavaScript bridge

    /** Exposed as window.EvCamNative to the local pairing page and to the paired PC's page. */
    class Bridge {
        private boolean trusted() {
            return isLocalUrl(currentUrl) || isStreamUrl(currentUrl);
        }

        @JavascriptInterface
        public String version() {
            return versionName();
        }

        @JavascriptInterface
        public boolean hasPermissions() {
            return hasRuntimePermissions();
        }

        @JavascriptInterface
        public void requestPermissions() {
            if (!trusted()) return;
            runOnUiThread(() -> {
                if (hasRuntimePermissions()) return;
                askPermissions();
            });
        }

        @JavascriptInterface
        public void openSettings() {
            if (!trusted()) return;
            runOnUiThread(() -> {
                Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()));
                startActivity(i);
            });
        }

        /** JSON describing the saved PC, or an empty string. */
        @JavascriptInterface
        public String getSaved() {
            if (!trusted() || !hasPairing()) return "";
            try {
                JSONObject o = new JSONObject();
                o.put("host", host());
                o.put("port", port());
                o.put("pinned", !pinFull().isEmpty() || !pinPrefix().isEmpty());
                return o.toString();
            } catch (Exception e) {
                return "";
            }
        }

        /** Pairs with a PC from the text of its QR code, then connects. Returns an error code or "". */
        @JavascriptInterface
        public String connect(final String url) {
            if (!trusted()) return "denied";
            final String error = savePairing(url);
            if (error != null) return error;
            runOnUiThread(MainActivity.this::loadStream);
            return "";
        }

        @JavascriptInterface
        public void connectSaved() {
            if (!trusted()) return;
            runOnUiThread(MainActivity.this::loadStream);
        }

        /** Back to the pairing screen; {@code state} may be an error code ("token", "cert"...). */
        @JavascriptInterface
        public void home(final String state) {
            if (!trusted()) return;
            runOnUiThread(() -> showHome(state == null || state.isEmpty() ? "pair" : state));
        }

        @JavascriptInterface
        public void forget() {
            if (!trusted()) return;
            prefs.edit().clear().apply();
        }

        @JavascriptInterface
        public void setStreaming(final boolean on) {
            if (!trusted()) return;
            runOnUiThread(() -> MainActivity.this.setStreaming(on));
        }

        /** The stream is (not) really flowing / carries video: the service holds its CPU and Wi-Fi locks accordingly. */
        @JavascriptInterface
        public void setLive(final boolean live, final boolean video) {
            if (!trusted()) return;
            runOnUiThread(() -> MainActivity.this.setStreaming(true, live, video));
        }

        /**
         * The screen only needs to stay on while the camera runs. In microphone-only mode Android may switch it off by
         * itself (the foreground service keeps the microphone going): that is what makes the battery last.
         */
        @JavascriptInterface
        public void setKeepScreenOn(final boolean on) {
            if (!trusted()) return;
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        /**
         * Backup for the web torch constraint: switches the rear LED with the Camera2 API.
         * Returns false when Android refuses (e.g. the camera is busy), the page then tells the user.
         */
        @JavascriptInterface
        public boolean setTorch(final boolean on) {
            if (!trusted()) return false;
            try {
                CameraManager cameras = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
                for (String id : cameras.getCameraIdList()) {
                    CameraCharacteristics c = cameras.getCameraCharacteristics(id);
                    Boolean flash = c.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                    Integer facing = c.get(CameraCharacteristics.LENS_FACING);
                    if (Boolean.TRUE.equals(flash) && facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                        cameras.setTorchMode(id, on);
                        return true;
                    }
                }
            } catch (Exception ignored) {
                // camera in use, no flash...
            }
            return false;
        }

        /** Screen brightness for this window: 0..1, or a negative value to give control back to the system. */
        @JavascriptInterface
        public void setBrightness(final float level) {
            if (!trusted()) return;
            runOnUiThread(() -> applyBrightness(level));
        }

        /** Battery saver: backlight at its lowest while the page shows a black screen. */
        @JavascriptInterface
        public void setDim(final boolean on) {
            if (!trusted()) return;
            runOnUiThread(() -> applyBrightness(on ? 0.01f : -1f));
        }

        /**
         * Screen off / app in the background: asks Android, once, not to restrict EvCam's battery use so the
         * system does not cut the stream. Returns true when EvCam is already exempt.
         */
        /**
         * Heat: battery temperature (°C) and Android's thermal status (0 none ... 3 severe, API 29+) as JSON, so the
         * page can lower quality by itself when the phone gets hot.
         */
        @JavascriptInterface
        public String thermal() {
            if (!trusted()) return "{}";
            try {
                JSONObject o = new JSONObject();
                Intent battery = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
                if (battery != null) {
                    int tenths = battery.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE);
                    if (tenths != Integer.MIN_VALUE) o.put("tempC", tenths / 10.0);
                }
                int status = 0;
                if (Build.VERSION.SDK_INT >= 29) {
                    PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                    status = pm.getCurrentThermalStatus();
                }
                o.put("status", status);
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public boolean askBatteryExemption() {
            if (!trusted()) return false;
            try {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (Build.VERSION.SDK_INT < 23 || pm.isIgnoringBatteryOptimizations(getPackageName())) return true;
                if (prefs.getBoolean("battery_asked", false)) return false;
                prefs.edit().putBoolean("battery_asked", true).apply();
                runOnUiThread(() -> {
                    try {
                        startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
                    } catch (Exception e) {
                        try {
                            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                        } catch (Exception ignored) {
                            // no such screen on this phone
                        }
                    }
                });
            } catch (Exception ignored) {
                // optional
            }
            return false;
        }

        @JavascriptInterface
        public void exit() {
            if (!trusted()) return;
            runOnUiThread(MainActivity.this::finish);
        }
    }
}
