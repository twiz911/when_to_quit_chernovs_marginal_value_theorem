package com.whentoquit.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.app.NotificationCompat;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

public class TimerService extends Service {

    public static final String ACTION_START = "ACTION_START";
    public static final String ACTION_STOP  = "ACTION_STOP";
    public static final String ACTION_DISMISS_NOTIFICATION = "ACTION_DISMISS_NOTIFICATION";

    private static final String CHANNEL_ID = "timer_channel";
    private static final String GROUP_KEY_TIMERS = "group_timers";
    private static final int SUMMARY_NOTIFICATION_ID = 1;
    private static final int FOREGROUND_NOTIFICATION_ID = 2;
    private static final int CHILD_NOTIFICATION_ID = 100;
    private static final String PREFS_NAME = "TimerPrefs";
    private static final String NOTIF_ID_NEXT_KEY = "notif_id_next";
    private static final String NOTIF_ID_PREFIX = "notif_id_";
    private static final long SHEET_SYNC_INTERVAL_MS = 15000;

    private static class TimerEntry {
        String activityId;
        String activityName;
        long startTime;
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, TimerEntry> runningTimers = new HashMap<>();
    private final Set<String> dismissedNotifications = new HashSet<>();
    private final Set<String> shownChildNotificationTags = new HashSet<>();
    private final Map<String, Integer> notificationIdsByActivity = new HashMap<>();
    private final Set<Integer> reservedNotificationIds = new HashSet<>();
    private volatile boolean sheetSyncInFlight = false;

    private final Runnable tickRunnable = new Runnable() {
        @Override public void run() {
            // No need to manually tick UI - Native setUsesChronometer handles it all.
            // handler.postDelayed(this, 1000);
        }
    };

    private final Runnable sheetSyncRunnable = new Runnable() {
        @Override public void run() {
            syncTimersFromSheetAsync();
            handler.postDelayed(this, SHEET_SYNC_INTERVAL_MS);
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
                entry.startTime = normalizeStartTime(
                        intent.getLongExtra("startTime", System.currentTimeMillis()),
                        System.currentTimeMillis()
                );
                runningTimers.put(activityId, entry);
                dismissedNotifications.remove(activityId);
            }
        } else if (ACTION_STOP.equals(action)) {
            String activityId = intent.getStringExtra("activityId");
            if (activityId != null && !activityId.isEmpty()) {
                runningTimers.remove(activityId);
                dismissedNotifications.remove(activityId);
                NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                if (nm != null) {
                    nm.cancel(notificationIdFor(activityId)); // legacy numeric child ID cleanup
                    nm.cancel(childNotificationTag(activityId), CHILD_NOTIFICATION_ID);
                }
            } else {
                runningTimers.clear();
                dismissedNotifications.clear();
            }
        } else if (ACTION_DISMISS_NOTIFICATION.equals(action)) {
            String activityId = intent.getStringExtra("activityId");
            if (activityId != null && !activityId.isEmpty()) {
                // Do not persistently suppress updates for tapped notifications.
                dismissedNotifications.remove(activityId);
                NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                if (nm != null) {
                    nm.cancel(notificationIdFor(activityId)); // legacy numeric child ID cleanup
                    nm.cancel(childNotificationTag(activityId), CHILD_NOTIFICATION_ID);
                }
            }
        }

        if (runningTimers.isEmpty()) {
            handler.removeCallbacks(tickRunnable);
            handler.removeCallbacks(sheetSyncRunnable);
            cancelAllChildNotifications();
            stopForeground(true);
            cancelLegacySummaryNotification();
            stopSelf();
            return START_NOT_STICKY;
        }

        startForegroundWithTimerNotification();
        updateNotifications();
        handler.removeCallbacks(tickRunnable);
        handler.post(tickRunnable);
        handler.removeCallbacks(sheetSyncRunnable);
        handler.postDelayed(sheetSyncRunnable, 3000);

        return START_STICKY;
    }

