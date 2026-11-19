package com.idbots.world;

import static org.junit.Assert.assertEquals;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class AppUpdateVerifierTest {
    @Rule public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void computesTheExpectedApkSha256() throws Exception {
        File file = temporaryFolder.newFile("update.apk");
        Files.write(file.toPath(), "abc".getBytes(StandardCharsets.UTF_8));
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            AppUpdateVerifier.sha256(file));
    }
}
