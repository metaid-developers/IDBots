package com.idbots.world;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import org.junit.Test;

public class NativeOriginPolicyTest {
    private static final String STAGING = "https://staging.idbots.world";

    @Test
    public void acceptsOnlyTheExactTrustedHttpsOrigin() {
        assertTrue(NativeOriginPolicy.isTrustedRemote("https://staging.idbots.world/app/?tab=chat", STAGING));
        assertTrue(NativeOriginPolicy.isTrustedRemote("https://staging.idbots.world:443/", STAGING));
        assertFalse(NativeOriginPolicy.isTrustedRemote("http://staging.idbots.world/", STAGING));
        assertFalse(NativeOriginPolicy.isTrustedRemote("https://staging.idbots.world:444/", STAGING));
        assertFalse(NativeOriginPolicy.isTrustedRemote("https://staging.idbots.world.evil.example/", STAGING));
        assertFalse(NativeOriginPolicy.isTrustedRemote("https://staging.idbots.world@evil.example/", STAGING));
        assertFalse(NativeOriginPolicy.isTrustedRemote("https://evil.example/", STAGING));
    }

    @Test
    public void allowsOnlyTheBundledOfflineDocument() {
        assertTrue(NativeOriginPolicy.isBundledOffline("https://localhost/offline.html?retry=https%3A%2F%2Fstaging.idbots.world%2F"));
        assertTrue(NativeOriginPolicy.isBundledOffline("capacitor://localhost/offline.html"));
        assertFalse(NativeOriginPolicy.isBundledOffline("https://localhost/index.html"));
        assertFalse(NativeOriginPolicy.isBundledOffline("https://evil.example/offline.html"));
    }

    @Test
    public void limitsSystemHandoffToApprovedSchemes() {
        assertTrue(NativeOriginPolicy.isApprovedExternal("https://qr.alipay.com/pay"));
        assertTrue(NativeOriginPolicy.isApprovedExternal("http://example.com/"));
        assertTrue(NativeOriginPolicy.isApprovedExternal("alipays://platformapi/startapp?saId=10000007"));
        assertFalse(NativeOriginPolicy.isApprovedExternal("javascript:alert(1)"));
        assertFalse(NativeOriginPolicy.isApprovedExternal("file:///data/user/0/com.idbots.world/private"));
        assertFalse(NativeOriginPolicy.isApprovedExternal("https://user@example.com/"));
    }
}