    private void syncTimersFromSheetAsync() {
        if (sheetSyncInFlight) return;

        SharedPreferences prefs = getSharedPreferences("TimerPrefs", MODE_PRIVATE);
        final String spreadsheetId = prefs.getString("spreadsheetId", null);
        final String accessToken = prefs.getString("authAccessToken", null);
        if (spreadsheetId == null || spreadsheetId.isEmpty() || accessToken == null || accessToken.isEmpty()) {
            return;
        }

        sheetSyncInFlight = true;
        new Thread(() -> {
            try {
                List<TimerEntry> remote = fetchTimersFromSheet(spreadsheetId, accessToken);
                if (remote == null) return;
                handler.post(() -> applyRemoteTimers(remote));
            } finally {
                sheetSyncInFlight = false;
            }
        }).start();
    }

    private List<TimerEntry> fetchTimersFromSheet(String spreadsheetId, String accessToken) {
        HttpURLConnection conn = null;
        try {
            String url = new Uri.Builder()
                    .scheme("https")
                    .authority("sheets.googleapis.com")
                    .appendPath("v4")
                    .appendPath("spreadsheets")
                    .appendPath(spreadsheetId)
                    .appendPath("values")
                    .appendPath("Timers!A2:B")
                    .build()
                    .toString();

            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Authorization", "Bearer " + accessToken);
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);

            int code = conn.getResponseCode();
            if (code == 401 || code == 403) {
                // Token expired or no longer valid; JS layer will refresh when app opens.
                return null;
            }
            if (code < 200 || code >= 300) {
                return null;
            }

            BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
            reader.close();

            JSONObject json = new JSONObject(sb.toString());
            JSONArray values = json.optJSONArray("values");
            Map<String, TimerEntry> latestByActivity = new HashMap<>();
            if (values == null) return new ArrayList<>();

            for (int i = 0; i < values.length(); i++) {
                JSONArray row = values.optJSONArray(i);
                if (row == null || row.length() < 1) continue;

                String activityId = row.optString(0, "");
                if (activityId.isEmpty()) continue;

                TimerEntry entry = new TimerEntry();
                entry.activityId = activityId;
                entry.activityName = resolveActivityName(activityId, "Activity");

                // Backward-compatible parse:
                // New rows: [activityId, startTime]
                // Legacy rows: [activityId, activityName, startTime]
                String rawStart = (row.length() > 2)
                    ? row.optString(2, "")
                    : row.optString(1, "");
                entry.startTime = parseRemoteStartTime(rawStart);

                TimerEntry existing = latestByActivity.get(activityId);
                if (existing == null || entry.startTime > existing.startTime) {
                    latestByActivity.put(activityId, entry);
                }
            }

            return new ArrayList<>(latestByActivity.values());
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void applyRemoteTimers(List<TimerEntry> remoteTimers) {
        Map<String, TimerEntry> remoteMap = new HashMap<>();
        for (TimerEntry t : remoteTimers) {
            remoteMap.put(t.activityId, t);
        }

        Set<String> localIds = new HashSet<>(runningTimers.keySet());

        for (String localId : localIds) {
            if (!remoteMap.containsKey(localId)) {
                runningTimers.remove(localId);
                dismissedNotifications.remove(localId);
                NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                if (nm != null) {
                    nm.cancel(notificationIdFor(localId)); // legacy numeric child ID cleanup
                    nm.cancel(childNotificationTag(localId), CHILD_NOTIFICATION_ID);
                }
            }
        }

        for (TimerEntry remote : remoteTimers) {
            TimerEntry existing = runningTimers.get(remote.activityId);
            long fallbackStart = (existing != null) ? existing.startTime : System.currentTimeMillis();
            remote.startTime = normalizeStartTime(remote.startTime, fallbackStart);
            remote.activityName = resolveActivityName(remote.activityId, remote.activityName);

            if (existing == null || existing.startTime != remote.startTime || !remote.activityName.equals(existing.activityName)) {
                runningTimers.put(remote.activityId, remote);
                dismissedNotifications.remove(remote.activityId);
            }
        }

        if (runningTimers.isEmpty()) {
            handler.removeCallbacks(tickRunnable);
            handler.removeCallbacks(sheetSyncRunnable);
            cancelAllChildNotifications();
            stopForeground(true);
            cancelLegacySummaryNotification();
            stopSelf();
            return;
        }

        updateNotifications();
    }

    private void updateNotifications() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;

        dismissedNotifications.clear();
        cancelLegacySummaryNotification();
        cancelLegacyNumericChildNotifications(nm);

        List<TimerEntry> ordered = getSortedRunningEntries();
        if (ordered.isEmpty()) {
            cancelAllChildNotifications();
            return;
        }

        // Post FGS Summary Notification
        Notification summaryNotification = buildForegroundGroupSummaryNotification();
        nm.notify(FOREGROUND_NOTIFICATION_ID, summaryNotification);
        startForeground(FOREGROUND_NOTIFICATION_ID, summaryNotification);

        Set<String> targetChildNotificationTags = new HashSet<>();

        // Post individual child notifications mapped to the group summary
        for (TimerEntry entry : ordered) {
            String childTag = childNotificationTag(entry.activityId);
            targetChildNotificationTags.add(childTag);
            Notification childNotif = buildActivityNotification(entry, notificationSortKey(entry));
            nm.notify(childTag, CHILD_NOTIFICATION_ID, childNotif);
        }

        // Cleanup stale child notifications
        for (String shownTag : new HashSet<>(shownChildNotificationTags)) {
            if (!targetChildNotificationTags.contains(shownTag)) {
                nm.cancel(shownTag, CHILD_NOTIFICATION_ID);
            }
        }
        shownChildNotificationTags.clear();
        shownChildNotificationTags.addAll(targetChildNotificationTags);
    }

