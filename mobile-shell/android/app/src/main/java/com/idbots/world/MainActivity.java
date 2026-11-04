package com.idbots.world;

import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        String remoteOrigin = BuildConfig.NATIVE_REMOTE_ORIGIN;
        config = new CapConfig.Builder(this)
            .setServerUrl(remoteOrigin + "/")
            .setErrorPath("offline.html?retry=" + Uri.encode(remoteOrigin + "/"))
            .setAllowNavigation(new String[] { Uri.parse(remoteOrigin).getHost() })
            .setAndroidScheme("https")
            .setAllowMixedContent(false)
            .setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
            .setLoggingEnabled(false)
            .setInitialFocus(true)
            .setBackgroundColor("#F5F7F9")
            .create();
        registerPlugin(NativeBackPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void load() {
        super.load();
        bridge.setWebViewClient(new NativeShellWebViewClient(bridge));
    }
}
