const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");

const DEFAULT_TIMESTAMP_URLS = [
  "http://time.certum.pl",
  "http://timestamp.digicert.com",
  "http://timestamp.sectigo.com"
];

function runSignTool(signtoolPath, args, options = {}) {
  const timeoutMs =
    Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : 60000;

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(signtoolPath, args, { stdio: "inherit" });

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        child.kill();
      } catch {
        // best effort
      }
      reject(new Error(`signtool timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`signtool exited with code ${code}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTimestampUrls() {
  const configured = [process.env.WIN_TIMESTAMP_URLS, process.env.WIN_TIMESTAMP_URL]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  return [...new Set([...configured, ...DEFAULT_TIMESTAMP_URLS])];
}

module.exports = async function signWindowsArtifact(configuration) {
  const filePath = configuration && configuration.path;
  if (!filePath) {
    throw new Error("windows-sign: missing target path from electron-builder.");
  }

  const signtoolPath = process.env.WIN_SIGNTOOL_PATH || "C:\\sign\\signtool.exe";
  if (!existsSync(signtoolPath)) {
    throw new Error(`windows-sign: signtool not found at ${signtoolPath}`);
  }

  const thumbprint = (process.env.WIN_CERT_SHA1 || "")
    .replace(/[^A-Fa-f0-9]/g, "")
    .toUpperCase();
  if (!thumbprint) {
    throw new Error("windows-sign: WIN_CERT_SHA1 is required.");
  }

  const timestampUrls = getTimestampUrls();
  const maxAttemptsPerUrl = 1;
  const timeoutMs = Number(process.env.WIN_SIGNTOOL_TIMEOUT_MS || 60000);
  const requireTimestamp = String(process.env.WIN_REQUIRE_TIMESTAMP || "").toLowerCase() === "true";
  const errors = [];

  for (const timestampUrl of timestampUrls) {
    for (let attempt = 1; attempt <= maxAttemptsPerUrl; attempt += 1) {
      const args = [
        "sign",
        "/sha1",
        thumbprint,
        "/fd",
        "SHA256",
        "/tr",
        timestampUrl,
        "/td",
        "SHA256",
        "/v",
        filePath
      ];

      try {
        if (attempt > 1 || timestampUrls.length > 1) {
          console.log(
            `[windows-sign] retrying with timestamp server ${timestampUrl} (attempt ${attempt}/${maxAttemptsPerUrl})`
          );
        }
        await runSignTool(signtoolPath, args, { timeoutMs });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`timestamp=${timestampUrl} attempt=${attempt} error=${message}`);
        if (attempt < maxAttemptsPerUrl) {
          await sleep(1500);
        }
      }
    }
  }

  if (!requireTimestamp) {
    console.warn(`[windows-sign] timestamp unavailable, fallback to signing without timestamp for ${filePath}`);
    await runSignTool(
      signtoolPath,
      ["sign", "/sha1", thumbprint, "/fd", "SHA256", "/v", filePath],
      { timeoutMs }
    );
    return;
  }

  throw new Error(`windows-sign: all timestamp attempts failed:\n${errors.join("\n")}`);
};
