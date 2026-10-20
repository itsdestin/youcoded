#!/usr/bin/env bash
# Verify that every packaged macOS app under desktop/release/ is signed and sealed.
#
# WHY this exists: electron-builder SILENTLY skips macOS signing when it cannot sign,
# and a Dependabot bump did exactly that on 2026-07-23 (26.8.1 -> 26.15.3 dropped the
# ad-hoc fallback). Every Mac build from then to 2026-09-03 shipped without a seal,
# which macOS treats as a BROKEN app — no "Open Anyway" button, no way in — and not
# one check anywhere went red. Postmortem:
#   youcoded-dev/docs/archive/investigations/2026-09-03-macos-beta72-unopenable-postmortem.md
#
# Both mac-producing workflows (desktop-release.yml, desktop-test-build.yml) call this
# ONE script so betas and releases are held to the same standard. Run from desktop/.
#
# What it asserts, per bundle (3: final review 2026-09-30):
#   1. `codesign --verify --deep --strict` passes. This is the verdict Gatekeeper
#      depends on and the exact check @electron/osx-sign runs after signing. It fails
#      both the beta.72 case ("code object is not signed at all") AND the subtler one
#      where a seal exists but no longer matches the bundle's contents — which a
#      "does _CodeSignature exist" test would wave through.
#   2. The signing identifier equals the bundle's own CFBundleIdentifier. An unsigned
#      build keeps the stock prebuilt Electron binary's identifier ("Electron"), so this
#      catches "the wrong thing got signed". Both values are read off the bundle, not
#      hard-coded, so a productName or appId change cannot desync them.
#   3. When the bundle carries Office, its converter (x2t and every dylib beside it) passes
#      `codesign --verify --strict` on its own — see the step below for why --deep misses it.
#
# CODESIGN / PLISTBUDDY overrides exist ONLY so the script can be exercised on Linux
# with stand-ins (tests/verify-mac-signature.test.ts). CI never sets them.
set -euo pipefail

CODESIGN="${CODESIGN:-codesign}"
PLISTBUDDY="${PLISTBUDDY:-/usr/libexec/PlistBuddy}"
XCRUN="${XCRUN:-xcrun}"
SPCTL="${SPCTL:-spctl}"
RELEASE_DIR="${1:-release}"

# WHY: a valid ad-hoc seal is sufficient for dev, but is NOT evidence of Apple trust.
# Trusted workflows must fail closed if they lose the certificate or notarization.
if [ "${SIGN_MACOS:-false}" = true ] && [ -z "${APPLE_TEAM_ID:-}" ]; then
  echo '::error::APPLE_TEAM_ID is required to verify a trusted Mac build'
  exit 1
fi

verify_developer_id() {
  local code="$1" info="$2"
  if ! printf '%s\n' "$info" | grep -q '^Authority=Developer ID Application:'; then
    echo "::error::$code does not carry a Developer ID Application signature"
    exit 1
  fi
  if ! printf '%s\n' "$info" | grep -Fxq "TeamIdentifier=$APPLE_TEAM_ID"; then
    echo "::error::$code TeamIdentifier does not match $APPLE_TEAM_ID"
    exit 1
  fi
  if ! printf '%s\n' "$info" | grep -q 'flags=.*(.*runtime.*)'; then
    echo "::error::$code is missing the hardened runtime"
    exit 1
  fi
  if ! printf '%s\n' "$info" | grep -q '^Timestamp=.'; then
    echo "::error::$code is missing a secure timestamp"
    exit 1
  fi
}

found=0
while IFS= read -r app; do
  found=$((found + 1))
  echo "checking $app"

  # 1. Ask macOS whether the seal is valid. Capture the output FIRST, then test the
  #    exit code — under `set -e` a failing command inside $(...) would abort the
  #    script before any ::error:: line ran, swallowing codesign's own explanation.
  if ! verify_out=$("$CODESIGN" --verify --deep --strict --verbose=2 "$app" 2>&1); then
    echo "::error::$app failed codesign --verify: ${verify_out:-<no output>}"
    exit 1
  fi

  # 2. Signing identifier must match what the bundle says it is.
  if ! details=$("$CODESIGN" -d --verbose=2 "$app" 2>&1); then
    echo "::error::codesign -d failed on $app: ${details:-<no output>}"
    exit 1
  fi
  ident=$(printf '%s\n' "$details" | sed -n 's/^Identifier=//p' | head -n1)
  if ! expected=$("$PLISTBUDDY" -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" 2>&1); then
    echo "::error::could not read CFBundleIdentifier from $app/Contents/Info.plist: $expected"
    exit 1
  fi
  if [ -z "$ident" ] || [ "$ident" != "$expected" ]; then
    echo "::error::$app signing identifier is '${ident:-<none>}', expected '$expected' (Info.plist)"
    exit 1
  fi
  echo "  ok: $ident, $(printf '%s\n' "$details" | sed -n 's/^Signature=//p' | head -n1 | sed 's/^$/certificate/') signature"

  if [ "${SIGN_MACOS:-false}" = true ]; then
    verify_developer_id "$app" "$details"
    if ! ticket_out=$("$XCRUN" stapler validate "$app" 2>&1); then
      echo "::error::$app failed notarization ticket validation: $ticket_out"
      exit 1
    fi
    if ! gatekeeper_out=$("$SPCTL" --assess --verbose=2 --type execute "$app" 2>&1); then
      echo "::error::$app failed Gatekeeper assessment: $gatekeeper_out"
      exit 1
    fi
    echo '  ok: Developer ID and notarization verified'
  fi

  # 3. The Office converter (x2t and its dylibs) is signed on its own. WHY (final review,
  #    2026-09-30): it lives in Contents/Resources/, where --deep does not look for code — the
  #    app's seal covers those files only as plain resources. Apple silicon refuses to run
  #    unsigned code, so an x2t the signer skipped would fail every Office open on a Mac while
  #    check 1 stayed green. electron-builder.yml's signIgnore leaves exactly these to the signer.
  conv="$app/Contents/Resources/office/converter"
  if [ -d "$app/Contents/Resources/office" ]; then
    if [ ! -f "$conv/x2t" ]; then
      echo "::error::$app carries Office but no converter/x2t"
      exit 1
    fi
    n=0
    for code in "$conv/x2t" "$conv"/*.dylib; do
      [ -e "$code" ] || continue
      if ! code_out=$("$CODESIGN" --verify --strict --verbose=2 "$code" 2>&1); then
        echo "::error::$code failed codesign --verify: ${code_out:-<no output>}"
        exit 1
      fi
      if [ "${SIGN_MACOS:-false}" = true ]; then
        if ! code_details=$("$CODESIGN" -d --verbose=2 "$code" 2>&1); then
          echo "::error::could not inspect $code: $code_details"
          exit 1
        fi
        verify_developer_id "$code" "$code_details"
      fi
      n=$((n + 1))
    done
    echo "  ok: Office converter signed (x2t and $((n - 1)) dylib(s))"
  fi
done < <(find "$RELEASE_DIR" -maxdepth 2 -name '*.app' -type d)

if [ "$found" -eq 0 ]; then
  echo "::error::no .app bundle found under $RELEASE_DIR/ - did the mac build run?"
  exit 1
fi
echo "$found macOS bundle(s) signed and sealed"
