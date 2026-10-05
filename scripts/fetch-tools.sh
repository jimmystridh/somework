#!/usr/bin/env bash
# Downloads the real infrastructure binaries used by the integration tests (NATS/JetStream and MinIO).
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=tools/bin
mkdir -p "$BIN" tools/downloads

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; esac

NATS_VERSION="${NATS_VERSION:-v2.15.0}"
if [ ! -x "$BIN/nats-server" ]; then
  url="https://github.com/nats-io/nats-server/releases/download/${NATS_VERSION}/nats-server-${NATS_VERSION}-${os}-${arch}.tar.gz"
  echo "fetching $url"
  curl -fsSL "$url" -o tools/downloads/nats.tar.gz
  tar -xzf tools/downloads/nats.tar.gz -C tools/downloads
  cp "tools/downloads/nats-server-${NATS_VERSION}-${os}-${arch}/nats-server" "$BIN/nats-server"
  chmod +x "$BIN/nats-server"
fi

if [ ! -x "$BIN/minio" ]; then
  # MinIO stopped publishing prebuilt binaries; build the (no longer maintained) community server from source with Go.
  echo "building MinIO from source (go install github.com/minio/minio@latest)"
  GOBIN="$PWD/$BIN" GOFLAGS=-mod=mod go install github.com/minio/minio@latest
fi

"$BIN/nats-server" --version
"$BIN/minio" --version | head -1
