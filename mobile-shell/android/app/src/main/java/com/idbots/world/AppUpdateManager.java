package com.idbots.world;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class AppUpdateManager {
    private static final String MANIFEST_URL = "https://idbots.ai/update.json";
    private static final String PREFERENCES = "app_update";
    private static final String KEY_DOWNLOAD_ID = "download_id";
    private static final String KEY_MANIFEST = "manifest";
    private static final String KEY_LAST_CHECK = "last_check";
    private static final String KEY_DISMISSED_VERSION = "dismissed_version";
    private static final String KEY_DISMISSED_AT = "dismissed_at";
    private static final long CHECK_INTERVAL_MS = 6L * 60L * 60L * 1000L;
    private static final long DISMISS_INTERVAL_MS = 24L * 60L * 60L * 1000L;
    private static final int MAX_MANIFEST_BYTES = 1024 * 1024;

    private final Activity activity;
    private final DownloadManager downloads;
    private final SharedPreferences preferences;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final BroadcastReceiver downloadReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            long completedId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            if (completedId == activeDownloadId) onDownloadComplete(true);
        }
    };
    private final Runnable progressUpdater = new Runnable() {
        @Override
        public void run() {
            updateProgress();
        }
    };

    private AppUpdateManifest pendingManifest;
    private AlertDialog dialog;
    private long activeDownloadId = -1;
    private boolean resumed;
    private boolean receiverRegistered;
    private boolean checkInFlight;
    private boolean awaitingInstallPermission;

    AppUpdateManager(Activity activity) {
        this.activity = activity;
        downloads = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
        preferences = activity.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    void onResume() {
        resumed = true;
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) {
            activity.registerReceiver(downloadReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            activity.registerReceiver(downloadReceiver, filter);
        }
        receiverRegistered = true;
        restoreDownload();
        if (awaitingInstallPermission && pendingManifest != null) {
            awaitingInstallPermission = false;
            launchInstall();
        } else {
            maybeCheckForUpdate();
        }
        if (activeDownloadId >= 0 && dialog != null && dialog.isShowing()) startProgressUpdates();
    }

    void onPause() {
        resumed = false;
        handler.removeCallbacks(progressUpdater);
        if (receiverRegistered) {
            activity.unregisterReceiver(downloadReceiver);
            receiverRegistered = false;
        }
    }

    void onDestroy() {
        resumed = false;
        handler.removeCallbacks(progressUpdater);
        dismissDialog();
        executor.shutdownNow();
    }

    private void maybeCheckForUpdate() {
        if (checkInFlight || activeDownloadId >= 0 || pendingManifest != null) return;
        long now = System.currentTimeMillis();
        if (now - preferences.getLong(KEY_LAST_CHECK, 0) < CHECK_INTERVAL_MS) return;
        checkInFlight = true;
        preferences.edit().putLong(KEY_LAST_CHECK, now).apply();
        executor.execute(() -> {
            try {
                AppUpdateManifest manifest = AppUpdateManifest.parse(fetchManifest());
                handler.post(() -> {
                    checkInFlight = false;
                    if (!resumed || manifest == null || !manifest.isNewerThan(BuildConfig.VERSION_CODE)) return;
                    boolean dismissed = preferences.getInt(KEY_DISMISSED_VERSION, 0) == manifest.versionCode
                        && now - preferences.getLong(KEY_DISMISSED_AT, 0) < DISMISS_INTERVAL_MS;
                    if (dismissed && !manifest.isRequiredFor(BuildConfig.VERSION_CODE)) return;
                    pendingManifest = manifest;
                    showAvailableDialog();
                });
            } catch (Exception error) {
                if (BuildConfig.DEBUG) Log.i("AppUpdate", "Background update check failed", error);
                handler.post(() -> checkInFlight = false);
            }
        });
    }

    private String fetchManifest() throws Exception {
        URI current = URI.create(MANIFEST_URL);
        for (int redirect = 0; redirect < 4; redirect++) {
            HttpURLConnection connection = (HttpURLConnection) new URL(current.toString()).openConnection();
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(15_000);
            connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Cache-Control", "no-cache");
            try {
                int status = connection.getResponseCode();
                if (status == HttpURLConnection.HTTP_OK) {
                    try (InputStream input = connection.getInputStream()) {
                        return readUtf8(input);
                    }
                }
                if (status < 300 || status >= 400) throw new IOException("Update check returned HTTP " + status);
                String location = connection.getHeaderField("Location");
                if (location == null) throw new IOException("Update redirect has no destination");
                URI next = current.resolve(location);
                if (!"https".equals(next.getScheme()) || !"idbots.ai".equals(next.getHost())
                    || next.getUserInfo() != null || (next.getPort() != -1 && next.getPort() != 443)) {
                    throw new IOException("Update redirect is not allowed");
                }
                current = next;
            } finally {
                connection.disconnect();
            }
        }
        throw new IOException("Too many update redirects");
    }

    private static String readUtf8(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16 * 1024];
        int total = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            total += read;
            if (total > MAX_MANIFEST_BYTES) throw new IOException("Update manifest is too large");
            output.write(buffer, 0, read);
        }
        return output.toString(StandardCharsets.UTF_8.name());
    }

    private void showAvailableDialog() {
        View content = inflateDialog();
        setText(content, R.id.updateTitle, R.string.update_available_title);
        setText(content, R.id.updateVersion, getString(R.string.update_version, pendingManifest.versionName));
        TextView notes = content.findViewById(R.id.updateNotes);
        StringBuilder copy = new StringBuilder();
        for (String note : pendingManifest.notesFor(Locale.getDefault())) {
            if (copy.length() > 0) copy.append("\n\n");
            copy.append("• ").append(note);
        }
        notes.setText(copy.toString());
        boolean required = pendingManifest.isRequiredFor(BuildConfig.VERSION_CODE);
        dialog = styledDialog()
            .setView(content)
            .setPositiveButton(R.string.update_now, (ignored, which) -> startDownload())
            .setNegativeButton(R.string.update_later, (ignored, which) -> dismissVersion())
            .create();
        configureDialog(required);
        showDialog();
    }

    private void startDownload() {
        if (pendingManifest == null) return;
        dismissDialog();
        try {
            File file = updateFile(pendingManifest);
            File parent = file.getParentFile();
            if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) throw new IOException("No update directory");
            if (file.exists() && !file.delete()) throw new IOException("Unable to replace the previous APK");
            long previousId = preferences.getLong(KEY_DOWNLOAD_ID, -1);
            if (previousId >= 0) downloads.remove(previousId);

            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(pendingManifest.url));
            request.setTitle(getString(R.string.update_notification_title));
            request.setDescription(getString(R.string.update_version, pendingManifest.versionName));
            request.setMimeType("application/vnd.android.package-archive");
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(false);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS,
                "updates/" + file.getName());
            activeDownloadId = downloads.enqueue(request);
            preferences.edit()
                .putLong(KEY_DOWNLOAD_ID, activeDownloadId)
                .putString(KEY_MANIFEST, pendingManifest.sourceJson)
                .apply();
            showProgressDialog();
        } catch (Exception error) {
            activeDownloadId = -1;
            clearDownloadState();
            showDownloadError();
        }
    }

    private void showProgressDialog() {
        View content = inflateDialog();
        setText(content, R.id.updateTitle, R.string.update_downloading_title);
        setText(content, R.id.updateVersion, getString(R.string.update_version, pendingManifest.versionName));
        content.findViewById(R.id.updateNotesScroll).setVisibility(View.GONE);
        content.findViewById(R.id.updateProgressGroup).setVisibility(View.VISIBLE);
        setText(content, R.id.updateProgressText, R.string.update_download_starting);
        dialog = styledDialog()
            .setView(content)
            .setPositiveButton(R.string.update_hide, null)
            .setNegativeButton(R.string.update_cancel_download, (ignored, which) -> cancelDownload())
            .create();
        configureDialog(false);
        showDialog();
        startProgressUpdates();
    }

    private void startProgressUpdates() {
        handler.removeCallbacks(progressUpdater);
        handler.post(progressUpdater);
    }

    private void updateProgress() {
        if (!resumed || activeDownloadId < 0 || dialog == null || !dialog.isShowing()) return;
        try (Cursor cursor = downloads.query(new DownloadManager.Query().setFilterById(activeDownloadId))) {
            if (cursor == null || !cursor.moveToFirst()) {
                showDownloadFailure();
                return;
            }
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            if (status == DownloadManager.STATUS_SUCCESSFUL) {
                onDownloadComplete(true);
                return;
            }
            if (status == DownloadManager.STATUS_FAILED) {
                showDownloadFailure();
                return;
            }
            long received = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            long total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
            ProgressBar bar = dialog.findViewById(R.id.updateProgressBar);
            TextView text = dialog.findViewById(R.id.updateProgressText);
            if (bar != null && text != null) {
                bar.setIndeterminate(total <= 0);
                int progress = total > 0 ? (int) Math.min(1000, received * 1000 / total) : 0;
                bar.setProgress(progress);
                String size = String.format(Locale.getDefault(), "%.1f / %.1f MB",
                    received / 1024.0 / 1024.0, Math.max(total, 0) / 1024.0 / 1024.0);
                text.setText(total > 0
                    ? getString(R.string.update_download_progress, progress / 10, size)
                    : getString(R.string.update_downloading_size, size));
            }
            handler.postDelayed(progressUpdater, 750);
        } catch (Exception error) {
            showDownloadFailure();
        }
    }

    private void restoreDownload() {
        long id = preferences.getLong(KEY_DOWNLOAD_ID, -1);
        String raw = preferences.getString(KEY_MANIFEST, null);
        if (id < 0 || raw == null || pendingManifest != null || activeDownloadId >= 0) return;
        try {
            AppUpdateManifest manifest = AppUpdateManifest.parseAndroid(raw);
            if (!manifest.isNewerThan(BuildConfig.VERSION_CODE)) {
                downloads.remove(id);
                updateFile(manifest).delete();
                clearDownloadState();
                return;
            }
            pendingManifest = manifest;
            try (Cursor cursor = downloads.query(new DownloadManager.Query().setFilterById(id))) {
                if (cursor != null && cursor.moveToFirst()) {
                    int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                    if (status == DownloadManager.STATUS_SUCCESSFUL) {
                        verifyDownloadedApk(false);
                        return;
                    }
                    if (status != DownloadManager.STATUS_FAILED) {
                        activeDownloadId = id;
                        return;
                    }
                }
            }
            downloads.remove(id);
            updateFile(manifest).delete();
            clearDownloadState();
            pendingManifest = null;
        } catch (Exception error) {
            clearDownloadState();
            pendingManifest = null;
        }
    }

    private void onDownloadComplete(boolean launchWhenReady) {
        if (pendingManifest == null) restoreDownload();
        if (pendingManifest == null) return;
        activeDownloadId = -1;
        handler.removeCallbacks(progressUpdater);
        verifyDownloadedApk(launchWhenReady);
    }

    private void verifyDownloadedApk(boolean launchWhenReady) {
        AppUpdateManifest manifest = pendingManifest;
        executor.execute(() -> {
            try {
                AppUpdateVerifier.verifyPackage(activity, updateFile(manifest), manifest);
                handler.post(() -> {
                    if (!resumed || pendingManifest != manifest) return;
                    if (launchWhenReady) launchInstall();
                    else showReadyDialog();
                });
            } catch (Exception error) {
                if (BuildConfig.DEBUG) Log.w("AppUpdate", "Downloaded APK verification failed", error);
                handler.post(() -> {
                    if (pendingManifest != manifest) return;
                    downloads.remove(preferences.getLong(KEY_DOWNLOAD_ID, -1));
                    updateFile(manifest).delete();
                    clearDownloadState();
                    showDownloadError();
                });
            }
        });
    }

    private void showReadyDialog() {
        if (pendingManifest == null) return;
        View content = inflateDialog();
        setText(content, R.id.updateTitle, R.string.update_ready_title);
        setText(content, R.id.updateVersion, getString(R.string.update_version, pendingManifest.versionName));
        TextView notes = content.findViewById(R.id.updateNotes);
        notes.setText(R.string.update_ready_message);
        boolean required = pendingManifest.isRequiredFor(BuildConfig.VERSION_CODE);
        dialog = styledDialog()
            .setView(content)
            .setPositiveButton(R.string.update_install, (ignored, which) -> launchInstall())
            .setNegativeButton(R.string.update_later, (ignored, which) -> dismissReadyUpdate())
            .create();
        configureDialog(required);
        showDialog();
    }

    private void launchInstall() {
        if (!resumed || pendingManifest == null) return;
        dismissDialog();
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(activity, R.style.IDBots_Dialog)
                .setTitle(R.string.update_permission_title)
                .setMessage(R.string.update_permission_message)
                .setPositiveButton(R.string.update_open_settings, (ignored, which) -> openInstallSettings())
                .setNegativeButton(R.string.update_later, null)
                .show();
            return;
        }
        try {
            File file = updateFile(pendingManifest);
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", file);
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(uri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            install.setClipData(ClipData.newRawUri("IDBots update", uri));
            activity.startActivity(install);
        } catch (Exception error) {
            showReadyDialog();
        }
    }

    private void openInstallSettings() {
        awaitingInstallPermission = true;
        Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:" + activity.getPackageName()));
        activity.startActivity(settings);
    }

    private void cancelDownload() {
        if (activeDownloadId >= 0) downloads.remove(activeDownloadId);
        if (pendingManifest != null) updateFile(pendingManifest).delete();
        activeDownloadId = -1;
        pendingManifest = null;
        clearDownloadState();
        dismissDialog();
    }

    private void showDownloadFailure() {
        downloads.remove(activeDownloadId);
        if (pendingManifest != null) updateFile(pendingManifest).delete();
        activeDownloadId = -1;
        clearDownloadState();
        showDownloadError();
    }

    private void showDownloadError() {
        if (!resumed || pendingManifest == null) return;
        dismissDialog();
        dialog = styledDialog()
            .setTitle(R.string.update_failed_title)
            .setMessage(R.string.update_failed_message)
            .setPositiveButton(R.string.update_retry, (ignored, which) -> startDownload())
            .setNegativeButton(R.string.update_later, (ignored, which) -> dismissVersion())
            .create();
        configureDialog(false);
        showDialog();
    }

    private void dismissVersion() {
        if (pendingManifest != null) {
            preferences.edit()
                .putInt(KEY_DISMISSED_VERSION, pendingManifest.versionCode)
                .putLong(KEY_DISMISSED_AT, System.currentTimeMillis())
                .apply();
        }
        pendingManifest = null;
        dismissDialog();
    }

    private void dismissReadyUpdate() {
        AppUpdateManifest dismissed = pendingManifest;
        dismissVersion();
        downloads.remove(preferences.getLong(KEY_DOWNLOAD_ID, -1));
        if (dismissed != null) updateFile(dismissed).delete();
        clearDownloadState();
    }

    private void clearDownloadState() {
        preferences.edit().remove(KEY_DOWNLOAD_ID).remove(KEY_MANIFEST).apply();
    }

    private File updateFile(AppUpdateManifest manifest) {
        return new File(new File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "updates"),
            "idbots-update-" + manifest.versionCode + ".apk");
    }

    private View inflateDialog() {
        return activity.getLayoutInflater().inflate(R.layout.dialog_app_update, null);
    }

    private AlertDialog.Builder styledDialog() {
        return new AlertDialog.Builder(activity, R.style.IDBots_Dialog);
    }

    private void configureDialog(boolean required) {
        dialog.setCancelable(!required);
        dialog.setCanceledOnTouchOutside(false);
        dialog.setOnShowListener(ignored -> {
            Button positive = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
            Button negative = dialog.getButton(AlertDialog.BUTTON_NEGATIVE);
            if (positive != null) positive.setTextColor(ContextCompat.getColor(activity, R.color.idbots_on_accent));
            if (negative != null) {
                negative.setTextColor(ContextCompat.getColor(activity, R.color.idbots_text_secondary));
                negative.setVisibility(required ? View.GONE : View.VISIBLE);
            }
        });
    }

    private void showDialog() {
        AlertDialog next = dialog;
        dialog = null;
        dismissDialog();
        dialog = next;
        if (!activity.isFinishing() && !activity.isDestroyed()) next.show();
    }

    private void dismissDialog() {
        if (dialog != null) {
            dialog.dismiss();
            dialog = null;
        }
    }

    private void setText(View content, int id, int string) {
        ((TextView) content.findViewById(id)).setText(string);
    }

    private void setText(View content, int id, String string) {
        ((TextView) content.findViewById(id)).setText(string);
    }

    private String getString(int id) {
        return activity.getString(id);
    }

    private String getString(int id, Object... arguments) {
        return activity.getString(id, arguments);
    }
}
