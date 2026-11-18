package com.idbots.world;

import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        registerPlugin(NativeBackPlugin.class);
        registerPlugin(NativeCapabilitiesPlugin.class);
        if (BuildConfig.DEBUG) {
            Log.i("NS0_START", "origin=" + BuildConfig.NATIVE_REMOTE_ORIGIN);
        }
        bridge.setWebViewClient(new NativeShellWebViewClient(bridge));
    }
}
