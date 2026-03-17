package com.whentoquit.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Opens the app to a specific activity details screen when a timer notification
 * is tapped, and dismisses that specific notification row.
 */
public class OpenActivityReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String activityId = intent.getStringExtra("activityId");
        String activityName = intent.getStringExtra("activityName");

        // Dismiss this specific notification row while leaving timer running.
        Intent dismissIntent = new Intent(context, TimerService.class);
        dismissIntent.setAction(TimerService.ACTION_DISMISS_NOTIFICATION);
        dismissIntent.putExtra("activityId", activityId);
        context.startService(dismissIntent);

        // Reopen app on the activity details screen.
        Intent openApp = new Intent(context, MainActivity.class);
        openApp.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        openApp.putExtra("capacitor_action", "OPEN_ACTIVITY");
        openApp.putExtra("activityId", activityId);
        openApp.putExtra("activityName", activityName);
        context.startActivity(openApp);
    }
}
