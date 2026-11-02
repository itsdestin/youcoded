#!/usr/bin/env bash
# Phase 0 trial (docs/active/plans/2026-11-01-real-app-testing.md in youcoded-dev): can a free GitHub
# arm64 Linux machine run the Android app's OWN bundled engine, with no phone and no emulator?
#
# WHY this works at all: the APK's programs are ordinary aarch64 musl Linux programs. Their loader path is
# hard-coded to /data/data/<appId>/files/usr/lib (app/runtime/build-runtime.sh), so this script recreates
# exactly the layout RuntimeInstaller.kt builds on a phone, at that same path, then runs them.
#
# Usage: android-engine.sh <apk>      Prints a PASS/FAIL line per check; exits 1 if any check failed.
set -uo pipefail
APK=$(realpath "$1")
WORK=$(mktemp -d)
cd "$WORK"
unzip -q "$APK" 'lib/arm64-v8a/*' 'assets/*'
APP_ID=$(tr -d '[:space:]' < assets/runtime/app-id.txt)
FILES=/data/data/$APP_ID/files
NATIVE=$WORK/lib/arm64-v8a        # stands in for Android's nativeLibraryDir
chmod +x "$NATIVE"/*.so           # Android marks native libraries runnable on install; unzip doesn't
sudo mkdir -p "$FILES" && sudo chown -R "$(id -u):$(id -g)" "/data/data/$APP_ID"
USR=$FILES/usr
mkdir -p "$USR/bin" "$USR/lib" "$USR/libexec/git-core" "$USR/etc/ssl/certs" "$USR/share" "$FILES/home" "$FILES/tmp" "$FILES/userdata"

# Same steps, same order, as RuntimeInstaller.install().
while read -r so soname; do [ -n "$so" ] && ln -sf "$NATIVE/$so" "$USR/lib/$soname"; done < assets/runtime/libmap.txt
while read -r so rel; do
  [ -n "$so" ] || continue
  case "$rel" in */libexec/git-core/*) ln -sf "$NATIVE/$so" "$USR/libexec/git-core/${rel##*/}";;
                 *) ln -sf "$NATIVE/$so" "$USR/bin/${rel##*/}";; esac
done < assets/runtime/binmap.txt
ln -sf "$NATIVE/libgit.so" "$USR/libexec/git-core/git"
cp assets/runtime/ca-certificates.crt "$USR/etc/ssl/certs/"
tar xzf assets/runtime/share.tgz -C "$USR/share"
mkdir -p "$FILES/backend" && tar xzf assets/backend.tgz -C "$FILES/backend"
mkdir -p "$FILES/backend/node_modules/node-pty/build/Release"
cp "$NATIVE/libptynode.so" "$FILES/backend/node_modules/node-pty/build/Release/pty.node"

# Same environment as RuntimeInstaller.environment(), cleared like the phone's ProcessBuilder.
ENVV=(PATH="$USR/bin:/usr/bin:/bin" HOME="$FILES/home" TMPDIR="$FILES/tmp" SHELL="$USR/bin/bash" LANG=C.UTF-8
  TERM=xterm-256color TERMINFO="$USR/share/terminfo" YOUCODED_ETC="$USR/etc"
  SSL_CERT_FILE="$USR/etc/ssl/certs/ca-certificates.crt" GIT_SSL_CAINFO="$USR/etc/ssl/certs/ca-certificates.crt"
  GIT_EXEC_PATH="$USR/libexec/git-core" GIT_TEMPLATE_DIR="$USR/share/git-core/templates"
  YOUCODED_USER_DATA="$FILES/userdata" YOUCODED_RG_PATH="$USR/bin/rg" DISABLE_AUTOUPDATER=1)
run() { env -i "${ENVV[@]}" "$@"; }

FAILS=0
check() { # name, then a command whose success means PASS
  local name=$1; shift
  if out=$("$@" 2>&1); then echo "PASS  $name"; else echo "FAIL  $name"; FAILS=$((FAILS+1)); fi
  echo "$out" | head -8 | sed 's/^/      /'
}

check "bundled node runs"             run "$USR/bin/node" -e 'console.log(process.version, process.arch)'
check "number formatting (language data)" run "$USR/bin/node" -e 'console.log((10000).toLocaleString("en-US"))'
# Sync writes .git/info/exclude without making info/ first (Android report #3); a repo without info/ breaks it.
git_repo_ok() { local d; d=$(mktemp -d); run "$USR/bin/git" init -q "$d/r" && ls -a "$d/r/.git" && test -d "$d/r/.git/info"; }
check "git makes a repo sync can use"  git_repo_ok

# The real backend, started the way BackendService.kt starts it. Ready = it prints YOUCODED_HEADLESS_READY.
TOKEN=$(openssl rand -hex 24); KEY=$(openssl rand -hex 32)
( cd "$FILES/backend" && env -i "${ENVV[@]}" YOUCODED_HEADLESS_PORT=19951 YOUCODED_SECRETS_ON_STDIN=1 \
    YOUCODED_APP_VERSION=probe "$USR/bin/node" dist/main/headless/headless-main.js \
    <<< "{\"token\":\"$TOKEN\",\"key\":\"$KEY\"}" > "$WORK/backend.log" 2>&1 ) &
BPID=$!
for _ in $(seq 1 60); do
  grep -q YOUCODED_HEADLESS_READY "$WORK/backend.log" && break
  kill -0 $BPID 2>/dev/null || break
  sleep 1
done
check "assistant engine starts" grep -q YOUCODED_HEADLESS_READY "$WORK/backend.log"
grep -q YOUCODED_HEADLESS_READY "$WORK/backend.log" || tail -25 "$WORK/backend.log" | sed 's/^/      log: /'
kill $BPID 2>/dev/null

echo "---- $FAILS check(s) failed"
[ "$FAILS" = 0 ]
