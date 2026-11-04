package com.idbots.world;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.WindowManager;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

@CapacitorPlugin(name = "NativeCapabilities")
public class NativeCapabilitiesPlugin extends Plugin {
    private static final long MAX_FILE_BYTES = 25L * 1024L * 1024L;
    private final Map<String, File> temporaryCameraFiles = new HashMap<>();
    private Uri pendingCameraUri;

    @PluginMethod
    public void pickPhoto(PluginCall call) {
        String source = call.getString("source", "photos");
        if ("camera".equals(source)) {
            launchCamera(call);
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        startActivityForResult(call, intent, "handlePhotoResult");
    }

    private void launchCamera(PluginCall call) {
        try {
            File file = new File(getContext().getCacheDir(), "camera-" + UUID.randomUUID() + ".jpg");
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, uri);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            if (intent.resolveActivity(getContext().getPackageManager()) == null) {
                call.reject("No camera application is available", "UNAVAILABLE");
                return;
            }
            pendingCameraUri = uri;
            temporaryCameraFiles.put(uri.toString(), file);
            startActivityForResult(call, intent, "handlePhotoResult");
        } catch (Exception error) {
            call.reject("Unable to open the camera", "UNAVAILABLE", error);
        }
    }

    @PluginMethod
    public void pickFiles(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, call.getBoolean("allowMultiple", true));
        startActivityForResult(call, intent, "handleFilesResult");
    }

    @ActivityCallback
    private void handlePhotoResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK) {
            if (pendingCameraUri != null) deleteTemporaryCameraFile(pendingCameraUri.toString());
            pendingCameraUri = null;
            call.resolve();
            return;
        }
        Uri uri = pendingCameraUri;
        pendingCameraUri = null;
        if (uri == null && result.getData() != null) uri = result.getData().getData();
        if (uri == null) {
            call.resolve();
            return;
        }
        try {
            call.resolve((JSObject) new JSObject().put("file", describe(uri, temporaryCameraFiles.containsKey(uri.toString()))));
        } catch (Exception error) {
            call.reject("Unable to read the selected photo", "NATIVE_FAILED", error);
        }
    }

    @ActivityCallback
    private void handleFilesResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.resolve();
            return;
        }
        JSArray files = new JSArray();
        try {
            Intent data = result.getData();
            if (data.getClipData() != null) {
                for (int index = 0; index < data.getClipData().getItemCount(); index++) {
                    Uri uri = data.getClipData().getItemAt(index).getUri();
                    files.put(describe(uri, false));
                }
            } else if (data.getData() != null) {
                files.put(describe(data.getData(), false));
            }
            call.resolve((JSObject) new JSObject().put("files", files));
        } catch (Exception error) {
            call.reject("Unable to read the selected files", "NATIVE_FAILED", error);
        }
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        String raw = call.getString("uri");
        boolean temporary = call.getBoolean("temporary", false);
        if (raw == null) {
            call.reject("A file URI is required", "NATIVE_FAILED");
            return;
        }
        try {
            Uri uri = Uri.parse(raw);
            String scheme = uri.getScheme();
            if (!"content".equals(scheme) && !"file".equals(scheme)) {
                call.reject("Only selected content files can be read", "NATIVE_FAILED");
                return;
            }
            if ("file".equals(scheme) && !isOwnedCameraFile(new File(uri.getPath() == null ? "" : uri.getPath()))) {
                call.reject("Only temporary camera files can be read by path", "NATIVE_FAILED");
                return;
            }
            long declaredSize = sizeOf(uri);
            if (declaredSize > MAX_FILE_BYTES) {
                call.reject("File exceeds the 25 MB limit", "TOO_LARGE");
                return;
            }
            byte[] bytes = readBytes(uri);
            JSObject response = new JSObject();
            response.put("name", nameOf(uri));
            response.put("mime", mimeOf(uri));
            response.put("size", bytes.length);
            response.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            call.resolve(response);
        } catch (SecurityException error) {
            call.reject("File permission was denied", "PERMISSION_DENIED", error);
        } catch (OversizeException error) {
            call.reject("File exceeds the 25 MB limit", "TOO_LARGE");
        } catch (Exception error) {
            call.reject("Unable to read the selected file", "NATIVE_FAILED", error);
        } finally {
            if (temporary) deleteTemporaryCameraFile(raw);
        }
    }

    @PluginMethod
    public void shareArtifact(PluginCall call) {
        String url = call.getString("url", "");
        String filename = call.getString("filename", "File");
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if ((!"https".equals(scheme) && !"http".equals(scheme)) || uri.getHost() == null || uri.getUserInfo() != null) {
            call.reject("Only HTTP(S) artifact URLs can be shared", "NATIVE_FAILED");
            return;
        }
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_TEXT, url);
        send.putExtra(Intent.EXTRA_TITLE, filename);
        Intent chooser = Intent.createChooser(send, filename);
        if (chooser.resolveActivity(getContext().getPackageManager()) == null) {
            call.reject("No system share target is available", "UNAVAILABLE");
            return;
        }
        getBridge().getActivity().startActivity(chooser);
        call.resolve((JSObject) new JSObject().put("result", "shared"));
    }

    @PluginMethod
    public void setSecureScreen(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        getBridge().getActivity().runOnUiThread(() -> {
            if (enabled) {
                getBridge().getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            } else {
                getBridge().getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            }
            call.resolve();
        });
    }

    private JSObject describe(Uri uri, boolean temporary) throws Exception {
        JSObject descriptor = new JSObject();
        descriptor.put("uri", uri.toString());
        descriptor.put("name", nameOf(uri));
        descriptor.put("mime", mimeOf(uri));
        descriptor.put("size", sizeOf(uri));
        descriptor.put("temporary", temporary);
        return descriptor;
    }

    private String nameOf(Uri uri) {
        if ("file".equals(uri.getScheme())) return new File(uri.getPath()).getName();
        try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        }
        return uri.getLastPathSegment() == null ? "file" : uri.getLastPathSegment();
    }

    private String mimeOf(Uri uri) {
        String mime = getContext().getContentResolver().getType(uri);
        return mime == null ? "application/octet-stream" : mime;
    }

    private long sizeOf(Uri uri) {
        if ("file".equals(uri.getScheme())) return new File(uri.getPath()).length();
        try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (index >= 0 && !cursor.isNull(index)) return cursor.getLong(index);
            }
        } catch (Exception ignored) {
            return -1;
        }
        return -1;
    }

    private byte[] readBytes(Uri uri) throws Exception {
        InputStream input = "file".equals(uri.getScheme())
            ? new FileInputStream(new File(uri.getPath()))
            : getContext().getContentResolver().openInputStream(uri);
        if (input == null) throw new IllegalStateException("Unable to open the selected file");
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            long total = 0;
            int read;
            while ((read = stream.read(buffer)) != -1) {
                total += read;
                if (total > MAX_FILE_BYTES) throw new OversizeException();
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    private boolean isOwnedCameraFile(File file) throws Exception {
        String cachePath = getContext().getCacheDir().getCanonicalPath() + File.separator;
        return file.getCanonicalPath().startsWith(cachePath) && file.getName().startsWith("camera-");
    }

    private void deleteTemporaryCameraFile(String raw) {
        File file = temporaryCameraFiles.remove(raw);
        if (file == null) return;
        try {
            if (isOwnedCameraFile(file) && file.exists()) file.delete();
        } catch (Exception ignored) {
        }
    }

    private static final class OversizeException extends Exception {}
}
