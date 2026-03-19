#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$ROOT_DIR/dist}"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to package the VS Code extension." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

NAME="$(node -p "require('$ROOT_DIR/package.json').name")"
VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"
OUTPUT_PATH="$OUT_DIR/${NAME}-${VERSION}.vsix"

cd "$ROOT_DIR"
npx --yes @vscode/vsce package --out "$OUTPUT_PATH"

echo "$OUTPUT_PATH"
