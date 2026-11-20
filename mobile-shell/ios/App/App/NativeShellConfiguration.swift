import Foundation

struct NativeShellConfiguration {
    let flavor: String
    let remoteOrigin: String
    let remoteURL: URL

    static func load() -> NativeShellConfiguration? {
        guard let url = Bundle.main.url(forResource: "NativeShellFlavor", withExtension: "plist"),
              let data = try? Data(contentsOf: url),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: String],
              let flavor = plist["Flavor"], let remoteOrigin = plist["RemoteOrigin"] else {
            return nil
        }
        let expectedOrigin: String
        switch flavor {
        case "staging": expectedOrigin = "https://staging.idbots.world"
        case "production": expectedOrigin = "https://app.idbots.world"
        default: return nil
        }
        guard remoteOrigin == expectedOrigin,
              let remoteURL = URL(string: remoteOrigin + "/"),
              NativeOriginPolicy.isTrustedRemote(remoteURL, remoteOrigin: remoteOrigin) else {
            return nil
        }
        return NativeShellConfiguration(flavor: flavor, remoteOrigin: remoteOrigin, remoteURL: remoteURL)
    }

    func bootstrapScript() -> String? {
        let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let appVersionCode = Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0
        guard let url = Bundle.main.url(forResource: "idbots-native-bootstrap", withExtension: "js"),
              let template = try? String(contentsOf: url, encoding: .utf8),
              let originData = try? JSONEncoder().encode(remoteOrigin),
              let platformData = try? JSONEncoder().encode("ios"),
              let appVersionData = try? JSONEncoder().encode(appVersion),
              let appVersionCodeData = try? JSONEncoder().encode(appVersionCode),
              let originJSON = String(data: originData, encoding: .utf8),
              let platformJSON = String(data: platformData, encoding: .utf8),
              let appVersionJSON = String(data: appVersionData, encoding: .utf8),
              let appVersionCodeJSON = String(data: appVersionCodeData, encoding: .utf8) else {
            return nil
        }
        return template
            .replacingOccurrences(of: "__IDBOTS_REMOTE_ORIGIN_JSON__", with: originJSON)
            .replacingOccurrences(of: "__IDBOTS_PLATFORM_JSON__", with: platformJSON)
            .replacingOccurrences(of: "__IDBOTS_APP_VERSION_JSON__", with: appVersionJSON)
            .replacingOccurrences(of: "__IDBOTS_APP_VERSION_CODE_JSON__", with: appVersionCodeJSON)
    }

    func offlineURL(localURL: URL) -> URL? {
        guard var components = URLComponents(url: localURL, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/offline.html"
        components.queryItems = [URLQueryItem(name: "retry", value: remoteURL.absoluteString)]
        return components.url
    }
}

enum NativeOriginPolicy {
    static func isTrustedRemote(_ url: URL, remoteOrigin: String) -> Bool {
        guard let expected = URLComponents(string: remoteOrigin), let actual = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return false
        }
        return isHttpsOrigin(expected) && isHttpsOrigin(actual) && expected.host?.lowercased() == actual.host?.lowercased()
    }

    static func isBundledOffline(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false), let scheme = components.scheme?.lowercased() else { return false }
        return (scheme == "capacitor" || scheme == "https") && components.host?.lowercased() == "localhost" &&
            (components.port == nil || components.port == 443) && components.path == "/offline.html" && components.user == nil && components.password == nil
    }

    static func isApprovedExternal(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false), let scheme = components.scheme?.lowercased() else { return false }
        guard components.host != nil, components.user == nil, components.password == nil else { return false }
        return scheme == "https" || scheme == "http" || scheme == "alipays"
    }

    private static func isHttpsOrigin(_ components: URLComponents) -> Bool {
        return components.scheme?.lowercased() == "https" && components.host != nil &&
            (components.port == nil || components.port == 443) && components.user == nil && components.password == nil
    }
}
