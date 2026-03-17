package com.whentoquit.app;

import android.content.Intent;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(android.os.Bundle savedInstanceState) {
        // Register the custom TimerPlugin before the bridge initialises
        registerPlugin(TimerPlugin.class);
        super.onCreate(savedInstanceState);

        // Google Identity Services detects Android WebViews via the "wv" marker in the
        // user-agent string and refuses to initialise google.accounts inside them.
        // Stripping that marker makes GIS behave as if it is running in a normal browser.
        WebSettings settings = getBridge().getWebView().getSettings();
        String ua = settings.getUserAgentString();
        // The WebView UA contains "; wv)" or " wv " – remove all occurrences.
        String cleanUa = ua.replace("; wv)", ")").replace("; wv ", " ").replace(" wv)", ")");
        if (!cleanUa.equals(ua)) {
            settings.setUserAgentString(cleanUa);
        }
    }

    /**
     * Forward new intents (e.g. from StopRateReceiver when the app is already
     * running) so that TimerPlugin.getIntentAction() sees the latest intent.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
    }
}
