package com.whentoquit.app;

import android.content.Intent;
import android.content.SharedPreferences;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "TimerPlugin")
public class TimerPlugin extends Plugin {

    /** Start (or update) the foreground timer service. */
    @PluginMethod
    public void startService(PluginCall call) {
        String activityId   = call.getString("activityId", "");
        String activityName = call.getString("activityName", "");
        long   startTime    = call.getLong("startTime", System.currentTimeMillis());

        Intent intent = new Intent(getContext(), TimerService.class);
        intent.setAction(TimerService.ACTION_START);
        intent.putExtra("activityId",   activityId);
        intent.putExtra("activityName", activityName);
        intent.putExtra("startTime",    startTime);
        ContextCompat.startForegroundService(getContext(), intent);
        call.resolve();
    }

    /** Stop the foreground timer service. */
    @PluginMethod
    public void stopService(PluginCall call) {
        Intent intent = new Intent(getContext(), TimerService.class);
        intent.setAction(TimerService.ACTION_STOP);
        String activityId = call.getString("activityId", null);
        if (activityId != null && !activityId.isEmpty()) {
            intent.putExtra("activityId", activityId);
        }
        getContext().startService(intent);
        call.resolve();
    }

    /**
     * Sync the activity list from JS so the notification "Start next" picker
     * and StopRateReceiver can read it without a live JS bridge.
     */
    @PluginMethod
    public void syncActivities(PluginCall call) {
        JSArray activities = call.getArray("activities");
        String json = (activities != null) ? activities.toString() : "[]";
        getContext()
            .getSharedPreferences("TimerPrefs", 0)
            .edit()
            .putString("activities", json)
            .apply();
        call.resolve();
    }

    /**
     * Check whether the app was launched/resumed from the "Stop & Rate"
     * notification action.  Returns { action: "STOP_AND_RATE", activityId,
     * activityName, startTime } or { action: "none" }.
     */
    @PluginMethod
    public void getIntentAction(PluginCall call) {
        Intent intent = getActivity().getIntent();
        JSObject result = new JSObject();
        String action = (intent != null) ? intent.getStringExtra("capacitor_action") : null;

        if ("STOP_AND_RATE".equals(action)) {
            result.put("action",       "STOP_AND_RATE");
            result.put("activityId",   intent.getStringExtra("activityId"));
            result.put("activityName", intent.getStringExtra("activityName"));
            result.put("startTime",    intent.getLongExtra("startTime", 0));
            // Consume so it is not replayed on the next call
            intent.removeExtra("capacitor_action");
        } else if ("OPEN_ACTIVITY".equals(action)) {
            result.put("action", "OPEN_ACTIVITY");
            result.put("activityId", intent.getStringExtra("activityId"));
            result.put("activityName", intent.getStringExtra("activityName"));
            intent.removeExtra("capacitor_action");
        } else {
            result.put("action", "none");
        }
        call.resolve(result);
    }
}
