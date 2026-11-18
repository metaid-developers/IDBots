package com.idbots.world;

import android.content.Context;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

final class NativeBootstrap {
    private NativeBootstrap() {}

    static String script(Context context, String remoteOrigin, String platform) throws IOException {
        try (InputStream input = context.getAssets().open("idbots-native-bootstrap.js")) {
            String template = readUtf8(input);
            return template
                .replace("__IDBOTS_REMOTE_ORIGIN_JSON__", JSONObject.quote(remoteOrigin))
                .replace("__IDBOTS_PLATFORM_JSON__", JSONObject.quote(platform));
        }
    }

    static String readUtf8(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int read;
        while ((read = input.read(buffer)) != -1) {
            output.write(buffer, 0, read);
        }
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }
}
