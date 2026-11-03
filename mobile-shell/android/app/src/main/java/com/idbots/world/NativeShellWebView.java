package com.idbots.world;

import android.content.Context;
import android.net.Uri;
import android.util.AttributeSet;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.CapacitorWebView;
import java.io.IOException;
import java.util.Collections;

public class NativeShellWebView extends CapacitorWebView {
    private boolean bootstrapRegistered = false;

    public NativeShellWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    public void loadUrl(String url) {
        if (!bootstrapRegistered && NativeOriginPolicy.isTrustedRemote(url, BuildConfig.NATIVE_REMOTE_ORIGIN)) {
            bootstrapRegistered = true;
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                super.loadUrl(offlineUrl());
                return;
            }
            try {
                String script = NativeBootstrap.script(getContext(), BuildConfig.NATIVE_REMOTE_ORIGIN, "android");
                WebViewCompat.addDocumentStartJavaScript(this, script, Collections.singleton(BuildConfig.NATIVE_REMOTE_ORIGIN));
            } catch (IOException | IllegalArgumentException error) {
                super.loadUrl(offlineUrl());
                return;
            }
        }
        super.loadUrl(url);
    }

    private String offlineUrl() {
        return "https://localhost/offline.html?retry=" + Uri.encode(BuildConfig.NATIVE_REMOTE_ORIGIN + "/");
    }
}
