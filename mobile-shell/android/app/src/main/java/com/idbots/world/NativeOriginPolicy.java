package com.idbots.world;

import java.net.URI;

public final class NativeOriginPolicy {
    private NativeOriginPolicy() {}

    public static boolean isTrustedRemote(String candidate, String remoteOrigin) {
        try {
            URI expected = URI.create(remoteOrigin);
            URI actual = URI.create(candidate);
            return isHttpsOrigin(expected) && isHttpsOrigin(actual) && expected.getHost().equalsIgnoreCase(actual.getHost());
        } catch (RuntimeException error) {
            return false;
        }
    }

    public static boolean isBundledOffline(String candidate) {
        try {
            URI uri = URI.create(candidate);
            boolean localScheme = "https".equalsIgnoreCase(uri.getScheme()) || "capacitor".equalsIgnoreCase(uri.getScheme());
            int port = uri.getPort();
            return localScheme && "localhost".equalsIgnoreCase(uri.getHost()) && (port == -1 || port == 443) && "/offline.html".equals(uri.getPath()) && uri.getUserInfo() == null;
        } catch (RuntimeException error) {
            return false;
        }
    }

    public static boolean isApprovedExternal(String candidate) {
        try {
            URI uri = URI.create(candidate);
            String scheme = uri.getScheme();
            if ("alipays".equalsIgnoreCase(scheme)) {
                return uri.getHost() != null && uri.getUserInfo() == null;
            }
            return ("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme)) && uri.getHost() != null && uri.getUserInfo() == null;
        } catch (RuntimeException error) {
            return false;
        }
    }

    private static boolean isHttpsOrigin(URI uri) {
        int port = uri.getPort();
        return "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null && (port == -1 || port == 443) && uri.getUserInfo() == null;
    }
}
