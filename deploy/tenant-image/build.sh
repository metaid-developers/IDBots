#!/usr/bin/env bash
# WS-C C1 — tenant image build script.
#
#   deploy/tenant-image/build.sh [--push] [--scan] [--registry R] [--tag T] \
#                                [--platform linux/amd64]
#
# Builds {REGISTRY}/idbots/tenant:{version}-{commit7} with the C1 labels.
# Defaults: registry=registry.cn-hongkong.aliyuncs.com, platform=linux/amd64.
#   --push   push the tag (requires `docker login` to the ACR push credential)
#   --scan   Trivy gate: fail on CRITICAL vulnerabilities that have a fix
#            (REQ-C-9 step 2); requires `trivy` on PATH
# CI (.github/workflows/cloud-images.yml) calls this same script.
set -euo pipefail

REGISTRY="${REGISTRY:-registry.cn-hongkong.aliyuncs.com}"
PLATFORM="linux/amd64"
PUSH=0
SCAN=0
TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --push) PUSH=1; shift ;;
    --scan) SCAN=1; shift ;;
    --registry) REGISTRY="${2:?}"; shift 2 ;;
    --tag) TAG="${2:?}"; shift 2 ;;
    --platform) PLATFORM="${2:?}"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
echo "cwd:       $(pwd)"
echo "script:    $HERE"
echo "repo root: $REPO_ROOT"

VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
COMMIT_FULL="$(git -C "$REPO_ROOT" rev-parse HEAD)"
COMMIT7="$(printf '%s' "$COMMIT_FULL" | cut -c1-7)"
# C2 contract version: the frozen value in docs/cloud-mobile/01-interface-contracts.md
CONTRACT_VERSION="$(sed -n 's/^Contract version: \*\*\([0-9.]*\)\*\*.*/\1/p' \
  "$REPO_ROOT/docs/cloud-mobile/01-interface-contracts.md" | head -1)"
CONTRACT_VERSION="${CONTRACT_VERSION:-1.0.0}"
TAG="${TAG:-${VERSION}-${COMMIT7}}"
IMAGE="${REGISTRY}/idbots/tenant:${TAG}"

echo "building ${IMAGE} (platform ${PLATFORM}, contract ${CONTRACT_VERSION})"

# build_attempt <builder> <electron-mirror>
#   One docker build pass. <electron-mirror> empty keeps the Dockerfile's
#   default download source (github.com/electron/electron releases); non-empty
#   feeds the Dockerfile's ELECTRON_MIRROR ARG (deps stage pnpm install).
build_attempt() {
  local builder="$1" mirror="$2"
  shift 2
  local args=(--build-arg "APP_VERSION=${VERSION}" --build-arg "GIT_COMMIT=${COMMIT_FULL}" --build-arg "CONTRACT_VERSION=${CONTRACT_VERSION}")
  if [ -n "$mirror" ]; then
    args+=(--build-arg "ELECTRON_MIRROR=${mirror}")
  fi
  if [ "$builder" = buildx ]; then
    docker buildx build \
      --platform "$PLATFORM" \
      "${args[@]}" \
      --tag "$IMAGE" \
      --label "org.idbots.version=${VERSION}" \
      --label "org.idbots.commit=${COMMIT_FULL}" \
      --label "org.idbots.contract=${CONTRACT_VERSION}" \
      --file "$HERE/Dockerfile" \
      --load \
      "$REPO_ROOT"
  else
    docker build \
      "${args[@]}" \
      --tag "$IMAGE" \
      --file "$HERE/Dockerfile" \
      "$REPO_ROOT"
  fi
}

# The Electron binary download is the build's one github.com dependency, and
# the releases CDN has recurring outage windows (2026-11-08 CI: two consecutive
# 504s). When ELECTRON_MIRROR is not preset, retry the failed pass once against
# npmmirror before giving up. An explicit ELECTRON_MIRROR is never overridden.
ELECTRON_MIRROR="${ELECTRON_MIRROR:-}"
ELECTRON_MIRROR_FALLBACK="${ELECTRON_MIRROR_FALLBACK:-https://npmmirror.com/mirrors/electron/}"

BUILDER="${IDBOTS_BUILDER:-buildx}"
if [ "$BUILDER" = buildx ]; then
  if build_attempt buildx "$ELECTRON_MIRROR"; then
    BUILDER=buildx-done
  elif build_attempt buildx "$ELECTRON_MIRROR_FALLBACK"; then
    echo "electron download failed from the default source; build succeeded via mirror fallback: ${ELECTRON_MIRROR_FALLBACK}" >&2
    BUILDER=buildx-done
  else
    echo "buildx failed (often registry reachability on dev machines) — falling back to classic docker build (host platform)" >&2
    BUILDER=classic
  fi
fi
if [ "$BUILDER" = classic ]; then
  if ! build_attempt classic "$ELECTRON_MIRROR"; then
    build_attempt classic "$ELECTRON_MIRROR_FALLBACK"
  fi
fi

if [ "$SCAN" = 1 ]; then
  echo "scanning ${IMAGE} with trivy (fail on fixed CRITICAL)"
  trivy image --severity CRITICAL --ignore-unfixed --exit-code 1 "$IMAGE"
fi

if [ "$PUSH" = 1 ]; then
  echo "pushing ${IMAGE}"
  docker push "$IMAGE"
fi

echo "done: ${IMAGE}"
