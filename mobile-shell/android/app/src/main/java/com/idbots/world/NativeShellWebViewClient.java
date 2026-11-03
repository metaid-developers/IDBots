package com.idbots.world;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

public class NativeShellWebViewClient extends BridgeWebViewClient {
    private final Bridge bridge;

    NativeShellWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        String candidate = request.getUrl().toString();
        if (NativeOriginPolicy.isTrustedRemote(candidate, BuildConfig.NATIVE_REMOTE_ORIGIN) || NativeOriginPolicy.isBundledOffline(candidate)) {
            return false;
        }
        if (request.isForMainFrame() && NativeOriginPolicy.isApprovedExternal(candidate)) {
            openExternal(candidate);
        }
        return true;
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        String currentUrl = view.getUrl();
        if (BuildConfig.DEBUG && currentUrl != null && NativeOriginPolicy.isTrustedRemote(currentUrl, BuildConfig.NATIVE_REMOTE_ORIGIN)) {
            String proof = "(function(){var n=window.idbotsNative;var p=window.idbotsNativeProof;var f=window.idbotsMobile;if(!n||location.origin!=='" + BuildConfig.NATIVE_REMOTE_ORIGIN + "')return null;return JSON.stringify({origin:location.origin,nativeBridgeVersion:n&&n.nativeBridgeVersion,nativePhase:n&&n.bootstrap&&n.bootstrap.phase,platform:n&&n.bootstrap&&n.bootstrap.platform,proof:p,capabilities:n&&n.getCapabilities(),shell:f&&f.shell,os:f&&f.os});})()";
            view.evaluateJavascript(proof, value -> {
                if (value != null && !"null".equals(value)) {
                    Log.i("NS0_BOOTSTRAP", value);
                }
            });
        }
    }

    private void openExternal(String candidate) {
        try {
            Uri uri = Uri.parse(candidate);
            if (BuildConfig.DEBUG) {
                Log.i("NS0_EXTERNAL_HANDOFF", "scheme=" + uri.getScheme() + " host=" + uri.getHost());
            }
            bridge.getActivity().startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            Log.w("NS0_NAVIGATION", "No system application accepted an approved external link");
        }
    }
}
