"""alpine-musl-patches.py contracts: APKBUILD parsing, checksum refusal, patch application. No network."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('alpine-musl-patches.py')

APKBUILD = '''pkgname=musl
pkgver=1.2.6
pkgrel=3
source="https://musl.libc.org/releases/musl-$pkgver.tar.gz
\thandle-aux-at_base.patch
\tCVE-2026-107891.patch
\tldconfig
\t"
sha512sums="
aaaa  musl-1.2.6.tar.gz
bbbb  handle-aux-at_base.patch
cccc  CVE-2026-107891.patch
dddd  ldconfig
"
'''


class AlpineMuslPatchesTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('alpine_musl_patches', SCRIPT)
        self.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.mod)
        self.temp = tempfile.TemporaryDirectory(prefix='alpine-musl-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_branch_mapping(self):
        self.assertEqual(self.mod.aports_branch('v3.24'), '3.24-stable')
        self.assertEqual(self.mod.aports_branch('edge'), 'master')
        with self.assertRaises(ValueError):
            self.mod.aports_branch('3.24')

    def test_parse_keeps_only_patches_in_alpine_order(self):
        pkgver, pkgrel, patches, sums = self.mod.parse_apkbuild(APKBUILD)
        self.assertEqual((pkgver, pkgrel), ('1.2.6', '3'))
        self.assertEqual(patches, ['handle-aux-at_base.patch', 'CVE-2026-107891.patch'])
        self.assertEqual(sums['CVE-2026-107891.patch'], 'cccc')

    def test_parse_refuses_patch_without_checksum(self):
        broken = APKBUILD.replace('cccc  CVE-2026-107891.patch\n', '')
        with self.assertRaises(ValueError):
            self.mod.parse_apkbuild(broken)

    def test_cached_patch_refuses_wrong_hash_and_keeps_good_one(self):
        good = b'--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n'
        sha = hashlib.sha512(good).hexdigest()
        self.mod.fetch = lambda url: good
        p = self.mod.cached_patch(self.root, 'fix.patch', sha, 'http://unused/fix.patch')
        self.assertEqual(p.read_bytes(), good)
        # A second call with the cache populated never downloads.
        self.mod.fetch = lambda url: (_ for _ in ()).throw(AssertionError('downloaded again'))
        self.assertEqual(self.mod.cached_patch(self.root, 'fix.patch', sha, 'http://unused/fix.patch'), p)
        self.mod.fetch = lambda url: b'tampered'
        with self.assertRaises(ValueError):
            self.mod.cached_patch(self.root, 'other.patch', sha, 'http://unused/other.patch')

    def test_apply_is_strict(self):
        src = self.root / 'musl'
        src.mkdir()
        (src / 'x').write_text('old\n')
        patch = self.root / 'fix.patch'
        patch.write_bytes(b'--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n')
        self.mod.apply(src, patch)
        self.assertEqual((src / 'x').read_text(), 'new\n')
        with self.assertRaises(RuntimeError):  # applying twice is an error, never a silent reversal
            self.mod.apply(src, patch)

    def test_version_mismatch_stops_the_build(self):
        self.mod.fetch = lambda url: APKBUILD.encode()
        with self.assertRaises(SystemExit) as cm:
            self.mod.main(['x', str(self.root), str(self.root), 'v3.24', '1.2.5'])
        self.assertIn('MUSL_VERSION', str(cm.exception))


if __name__ == '__main__':
    unittest.main()
