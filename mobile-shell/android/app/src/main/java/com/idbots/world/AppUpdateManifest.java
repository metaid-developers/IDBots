package com.idbots.world;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class AppUpdateManifest {
    static final long MAX_APK_BYTES = 512L * 1024L * 1024L;

    final String versionName;
    final int versionCode;
    final int minVersionCode;
    final String url;
    final String sha256;
    final long size;
    final String[] notesEnglish;
    final String[] notesChinese;
    final String sourceJson;

    private AppUpdateManifest(JSONObject json) throws JSONException {
        versionName = requiredText(json, "version", 64);
        versionCode = json.getInt("versionCode");
        minVersionCode = json.optInt("minVersionCode", 0);
        if (versionCode <= 0 || minVersionCode < 0 || minVersionCode > versionCode) {
            throw new IllegalArgumentException("Invalid Android version code");
        }
        url = validatedApkUrl(requiredText(json, "url", 2048));
        sha256 = requiredText(json, "sha256", 64).toLowerCase(Locale.ROOT);
        if (!sha256.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Invalid APK SHA-256");
        size = json.getLong("size");
        if (size <= 0 || size > MAX_APK_BYTES) throw new IllegalArgumentException("Invalid APK size");
        JSONObject changeLog = json.getJSONObject("changeLog");
        notesEnglish = readNotes(changeLog.getJSONObject("en").getJSONArray("content"));
        notesChinese = readNotes(changeLog.getJSONObject("ch").getJSONArray("content"));
        sourceJson = json.toString();
    }

    static AppUpdateManifest parse(String body) throws JSONException {
        JSONObject root = new JSONObject(body);
        if (root.getInt("code") != 0) throw new IllegalArgumentException("Update service returned an error");
        JSONObject value = root.getJSONObject("data").getJSONObject("value");
        if (!value.has("android") || value.isNull("android")) return null;
        return new AppUpdateManifest(value.getJSONObject("android"));
    }

    static AppUpdateManifest parseAndroid(String body) throws JSONException {
        return new AppUpdateManifest(new JSONObject(body));
    }

    boolean isNewerThan(int currentVersionCode) {
        return versionCode > currentVersionCode;
    }

    boolean isRequiredFor(int currentVersionCode) {
        return currentVersionCode < minVersionCode;
    }

    String[] notesFor(Locale locale) {
        boolean chinese = "zh".equals(locale.getLanguage());
        String[] preferred = chinese ? notesChinese : notesEnglish;
        return preferred.length > 0 ? preferred : (chinese ? notesEnglish : notesChinese);
    }

    private static String requiredText(JSONObject json, String key, int maxLength) throws JSONException {
        String value = json.getString(key).trim();
        if (value.isEmpty() || value.length() > maxLength) throw new IllegalArgumentException("Invalid " + key);
        return value;
    }

    private static String[] readNotes(JSONArray array) throws JSONException {
        if (array.length() > 20) throw new IllegalArgumentException("Too many release notes");
        String[] notes = new String[array.length()];
        for (int index = 0; index < array.length(); index++) {
            String note = array.getString(index).trim();
            if (note.isEmpty() || note.length() > 500) throw new IllegalArgumentException("Invalid release note");
            notes[index] = note;
        }
        return notes;
    }

    private static String validatedApkUrl(String value) {
        try {
            URI uri = new URI(value);
            boolean allowedHost = "app.idbots.world".equals(uri.getHost())
                || "download.idbots.ai".equals(uri.getHost());
            if (!"https".equals(uri.getScheme()) || !allowedHost || uri.getUserInfo() != null
                || (uri.getPort() != -1 && uri.getPort() != 443) || uri.getQuery() != null
                || uri.getFragment() != null || uri.getPath() == null || !uri.getPath().endsWith(".apk")) {
                throw new IllegalArgumentException("APK URL is not allowed");
            }
            return uri.toString();
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("Invalid APK URL", error);
        }
    }
}
