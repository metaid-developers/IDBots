package com.idbots.world;

import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private AppUpdateManager appUpdateManager;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeBackPlugin.class);
        registerPlugin(NativeCapabilitiesPlugin.class);
        super.onCreate(savedInstanceState);
        appUpdateManager = new AppUpdateManager(this);
        if (BuildConfig.DEBUG) {
            Log.i("NS0_START", "origin=" + BuildConfig.NATIVE_REMOTE_ORIGIN);
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        appUpdateManager.onResume();
    }

    @Override
    public void onPause() {
        appUpdateManager.onPause();
        super.onPause();
    }

    @Override
    public void onDestroy() {
        appUpdateManager.onDestroy();
        super.onDestroy();
    }

    @Override
    protected void load() {
        super.load();
        installNativeWebViewClient(bridge);
    }

    static void installNativeWebViewClient(Bridge bridge) {
        if (bridge == null) return;
        bridge.setWebViewClient(new NativeShellWebViewClient(bridge));
    }
}
