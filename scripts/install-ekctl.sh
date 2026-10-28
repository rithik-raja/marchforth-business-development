#!/usr/bin/env bash
set -euo pipefail

VERSION="1.9.0"
SHA256="6f5b78353c9b1e4a06dfdb39a4de16a63e845f50be87158a95a36abb529753ec"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/bin/ekctl"
URL="https://github.com/schappim/ekctl/releases/download/v${VERSION}/ekctl-v${VERSION}.tar.gz"

if [[ -x "$BIN" ]] && [[ "$("$BIN" --version 2>/dev/null || true)" == "$VERSION" ]]; then
  echo "ekctl ${VERSION} already installed at ${BIN}"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "$URL" -o "$TMP/ekctl.tar.gz"
printf '%s  %s\n' "$SHA256" "$TMP/ekctl.tar.gz" | shasum -a 256 -c -
tar -xzf "$TMP/ekctl.tar.gz" -C "$TMP"

mkdir -p "$ROOT/bin"
cp "$TMP/ekctl" "$BIN"
chmod +x "$BIN"
xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true

echo "Installed ekctl ${VERSION} at ${BIN}"
"$BIN" --version
