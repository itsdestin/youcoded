#!/usr/bin/env bash
# build-backend.sh <outDir> — the desktop backend, packed for the Android app as <outDir>/backend.tgz.
#
# WHY (2026-10-14, Android clean rebuild): the phone runs the desktop's own backend
# (desktop/src/main/headless/headless-main.ts) on the bundled Node. This packs exactly what it loads,
# laid out the way it expects relative to its own files (dist/main, dist/shared, the skill registry,
# hook-scripts and scripts/install-hooks.js, package.json for the version) plus production
# dependencies with other platforms' native builds removed. node-pty's native part is not in here: it
# is built for the phone by build-runtime.sh and copied in by RuntimeInstaller.kt.
# Needs: node + npm (the desktop's toolchain), tar.
set -euo pipefail

OUT="${1:?output dir}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DESKTOP="$(cd "$HERE/../../desktop" && pwd)"
STAGE="$OUT/stage"
DEPS="$OUT/deps"

say() { echo "[build-backend] $*"; }

[ -d "$DESKTOP/node_modules" ] || { echo "[build-backend] desktop/node_modules is missing: run the bundleWebUi task (or npm ci in desktop/) first" >&2; exit 1; }
say "compiling the backend"
# Into our own folder, never the desktop's dist/: the page bundle (bundleWebUi) is copied out of
# dist/renderer, and tsc's output there would ride along into the app.
TSC="$OUT/tsc"
rm -rf "$TSC"
(cd "$DESKTOP" && node scripts/generate-preload-channels.mjs >/dev/null && npx tsc -p . --outDir "$TSC" >/dev/null)
cp "$DESKTOP/src/main/pty-worker.js" "$TSC/main/pty-worker.js"

rm -rf "$STAGE"; mkdir -p "$STAGE/dist/renderer/data" "$STAGE/scripts"
cp "$DESKTOP/package.json" "$STAGE/"
cp -r "$TSC/main" "$TSC/shared" "$STAGE/dist/"
# A few renderer modules are shared with the backend (the marketplace client, types).
cp -r "$TSC/renderer/." "$STAGE/dist/renderer/"
cp "$DESKTOP/src/renderer/data/skill-registry.json" "$STAGE/dist/renderer/data/"
cp -r "$DESKTOP/hook-scripts" "$STAGE/"
cp "$DESKTOP/scripts/install-hooks.js" "$STAGE/scripts/"

# Production dependencies, installed fresh (never through the desktop's own node_modules) and only
# re-installed when the lockfile changes.
if ! cmp -s "$DESKTOP/package-lock.json" "$DEPS/package-lock.json" 2>/dev/null || [ ! -d "$DEPS/node_modules" ]; then
  say "installing production dependencies"
  rm -rf "$DEPS"; mkdir -p "$DEPS"
  cp "$DESKTOP/package.json" "$DESKTOP/package-lock.json" "$DEPS/"
  (cd "$DEPS" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
fi
cp -r "$DEPS/node_modules" "$STAGE/node_modules"
# WHY: retain original notices independently before platform binaries are trimmed.
python3 -I "$HERE/preserve-npm-legal.py" "$STAGE/node_modules" "$STAGE/legal"

say "trimming"
NM="$STAGE/node_modules"
# Other platforms' native builds: the phone is linux arm64 musl.
rm -rf "$NM/node-pty/prebuilds" "$NM/node-pty/build"
if [ -d "$NM/koffi/build/koffi" ]; then
  find "$NM/koffi/build/koffi" -mindepth 1 -maxdepth 1 ! -name musl_arm64 -exec rm -rf {} +
fi
rm -rf "$NM"/@napi-rs/*-x64* "$NM"/@napi-rs/*-darwin* "$NM"/@napi-rs/*-win32* "$NM"/@napi-rs/*-gnu 2>/dev/null || true
rm -rf "$NM"/@vscode/ripgrep/bin 2>/dev/null || true
# WHY: Markdown, documentation and vendored directories can carry LICENSE, NOTICE or
# README-only copyright terms (e.g. jose/LICENSE.md and jszip/LICENSE.markdown).
# Keep them in the shipped backend; only discard generated maps and type declarations.
find "$NM" \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -type f -delete

python3 -I "$HERE/preserve-npm-legal.py" --mark-retained "$NM" "$STAGE/legal"
tar czf "$OUT/backend.tgz" -C "$STAGE" .
say "done: $(du -h "$OUT/backend.tgz" | cut -f1) packed ($(du -sh "$STAGE" | cut -f1) unpacked)"
