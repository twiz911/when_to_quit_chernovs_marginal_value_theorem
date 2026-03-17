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
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public class TimerService extends Service {

    public static final String ACTION_START = "ACTION_START";
    public static final String ACTION_STOP  = "ACTION_STOP";
    public static final String ACTION_DISMISS_NOTIFICATION = "ACTION_DISMISS_NOTIFICATION";

    private static final String CHANNEL_ID = "timer_channel";
    private static final int SUMMARY_NOTIFICATION_ID = 1;

    private static class TimerEntry {
        String activityId;
        String activityName;
        long startTime;
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, TimerEntry> runningTimers = new HashMap<>();
    private final Set<String> dismissedNotifications = new HashSet<>();

    private final Runnable tickRunnable = new Runnable() {
        @Override public void run() {
            updateNotifications();
            handler.postDelayed(this, 1000);
        }
    };

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        createNotificationChannel();
        cancelLegacySummaryNotification();

        String action = intent.getAction();
        if (ACTION_START.equals(action)) {
            String activityId = intent.getStringExtra("activityId");
            if (activityId != null && !activityId.isEmpty()) {
                TimerEntry entry = new TimerEntry();
                entry.activityId = activityId;
                entry.activityName = intent.getStringExtra("activityName");
                entry.startTime = intent.getLongExtra("startTime", System.currentTimeMillis());
                runningTimers.put(activityId, entry);
                dismissedNotifications.remove(activityId);
            }
        } else if (ACTION_STOP.equals(action)) {
            String activityId = intent.getStringExtra("activityId");
            if (activityId != null && !activityId.isEmpty()) {
                runningTimers.remove(activityId);
                dismissedNotifications.remove(activityId);
                NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                if (nm != null) nm.cancel(notificationIdFor(activityId));
            } else {
                runningTimers.clear();
                dismissedNotifications.clear();
            }
        } else if (ACTION_DISMISS_NOTIFICATION.equals(action)) {
            String activityId = intent.getStringExtra("activityId");
            if (activityId != null && !activityId.isEmpty()) {
                dismissedNotifications.add(activityId);
                NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                if (nm != null) nm.cancel(notificationIdFor(activityId));
            }
        }

        if (runningTimers.isEmpty()) {
            handler.removeCallbacks(tickRunnable);
            stopForeground(true);
            cancelLegacySummaryNotification();
            stopSelf();
            return START_NOT_STICKY;
        }

        startForegroundWithTimerNotification();
        updateNotifications();
        handler.removeCallbacks(tickRunnable);
        handler.post(tickRunnable);

        return START_STICKY;
    }

    private void updateNotifications() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;

        // Clean up any legacy summary notification row.
        cancelLegacySummaryNotification();

        for (TimerEntry entry : runningTimers.values()) {
            if (dismissedNotifications.contains(entry.activityId)) continue;
            long elapsed = (System.currentTimeMillis() - entry.startTime) / 1000;
            String time = formatElapsed(elapsed);
            nm.notify(notificationIdFor(entry.activityId), buildActivityNotification(entry, time));
        }

        startForegroundWithTimerNotification();
    }

    private void startForegroundWithTimerNotification() {
        TimerEntry foregroundEntry = pickForegroundEntry();
        if (foregroundEntry == null) return;

        long elapsed = (System.currentTimeMillis() - foregroundEntry.startTime) / 1000;
        String time = formatElapsed(elapsed);
        startForeground(
                notificationIdFor(foregroundEntry.activityId),
                buildActivityNotification(foregroundEntry, time)
        );
    }

    private String formatElapsed(long elapsedSeconds) {
        long safe = Math.max(0, elapsedSeconds);
        long days = safe / 86400;
        long rem = safe % 86400;
        long hours = rem / 3600;
        long minutes = (rem % 3600) / 60;
        long seconds = rem % 60;
        String hms = String.format(Locale.US, "%02d:%02d:%02d", hours, minutes, seconds);
        return days > 0 ? (days + "d " + hms) : hms;
    }

    private TimerEntry pickForegroundEntry() {
        for (TimerEntry entry : runningTimers.values()) {
            if (!dismissedNotifications.contains(entry.activityId)) return entry;
        }
        for (TimerEntry entry : runningTimers.values()) {
            return entry;
        }
        return null;
    }

    private Notification buildActivityNotification(TimerEntry entry, String elapsed) {
        Intent openIntent = new Intent(this, OpenActivityReceiver.class);
        openIntent.putExtra("activityId", entry.activityId);
        openIntent.putExtra("activityName", entry.activityName);
        openIntent.putExtra("startTime", entry.startTime);
        PendingIntent openPi = PendingIntent.getBroadcast(
                this,
                notificationIdFor(entry.activityId),
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(entry.activityName)
                .setContentText("\u23f1 " + elapsed)   // ⏱
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(openPi)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .build();
    }

    private int notificationIdFor(String activityId) {
        return 1000 + Math.abs(activityId.hashCode() % 100000);
    }

    private void cancelLegacySummaryNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(SUMMARY_NOTIFICATION_ID);
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
        cancelLegacySummaryNotification();
        super.onDestroy();
    }
}
