package com.idbots.world;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class AppUpdateDownloaderTest {
    @Rule public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void downloadsExactBytesAndReportsProgress() throws Exception {
        byte[] apk = "apk-content".getBytes(StandardCharsets.UTF_8);
        try (TestServer server = new TestServer().respond("/apk", 200, null, apk)) {
            File destination = new File(temporaryFolder.getRoot(), "update.apk");
            long[] progress = {0};
            AppUpdateDownloader.download(URI.create(server.address("/apk")), destination, apk.length,
                downloaded -> progress[0] = downloaded, Set.of("127.0.0.1"));
            assertArrayEquals(apk, Files.readAllBytes(destination.toPath()));
            assertEquals(apk.length, progress[0]);
        }
    }

    @Test
    public void followsAnAllowedRedirect() throws Exception {
        byte[] apk = "abc".getBytes(StandardCharsets.UTF_8);
        try (TestServer server = new TestServer()
            .respond("/old", 302, "/apk", null)
            .respond("/apk", 200, null, apk)) {
            File destination = new File(temporaryFolder.getRoot(), "update.apk");
            AppUpdateDownloader.download(URI.create(server.address("/old")), destination, apk.length, null, Set.of("127.0.0.1"));
            assertArrayEquals(apk, Files.readAllBytes(destination.toPath()));
        }
    }

    @Test
    public void rejectsShortOrOversizedResponsesWithoutLeavingAnApk() throws Exception {
        try (TestServer server = new TestServer()
            .respond("/short", 200, null, "ab".getBytes(StandardCharsets.UTF_8))
            .respond("/long", 200, null, "abcd".getBytes(StandardCharsets.UTF_8))) {
            for (String path : new String[]{"/short", "/long"}) {
                File destination = new File(temporaryFolder.getRoot(), path.substring(1) + ".apk");
                assertThrows(IOException.class, () -> AppUpdateDownloader.download(
                    URI.create(server.address(path)), destination, 3, null, Set.of("127.0.0.1")));
                assertFalse(destination.exists());
                assertFalse(new File(destination.getPath() + ".download").exists());
            }
        }
    }

    @Test
    public void rejectsARedirectToAnUntrustedHostBeforeConnecting() throws Exception {
        try (TestServer server = new TestServer().respond("/old", 302, "https://example.com/apk", null)) {
            File destination = new File(temporaryFolder.getRoot(), "update.apk");
            assertThrows(IllegalArgumentException.class, () -> AppUpdateDownloader.download(
                URI.create(server.address("/old")), destination, 3, null, Set.of("127.0.0.1")));
            assertFalse(destination.exists());
        }
    }

    private static final class TestServer implements AutoCloseable {
        private static final class Response {
            final int status;
            final String location;
            final byte[] body;

            Response(int status, String location, byte[] body) {
                this.status = status;
                this.location = location;
                this.body = body;
            }
        }

        private final ServerSocket socket;
        private final ExecutorService executor = Executors.newCachedThreadPool();
        private final Map<String, Response> responses = new HashMap<>();
        private volatile boolean running = true;

        TestServer() throws IOException {
            socket = new ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"));
            executor.execute(() -> {
                while (running) {
                    try {
                        Socket client = socket.accept();
                        executor.execute(() -> serve(client));
                    } catch (IOException error) {
                        if (running) error.printStackTrace();
                    }
                }
            });
        }

        TestServer respond(String path, int status, String location, byte[] body) {
            responses.put(path, new Response(status, location, body));
            return this;
        }

        String address(String path) {
            return "http://127.0.0.1:" + socket.getLocalPort() + path;
        }

        private void serve(Socket client) {
            try (Socket connection = client) {
                connection.setSoTimeout(5_000);
                BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.US_ASCII));
                String request = reader.readLine();
                if (request == null) return;
                String line;
                while ((line = reader.readLine()) != null && !line.isEmpty()) {}
                String path = request.split(" ")[1];
                Response response = responses.get(path);
                if (response == null) response = new Response(404, null, new byte[0]);
                byte[] body = response.body == null ? new byte[0] : response.body;
                OutputStream output = connection.getOutputStream();
                String headers = "HTTP/1.1 " + response.status + " Test\r\n"
                    + "Content-Length: " + body.length + "\r\n"
                    + (response.location == null ? "" : "Location: " + response.location + "\r\n")
                    + "Connection: close\r\n\r\n";
                output.write(headers.getBytes(StandardCharsets.US_ASCII));
                output.write(body);
                output.flush();
            } catch (IOException error) {
                if (running) error.printStackTrace();
            }
        }

        @Override
        public void close() throws IOException {
            running = false;
            socket.close();
            executor.shutdownNow();
        }
    }
}
