const { spawn } = require("node:child_process");
const { existsSync, statSync, readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");

const DEFAULT_TIMESTAMP_URLS = [
  "http://time.certum.pl",
  "http://timestamp.digicert.com",
  "http://timestamp.sectigo.com"
];
const DEFAULT_SIGNTOOL_TIMEOUT_MS = 90000;
const unhealthyTimestampUrls = new Set();

// electron-builder 24 asks the custom sign hook twice for every extra-file
// executable (once per file-copy pass), so v1.1.2 and v1.1.3 each ran signtool
// 712 times for 356 files — 333 of them PortableGit binaries — at ~0.7 s per
// timestamped signature. The second signature adds nothing: a file this
// process already signed is skipped, unless it changed on disk since (size or
// mtime), which is exactly when a re-sign is required.
const signedInThisProcess = new Map();

function fileFingerprint(filePath) {
  try {
    const stats = statSync(filePath);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return null;
  }
}

function signAndRemember(signtoolPath, args, filePath, options) {
  return runSignTool(signtoolPath, args, options).then(() => {
    signedInThisProcess.set(path.resolve(filePath), fileFingerprint(filePath));
  });
}

// PortableGit can arrive pre-signed: scripts/mingit-signed-cache.cjs `apply`
// substitutes the tree signed once for this archive and certificate, and hands
// over the digest of every file in it through IDBOTS_PRESIGNED_MANIFEST. A file
// is skipped only while its bytes still equal that digest, so a damaged or
// half-replaced tree is signed as usual.
let presignedDigests = null;

function presignedDigestFor(filePath) {
  if (presignedDigests === null) {
    presignedDigests = new Map();
    try {
      const manifest = JSON.parse(readFileSync(process.env.IDBOTS_PRESIGNED_MANIFEST, "utf8"));
      for (const [relative, digest] of Object.entries(manifest.files ?? {})) {
        presignedDigests.set(String(relative).replace(/\\/g, "/"), String(digest));
      }
    } catch {
      // no digest list: nothing is pre-signed
    }
  }
  const match = String(filePath).match(/[\\/]resources[\\/]mingit[\\/](.+)$/i);
  return match ? presignedDigests.get(match[1].replace(/\\/g, "/")) : undefined;
}

function runSignTool(signtoolPath, args, options = {}) {
  const timeoutMs =
    Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : DEFAULT_SIGNTOOL_TIMEOUT_MS;

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

  const orderedUrls = [...new Set([...configured, ...DEFAULT_TIMESTAMP_URLS])];
  return orderedUrls.filter((url) => !unhealthyTimestampUrls.has(url));
}

module.exports = async function signWindowsArtifact(configuration) {
  const filePath = configuration && configuration.path;
  if (!filePath) {
    throw new Error("windows-sign: missing target path from electron-builder.");
  }

  const expectedDigest = presignedDigestFor(filePath);
  if (
    expectedDigest &&
    existsSync(filePath) &&
    createHash("sha256").update(readFileSync(filePath)).digest("hex") === expectedDigest
  ) {
    console.log(`[windows-sign] already signed (PortableGit cache): ${filePath}`);
    return;
  }

  const fingerprint = fileFingerprint(filePath);
  if (fingerprint !== null && signedInThisProcess.get(path.resolve(filePath)) === fingerprint) {
    console.log(`[windows-sign] already signed in this build: ${filePath}`);
    return;
  }

  const signtoolPath = process.env.WIN_SIGNTOOL_PATH || "C:\\sign\\signtool.exe";
  if (!existsSync(signtoolPath)) {
    throw new Error(`windows-sign: signtool not found at ${signtoolPath}`);
  }

  const thumbprint = (process.env.WIN_CERT_SHA1 || "")
    .replace(/[^A-Fa-f0-9]/g, "")
    .toUpperCase();
  const enableAutoSelectFallback =
    String(process.env.WIN_CERT_AUTO_SELECT || "true").toLowerCase() !== "false";

  const timestampUrls = getTimestampUrls();
  const maxAttemptsPerUrl = 1;
  const timeoutMs = Number(process.env.WIN_SIGNTOOL_TIMEOUT_MS || DEFAULT_SIGNTOOL_TIMEOUT_MS);
  const requireTimestamp = String(process.env.WIN_REQUIRE_TIMESTAMP || "").toLowerCase() === "true";
  const errors = [];
  const signingProfiles = [];

  if (thumbprint) {
    signingProfiles.push({
      name: `thumbprint ${thumbprint}`,
      certArgs: ["/sha1", thumbprint]
    });
  }
  if (enableAutoSelectFallback) {
    signingProfiles.push({
      name: "auto certificate selection",
      certArgs: ["/a"]
    });
  }

  if (signingProfiles.length === 0) {
    throw new Error(
      "windows-sign: no certificate selection strategy available. Set WIN_CERT_SHA1 or enable WIN_CERT_AUTO_SELECT."
    );
  }

  // If all known timestamp services were marked unhealthy in this build process,
  // skip timestamp attempts and sign directly (unless timestamp is mandatory).
  if (timestampUrls.length === 0 && !requireTimestamp) {
    for (const profile of signingProfiles) {
      try {
        await signAndRemember(
          signtoolPath,
          ["sign", ...profile.certArgs, "/fd", "SHA256", "/v", filePath],
          filePath,
          { timeoutMs }
        );
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`profile=${profile.name} timestamp=none attempt=1 error=${message}`);
      }
    }
  }

  for (const profile of signingProfiles) {
    console.log(`[windows-sign] signing ${filePath} using ${profile.name}`);
    for (const timestampUrl of timestampUrls) {
      for (let attempt = 1; attempt <= maxAttemptsPerUrl; attempt += 1) {
        const args = [
          "sign",
          ...profile.certArgs,
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
          await signAndRemember(signtoolPath, args, filePath, { timeoutMs });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(
            `profile=${profile.name} timestamp=${timestampUrl} attempt=${attempt} error=${message}`
          );
          if (/timed out/i.test(message)) {
            unhealthyTimestampUrls.add(timestampUrl);
            console.warn(
              `[windows-sign] mark timestamp server unavailable for this build: ${timestampUrl}`
            );
          }
          if (attempt < maxAttemptsPerUrl) {
            await sleep(1500);
          }
        }
      }
    }
  }

  if (!requireTimestamp) {
    console.warn(`[windows-sign] timestamp unavailable, fallback to signing without timestamp for ${filePath}`);
    for (const profile of signingProfiles) {
      try {
        await signAndRemember(
          signtoolPath,
          ["sign", ...profile.certArgs, "/fd", "SHA256", "/v", filePath],
          filePath,
          { timeoutMs }
        );
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`profile=${profile.name} timestamp=none attempt=1 error=${message}`);
      }
    }
  }

  throw new Error(`windows-sign: all timestamp attempts failed:\n${errors.join("\n")}`);
};

module.exports.resetForTests = () => {
  signedInThisProcess.clear();
  presignedDigests = null;
};
