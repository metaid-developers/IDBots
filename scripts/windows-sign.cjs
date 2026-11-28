const { spawn } = require("node:child_process");
const { existsSync, statSync, readFileSync, copyFileSync, unlinkSync } = require("node:fs");
const { createHash } = require("node:crypto");
const os = require("node:os");
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
    } catch (error) {
      // No variable set is normal (no cache hit, or a machine without the cache):
      // nothing is pre-signed. A variable that points at a file that cannot be read is
      // not — it is why the first cache hit went unnoticed (run 46037790077, 2026-11-28:
      // the list had been written to another directory) — so it is said out loud.
      if (process.env.IDBOTS_PRESIGNED_MANIFEST) {
        console.warn(`[windows-sign] the digest list of pre-signed PortableGit files cannot be read (${process.env.IDBOTS_PRESIGNED_MANIFEST}): ${error instanceof Error ? error.message : error}. They will be signed again.`);
      }
      presignedDigests = new Map();
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

// A signature asked without a timestamp puts nothing on the path but the
// signing service: there is no timestamp server to wait for. So when the
// service has fallen silent, one such question settles it. The ladder used to
// spend eight timeouts of 90 seconds — three servers, two certificate
// profiles, two last attempts without a timestamp — and then blame the
// timestamp servers. On the signing machine the service is SimplySign, whose
// session runs out 2 h 27 min after the login however recently it was used
// (release SOP 11.54): run 46051725913 signed its smoke test at 18:45 and
// found the service gone at 19:34.
// Asks on a throwaway copy of signtool itself, as the job's smoke test does.
// @returns {Promise<"answered" | "silent" | string>} "silent" for a timeout, the reason for a refusal
async function askSignerAlone(signtoolPath, certArgs, options = {}) {
  const probePath = path.join(os.tmpdir(), `idbots-signer-probe-${process.pid}-${Date.now()}.exe`);
  try {
    copyFileSync(signtoolPath, probePath);
    await runSignTool(signtoolPath, ["sign", ...certArgs, "/fd", "SHA256", probePath], options);
    return "answered";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /timed out/i.test(message) ? "silent" : `refused: ${message}`;
  } finally {
    try {
      unlinkSync(probePath);
    } catch {
      // best effort
    }
  }
}

function signerSilentError(filePath, timeoutMs, errors) {
  return new Error(
    [
      "windows-sign: the signing service is not answering.",
      `signtool timed out after ${timeoutMs}ms on a signature asked without a timestamp, so no timestamp server is involved. What was tried for ${filePath}:`,
      ...errors,
      "On the signing machine this is the SimplySign session running out: it lasts 2 h 27 min from the login, however recently it was used (release SOP 11.54).",
      "Re-login SimplySign on the signing machine, do the smoke signature of release SOP 11.18, then rerun the job."
    ].join("\n")
  );
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
  let signerAnswered = false;

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

  // One attempt without a timestamp for each profile. A timeout here is the
  // signing service itself, so it is the end of the build, named as that;
  // a refusal is a reason to go on to the next profile.
  const signWithoutTimestamp = async () => {
    for (const profile of signingProfiles) {
      try {
        await signAndRemember(
          signtoolPath,
          ["sign", ...profile.certArgs, "/fd", "SHA256", "/v", filePath],
          filePath,
          { timeoutMs }
        );
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`profile=${profile.name} timestamp=none attempt=1 error=${message}`);
        if (/timed out/i.test(message)) {
          throw signerSilentError(filePath, timeoutMs, errors);
        }
      }
    }
    return false;
  };

  // If all known timestamp services were marked unhealthy in this build process,
  // skip timestamp attempts and sign directly (unless timestamp is mandatory).
  if (timestampUrls.length === 0 && !requireTimestamp) {
    if (await signWithoutTimestamp()) {
      return;
    }
  }

  for (const profile of signingProfiles) {
    // A server given up for this build is not asked again under the next
    // certificate profile: the service answered, the server did not.
    const serversLeft = timestampUrls.filter((timestampUrl) => !unhealthyTimestampUrls.has(timestampUrl));
    if (serversLeft.length === 0 && !requireTimestamp) {
      continue;
    }
    console.log(`[windows-sign] signing ${filePath} using ${profile.name}`);
    for (const timestampUrl of serversLeft) {
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
            // Two things can make a timestamped signature time out: the timestamp
            // server and the signing service. The service alone is asked which.
            if (!signerAnswered) {
              const answer = await askSignerAlone(signtoolPath, profile.certArgs, { timeoutMs });
              if (answer === "silent") {
                throw signerSilentError(filePath, timeoutMs, errors);
              }
              signerAnswered = answer === "answered";
              if (!signerAnswered) {
                errors.push(`profile=${profile.name} asked alone, without a timestamp: ${answer}`);
              }
            }
            if (signerAnswered) {
              unhealthyTimestampUrls.add(timestampUrl);
              console.warn(
                `[windows-sign] mark timestamp server unavailable for this build: ${timestampUrl}`
              );
            }
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
    if (await signWithoutTimestamp()) {
      return;
    }
  }

  throw new Error(`windows-sign: all timestamp attempts failed:\n${errors.join("\n")}`);
};

module.exports.resetForTests = () => {
  signedInThisProcess.clear();
  presignedDigests = null;
  unhealthyTimestampUrls.clear();
};
