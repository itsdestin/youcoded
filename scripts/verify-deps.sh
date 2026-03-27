#!/system/bin/sh
# verify-deps.sh — Verify all ELF binaries can link their shared libraries
#
# Uses /system/bin/linker64 --list to check real dynamic linking, not
# string matching. This catches genuinely missing .so files without
# false positives from format strings or optional plugins.
#
# Run on device:  adb shell "run-as com.destin.code sh /path/to/verify-deps.sh"
# Exit code 0 = all deps satisfied, 1 = missing deps found.

PREFIX="${PREFIX:-/data/data/com.destin.code/files/usr}"
export LD_LIBRARY_PATH="$PREFIX/lib"

PASS=0
FAIL=0
SKIP=0
FAILED_BINS=""

check_bin() {
    local bin="$1"
    local name="${bin##*/}"

    # Check ELF magic
    local magic
    magic=$(od -A n -t x1 -N 4 "$bin" 2>/dev/null | tr -d ' ')
    if [ "$magic" != "7f454c46" ]; then
        return 0  # Not ELF, skip
    fi

    # Try to link — linker64 --list exits non-zero if any lib is missing
    local result
    result=$(/system/bin/linker64 --list "$bin" 2>&1)
    local rc=$?

    if echo "$result" | grep -q "not found"; then
        FAIL=$((FAIL + 1))
        local missing
        missing=$(echo "$result" | grep "not found" | sed 's/.*library "\([^"]*\)".*/\1/')
        echo "  FAIL: $name — missing: $missing"
        FAILED_BINS="$FAILED_BINS $name"
    else
        PASS=$((PASS + 1))
    fi
}

echo "============================================"
echo " Shared Library Dependency Verification"
echo "============================================"
echo "PREFIX: $PREFIX"
echo ""

echo "── Binaries ($PREFIX/bin/) ──"
for bin in "$PREFIX/bin/"*; do
    [ -f "$bin" ] || continue
    check_bin "$bin"
done

echo ""
echo "── Key shared libraries ──"
# Only check top-level .so files, not versioned duplicates
for lib in "$PREFIX/lib/"*.so; do
    [ -f "$lib" ] || continue
    check_bin "$lib"
done

echo ""
echo "============================================"
echo " $PASS linked OK, $FAIL failed"
echo "============================================"

if [ $FAIL -gt 0 ]; then
    echo ""
    echo "Failed binaries:$FAILED_BINS"
    exit 1
fi
exit 0
