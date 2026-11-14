#!/usr/bin/env bash
# Run one of the tools in this folder: `bash run-tool.sh validate-chat-files.mjs <folder> [options]`.
# WHY a wrapper: the repo has no ts runner (tsx/esbuild) and Node cannot load the store's extension-less
# TypeScript imports directly, so the store is compiled with the repo's own tsc into a throwaway folder
# first and the tool (plain .mjs) loads that build. WHY .mjs: the tools are hand-run, never imported,
# so they stay out of the TypeScript project (and its dead-code check). Not a test, not run in CI.
# Nothing here writes outside the throwaway folder.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
desktop="$(cd "$here/../../../../.." && pwd)"
tool="$1"; shift
out="$(mktemp -d "${TMPDIR:-/tmp}/mesh-store-tool-XXXXXX")"
trap 'rm -rf "$out"' EXIT
"$desktop/node_modules/.bin/tsc" --outDir "$out" --rootDir "$desktop/src/main/mesh/store" \
  --ignoreConfig --module commonjs --target es2022 --moduleResolution bundler --esModuleInterop --skipLibCheck --strict \
  --types node --typeRoots "$desktop/node_modules/@types" \
  "$desktop/src/main/mesh/store/index.ts"
MESH_STORE_OUT="$out" node "$here/$tool" "$@"
