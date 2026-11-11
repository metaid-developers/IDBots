import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

/**
 * Static checks for the tenant container image (REQ-A-6 entrypoint,
 * REQ-A-26/27/28) under deploy/tenant-image/. The heavy verification is
 * deploy/tenant-image/verify-image.sh against a built image; these checks
 * keep the frozen contract decisions (C1 labels, resource values, display
 * strategy) from drifting without Docker.
 */

const dir = resolve(import.meta.dirname, "../deploy/tenant-image");

function read(name) {
  return readFileSync(join(dir, name), "utf8");
}

function listFiles(root) {
  const out = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

const dockerfile = read("Dockerfile");
const entrypoint = read("entrypoint.sh");
const readme = read("README.md");
const compose = read("docker-compose.yml");
const allFiles = listFiles(dir);
const allText = allFiles.map((f) => readFileSync(f, "utf8")).join("\n");

test("Dockerfile is multi-stage with node build and debian runtime", () => {
  assert.match(dockerfile, /FROM node:24-bookworm AS deps/);
  assert.match(dockerfile, /FROM deps AS build/);
  assert.match(dockerfile, /FROM node:24-bookworm AS prod-deps/);
  assert.match(dockerfile, /FROM debian:bookworm-slim AS runtime/);
});

test("runtime stage installs are frozen-lockfile only", () => {
  const installs = dockerfile
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("#"))
    .filter((l) => l.includes("pnpm install") || l.includes("pnpm --dir"));
  assert.ok(installs.length >= 3, "expected the deps and prod-deps installs");
  for (const line of installs) {
    assert.ok(
      line.includes("--frozen-lockfile") || line.includes("SKILLs/pptx") || line.includes("SKILLs/imap-smtp-email"),
      `non-frozen install line: ${line.trim()}`,
    );
  }
});

test("no npm ci or npm install anywhere under deploy/tenant-image", () => {
  assert.doesNotMatch(allText, /\bnpm\s+(ci|install)\b/);
});

test("entrypoint launches electron with --no-sandbox via exec and no debugging port", () => {
  assert.match(entrypoint, /exec electron --no-sandbox \/app/);
  // The tenant's no-new-privileges profile breaks Chromium's sandbox too; the
  // web-search browser path must opt into --no-sandbox via this env (AC-A-5).
  // Carried as an image ENV so docker exec sessions inherit it as well.
  assert.match(entrypoint, /WEB_SEARCH_CHROME_NO_SANDBOX=1/);
  assert.match(dockerfile, /^ENV WEB_SEARCH_CHROME_NO_SANDBOX=1/m);
  for (const file of allFiles) {
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes("remote-debugging"), `${file} must not reference remote-debugging`);
  }
});

test("entrypoint implements the REQ-A-6 restart findings", () => {
  assert.ok(entrypoint.includes("rm -f /tmp/.X99-lock /tmp/.X11-unix/X99"), "stale Xvfb locks removed");
  assert.match(entrypoint, /Xvfb :99 /);
  assert.match(entrypoint, /dbus-launch/);
  assert.match(entrypoint, /DISPLAY=:99/);
});

test("entrypoint requires server mode and the C1 secrets", () => {
  assert.match(entrypoint, /IDBOTS_SERVER_MODE/);
  assert.match(entrypoint, /IDBOTS_TENANT_ID/);
  assert.match(entrypoint, /IDBOTS_GATEWAY_SECRET/);
  assert.match(entrypoint, /exit 1/);
  assert.ok(entrypoint.includes("mkdir -p /data/userdata /data/appdata /data/workspace"));
});

