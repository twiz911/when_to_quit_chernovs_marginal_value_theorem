package com.whentoquit.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.app.NotificationCompat;
import java.util.Locale;

public class TimerService extends Service {

    public static final String ACTION_START = "ACTION_START";
    public static final String ACTION_STOP  = "ACTION_STOP";

    private static final String CHANNEL_ID     = "timer_channel";
    private static final int    NOTIFICATION_ID = 1;

    private final Handler   handler      = new Handler(Looper.getMainLooper());
    private       String    activityId;
    private       String    activityName;
    private       long      startTime;

    private final Runnable tickRunnable = new Runnable() {
        @Override public void run() {
            updateNotification();
            handler.postDelayed(this, 1000);
        }
    };

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;

        if (ACTION_START.equals(intent.getAction())) {
            activityId   = intent.getStringExtra("activityId");
            activityName = intent.getStringExtra("activityName");
            startTime    = intent.getLongExtra("startTime", System.currentTimeMillis());

            createNotificationChannel();
            startForeground(NOTIFICATION_ID, buildNotification("00:00:00"));
            handler.removeCallbacks(tickRunnable);
            handler.post(tickRunnable);

        } else if (ACTION_STOP.equals(intent.getAction())) {
            handler.removeCallbacks(tickRunnable);
            stopForeground(true);
            stopSelf();
        }
        return START_STICKY;
    }

    private void updateNotification() {
        long elapsed = (System.currentTimeMillis() - startTime) / 1000;
        String time = String.format(Locale.US, "%02d:%02d:%02d",
                elapsed / 3600, (elapsed % 3600) / 60, elapsed % 60);
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification(time));
    }

    private Notification buildNotification(String elapsed) {
        // "Stop & Rate" action — sends broadcast to StopRateReceiver
        Intent stopIntent = new Intent(this, StopRateReceiver.class);
        stopIntent.putExtra("activityId",   activityId);
        stopIntent.putExtra("activityName", activityName);
        stopIntent.putExtra("startTime",    startTime);
        PendingIntent stopPi = PendingIntent.getBroadcast(this, 0, stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // Tapping the notification body opens the app normally
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(this, 1, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(activityName)
                .setContentText("\u23f1 " + elapsed)   // ⏱
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(openPi)
                .addAction(android.R.drawable.ic_media_pause, "Stop & Rate", stopPi)
                .setOngoing(true)
                .setSilent(true)
                .build();
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Activity Timer", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shows the currently running activity timer");
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(channel);
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(tickRunnable);
        super.onDestroy();
    }
}
