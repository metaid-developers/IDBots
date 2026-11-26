package com.idbots.world;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.util.Set;

final class AppUpdateDownloader {
    private static final Set<String> PRODUCTION_HOSTS = Set.of("app.idbots.world", "download.idbots.ai");

    interface ProgressListener {
        void onProgress(long downloadedBytes) throws IOException;
    }

    private AppUpdateDownloader() {}

    static File download(URI target, File destination, long expectedBytes, ProgressListener listener) throws IOException {
        return download(target, destination, expectedBytes, listener, PRODUCTION_HOSTS);
    }

    static File download(URI target, File destination, long expectedBytes, ProgressListener listener, Set<String> allowedHosts) throws IOException {
        if (expectedBytes <= 0 || expectedBytes > AppUpdateManifest.MAX_APK_BYTES) throw new IOException("Invalid APK size");
        URI current = target;
        for (int redirect = 0; redirect < 4; redirect++) {
            validateRemote(current, allowedHosts);
            HttpURLConnection connection = (HttpURLConnection) current.toURL().openConnection();
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(20_000);
            connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("Cache-Control", "no-cache");
            try {
                int status = connection.getResponseCode();
                if (status == HttpURLConnection.HTTP_OK) {
                    writeResponse(connection, destination, expectedBytes, listener);
                    return destination;
                }
                if (status < 300 || status >= 400) throw new IOException("Download returned HTTP " + status);
                String location = connection.getHeaderField("Location");
                if (location == null) throw new IOException("Download redirect has no destination");
                current = current.resolve(location);
            } finally {
                connection.disconnect();
            }
        }
        throw new IOException("Too many download redirects");
    }

    private static void validateRemote(URI uri, Set<String> allowedHosts) {
        String scheme = uri.getScheme();
        String host = uri.getHost();
        boolean localHttp = "http".equals(scheme) && ("127.0.0.1".equals(host) || "localhost".equals(host));
        boolean productionHttps = "https".equals(scheme) && allowedHosts.contains(host);
        if (uri.getUserInfo() != null || (uri.getPort() != -1 && uri.getPort() != 443 && !localHttp)
            || uri.getQuery() != null || uri.getFragment() != null || uri.getPath() == null
            || (!productionHttps && !localHttp)) {
            throw new IllegalArgumentException("Download URL is not allowed");
        }
    }

    private static void writeResponse(HttpURLConnection connection, File destination, long expectedBytes, ProgressListener listener) throws IOException {
        File parent = destination.getParentFile();
        if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) throw new IOException("No update directory");
        File temporary = new File(destination.getPath() + ".download");
        if (temporary.exists() && !temporary.delete()) throw new IOException("Unable to replace the partial APK");
        long total = 0;
        try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(temporary)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > expectedBytes) throw new IOException("APK exceeds the declared size");
                output.write(buffer, 0, read);
                if (listener != null) listener.onProgress(total);
            }
            if (total != expectedBytes) throw new IOException("APK size does not match the manifest");
            if (destination.exists() && !destination.delete()) throw new IOException("Unable to replace the previous APK");
            if (!temporary.renameTo(destination)) throw new IOException("Unable to finalize the APK download");
        } finally {
            if (temporary.exists()) temporary.delete();
        }
    }
}
