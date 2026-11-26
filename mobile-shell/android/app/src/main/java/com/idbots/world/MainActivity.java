package com.idbots.world;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    static volatile AppUpdateManager appUpdateManager;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeBackPlugin.class);
        registerPlugin(NativeCapabilitiesPlugin.class);
        super.onCreate(savedInstanceState);
        createNotificationChannels();
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
        appUpdateManager = null;
        super.onDestroy();
    }

    @Override
    protected void load() {
        super.load();
        installNativeWebViewClient(bridge);
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        String[] ids = {"work", "action", "report", "system"};
        int[] names = {R.string.notification_channel_work, R.string.notification_channel_action, R.string.notification_channel_report, R.string.notification_channel_system};
        for (int index = 0; index < ids.length; index++) {
            int importance = "action".equals(ids[index]) ? NotificationManager.IMPORTANCE_HIGH : NotificationManager.IMPORTANCE_DEFAULT;
            NotificationChannel channel = new NotificationChannel(ids[index], getString(names[index]), importance);
            manager.createNotificationChannel(channel);
        }
    }

    static void installNativeWebViewClient(Bridge bridge) {
        if (bridge == null) return;
        bridge.setWebViewClient(new NativeShellWebViewClient(bridge));
    }
}
