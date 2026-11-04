package com.idbots.world;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Android-only deterministic exit for an unhandled product-root Back. */
@CapacitorPlugin(name = "NativeBack")
public class NativeBackPlugin extends Plugin {
    @PluginMethod
    public void exitApp(PluginCall call) {
        call.resolve();
        getBridge().getActivity().finish();
    }
}
