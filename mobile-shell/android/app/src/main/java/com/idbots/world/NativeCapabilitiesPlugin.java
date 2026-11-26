package com.idbots.world;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Base64;
import android.view.HapticFeedbackConstants;
import android.view.View;
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
    public void checkForUpdate(PluginCall call) {
        AppUpdateManager manager = MainActivity.appUpdateManager;
        if (manager == null) {
            call.reject("Update checks are unavailable", "UNAVAILABLE");
            return;
        }
        manager.checkNow(new AppUpdateManager.UpdateCheckListener() {
            @Override
            public void onUpdateAvailable() {
                call.resolve(new JSObject().put("status", "update-available"));
            }

            @Override
            public void onUpToDate() {
                call.resolve(new JSObject().put("status", "up-to-date"));
            }

            @Override
            public void onCheckFailed(String message) {
                call.resolve(new JSObject().put("status", "check-failed"));
            }
        });
    }

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
        Integer chunkLength = call.getInt("length");
        if (chunkLength != null) {
            new Thread(() -> readFileChunk(call, raw, chunkLength), "idbots-native-file-read").start();
            return;
        }
        try {
            Uri uri = Uri.parse(raw);
            validateReadableUri(uri);
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

    private void readFileChunk(PluginCall call, String raw, int requestedLength) {
        Uri uri = Uri.parse(raw);
        boolean temporary = call.getBoolean("temporary", false);
        int offset = Math.max(0, call.getInt("offset", 0));
        boolean end = false;
        try {
            validateReadableUri(uri);
            if (requestedLength <= 0 || offset > MAX_FILE_BYTES) {
                call.reject("Invalid file chunk request", "NATIVE_FAILED");
                return;
            }
            long declaredSize = sizeOf(uri);
            if (declaredSize > MAX_FILE_BYTES) {
                call.reject("File exceeds the 25 MB limit", "TOO_LARGE");
                return;
            }
            int length = Math.min(requestedLength, 256 * 1024);
            byte[] bytes = new byte[length];
            int total = 0;
            try (InputStream stream = openStream(uri)) {
                long remaining = offset;
                while (remaining > 0) {
                    long skipped = stream.skip(remaining);
                    if (skipped > 0) {
                        remaining -= skipped;
                    } else if (stream.read() >= 0) {
                        remaining -= 1;
                    } else {
                        break;
                    }
                }
                if (remaining == 0) {
                    while (total < length) {
                        int read = stream.read(bytes, total, length - total);
                        if (read < 0) break;
                        total += read;
                    }
                }
            }
            end = total < length || (declaredSize >= 0 && offset + total >= declaredSize);
            if (offset + total > MAX_FILE_BYTES) throw new OversizeException();
            JSObject response = new JSObject();
            response.put("name", nameOf(uri));
            response.put("mime", mimeOf(uri));
            response.put("size", declaredSize);
            response.put("offset", offset);
            response.put("chunked", true);
            response.put("end", end);
            response.put("data", Base64.encodeToString(bytes, 0, total, Base64.NO_WRAP));
            call.resolve(response);
        } catch (SecurityException error) {
            call.reject("File permission was denied", "PERMISSION_DENIED", error);
        } catch (OversizeException error) {
            call.reject("File exceeds the 25 MB limit", "TOO_LARGE");
        } catch (Exception error) {
            call.reject("Unable to read the selected file", "NATIVE_FAILED", error);
        } finally {
            if (temporary && end) deleteTemporaryCameraFile(raw);
        }
    }

    private void validateReadableUri(Uri uri) throws Exception {
        String scheme = uri.getScheme();
        if (!"content".equals(scheme) && !"file".equals(scheme)) {
            throw new IllegalArgumentException("Only selected content files can be read");
        }
        if ("file".equals(scheme) && !isOwnedCameraFile(new File(uri.getPath() == null ? "" : uri.getPath()))) {
            throw new SecurityException("Only temporary camera files can be read by path");
        }
    }

    @PluginMethod
    public void shareArtifact(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null) url = "";
        String filename = call.getString("filename", "File");
        if (filename == null) filename = "File";
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
        try {
            getBridge().getActivity().startActivity(chooser);
            call.resolve((JSObject) new JSObject().put("result", "shared"));
        } catch (android.content.ActivityNotFoundException error) {
            call.reject("No system share target is available", "UNAVAILABLE", error);
        }
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

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            getBridge().getActivity().startActivity(intent);
            call.resolve();
        } catch (android.content.ActivityNotFoundException error) {
            call.reject("System notification settings are unavailable", "UNAVAILABLE", error);
        }
    }

    @PluginMethod
    public void haptic(PluginCall call) {
        String rawStyle = call.getString("style", "medium");
        String style = rawStyle == null ? "medium" : rawStyle;
        if ("prepare".equals(style)) {
            call.resolve();
            return;
        }
        boolean vibrated = false;
        try {
            Vibrator vibrator = resolveVibrator();
            if (vibrator != null && vibrator.hasVibrator()) {
                boolean hasAmplitude = vibrator.hasAmplitudeControl();
                VibrationEffect effect;
                if ("ready".equals(style) || "heavy".equals(style)) {
                    effect = VibrationEffect.createOneShot(38L, hasAmplitude ? 225 : VibrationEffect.DEFAULT_AMPLITUDE);
                } else if ("light".equals(style)) {
                    effect = VibrationEffect.createOneShot(12L, hasAmplitude ? 110 : VibrationEffect.DEFAULT_AMPLITUDE);
                } else {
                    effect = VibrationEffect.createOneShot(22L, VibrationEffect.DEFAULT_AMPLITUDE);
                }
                vibrator.vibrate(effect);
                vibrated = true;
            }
        } catch (Exception ignored) {
        }
        if (!vibrated && getBridge() != null && getBridge().getActivity() != null) {
            final int constant = "light".equals(style)
                ? HapticFeedbackConstants.CLOCK_TICK
                : HapticFeedbackConstants.LONG_PRESS;
            getBridge().getActivity().runOnUiThread(() -> {
                View view = getBridge().getWebView();
                if (view != null) {
                    view.performHapticFeedback(constant);
                }
            });
        }
        call.resolve();
    }

    @SuppressWarnings("deprecation")
    private Vibrator resolveVibrator() {
        Context context = getContext();
        if (context == null) return null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager manager = (VibratorManager) context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            return manager != null ? manager.getDefaultVibrator() : null;
        }
        return (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
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
                if (index >= 0) {
                    String displayName = cursor.getString(index);
                    if (displayName != null && !displayName.isEmpty()) return displayName;
                }
            }
        } catch (Exception ignored) {
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

    private InputStream openStream(Uri uri) throws Exception {
        InputStream input = "file".equals(uri.getScheme())
            ? new FileInputStream(new File(uri.getPath()))
            : getContext().getContentResolver().openInputStream(uri);
        if (input == null) throw new IllegalStateException("Unable to open the selected file");
        return input;
    }

    private byte[] readBytes(Uri uri) throws Exception {
        try (InputStream stream = openStream(uri); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
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
