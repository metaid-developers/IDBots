# IDBots tenant image (`deploy/tenant-image/`)

The C1 tenant runtime: one container per user runs the IDBots Electron
backend in server mode and serves the C2 gateway. Contract:
[`docs/cloud-mobile/01-interface-contracts.md`](../../docs/cloud-mobile/01-interface-contracts.md)
(C1) and requirements
[`docs/cloud-mobile/10-ws-a-idbots-server-mode.md`](../../docs/cloud-mobile/10-ws-a-idbots-server-mode.md)
(REQ-A-6, REQ-A-26, REQ-A-27, REQ-A-28).

- `Dockerfile` — multi-stage build (`deps` → `build` → `prod-deps` →
  `runtime`, Debian bookworm base).
- `entrypoint.sh` — REQ-A-6 entrypoint baked in at
  `/usr/local/bin/tenant-entrypoint.sh`.
- `skills-requirements.txt` — Python packages for the bundled document
  skills, installed into `/opt/skills-venv` (on `PATH`).
- `docker-compose.yml` — local/dev runner encoding the C1 resource table.
- `verify-image.sh` — post-build checks against a built image.

## Architecture

The tenant host is **x86_64** (Hong Kong ECS). This development host is
**arm64**, so always build through buildx with an explicit platform; the
image is not arch-portable because of the Debian `chromium` and
`libreoffice` binaries and the Electron download:

```bash
docker buildx build --platform linux/amd64 ...
```

Add `--load` to keep the result in the local Docker daemon (single-platform),
or push straight to the registry in WS-C's CI.

## Build (REQ-A-27)

From the **repository root** (the build context must cover every copied
tree). Tag and labels come from build arguments; the build fails if
`APP_VERSION` or `GIT_COMMIT` is empty:

```bash
APP_VERSION="$(node -p 'require("./package.json").version')"
COMMIT7="$(git rev-parse HEAD | cut -c1-7)"

docker buildx build --platform linux/amd64 --load \
  -f deploy/tenant-image/Dockerfile \
  --build-arg APP_VERSION="${APP_VERSION}" \
  --build-arg GIT_COMMIT="$(git rev-parse HEAD)" \
  --build-arg ROLLBACK_SAFE_TO="" \
  -t "idbots/tenant:${APP_VERSION}-${COMMIT7}" \
  .
```

- Tag: `{appVersion}-{commit7}` (C1), e.g. `1.0.2-a2bff22`.
- `org.idbots.rollback-safe-to` defaults to empty (C1: empty when no
  rollback is safe). Each release note states the oldest safe version and
  WS-C's CI passes it here.
- `ELECTRON_MIRROR` (optional build ARG, empty by default) points the
  Electron binary download at a mirror on build networks where the GitHub
  releases host is unreachable; leave it unset for normal builds.

Both build-time gates from REQ-A-26 run in the `build` stage and fail the
build on error: `node scripts/apply-dsh-kernel-patches.cjs --check` and
`pnpm run check:dsh-deps`.

## Run (C1 resource table baked in)

```bash
docker run -d --name idbots-tenant --init \
  --memory 2304m --memory-swap 4608m \
  --cpus 2 \
  --pids-limit 2048 \
  --shm-size 1g \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --restart unless-stopped \
  --log-driver json-file --log-opt max-size=20m --log-opt max-file=5 \
  -v idbots-tenant-data:/data \
  -e IDBOTS_SERVER_MODE=1 \
  -e IDBOTS_TENANT_ID=t_xxxxxxxxxxxxxxxxxxxx \
  -e IDBOTS_GATEWAY_SECRET="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" \
  -e IDBOTS_BOOTSTRAP_DISPLAY_NAME="IDBots User" \
  "idbots/tenant:${APP_VERSION}-${COMMIT7}"
```

Notes:

- **RAM plus an equal swap allowance.** `--memory-swap` is RAM and swap
  combined, so `4608m` leaves the 2304 MB RAM cap of the C1 table intact and
  lets the tenant use up to 2304 MB of host swap (CR-WSA-006). Tenant hosts
  back that swap with zram; without a swap device the allowance is unused.
- **No published ports.** The container listens on
  `0.0.0.0:{IDBOTS_GATEWAY_PORT}` (default 8790) inside the container
  network; the control plane (WS-B/WS-C) reaches it over that network.
- **Port 9222 is web-search's.** The web-search skill attaches its own
  Chromium to whatever answers on 9222 (`SKILLs/web-search/server/config.ts`
  fixes the port), and the app itself never opens a debugging port
  (REQ-A-32). Do not map or proxy 9222 to anything else, and do not add
  flags that would put another listener there — web-search would drive the
  wrong page (the Phase 0 failure mode).
- `--memory 2304m` covers the highest corrected skill peak (pptx 1630 MB ×
  1.3); `--shm-size 1g` is the value Phase 0 ran with.
