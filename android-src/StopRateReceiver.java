package com.whentoquit.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Receives the "Stop & Rate" broadcast from the persistent notification,
 * stops the foreground service, then reopens the app with a STOP_AND_RATE
 * intent extra so the JS quick-rate modal can be shown.
 */
public class StopRateReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        // 1. Stop the foreground timer service
        Intent stopService = new Intent(context, TimerService.class);
        stopService.setAction(TimerService.ACTION_STOP);
        context.startService(stopService);

        // 2. Bring the app to foreground with STOP_AND_RATE payload
        Intent openApp = new Intent(context, MainActivity.class);
        openApp.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        openApp.putExtra("capacitor_action", "STOP_AND_RATE");
        openApp.putExtra("activityId",   intent.getStringExtra("activityId"));
        openApp.putExtra("activityName", intent.getStringExtra("activityName"));
        openApp.putExtra("startTime",    intent.getLongExtra("startTime", 0));
        context.startActivity(openApp);
    }
}
