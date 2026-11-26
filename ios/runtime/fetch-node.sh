#!/usr/bin/env bash
# fetch-node.sh <outDir> — download nodejs-mobile's iOS framework into <outDir>/NodeMobile.xcframework.
#
# WHY a download with a pinned checksum (not a committed binary, not a package manager): the framework is ~110 MB
# unpacked, far too large for git, and it is the one piece of the app we do not build ourselves. The checksum in
# pins.env means the app can only ever be built with the exact file that was tested on a phone; a changed or
# tampered download stops the build.
set -euo pipefail
OUT="${1:?output dir}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/pins.env"

CACHE="${YOUCODED_IOS_CACHE:-$HERE/../build/cache}"
ZIP="$CACHE/nodejs-mobile-v$NODEJS_MOBILE_VERSION-ios.zip"
STAMP="$OUT/NodeMobile.xcframework/.youcoded-sha256"

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$NODEJS_MOBILE_SHA256" ]; then
  echo "[fetch-node] NodeMobile.xcframework $NODEJS_MOBILE_VERSION already in place"
  exit 0
fi

mkdir -p "$CACHE" "$OUT"
if [ ! -f "$ZIP" ] || [ "$(sha "$ZIP")" != "$NODEJS_MOBILE_SHA256" ]; then
  echo "[fetch-node] downloading nodejs-mobile $NODEJS_MOBILE_VERSION"
  curl -fsSL --retry 3 -o "$ZIP.part" "$NODEJS_MOBILE_URL"
  mv "$ZIP.part" "$ZIP"
fi
GOT="$(sha "$ZIP")"
if [ "$GOT" != "$NODEJS_MOBILE_SHA256" ]; then
  echo "[fetch-node] checksum mismatch for $ZIP" >&2
  echo "  expected $NODEJS_MOBILE_SHA256" >&2
  echo "  got      $GOT" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
unzip -q "$ZIP" 'NodeMobile.xcframework/*' -d "$TMP"
rm -rf "$OUT/NodeMobile.xcframework"
mv "$TMP/NodeMobile.xcframework" "$OUT/NodeMobile.xcframework"
printf '%s\n' "$NODEJS_MOBILE_SHA256" > "$STAMP"
echo "[fetch-node] NodeMobile.xcframework $NODEJS_MOBILE_VERSION ready"
