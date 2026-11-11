# No #syntax directive on purpose: buildx's built-in frontend needs no
# registry metadata fetch, which keeps CI builds hermetic on restricted
# networks (the external docker/dockerfile:1 pull timed out once).
# ============================================================================
# IDBots tenant image — C1 tenant runtime / REQ-A-26.
#
# One container per user runs the IDBots Electron backend in server mode
# (IDBOTS_SERVER_MODE=1) behind the C2 gateway. Build from the REPO ROOT so
# the build context covers every copied tree:
#
#   docker build \
#     --platform linux/amd64 \
#     -f deploy/tenant-image/Dockerfile \
#     --build-arg APP_VERSION="$(node -p 'require("./package.json").version')" \
#     --build-arg GIT_COMMIT="$(git rev-parse HEAD)" \
#     -t idbots/tenant:"$(node -p 'require("./package.json").version')"-"$(git rev-parse HEAD | cut -c1-7)" \
#     .
#
# Stages:
#   deps       node:24-bookworm  full pnpm install (layer-cached on manifests)
#   build      deps + sources    build-time gates + renderer/main/skills builds
#   prod-deps  node:24-bookworm  production-only node_modules (+ skill deps)
#   runtime    debian:bookworm-slim  apt stack, Python venv, payload, uid 1000
#
# See deploy/tenant-image/README.md for the run command, the C1 resource
# table, and the architecture story (x86_64 tenant host, buildx platform).
# ============================================================================

# ---------------------------------------------------------------------------
# Stage 1: deps — full install for building.
# The root postinstall runs here end to end: native rebuilds, the nested
# SKILLs/web-search and dsh-runtime installs, and the dsh kernel + mvc-scrypt
# patches (scripts/apply-dsh-kernel-patches.cjs needs git — the full
# node:24-bookworm image ships it).
# ---------------------------------------------------------------------------
FROM node:24-bookworm AS deps
WORKDIR /app
RUN corepack enable

# Optional Electron binary mirror for build networks where the GitHub
# releases host is unreachable; empty keeps the default download source.
ARG ELECTRON_MIRROR=""
ENV ELECTRON_MIRROR=${ELECTRON_MIRROR}

# Manifests first so the install layer caches until a dependency changes.
# scripts/ is needed because the root postinstall runs scripts/
# rebuild-electron-native-deps.cjs, apply-dsh-kernel-patches.cjs (plus
# scripts/dsh-kernel-patches/), and apply-mvc-scrypt-lib-patch.cjs.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY scripts ./scripts
COPY dsh-runtime/package.json dsh-runtime/pnpm-lock.yaml dsh-runtime/pnpm-workspace.yaml ./dsh-runtime/
# dsh-runtime/pnpm-lock.yaml declares patchedDependencies; the root
# postinstall's nested `pnpm --dir dsh-runtime install --frozen-lockfile`
# reads those patch files from here (same reason as `COPY patches` above).
COPY dsh-runtime/patches ./dsh-runtime/patches
COPY SKILLs/web-search/package.json SKILLs/web-search/pnpm-lock.yaml SKILLs/web-search/pnpm-workspace.yaml ./SKILLs/web-search/

RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage 2: build — sources plus every build-time gate and artifact.
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .

# Build-time gates (REQ-A-26): both must pass or the build fails here.
RUN node scripts/apply-dsh-kernel-patches.cjs --check \
 && pnpm run check:dsh-deps

# Renderer build + the vite-plugin-electron main bundle (dist-electron/main.js
# is the Electron entry), then the loose tsc tree + copied JS runtime modules
# (dist-electron/main/**, same layout the packaged app ships), then skills.
RUN pnpm run build \
 && pnpm run compile:electron \
 && pnpm run build:skills

# The PWA is served by the tenant; a missing or failed build must fail the image.
RUN pnpm run build:mobile