test("image runs as uid 1000 with the /data volume", () => {
  assert.match(dockerfile, /useradd --uid 1000/);
  assert.match(dockerfile, /USER 1000/);
  assert.match(dockerfile, /VOLUME \[?"\/data/);
});

test("C1 labels are declared with the contract version", () => {
  assert.match(dockerfile, /org\.idbots\.version/);
  assert.match(dockerfile, /org\.idbots\.commit/);
  assert.match(dockerfile, /org\.idbots\.contract="1\.0\.0"/);
  assert.match(dockerfile, /org\.idbots\.rollback-safe-to/);
  assert.match(dockerfile, /ARG APP_VERSION/);
  assert.match(dockerfile, /ARG GIT_COMMIT/);
});

test("HEALTHCHECK probes /healthz on the gateway port", () => {
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /\/healthz/);
  assert.match(dockerfile, /IDBOTS_GATEWAY_PORT/);
});

test("build gates fail the build (kernel patches --check and dsh-deps)", () => {
  assert.match(dockerfile, /apply-dsh-kernel-patches\.cjs --check/);
  assert.match(dockerfile, /pnpm run check:dsh-deps/);
});

test("tenant images require the PWA build and expose exact commit provenance", () => {
  assert.match(dockerfile, /RUN pnpm run build:mobile/);
  assert.doesNotMatch(dockerfile, /build:mobile not present yet/);
  assert.match(dockerfile, /^ENV IDBOTS_COMMIT=\$\{GIT_COMMIT\}$/m);
});

test("runtime stage ships assets required by unpackaged Studio services", () => {
  for (const asset of ["default_metabot.png", "live-stage", "genesis-stage"]) {
    assert.ok(statSync(resolve(import.meta.dirname, "../public", asset)), `missing source asset ${asset}`);
    assert.ok(
      dockerfile.includes(`COPY --from=build /app/public/${asset} ./public/${asset}`),
      `runtime image must copy public/${asset}`,
    );
  }
});

test("cloud image CI requires the control-plane and conformance legs", () => {
  const workflow = readFileSync(resolve(import.meta.dirname, "../.github/workflows/cloud-images.yml"), "utf8");
  assert.doesNotMatch(workflow, /hashFiles\('cloud\/control-plane\/Dockerfile'\)/);
  assert.doesNotMatch(workflow, /hashFiles\('cloud\/conformance\/run\.mjs'\)/);
  assert.match(workflow, /node cloud\/conformance\/run\.mjs/);
  assert.match(workflow, /ready\.commit !== expected/);
});

test("runtime stage carries the Phase 0 apt stack and the skills venv", () => {
  for (const pkg of [
    "xvfb",
    "dbus-x11",
    "chromium",
    "libreoffice-writer",
    "libreoffice-calc",
    "libreoffice-impress",
    "pandoc",
    "poppler-utils",
    "tesseract-ocr-chi-sim",
    "ffmpeg",
    "fonts-noto-cjk",
    "python3-venv",
  ]) {
    assert.ok(dockerfile.includes(pkg), `missing apt package ${pkg}`);
  }
  assert.match(dockerfile, /\/opt\/skills-venv/);
  assert.match(dockerfile, /import pptx/);
});

test("README and compose encode the C1 resource values", () => {
  for (const text of [readme, compose]) {
    assert.match(text, /2304m/);
    assert.match(text, /1g/);
  }
  assert.match(readme, /--memory 2304m --memory-swap 2304m/);
  assert.match(readme, /--cpus 2/);
  assert.match(readme, /--pids-limit 2048/);
  assert.match(readme, /--shm-size 1g/);
  assert.match(readme, /--cap-drop ALL/);
  assert.match(readme, /no-new-privileges/);
  assert.match(readme, /--restart unless-stopped/);
  assert.match(readme, /max-size=20m/);
  assert.match(readme, /max-file=5/);
  assert.match(readme, /--init/);
  assert.doesNotMatch(compose, /^\s+ports:/m);
  assert.match(compose, /mem_limit: 2304m/);
  assert.match(compose, /shm_size: 1g/);
  assert.match(compose, /cap_drop:/);
});

test("skills requirements cover python-pptx and the document skill imports", () => {
  const reqs = read("skills-requirements.txt");
  for (const pkg of ["python-pptx", "openpyxl", "pdf2image", "pypdf", "defusedxml", "lxml", "markitdown[pptx]", "pytesseract", "Pillow"]) {
    assert.ok(reqs.includes(pkg), `missing python package ${pkg}`);
  }
});
