const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");

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

  const timestampUrl = process.env.WIN_TIMESTAMP_URL || "http://time.certum.pl";
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

  await runSignTool(signtoolPath, args);
};