    private void startForegroundWithTimerNotification() {
        if (runningTimers.isEmpty()) return;

        startForeground(
                FOREGROUND_NOTIFICATION_ID,
                buildForegroundGroupSummaryNotification()
        );
    }

    private Notification buildForegroundGroupSummaryNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(
                this,
                FOREGROUND_NOTIFICATION_ID,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle("Activities Running")
                .setContentIntent(openPi)
                .setGroup(GROUP_KEY_TIMERS)
                .setGroupSummary(true)
                .setOngoing(true)
                .setAutoCancel(false)
                .setOnlyAlertOnce(true)
                .setSilent(true);

        Notification notification = builder.build();
        notification.flags |= Notification.FLAG_NO_CLEAR | Notification.FLAG_ONGOING_EVENT;
        return notification;
    }

    private Notification buildActivityNotification(TimerEntry entry, String sortKey) {
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

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(entry.activityName)
                .setContentText("\u23f1 Running")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(openPi)
                .setGroup(GROUP_KEY_TIMERS)
                .setSortKey(sortKey)
                .setOngoing(true)
                .setAutoCancel(false)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setShowWhen(true)
                .setWhen(entry.startTime)
                .setUsesChronometer(true);

        Notification notification = builder.build();
        notification.flags |= Notification.FLAG_NO_CLEAR | Notification.FLAG_ONGOING_EVENT;
        return notification;
    }

    private String notificationSortKey(TimerEntry entry) {
        String name = (entry.activityName == null) ? "" : entry.activityName.toLowerCase(Locale.US);
        String id = (entry.activityId == null) ? "" : entry.activityId;
        return name + "|" + id;
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

    private List<TimerEntry> getSortedRunningEntries() {
        List<TimerEntry> sorted = new ArrayList<>(runningTimers.values());
        sorted.sort(Comparator
                .comparing((TimerEntry t) -> (t.activityName == null ? "" : t.activityName.toLowerCase(Locale.US)))
                .thenComparing(t -> (t.activityId == null ? "" : t.activityId)));
        return sorted;
    }

    private String resolveActivityName(String activityId, String fallback) {
        SharedPreferences prefs = getSharedPreferences("TimerPrefs", MODE_PRIVATE);
        String activitiesJson = prefs.getString("activities", "[]");
        try {
            JSONArray arr = new JSONArray(activitiesJson);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.optJSONObject(i);
                if (obj == null) continue;
                String id = obj.optString("id", "");
                if (!activityId.equals(id)) continue;
                String name = obj.optString("name", "");
                if (!name.isEmpty()) return name;
            }
        } catch (Exception ignored) {
        }
        return (fallback == null || fallback.isEmpty()) ? "Activity" : fallback;
    }

