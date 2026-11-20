package com.idbots.world;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;
import java.util.Locale;
import org.junit.Test;

public class AppUpdateManifestTest {
    @Test
    public void parsesAndroidEntryWithoutChangingDesktopVersion() throws Exception {
        AppUpdateManifest manifest = AppUpdateManifest.parse(envelope(android(6, "https://app.idbots.world/downloads/IDBots-Android-0.1.4.apk")));
        assertEquals("0.1.4", manifest.versionName);
        assertEquals(6, manifest.versionCode);
        assertEquals("https://app.idbots.world/downloads/IDBots-Android-0.1.4.apk", manifest.url);
        assertEquals(12345678, manifest.size);
        assertArrayEquals(new String[]{"Secure automatic updates"}, manifest.notesFor(Locale.ENGLISH));
        assertArrayEquals(new String[]{"安全的自动更新"}, manifest.notesFor(Locale.CHINA));
    }

    @Test
    public void desktopOnlyManifestDoesNotOfferAnAndroidUpdate() throws Exception {
        assertNull(AppUpdateManifest.parse("{\"code\":0,\"data\":{\"value\":{\"version\":\"1.1.1\"}}}"));
    }

    @Test
    public void versionAndRequiredChecksUseIntegerVersionCodes() throws Exception {
        AppUpdateManifest manifest = AppUpdateManifest.parseAndroid(android(6, "https://download.idbots.ai/IDBots-Android-0.1.4.apk"));
        assertTrue(manifest.isNewerThan(5));
        assertFalse(manifest.isNewerThan(6));
        assertFalse(manifest.isRequiredFor(5));
        AppUpdateManifest required = AppUpdateManifest.parseAndroid(android(6, "https://app.idbots.world/downloads/update.apk").replace("\"minVersionCode\":0", "\"minVersionCode\":6"));
        assertTrue(required.isRequiredFor(5));
        assertFalse(required.isRequiredFor(6));
    }

    @Test
    public void rejectsUntrustedUrlsAndBadIntegrityMetadata() {
        for (String url : new String[]{
            "http://app.idbots.world/downloads/update.apk",
            "https://example.com/update.apk",
            "https://user@app.idbots.world/downloads/update.apk",
            "https://app.idbots.world/downloads/update.txt",
            "https://app.idbots.world/downloads/update.apk?source=other"
        }) {
            assertThrows(IllegalArgumentException.class,
                () -> AppUpdateManifest.parseAndroid(android(6, url)));
        }
        assertThrows(IllegalArgumentException.class,
            () -> AppUpdateManifest.parseAndroid(android(6, "https://app.idbots.world/downloads/update.apk").replace(repeat('a', 64), repeat('g', 64))));
        assertThrows(IllegalArgumentException.class,
            () -> AppUpdateManifest.parseAndroid(android(6, "https://app.idbots.world/downloads/update.apk").replace("\"size\":12345678", "\"size\":0")));
        assertThrows(IllegalArgumentException.class,
            () -> AppUpdateManifest.parseAndroid(android(6, "https://app.idbots.world/downloads/update.apk").replace("\"minVersionCode\":0", "\"minVersionCode\":7")));
    }

    @Test
    public void rejectsMalformedOrOversizedReleaseNotes() {
        assertThrows(Exception.class, () -> AppUpdateManifest.parseAndroid("not-json"));
        String oversized = repeat('x', 501);
        assertThrows(IllegalArgumentException.class,
            () -> AppUpdateManifest.parseAndroid(android(6, "https://app.idbots.world/downloads/update.apk").replace("Secure automatic updates", oversized)));
    }

    private static String envelope(String android) {
        return "{\"code\":0,\"data\":{\"value\":{\"version\":\"1.1.1\",\"android\":" + android + "}}}";
    }

    private static String android(int versionCode, String url) {
        return "{\"version\":\"0.1.4\",\"versionCode\":" + versionCode + ",\"minVersionCode\":0,"
            + "\"url\":\"" + url + "\",\"sha256\":\"" + repeat('a', 64) + "\",\"size\":12345678,"
            + "\"changeLog\":{\"en\":{\"title\":\"Release Notes\",\"content\":[\"Secure automatic updates\"]},"
            + "\"ch\":{\"title\":\"更新说明\",\"content\":[\"安全的自动更新\"]}}}";
    }

    private static String repeat(char value, int count) {
        StringBuilder result = new StringBuilder(count);
        for (int index = 0; index < count; index++) result.append(value);
        return result.toString();
    }
}
