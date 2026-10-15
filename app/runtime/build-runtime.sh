#!/usr/bin/env bash
# build-runtime.sh <applicationId> <outDir> — the programs the Android app ships: Node, bash, git, ripgrep
# and Claude Code, built for an app sandbox.
#
# WHY (2026-10-14, Android clean rebuild; every step proved on a real phone, see
# youcoded-dev docs/active/plans/2026-10-14-android-clean-rebuild-plan.md → A0 results):
#  - Programs are Alpine Linux (musl) packages, unmodified except for paths. They ship as
#    jniLibs/arm64-v8a/lib<name>.so because an app may only execute files Android unpacked into its
#    native-library folder (useLegacyPackaging), never files in its own data folder.
#  - Each executable's interpreter is rewritten to /data/data/<appId>/files/usr/lib/ld-musl-aarch64.so.1
#    and its library path to /data/data/<appId>/files/usr/lib; the app fills that folder with symlinks
#    into the native-library folder at startup (RuntimeInstaller.kt). The path names the package, so each
#    build variant (.dev, .releasetest) gets its own build of this folder.
#  - musl is built from source with patch-musl.py (name lookups read $YOUCODED_ETC/resolv.conf).
#  - ycshim.c is linked FIRST into every executable: io_uring, #! scripts, /bin/sh, /etc.
#  - Claude Code is its official musl build, run through the loader (it is a Bun single-file binary;
#    editing its headers is not safe).
# Needs: bash, curl, tar, python3, clang + lld (any recent LLVM). Downloads are cached in $CACHE.
set -euo pipefail

APP_ID="${1:?applicationId}"
OUT="${2:?output dir}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CACHE="${YOUCODED_RUNTIME_CACHE:-$HERE/../build/runtime-cache}"
source "$HERE/pins.env"

FILES="/data/data/$APP_ID/files"
INTERP="$FILES/usr/lib/ld-musl-aarch64.so.1"
RPATH="$FILES/usr/lib"
ALPINE="https://dl-cdn.alpinelinux.org/alpine/$ALPINE_BRANCH"

mkdir -p "$CACHE/apk" "$CACHE/root" "$CACHE/sysroot"
JNI="$OUT/jniLibs/arm64-v8a"
ASSETS="$OUT/assets/runtime"
rm -rf "$OUT"; mkdir -p "$JNI" "$ASSETS"

say() { echo "[build-runtime] $*"; }

# --- tools -------------------------------------------------------------------------------------
PATCHELF="$CACHE/patchelf-$PATCHELF_VERSION/bin/patchelf"
if [ ! -x "$PATCHELF" ]; then
  say "patchelf $PATCHELF_VERSION"
  mkdir -p "$CACHE/patchelf-$PATCHELF_VERSION"
  curl -fsSL "https://github.com/NixOS/patchelf/releases/download/$PATCHELF_VERSION/patchelf-$PATCHELF_VERSION-x86_64.tar.gz" \
    | tar xz -C "$CACHE/patchelf-$PATCHELF_VERSION"
fi

# --- Alpine packages ---------------------------------------------------------------------------
fetch_index() {
  local repo=$1
  [ -s "$CACHE/$repo.idx" ] || curl -fsSL "$ALPINE/$repo/aarch64/APKINDEX.tar.gz" | tar xzO APKINDEX > "$CACHE/$repo.idx"
}
fetch_index main; fetch_index community

# install <dest> <pkg…>: each package and its dependencies, extracted into dest.
install_pkgs() {
  local dest=$1; shift
  (cd "$CACHE" && python3 -I "$HERE/resolve-apk.py" "$@") | while read -r repo name ver _; do
    case "$name" in busybox|busybox-binsh|alpine-baselayout*|apk-tools) continue;; esac
    local f="$CACHE/apk/$name-$ver.apk"
    [ -s "$f" ] || curl -fsSL -o "$f" "$ALPINE/$repo/aarch64/$name-$ver.apk"
    tar xzf "$f" -C "$dest" 2>/dev/null || true
  done
}
say "Alpine $ALPINE_BRANCH: $RUNTIME_PACKAGES"
rm -rf "$CACHE/root"; mkdir -p "$CACHE/root"
install_pkgs "$CACHE/root" $RUNTIME_PACKAGES
[ -x "$CACHE/sysroot/usr/include/node/node.h" ] || [ -f "$CACHE/sysroot/usr/include/node/node.h" ] || install_pkgs "$CACHE/sysroot" $SYSROOT_PACKAGES
R="$CACHE/root"; SR="$CACHE/sysroot"

# --- musl, patched ------------------------------------------------------------------------------
MUSL_SO="$CACHE/musl-$MUSL_VERSION/lib/libc.so"
if [ ! -s "$MUSL_SO" ]; then
  say "musl $MUSL_VERSION"
  curl -fsSL "https://musl.libc.org/releases/musl-$MUSL_VERSION.tar.gz" | tar xz -C "$CACHE"
  python3 -I "$HERE/patch-musl.py" "$CACHE/musl-$MUSL_VERSION"
  CRT="$(find "$SR" -name 'libclang_rt.builtins-aarch64.a' | head -1)"
  (cd "$CACHE/musl-$MUSL_VERSION" && CC="clang --target=aarch64-linux-musl -fuse-ld=lld" \
    ./configure --target=aarch64-linux-musl --prefix=/ --syslibdir=/lib LIBCC="$CRT" >/dev/null && make -j"$(nproc)" lib/libc.so >/dev/null)