    private long parseRemoteStartTime(String rawStart) {
        if (rawStart == null || rawStart.isEmpty()) return -1;
        try {
            return Instant.parse(rawStart).toEpochMilli();
        } catch (Exception ignored) {
        }
        try {
            return Long.parseLong(rawStart);
        } catch (Exception ignored) {
        }
        return -1;
    }

    private long normalizeStartTime(long candidateStart, long fallbackStart) {
        long now = System.currentTimeMillis();
        long safeFallback = (fallbackStart > 0) ? fallbackStart : now;
        if (candidateStart <= 0) return safeFallback;
        // If start time is way in the future (clock skew/bad parse), keep timer counting from fallback.
        if (candidateStart > now + 60000) return safeFallback;
        return candidateStart;
    }

    private synchronized int notificationIdFor(String activityId) {
        Integer cached = notificationIdsByActivity.get(activityId);
        if (cached != null && cached > 0 && cached != SUMMARY_NOTIFICATION_ID && cached != FOREGROUND_NOTIFICATION_ID) {
            return cached;
        }

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        int existing = prefs.getInt(NOTIF_ID_PREFIX + activityId, -1);
        if (existing > 0 && existing != SUMMARY_NOTIFICATION_ID && existing != FOREGROUND_NOTIFICATION_ID) {
            notificationIdsByActivity.put(activityId, existing);
            reservedNotificationIds.add(existing);
            return existing;
        }

        int next = prefs.getInt(NOTIF_ID_NEXT_KEY, 1000);
        if (next <= FOREGROUND_NOTIFICATION_ID) next = 1000;
        if (next >= Integer.MAX_VALUE - 10) next = 1000;

        while (next == SUMMARY_NOTIFICATION_ID
                || next == FOREGROUND_NOTIFICATION_ID
                || reservedNotificationIds.contains(next)) {
            next += 1;
            if (next >= Integer.MAX_VALUE - 10) {
                next = 1000;
            }
        }

        prefs.edit()
                .putInt(NOTIF_ID_PREFIX + activityId, next)
                .putInt(NOTIF_ID_NEXT_KEY, next + 1)
                .commit();

        notificationIdsByActivity.put(activityId, next);
        reservedNotificationIds.add(next);
        return next;
    }

    private void cancelAllChildNotifications() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        for (String shownTag : new HashSet<>(shownChildNotificationTags)) {
            nm.cancel(shownTag, CHILD_NOTIFICATION_ID);
        }
        shownChildNotificationTags.clear();
    }

    private String childNotificationTag(String activityId) {
        return "timer_activity_" + activityId;
    }

    private void cancelLegacyNumericChildNotifications(NotificationManager nm) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        Map<String, ?> all = prefs.getAll();
        for (Map.Entry<String, ?> entry : all.entrySet()) {
            String key = entry.getKey();
            if (key == null || !key.startsWith(NOTIF_ID_PREFIX)) continue;
            Object val = entry.getValue();
            if (!(val instanceof Integer)) continue;
            int id = (Integer) val;
            if (id <= 0 || id == SUMMARY_NOTIFICATION_ID || id == FOREGROUND_NOTIFICATION_ID) continue;
            nm.cancel(id);
        }
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
        handler.removeCallbacks(sheetSyncRunnable);
        cancelAllChildNotifications();
        cancelLegacySummaryNotification();
        super.onDestroy();
    }
}