# ---------------------------------------------------------------------------
# Stage 3: prod-deps — production-only node_modules for the runtime payload.
#
# Why not reuse the stock postinstall: its first step rebuilds native modules
# through electron-builder, which is a devDependency and therefore absent
# under --prod. --ignore-scripts skips lifecycle scripts, and the steps that
# matter for the trees this stage ships (root node_modules + the bundled npm
# skills) are applied explicitly below. The mvc-scrypt -> mvc-lib patch runs
# here with the same fail-loud contract as the desktop postinstall: a
# silently unpatched tree must never ship. The DSH runtime ships from the
# build stage instead (its nested install has no devDependencies, so that
# tree is already production-shaped, and the build-stage gates verified its
# kernel patches).
#
# The bundled npm-depending skills (pptx, imap-smtp-email) ship WITH
# node_modules pre-installed here (hoisted, real directories) so the app's
# first-use background install is a no-op and first boot stays inside the C1
# 300 s budget. No Playwright browser is downloaded anywhere: web-search and
# the html2pptx path drive the Debian chromium package.
# ---------------------------------------------------------------------------
FROM node:24-bookworm AS prod-deps
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY scripts ./scripts
COPY SKILLs ./SKILLs

RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
 && pnpm --dir SKILLs/web-search install --prod --frozen-lockfile --ignore-scripts \
 && pnpm --dir SKILLs/pptx install --prod --ignore-scripts --node-linker=hoisted \
 && pnpm --dir SKILLs/imap-smtp-email install --prod --ignore-scripts --node-linker=hoisted \
 && node scripts/apply-mvc-scrypt-lib-patch.cjs

# ---------------------------------------------------------------------------
# Stage 4: runtime — debian:bookworm-slim, non-root, no compilers.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive

# Apt stack (Phase 0 "Tenant Image Requirements" + Electron runtime libs):
#   xvfb, dbus-x11       REQ-A-6 display strategy (Xvfb on :99 + D-Bus)
#   chromium             web-search's browser (auto-detect list hits
#                        /usr/bin/chromium); nothing else may listen on 9222
#   libreoffice-*        docx (Writer), xlsx (Calc recalc), pptx (Impress)
#                        headless conversions; -writer/-calc/-impress over the
#                        full metapackage — no Draw/Base/Math, much smaller
#   pandoc               docx/pptx markdown conversions
#   poppler-utils        pdftotext/pdfinfo + pdf2image's pdftoppm backend
#   tesseract-ocr*       pdf OCR (Simplified Chinese included)
#   ffmpeg               media tools (vision/audio relay)
#   fonts-noto-cjk       CJK rendering for LibreOffice/Chromium
#   libgtk/libnss/...    shared libraries Electron needs on Debian
#   python3, python3-venv  the skills Python venv at /opt/skills-venv
#   curl                 HEALTHCHECK probe
RUN apt-get -o Acquire::Retries=8 -o Acquire::http::Timeout=30 update \
 && apt-get -o Acquire::Retries=8 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
    xvfb \
    dbus \
    dbus-x11 \
    chromium \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    pandoc \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-chi-sim \
    ffmpeg \
    fonts-noto-cjk \
    libgtk-3-0 \
    libnss3 \
    libasound2 \
    libgbm1 \
    libxss1 \
    libxtst6 \
    python3 \
    python3-venv \
    curl \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Skills Python venv (REQ-A-26): /opt/skills-venv on PATH; python-pptx must
# import, so the install fails the build if the venv is incomplete.
COPY deploy/tenant-image/skills-requirements.txt /opt/skills-requirements.txt
RUN python3 -m venv /opt/skills-venv \
 && /opt/skills-venv/bin/pip install --no-cache-dir -r /opt/skills-requirements.txt \
 && /opt/skills-venv/bin/python -c "import pptx, openpyxl, PIL, pdf2image, pypdf, defusedxml, lxml, markitdown, pytesseract; print('[tenant-image] skills venv ok')"
ENV PATH=/opt/skills-venv/bin:$PATH

