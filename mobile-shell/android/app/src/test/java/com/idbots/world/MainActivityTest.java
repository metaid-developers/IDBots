package com.idbots.world;

import org.junit.Test;

public class MainActivityTest {
    @Test
    public void missingBridgeSkipsWebViewClientInstallation() {
        MainActivity.installNativeWebViewClient(null);
    }
}
