import Capacitor
import UIKit
import WebKit

final class NativeBridgeViewController: CAPBridgeViewController {
    private var nativeNavigationDelegate: NativeShellNavigationDelegate?

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        if let shell = NativeShellConfiguration.load(), let script = shell.bootstrapScript() {
            let userScript = WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            configuration.userContentController.addUserScript(userScript)
        }
        return super.webView(with: frame, configuration: configuration)
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let shell = NativeShellConfiguration.load(),
              let capacitorBridge = bridge as? CapacitorBridge,
              let offlineURL = shell.offlineURL(localURL: capacitorBridge.config.localURL),
              let webView else {
            return
        }
        capacitorBridge.registerPluginInstance(NativeCapabilitiesPlugin())
        let delegate = NativeShellNavigationDelegate(
            remoteOrigin: shell.remoteOrigin,
            offlineURL: offlineURL,
            capacitorDelegate: capacitorBridge.webViewDelegationHandler
        )
        nativeNavigationDelegate = delegate
        webView.navigationDelegate = delegate
    }
}