# App payload: production node_modules + the built artifacts, mirroring the
# unpackaged layout the Electron main bundle resolves at runtime.
WORKDIR /app
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-electron ./dist-electron
# Unpackaged Electron resolves Studio assets from public/ rather than dist/.
COPY --from=build /app/public/default_metabot.png ./public/default_metabot.png
COPY --from=build /app/public/live-stage ./public/live-stage
COPY --from=build /app/public/genesis-stage ./public/genesis-stage
# Mobile/PWA bundle (build:mobile output): the gateway serves /app/* from it
# in server mode (gateway wiring looks next to the app path); absent → 404.
COPY --from=build /app/dist-mobile ./dist-mobile
COPY --from=prod-deps /app/SKILLs ./SKILLs
# web-search's compiled server output comes from the build stage.
COPY --from=build /app/SKILLs/web-search/dist ./SKILLs/web-search/dist
# DSH runtime (bin.mjs + lib + plugins + its own node_modules): the build
# stage's nested install has no devDependencies and the build gates verified
# its kernel patches, so that tree ships as-is (mirrors the packaged app's
# extraResources).
COPY --from=build /app/dsh-runtime ./dsh-runtime
# Bundled MetaApps (same set electron-builder ships as extraResources).
COPY --from=build /app/METAAPPs/buzz ./METAAPPs/buzz
COPY --from=build /app/METAAPPs/chat ./METAAPPs/chat
COPY --from=build /app/METAAPPs/qanda ./METAAPPs/qanda
COPY --from=build /app/METAAPPs/metatask-viz ./METAAPPs/metatask-viz
COPY --from=build /app/METAAPPs/simplelog-timeline ./METAAPPs/simplelog-timeline
# Runtime-read prompt/bootstrap docs (coworkStore + welcomeBootstrap read
# them from app.getAppPath()).
COPY --from=build /app/sandbox/agent-runner ./sandbox/agent-runner

# Electron binary and node/npm for the main process and skill servers
# (skillServices/skillManager fall back to plain `node` on PATH when
# unpackaged; the bundled-skill first-use install needs npm as a backstop).
COPY --from=build /app/node_modules/electron/dist /opt/electron
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /usr/local/bin/npm /usr/local/bin/npm
COPY --from=build /usr/local/bin/npx /usr/local/bin/npx
COPY --from=build /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
ENV PATH=/opt/electron:$PATH

# C1 environment defaults; the entrypoint enforces the required ones.
ENV TZ=Asia/Shanghai
ENV IDBOTS_GATEWAY_PORT=8790
ENV HOME=/home/idbots
# The tenant runs with --cap-drop ALL + no-new-privileges: Chromium's sandbox
# cannot work, so the web-search browser path opts into --no-sandbox. ENV (not
# only an entrypoint export) so docker exec sessions see it too.
ENV WEB_SEARCH_CHROME_NO_SANDBOX=1

# Non-root runtime user (C1: uid 1000) and the single state volume.
# /app/SKILLs must be owned by the runtime user too: COPY payloads arrive as
# root, but skill servers write their own state inside their skill dir
# (web-search's .server.log: EACCES at first start on every tenant → Web2
# search dead fleet-wide, audit gate5 2026-10-25 F-12). The tenant runs with
# --cap-drop ALL, so ownership cannot be fixed at runtime — only in-image.
RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin idbots \
 && mkdir -p /data \
 && chown -R 1000:1000 /data /home/idbots /app/SKILLs
USER 1000
VOLUME ["/data"]

# Required build arguments (REQ-A-27): no usable defaults exist inside the
# image, so an unset value fails the build instead of shipping a blank label.
ARG APP_VERSION
ARG GIT_COMMIT
ARG ROLLBACK_SAFE_TO=""
RUN test -n "$APP_VERSION" \
 && test -n "$GIT_COMMIT" \
 && echo "[tenant-image] version=$APP_VERSION commit=$GIT_COMMIT rollback-safe-to='${ROLLBACK_SAFE_TO}'"
ENV IDBOTS_COMMIT=${GIT_COMMIT}

# C1 image labels.
LABEL org.idbots.version="${APP_VERSION}" \
      org.idbots.commit="${GIT_COMMIT}" \
      org.idbots.contract="1.0.0" \
      org.idbots.rollback-safe-to="${ROLLBACK_SAFE_TO}"

# Liveness per C1: GET /healthz on the gateway port; never blocks on the DB.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${IDBOTS_GATEWAY_PORT}/healthz" >/dev/null || exit 1

COPY --chmod=0755 deploy/tenant-image/entrypoint.sh /usr/local/bin/tenant-entrypoint.sh

# Must run with --init (C1) so SIGTERM reaches Electron through exec.
ENTRYPOINT ["/usr/local/bin/tenant-entrypoint.sh"]
