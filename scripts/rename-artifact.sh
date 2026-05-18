#!/usr/bin/env bash
# scripts/rename-artifact.sh — insert OS name (macOS / Windows) into
# Tauri's bundle filenames so users see what they're downloading
# without having to recognize `.dmg` / `.exe` extensions.
#
# Tauri's bundler hard-codes the artifact filename as
# `{productName}_{version}_{archSuffix}.{ext}` — there's no
# `artifactName` config to customize this. We do the rename after
# `tauri build` instead:
#
#   Galley_0.1.1-alpha.1_aarch64.dmg       → Galley_0.1.1-alpha.1_macOS_aarch64.dmg
#   Galley_0.1.1-alpha.1_x64.dmg           → Galley_0.1.1-alpha.1_macOS_x64.dmg
#   Galley_0.1.1-alpha.1_x64-setup.exe     → Galley_0.1.1-alpha.1_Windows_x64-setup.exe
#
# Idempotent: skips files that already include `_macOS_` / `_Windows_`.
#
# Usage:
#   ./scripts/rename-artifact.sh <rust-target-triple>
#
# Examples:
#   ./scripts/rename-artifact.sh aarch64-apple-darwin
#   ./scripts/rename-artifact.sh x86_64-apple-darwin
#   ./scripts/rename-artifact.sh x86_64-pc-windows-msvc
#
# Called by:
#   - .github/workflows/release.yml after `tauri build` (per matrix entry)
#   - locally by JC after `pnpm tauri build` on his Intel Mac

set -euo pipefail

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "Usage: $0 <rust-target-triple>" >&2
  echo "Known triples: aarch64-apple-darwin / x86_64-apple-darwin / x86_64-pc-windows-msvc" >&2
  exit 1
fi

case "$TARGET" in
  *-apple-darwin)
    OS="macOS"
    BUNDLE_DIR_NAME="dmg"
    GLOB="*.dmg"
    ;;
  *-pc-windows-msvc)
    OS="Windows"
    BUNDLE_DIR_NAME="nsis"
    GLOB="*-setup.exe"
    ;;
  *)
    echo "Unmapped target: $TARGET" >&2
    exit 1
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$REPO_ROOT/core/target/$TARGET/release/bundle/$BUNDLE_DIR_NAME"

if [[ ! -d "$DIR" ]]; then
  echo "[rename-artifact] bundle dir not found: $DIR" >&2
  echo "[rename-artifact] (did you run \`pnpm tauri build --target $TARGET\` first?)" >&2
  exit 1
fi

cd "$DIR"

# nullglob so unmatched pattern yields empty array rather than the
# literal "*.dmg" string.
shopt -s nullglob
matches=( $GLOB )
shopt -u nullglob

if [[ ${#matches[@]} -eq 0 ]]; then
  echo "[rename-artifact] no files matching $GLOB in $DIR" >&2
  exit 1
fi

for f in "${matches[@]}"; do
  if [[ "$f" == *"_${OS}_"* ]]; then
    echo "[rename-artifact] $f already contains '_${OS}_', skipping"
    continue
  fi
  # Tauri pattern: Galley_<version>_<archSuffix>.<ext>
  # Split: drop ext, then split base on last underscore.
  BASE="${f%.*}"
  EXT="${f##*.}"
  PREFIX="${BASE%_*}"   # everything before the last '_'
  ARCH="${BASE##*_}"    # everything after the last '_'
  NEW="${PREFIX}_${OS}_${ARCH}.${EXT}"
  echo "[rename-artifact] $f → $NEW"
  mv -- "$f" "$NEW"
done
