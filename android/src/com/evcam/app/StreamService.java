package com.evcam.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Foreground service shown while the phone is streaming. It keeps the process (and, on recent
 * Android versions, the camera and microphone) alive when the app is not on screen or the phone is
 * asleep, and holds a CPU wake lock plus Wi-Fi locks so the connection stays up with the screen off.
 */
public class StreamService extends Service {
    private static final String CHANNEL = "evcam_stream";

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private WifiManager.WifiLock wifiLockLowLatency;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Diffusion EvCam", NotificationManager.IMPORTANCE_LOW));
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        builder.setContentTitle("EvCam diffuse votre micro et votre caméra")
                .setContentText("Continue écran éteint · touchez pour revenir à EvCam")
                .setSmallIcon(R.drawable.ic_stat_evcam)
                .setContentIntent(pending)
                .setOngoing(true);
        Notification notification = builder.build();

        try {
            if (Build.VERSION.SDK_INT >= 30) {
                int type = 0;
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                startForeground(1, notification, type);
            } else {
                startForeground(1, notification);
            }
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }

        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "evcam:stream");
                wakeLock.acquire();
            }
            if (wifiLock == null) {
                // high performance keeps the radio awake with the screen OFF; low latency only helps with the screen on
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "evcam:wifi");
                wifiLock.acquire();
                if (Build.VERSION.SDK_INT >= 29) {
                    wifiLockLowLatency = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "evcam:wifi-ll");
                    wifiLockLowLatency.acquire();
                }
            }
        } catch (Exception ignored) {
            // locks are an optimisation only
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
            if (wifiLockLowLatency != null && wifiLockLowLatency.isHeld()) wifiLockLowLatency.release();
        } catch (Exception ignored) {
            // nothing to do
        }
        wakeLock = null;
        wifiLock = null;
        wifiLockLowLatency = null;
        stopForeground(true);
        super.onDestroy();
    }
}