fi
cp "$MUSL_SO" "$JNI/libldmusl.so"

# --- shim and node-pty -------------------------------------------------------------------------
CCX=(--target=aarch64-alpine-linux-musl --sysroot="$SR" -fuse-ld=lld)
say "ycshim"
clang "${CCX[@]}" -O2 -fPIC -shared -nostdlib "$HERE/ycshim.c" -o "$JNI/libycshim.so" -L"$SR/usr/lib" -lc

say "node-pty"
NODE_PTY="$HERE/../../desktop/node_modules/node-pty"
CXXINC="$(ls -d "$SR"/usr/include/c++/* | head -1)"
mkdir -p "$CACHE/stub"; [ -f "$CACHE/stub/libgcc.a" ] || ar rc "$CACHE/stub/libgcc.a"
clang++ "${CCX[@]}" -nostdinc++ -isystem "$CXXINC" -isystem "$CXXINC/aarch64-alpine-linux-musl" \
  -I"$SR/usr/include/node" -I"$NODE_PTY/node_modules/node-addon-api" -DNAPI_CPP_EXCEPTIONS -fexceptions \
  -O2 -fPIC -shared -std=c++20 -nostartfiles -nodefaultlibs "$NODE_PTY/src/unix/pty.cc" -o "$JNI/libptynode.so" \
  -L"$CACHE/stub" -L"$SR/usr/lib" -lstdc++ -lgcc_s -lc
"$PATCHELF" --set-rpath "$RPATH" "$JNI/libptynode.so"

# --- executables and libraries -------------------------------------------------------------------
# name:path-in-root. The name is what PATH sees; git's helpers keep their libexec layout (binmap).
: > "$ASSETS/binmap.txt"
for pair in $RUNTIME_EXECUTABLES; do
  name="${pair%%:*}"; rel="${pair#*:}"
  src="$R/$rel"; [ -e "$src" ] || { echo "missing executable $rel" >&2; exit 1; }
  so="lib$(echo "$name" | tr -c 'a-zA-Z0-9\n' '_').so"
  cp -L "$src" "$JNI/$so"
  "$PATCHELF" --set-interpreter "$INTERP" --set-rpath "$RPATH" "$JNI/$so"
  "$PATCHELF" --add-needed libycshim.so "$JNI/$so"
  echo "$so $rel" >> "$ASSETS/binmap.txt"
done

: > "$ASSETS/libmap.txt"
while IFS= read -r f; do
  base="$(basename "$f")"
  soname="$("$PATCHELF" --print-soname "$f" 2>/dev/null || true)"; soname="${soname:-$base}"
  [ "$soname" = "libc.musl-aarch64.so.1" ] && continue
  grep -q " $soname\$" "$ASSETS/libmap.txt" && continue
  so="lib_$(echo "$soname" | tr -c 'a-zA-Z0-9\n' '_').so"
  cp -L "$f" "$JNI/$so"
  "$PATCHELF" --set-rpath "$RPATH" "$JNI/$so" 2>/dev/null || true
  echo "$so $soname" >> "$ASSETS/libmap.txt"
done < <(find "$R/lib" "$R/usr/lib" -maxdepth 1 -name '*.so*' \( -type f -o -type l \) | sort)
echo "libldmusl.so libc.musl-aarch64.so.1" >> "$ASSETS/libmap.txt"
echo "libldmusl.so ld-musl-aarch64.so.1" >> "$ASSETS/libmap.txt"
echo "libycshim.so libycshim.so" >> "$ASSETS/libmap.txt"

# --- Claude Code ---------------------------------------------------------------------------------
CC_TGZ="$CACHE/claude-code-$CLAUDE_CODE_VERSION.tgz"
if [ ! -s "$CC_TGZ" ]; then
  say "Claude Code $CLAUDE_CODE_VERSION"
  curl -fsSL -o "$CC_TGZ" "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-arm64-musl/-/claude-code-linux-arm64-musl-$CLAUDE_CODE_VERSION.tgz"
fi
tar xzf "$CC_TGZ" -O package/claude > "$JNI/libclaude.so"
echo "$CLAUDE_CODE_VERSION" > "$ASSETS/claude-code-version.txt"

# --- data files ----------------------------------------------------------------------------------
cp "$R/etc/ssl/certs/ca-certificates.crt" "$ASSETS/ca-certificates.crt"
# terminfo for bash/readline, git's templates: small trees the app unpacks into files/usr/share.
(cd "$R/usr/share" && tar czf "$ASSETS/share.tgz" $(for d in terminfo git-core; do [ -d "$d" ] && echo "$d"; done))
[ -d "$R/etc/terminfo" ] && (cd "$R/etc" && tar czf "$ASSETS/etc-terminfo.tgz" terminfo) || true
echo "$APP_ID" > "$ASSETS/app-id.txt"
say "done: $(du -sh "$JNI" | cut -f1) of programs for $APP_ID"
