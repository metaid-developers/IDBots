#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE_NAME=${IMAGE_NAME:-idbots-sandbox-image-builder}
DOCKERFILE=${DOCKERFILE:-"${ROOT_DIR}/sandbox/image/Dockerfile"}
BUILD_CONTEXT=${BUILD_CONTEXT:-"${ROOT_DIR}/sandbox/image"}
CONTAINER_PLATFORM=${CONTAINER_PLATFORM:-}
BASE_IMAGE=${BASE_IMAGE:-ubuntu:22.04}

# Auto-detect container tool: prefer docker, then podman
if [ -z "${CONTAINER_TOOL:-}" ]; then
  if command -v docker >/dev/null 2>&1; then
    CONTAINER_TOOL=docker
  elif command -v podman >/dev/null 2>&1; then
    CONTAINER_TOOL=podman
  else
    echo "Error: Neither docker nor podman found. Install one to continue." >&2
    exit 1
  fi
fi

echo "Using container tool: ${CONTAINER_TOOL}"

if ! command -v "${CONTAINER_TOOL}" >/dev/null 2>&1; then
  echo "Container tool '${CONTAINER_TOOL}' is required to run this script." >&2
  exit 1
fi

HOST_UID=$(id -u)
HOST_GID=$(id -g)
WORK_DIR_DEFAULT=/tmp/idbots-sandbox-work
WORK_DIR_ENV=${WORK_DIR:-${WORK_DIR_DEFAULT}}

# Container-specific options
CONTAINER_OPTS=""
VOLUME_OPTS=""
DEVICE_OPTS=""

if [ "${CONTAINER_TOOL}" = "podman" ]; then
  # On macOS, podman machine needs rootful mode for privileged operations
  if [ "$(uname)" = "Darwin" ]; then
    echo "Note: On macOS, ensure 'podman machine' is running in rootful mode for privileged operations."
    echo "Run: podman machine stop && podman machine set --rootful && podman machine start"
    # For macOS podman, we need to run as root inside the container
    # --userns=keep-id doesn't work well with privileged operations
  else
    # On Linux, use keep-id for proper user mapping
    CONTAINER_OPTS="--userns=keep-id"
    # Add SELinux label for volume mounts (useful on Fedora/RHEL)
    VOLUME_OPTS=":Z"
  fi
  # Add security options for device access
  CONTAINER_OPTS="${CONTAINER_OPTS} --security-opt label=disable"
fi

# Mount /dev for loop device access (needed for disk image creation)
DEV_MOUNT="-v /dev:/dev"

BUILD_PLATFORM_ARGS=()
RUN_PLATFORM_ARGS=()
BUILD_ARG_BASE_IMAGE=(--build-arg "BASE_IMAGE=${BASE_IMAGE}")
if [ -n "${CONTAINER_PLATFORM}" ]; then
  BUILD_PLATFORM_ARGS=(--platform "${CONTAINER_PLATFORM}")
  RUN_PLATFORM_ARGS=(--platform "${CONTAINER_PLATFORM}")
  echo "Using container platform: ${CONTAINER_PLATFORM}"
fi

echo "Using base image: ${BASE_IMAGE}"
"${CONTAINER_TOOL}" build "${BUILD_PLATFORM_ARGS[@]}" "${BUILD_ARG_BASE_IMAGE[@]}" -f "${DOCKERFILE}" -t "${IMAGE_NAME}" "${BUILD_CONTEXT}"

"${CONTAINER_TOOL}" run --rm --privileged "${RUN_PLATFORM_ARGS[@]}" ${CONTAINER_OPTS} ${DEV_MOUNT} \
  -e ARCHS="${ARCHS:-}" \
  -e ALPINE_MIRROR="${ALPINE_MIRROR:-}" \
  -e ALPINE_BRANCH="${ALPINE_BRANCH:-}" \
  -e ALPINE_VERSION="${ALPINE_VERSION:-}" \
  -e IMAGE_SIZE="${IMAGE_SIZE:-}" \
  -e AGENT_RUNNER_BUILD="${AGENT_RUNNER_BUILD:-}" \
  -e ALLOW_CROSS="${ALLOW_CROSS:-}" \
  -e WORK_DIR="${WORK_DIR_ENV}" \
  -e NO_SUDO="1" \
  -e HOST_UID="${HOST_UID}" \
  -e HOST_GID="${HOST_GID}" \
  -v "${ROOT_DIR}:/workspace${VOLUME_OPTS}" \
  -w /workspace \
  "${IMAGE_NAME}" \
  -lc "sandbox/image/build.sh && { chown -R ${HOST_UID}:${HOST_GID} sandbox/image/out || true; if [[ \"${WORK_DIR_ENV}\" == /workspace/* ]]; then chown -R ${HOST_UID}:${HOST_GID} \"${WORK_DIR_ENV}\" || true; fi; }"