- Environment variables: full table in C1 ("Environment"). Required:
  `IDBOTS_SERVER_MODE=1`, `IDBOTS_TENANT_ID`, `IDBOTS_GATEWAY_SECRET`.
  Optional (`IDBOTS_GATEWAY_PORT`, `IDBOTS_GATEWAY_TIER`, the three
  `IDBOTS_*_PATH` overrides, `IDBOTS_BOOTSTRAP_*`, `IDBOTS_METASO_*`,
  `TZ`) use the C1 defaults baked into the image and the app.

For day-to-day local runs, `docker compose -f deploy/tenant-image/docker-compose.yml up`
encodes the same flags (build args included).

## Verification

```bash
deploy/tenant-image/verify-image.sh <image:tag> [build-log]
```

Checks labels, uid 1000, the skills venv (`python-pptx` import), the apt
stack (`chromium`, `soffice`, `pandoc`, `tesseract` with `chi_sim`,
`ffmpeg`), the entrypoint's server-mode refusal, and — when the build log
from `docker buildx build ... 2>&1 | tee build.log` is passed — the two
build-time gate results.

## Apt stack and image-size decisions

Phase 0's "Tenant Image Requirements" drive the runtime stage:

| Package | Why |
|---|---|
| `xvfb`, `dbus`, `dbus-x11` | REQ-A-6 display strategy: Xvfb on `:99` + a D-Bus session bus. |
| `chromium` | web-search's browser; the skill's auto-detect list hits `/usr/bin/chromium`. No Playwright browser is downloaded anywhere in the image. |
| `libreoffice-writer`, `libreoffice-calc`, `libreoffice-impress` | Document skills: Writer (docx → PDF), Calc (`recalc.py` headless recalculation), Impress (pptx conversions). The component packages pull `libreoffice-core`; the full `libreoffice` metapackage additionally drags in Draw/Base/Math and their dependency chains for no skill need, so it is deliberately not installed. |
| `pandoc` | docx/pptx markdown conversions. |
| `poppler-utils` | `pdftotext`/`pdfinfo` and the `pdf2image` backend (`pdftoppm`). |
| `tesseract-ocr`, `tesseract-ocr-chi-sim` | PDF OCR including Simplified Chinese. |
| `ffmpeg` | Media tools (vision/audio relay). |
| `fonts-noto-cjk` | CJK rendering for LibreOffice conversions and Chromium. |
| `libgtk-3-0`, `libnss3`, `libasound2`, `libgbm1`, `libxss1`, `libxtst6` | Electron's shared-library set on Debian; X itself comes from `xvfb`. |
| `python3`, `python3-venv` | The skills Python venv at `/opt/skills-venv`. |
| `curl`, `ca-certificates` | `HEALTHCHECK` probe on `/healthz`; TLS for outbound. |

## Production `node_modules` decision

The image uses a dedicated production install (`prod-deps` stage:
`pnpm install --prod --frozen-lockfile --ignore-scripts`), not a copy of
the full development `node_modules` — the full tree is ~1.6 GB, dominated
by the Electron binary download and the dev toolchain, none of which the
tenant runs. The stock root postinstall cannot run under `--prod` (its
first step drives the native rebuild through `electron-builder`, a
devDependency), so `--ignore-scripts` is used and every
production-relevant effect is applied explicitly: the nested
`SKILLs/web-search` prod install and the `mvc-scrypt` → `mvc-lib` patch
run in `prod-deps`, while the DSH runtime ships from the `build` stage —
its nested install has no devDependencies, so that tree is already
production-shaped and the build-stage gates verified its kernel patches.
The Electron-ABI native rebuild is dev-only tooling: the container runs
the main bundle through the Electron binary and skill servers through
system `node`, and `ws` degrades gracefully without its optional native
addons.

The bundled npm-depending skills (`pptx`, `imap-smtp-email`) get their
`node_modules` pre-installed in the image (hoisted, real directories), so
the app's first-use background install finds nothing to do and a fresh
tenant stays inside the C1 300 s ready budget instead of downloading
`playwright`/`sharp` on first boot.

## Payload layout

`/app` mirrors the unpackaged layout the main bundle resolves at runtime:
`package.json` (`main: dist-electron/main.js`, the vite-plugin-electron
bundle), production `node_modules/`, `dist/` (renderer), `dist-electron/`
(bundle + the tsc tree with the copied JS runtime modules), `SKILLs/`
(bundled, read-only set; the writable copies live in `/data/userdata/SKILLs`),
`dsh-runtime/` with its own `node_modules` (mirroring the packaged app's
extraResources), the five bundled `METAAPPs/`, and
`sandbox/agent-runner/` (prompt/bootstrap docs read from `app.getAppPath()`).
The Electron binary ships at `/opt/electron`, and `node`/`npm` from the
Node image are on `PATH` for the skill servers and the first-use install
backstop.

## Registry

WS-C's CI builds and pushes this image to the registry
(`{REGISTRY}/idbots/tenant:{appVersion}-{commit7}`, C1); this workstream
does not open or use cloud accounts. The compose file and the commands
above are for local builds and the AC-A-3/4/5 acceptance runs.
