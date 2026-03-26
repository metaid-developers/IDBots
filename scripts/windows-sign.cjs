const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");

const DEFAULT_TIMESTAMP_URLS = [
  "http://time.certum.pl",
  "http://timestamp.digicert.com",
  "http://timestamp.sectigo.com"
];

function runSignTool(signtoolPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(signtoolPath, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
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
  const maxAttemptsPerUrl = 2;
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
        await runSignTool(signtoolPath, args);
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

  throw new Error(`windows-sign: all timestamp attempts failed:\n${errors.join("\n")}`);
};
