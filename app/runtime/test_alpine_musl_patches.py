"""alpine-musl-patches.py contracts: APKBUILD parsing, manifest verification, strict apply. No network."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('alpine-musl-patches.py')
VENDORED = Path(__file__).with_name('alpine-musl-patches')

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
PATCH = b'--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n'


class AlpineMuslPatchesTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('alpine_musl_patches', SCRIPT)
        self.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.mod)
        self.temp = tempfile.TemporaryDirectory(prefix='alpine-musl-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def vendored(self, sha=None, sub='one'):
        """A fake vendored set: one patch and a manifest naming it, plus a fresh musl tree."""
        base = self.root / sub
        d = base / 'vendored'
        d.mkdir(parents=True)
        (d / 'fix.patch').write_bytes(PATCH)
        manifest = d / 'manifest.json'
        manifest.write_text(json.dumps({'alpine': '1.2.6-r3', 'musl': '1.2.6', 'branch': 'v3.24',
                                        'patches': [{'name': 'fix.patch', 'sha512': sha or hashlib.sha512(PATCH).hexdigest()}]}))
        src = base / 'musl'
        src.mkdir()
        (src / 'x').write_text('old\n')
        return d, manifest, src

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
        with self.assertRaises(ValueError):
            self.mod.parse_apkbuild(APKBUILD.replace('cccc  CVE-2026-107891.patch\n', ''))

    def test_apply_verifies_then_patches_and_records(self):
        d, manifest, src = self.vendored()
        self.assertEqual(self.mod.apply_all(src, '1.2.6', vendored=d, manifest_path=manifest), '1.2.6-r3')
        self.assertEqual((src / 'x').read_text(), 'new\n')
        self.assertEqual(json.loads((src / '.alpine-patches.json').read_text())['alpine'], '1.2.6-r3')
        with self.assertRaises(RuntimeError):  # applying twice is an error, never a silent reversal
            self.mod.apply_all(src, '1.2.6', vendored=d, manifest_path=manifest)

    def test_apply_refuses_tampered_patch_and_wrong_musl_version(self):
        d, manifest, src = self.vendored(sha='0' * 128)
        with self.assertRaises(SystemExit) as cm:
            self.mod.apply_all(src, '1.2.6', vendored=d, manifest_path=manifest)
        self.assertIn('sha512', str(cm.exception))
        d2, manifest2, src2 = self.vendored(sub='two')
        with self.assertRaises(SystemExit) as cm:
            self.mod.apply_all(src2, '1.2.5', vendored=d2, manifest_path=manifest2)
        self.assertIn('MUSL_VERSION', str(cm.exception))

    def test_committed_vendored_set_matches_its_manifest_and_pins(self):
        """The real vendored patches must verify, and must be for the musl version pins.env builds."""
        m = json.loads((VENDORED / 'manifest.json').read_text())
        pins = (SCRIPT.with_name('pins.env')).read_text()
        self.assertIn(f'MUSL_VERSION={m["musl"]}\n', pins)
        self.assertTrue(m['patches'], 'the vendored set is empty')
        for e in m['patches']:
            self.assertEqual(self.mod.sha512(VENDORED / e['name']), e['sha512'], e['name'])


if __name__ == '__main__':
    unittest.main()
