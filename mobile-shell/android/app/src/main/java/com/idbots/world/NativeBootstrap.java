package com.idbots.world;

import android.content.Context;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

final class NativeBootstrap {
    private NativeBootstrap() {}

    static String script(Context context, String remoteOrigin, String platform) throws IOException {
        String template;
        try (InputStream input = context.getAssets().open("idbots-native-bootstrap.js")) {
            template = new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
        return template.replace("__IDBOTS_REMOTE_ORIGIN_JSON__", JSONObject.quote(remoteOrigin)).replace("__IDBOTS_PLATFORM_JSON__", JSONObject.quote(platform));
    }
}
