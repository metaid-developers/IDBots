package com.idbots.world;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

final class AppUpdateVerifier {
    private AppUpdateVerifier() {}

    static void verifyPackage(Context context, File file, AppUpdateManifest manifest) throws Exception {
        if (!file.isFile() || file.length() != manifest.size) throw new IOException("APK size does not match");
        if (!manifest.sha256.equals(sha256(file))) throw new IOException("APK checksum does not match");

        PackageManager manager = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archive = manager.getPackageArchiveInfo(file.getAbsolutePath(), flags);
        if (archive == null || !context.getPackageName().equals(archive.packageName)) {
            throw new SecurityException("APK package name does not match");
        }
        long archiveVersion = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? archive.getLongVersionCode() : archive.versionCode;
        if (archiveVersion != manifest.versionCode) throw new SecurityException("APK version does not match");

        PackageInfo installed = manager.getPackageInfo(context.getPackageName(), flags);
        Set<Signature> expected = new HashSet<>(Arrays.asList(signers(installed)));
        Set<Signature> actual = new HashSet<>(Arrays.asList(signers(archive)));
        if (expected.isEmpty() || !expected.equals(actual)) throw new SecurityException("APK signature does not match");
    }

    static String sha256(File file) throws IOException {
        try (FileInputStream input = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
            StringBuilder hex = new StringBuilder(64);
            for (byte value : digest.digest()) hex.append(String.format("%02x", value & 0xff));
            return hex.toString();
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    @SuppressWarnings("deprecation")
    private static Signature[] signers(PackageInfo info) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return info.signingInfo == null ? new Signature[0] : info.signingInfo.getApkContentsSigners();
        }
        return info.signatures == null ? new Signature[0] : info.signatures;
    }
}
