import AVFoundation
import Capacitor
import Photos
import UIKit
import UniformTypeIdentifiers

@objc(NativeCapabilitiesPlugin)
public class NativeCapabilitiesPlugin: CAPPlugin, CAPBridgedPlugin, UIImagePickerControllerDelegate, UINavigationControllerDelegate, UIDocumentPickerDelegate {
    public let identifier = "NativeCapabilitiesPlugin"
    public let jsName = "NativeCapabilities"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickPhoto", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareArtifact", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSecureScreen", returnType: CAPPluginReturnPromise),
    ]

    private let maxFileBytes = 25 * 1024 * 1024
    private var photoCall: CAPPluginCall?
    private var filesCall: CAPPluginCall?
    private var temporaryCameraFiles: [String: URL] = [:]

    @objc func pickPhoto(_ call: CAPPluginCall) {
        guard photoCall == nil, filesCall == nil else {
            call.reject("Another picker is active", "UNAVAILABLE")
            return
        }
        photoCall = call
        if call.getString("source", "photos") == "camera" {
            requestCameraAccess { [weak self] granted in
                guard granted else {
                    self?.photoCall = nil
                    call.reject("Camera permission was denied", "PERMISSION_DENIED")
                    return
                }
                self?.presentCamera(call)
            }
        } else {
            requestPhotoAccess { [weak self] granted in
                guard granted else {
                    self?.photoCall = nil
                    call.reject("Photo library permission was denied", "PERMISSION_DENIED")
                    return
                }
                self?.presentPhotoLibrary(call)
            }
        }
    }

    private func requestCameraAccess(completion: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            completion(true)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async { completion(granted) }
            }
        case .denied, .restricted:
            completion(false)
        @unknown default:
            completion(false)
        }
    }

    private func requestPhotoAccess(completion: @escaping (Bool) -> Void) {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized, .limited:
            completion(true)
        case .notDetermined:
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
                DispatchQueue.main.async { completion(status == .authorized || status == .limited) }
            }
        case .denied, .restricted:
            completion(false)
        @unknown default:
            completion(false)
        }
    }

    private func presentCamera(_ call: CAPPluginCall) {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            photoCall = nil
            call.reject("The camera is unavailable", "UNAVAILABLE")
            return
        }
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = self
        bridge?.viewController?.present(picker, animated: true)
    }

    private func presentPhotoLibrary(_ call: CAPPluginCall) {
        let picker = UIImagePickerController()
        picker.sourceType = .photoLibrary
        picker.delegate = self
        bridge?.viewController?.present(picker, animated: true)
    }

    @objc func pickFiles(_ call: CAPPluginCall) {
        guard photoCall == nil, filesCall == nil else {
            call.reject("Another picker is active", "UNAVAILABLE")
            return
        }
        filesCall = call
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.data])
        picker.allowsMultipleSelection = call.getBool("allowMultiple", true)
        picker.delegate = self
        bridge?.viewController?.present(picker, animated: true)
    }

    public func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        photoCall?.resolve()
        photoCall = nil
    }

    public func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        guard let call = photoCall else { return }
        photoCall = nil
        do {
            var url = info[.imageURL] as? URL
            var temporary = false
            if picker.sourceType == .camera || url == nil {
                guard let image = info[.originalImage] as? UIImage,
                      let data = image.jpegData(compressionQuality: 0.9) else {
                    call.reject("Unable to read the selected photo", "NATIVE_FAILED")
                    return
                }
                let target = FileManager.default.temporaryDirectory.appendingPathComponent("camera-\(UUID().uuidString).jpg")
                try data.write(to: target, options: .atomic)
                temporaryCameraFiles[target.absoluteString] = target
                temporary = true
                url = target
            }
            guard let selected = url else {
                call.resolve()
                return
            }
            call.resolve(["file": try descriptor(for: selected, temporary: temporary)])
        } catch {
            call.reject("Unable to read the selected photo", "NATIVE_FAILED", error)
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        filesCall?.resolve()
        filesCall = nil
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = filesCall else { return }
        filesCall = nil
        do {
            let files = try urls.map { try descriptor(for: $0, temporary: false) }
            call.resolve(["files": files])
        } catch {
            call.reject("Unable to read the selected files", "NATIVE_FAILED", error)
        }
    }

    @objc func readFile(_ call: CAPPluginCall) {
        guard let raw = call.getString("uri"), let url = URL(string: raw) else {
            call.reject("A file URI is required", "NATIVE_FAILED")
            return
        }
        let temporary = call.getBool("temporary", false)
        defer { if temporary { deleteTemporaryCameraFile(raw) } }
        do {
            if url.isFileURL && !isOwnedCameraFile(url) {
                call.reject("Only temporary camera files can be read by path", "NATIVE_FAILED")
                return
            }
            let accessing = url.startAccessingSecurityScopedResource()
            defer { if accessing { url.stopAccessingSecurityScopedResource() } }
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .nameKey])
            if let size = values.fileSize, size > maxFileBytes {
                call.reject("File exceeds the 25 MB limit", "TOO_LARGE")
                return
            }
            let data = try Data(contentsOf: url, options: .mappedIfSafe)
            if data.count > maxFileBytes {
                call.reject("File exceeds the 25 MB limit", "TOO_LARGE")
                return
            }
            call.resolve([
                "name": values.name ?? url.lastPathComponent,
                "mime": mimeType(for: url),
                "size": data.count,
                "data": data.base64EncodedString(),
            ])
        } catch {
            call.reject("Unable to read the selected file", "NATIVE_FAILED", error)
        }
    }

    @objc func shareArtifact(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"),
              let url = URL(string: raw),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              (scheme == "https" || scheme == "http"),
              components.host != nil,
              components.user == nil,
              components.password == nil else {
            call.reject("Only HTTP(S) artifact URLs can be shared", "NATIVE_FAILED")
            return
        }
        let filename = call.getString("filename", "File")
        let activity = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        activity.setValue(filename, forKey: "subject")
        if let popover = activity.popoverPresentationController, let view = bridge?.viewController?.view {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 1, width: 1, height: 1)
        }
        activity.completionWithItemsHandler = { _, completed, _, error in
            if let error {
                call.reject("System sharing failed", "NATIVE_FAILED", error)
            } else {
                call.resolve(["result": completed ? "shared" : "cancelled"])
            }
        }
        bridge?.viewController?.present(activity, animated: true)
    }

    @objc func setSecureScreen(_ call: CAPPluginCall) {
        NativeSecureScreen.setEnabled(call.getBool("enabled", false))
        call.resolve()
    }

    private func descriptor(for url: URL, temporary: Bool) throws -> [String: Any] {
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .nameKey])
        return [
            "uri": url.absoluteString,
            "name": values.name ?? url.lastPathComponent,
            "mime": mimeType(for: url),
            "size": values.fileSize ?? -1,
            "temporary": temporary,
        ]
    }

    private func mimeType(for url: URL) -> String {
        UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }

    private func isOwnedCameraFile(_ url: URL) -> Bool {
        let root = FileManager.default.temporaryDirectory.standardizedFileURL.path
        return url.standardizedFileURL.path.hasPrefix(root + "/") && url.lastPathComponent.hasPrefix("camera-")
    }

    private func deleteTemporaryCameraFile(_ raw: String) {
        guard let url = temporaryCameraFiles.removeValue(forKey: raw), isOwnedCameraFile(url) else { return }
        try? FileManager.default.removeItem(at: url)
    }
}

enum NativeSecureScreen {
    private static var enabled = false
    private static var coverView: UIView?

    static func setEnabled(_ value: Bool) {
        enabled = value
        if !value {
            coverView?.removeFromSuperview()
            coverView = nil
        }
    }

    static func didEnterBackground(in window: UIWindow?) {
        guard enabled, let window, coverView == nil else { return }
        let cover = UIView(frame: window.bounds)
        cover.backgroundColor = .systemBackground
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        window.addSubview(cover)
        coverView = cover
    }

    static func willEnterForeground() {
        coverView?.removeFromSuperview()
        coverView = nil
    }
}
