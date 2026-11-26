#!/usr/bin/env bash
# build-resources.sh — everything the Xcode project needs that is not Swift, then the project itself:
#   build/Resources/web        the shared page (desktop renderer, `npm run build:web`)
#   build/Resources/backend    the desktop backend as one bundle (runtime/build-backend.mjs)
#   build/Frameworks/…         Node for iOS (runtime/fetch-node.sh)
#   YouCoded.xcodeproj         generated from project.yml (needs xcodegen; skipped with a note when absent)
#
# Runs on macOS (CI: .github/workflows/ios-ci.yml) and — for everything except the Xcode project — on Linux,
# which is how the backend bundle is tested off a Mac (desktop/tests/ios-backend-boot.test.ts).
#
# Flags: --skip-web      reuse build/Resources/web (the page build is the slow step)
#        --skip-install  do not run `npm ci` in desktop/ (dependencies are already there)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
DESKTOP="$REPO/desktop"
BUILD="$HERE/build"
SKIP_WEB=0; SKIP_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --skip-web) SKIP_WEB=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done
say() { echo "[ios] $*"; }

mkdir -p "$BUILD/Resources" "$BUILD/Frameworks"

if [ "$SKIP_INSTALL" = 0 ]; then
  say "installing desktop dependencies"
  (cd "$DESKTOP" && npm ci --no-audit --no-fund)
fi

if [ "$SKIP_WEB" = 0 ] || [ ! -f "$BUILD/Resources/web/index.html" ]; then
  say "building the page"
  (cd "$DESKTOP" && npm run build:web)
  [ -f "$DESKTOP/dist/renderer/index.html" ] || { echo "[ios] the page build produced no dist/renderer/index.html" >&2; exit 1; }
  rm -rf "$BUILD/Resources/web"
  cp -R "$DESKTOP/dist/renderer" "$BUILD/Resources/web"
fi

say "bundling the backend"
[ -d "$HERE/runtime/node_modules/esbuild" ] || (cd "$HERE/runtime" && npm ci --no-audit --no-fund)
node "$HERE/runtime/build-backend.mjs" "$BUILD/Resources/backend"

say "fetching Node for iOS"
bash "$HERE/runtime/fetch-node.sh" "$BUILD/Frameworks"

VERSION="$(node -p "require('$DESKTOP/package.json').version")"
BUILD_NUMBER="${YOUCODED_IOS_BUILD_NUMBER:-1}"
if command -v xcodegen >/dev/null 2>&1; then
  say "generating YouCoded.xcodeproj ($VERSION build $BUILD_NUMBER)"
  # The version is stamped into a copy of the spec so project.yml itself never changes during a build.
  sed -e "s/MARKETING_VERSION: \"0.0.0\"/MARKETING_VERSION: \"$VERSION\"/" \
      -e "s/CURRENT_PROJECT_VERSION: \"1\"/CURRENT_PROJECT_VERSION: \"$BUILD_NUMBER\"/" \
      "$HERE/project.yml" > "$HERE/project.stamped.yml"
  (cd "$HERE" && xcodegen generate --spec project.stamped.yml --project .)
  rm -f "$HERE/project.stamped.yml"
else
  say "xcodegen not found: resources are ready, the Xcode project was not generated (macOS only: brew install xcodegen)"
fi
say "done"
