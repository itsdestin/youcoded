"""Run-local native compilation cache contracts; no compiler/network required."""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('native-cache.py')


class NativeCacheTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), 'native cache helper is not implemented')
        spec = importlib.util.spec_from_file_location('native_cache', SCRIPT)
        self.cache = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.cache)
        self.temp = tempfile.TemporaryDirectory(prefix='native-cache-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.tar.gz'
        self.source.write_bytes(b'fixed source')
        self.patch = self.root / 'patch.py'
        self.patch.write_bytes(b'fixed patch')
        self.inputs = {'source': self.source, 'patch': self.patch}
        self.values = {'clang': 'clang fixed version', 'flags': '-O2'}
        self.key = self.cache.fingerprint(self.inputs, self.values)
        self.artifact = self.root / 'libc.so'
        self.artifact.write_bytes(b'fixed compiled ELF')
        self.artifact.chmod(0o755)
        self.folder = self.root / 'cache'
        self.destination = self.root / 'restored/libc.so'

    def test_key_is_stable_across_input_order_and_directory_location(self):
        other = self.root / 'other-source.tar.gz'
        other.write_bytes(self.source.read_bytes())
        self.assertEqual(self.key, self.cache.fingerprint({'patch': self.patch, 'source': other}, {'flags': '-O2', 'clang': 'clang fixed version'}))

    def test_every_source_and_toolchain_flag_invalidates_the_key(self):
        for label, path in self.inputs.items():
            original = path.read_bytes()
            path.write_bytes(original + b' changed')
            self.assertNotEqual(self.key, self.cache.fingerprint(self.inputs, self.values), label)
            path.write_bytes(original)
        self.assertNotEqual(self.key, self.cache.fingerprint(self.inputs, {**self.values, 'clang': 'new compiler'}))
        self.assertNotEqual(self.key, self.cache.fingerprint(self.inputs, {**self.values, 'flags': '-O0'}))

    def test_missing_input_cannot_yield_a_reusable_key(self):
        self.patch.unlink()
        with self.assertRaises((ValueError, OSError)):
            self.cache.fingerprint(self.inputs, self.values)

    def test_miss_does_not_overwrite_destination(self):
        self.destination.parent.mkdir()
        self.destination.write_bytes(b'untouched')
        self.assertFalse(self.cache.restore(self.folder, self.key, self.destination))
        self.assertEqual(self.destination.read_bytes(), b'untouched')

    def test_store_restore_preserves_exact_bytes_and_mode(self):
        self.cache.store(self.folder, self.key, self.artifact)
        self.assertTrue(self.cache.restore(self.folder, self.key, self.destination))
        self.assertEqual(self.destination.read_bytes(), self.artifact.read_bytes())
        self.assertEqual(self.destination.stat().st_mode & 0o777, 0o755)

    def test_tampered_binary_is_a_miss_not_a_restored_output(self):
        self.cache.store(self.folder, self.key, self.artifact)
        (self.folder / self.key / 'artifact').write_bytes(b'tampered')
        self.assertFalse(self.cache.restore(self.folder, self.key, self.destination))
        self.assertFalse(self.destination.exists())

    def test_tampered_manifest_or_changed_mode_is_a_miss(self):
        self.cache.store(self.folder, self.key, self.artifact)
        manifest = self.folder / self.key / 'manifest.json'
        original = manifest.read_text()
        for text in ['{bad', '{}', json.dumps({'schema': 1, 'key': 'wrong'})]:
            manifest.write_text(text)
            self.assertFalse(self.cache.restore(self.folder, self.key, self.destination))
        manifest.write_text(original)
        (self.folder / self.key / 'artifact').chmod(0o644)
        self.assertFalse(self.cache.restore(self.folder, self.key, self.destination))

    def test_changed_key_does_not_reuse_old_directory(self):
        self.cache.store(self.folder, self.key, self.artifact)
        other = self.cache.fingerprint(self.inputs, {**self.values, 'flags': '-O3'})
        self.assertFalse(self.cache.restore(self.folder, other, self.destination))

    def test_replacing_bad_entry_is_atomic_and_does_not_modify_source(self):
        self.cache.store(self.folder, self.key, self.artifact)
        (self.folder / self.key / 'artifact').write_bytes(b'broken')
        self.cache.store(self.folder, self.key, self.artifact)
        self.assertTrue(self.cache.restore(self.folder, self.key, self.destination))
        self.assertEqual(self.artifact.read_bytes(), b'fixed compiled ELF')
        self.assertEqual(sorted(p.name for p in (self.folder / self.key).iterdir()), ['artifact', 'manifest.json'])

    def test_cache_entry_symlink_cannot_redirect_store_or_restore(self):
        self.folder.mkdir()
        outside = self.root / 'outside'
        outside.mkdir()
        (self.folder / self.key).symlink_to(outside, target_is_directory=True)
        self.assertFalse(self.cache.restore(self.folder, self.key, self.destination))
        with self.assertRaises(ValueError):
            self.cache.store(self.folder, self.key, self.artifact)
        self.assertEqual(list(outside.iterdir()), [])

    def test_key_cannot_escape_cache_root(self):
        for key in ['../escape', '', 'x' * 64, 'a' * 63]:
            with self.assertRaises(ValueError):
                self.cache.store(self.folder, key, self.artifact)
            with self.assertRaises(ValueError):
                self.cache.restore(self.folder, key, self.destination)


@unittest.skipUnless(sys.platform.startswith('linux'), 'Android native build host is Linux')
class MuslSectionTests(unittest.TestCase):
    """Execute the actual build script section with fixture compiler tools."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='musl-build-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.here = self.root / 'runtime'
        self.here.mkdir()
        for name in ('native-cache.py', 'patch-musl.py', 'build-runtime.sh'):
            shutil.copyfile(SCRIPT.with_name(name), self.here / name)
        (self.here / 'pins.env').write_text('fixture input pins\n')
        (self.here / 'runtime-redistribution.py').write_text('# fixture record command\n')
        self.cache = self.root / 'downloads'
        self.cache.mkdir()
        self.sysroot = self.cache / 'sysroot'
        self.sysroot.mkdir()
        (self.sysroot / 'libclang_rt.builtins-aarch64.a').write_bytes(b'fixed compiler runtime')
        source = self.root / 'musl-fixture'
        source.mkdir()
        (source / 'COPYRIGHT').write_text('preserve original copyright\n')
        (source / 'configure').write_text('#!/bin/sh\nexit 0\n')
        (source / 'configure').chmod(0o755)
        for name, files in {
            'resolvconf.c': ['resolv.conf'], 'lookup_serv.c': ['services'],
            'lookup_name.c': ['hosts'], 'getnameinfo.c': ['hosts', 'services'],
        }.items():
            file = source / 'src/network' / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('#include <stdio.h>\n' + '\n'.join(f'__fopen_rb_ca("/etc/{n}", x);' for n in files))
        with tarfile.open(self.cache / 'musl-fixture.tar.gz', 'w:gz') as archive:
            archive.add(source, arcname='musl-fixture')
        tools = self.root / 'tools'
        tools.mkdir()
        self.count = self.root / 'compiles'
        for name in ('clang', 'ld.lld'):
            file = tools / name
            file.write_text(f'#!/bin/sh\necho "{name} fixture version"\n')
            file.chmod(0o755)
        make = tools / 'make'
        make.write_text('#!/bin/sh\necho compiled >> "$BUILD_COUNT"\nmkdir -p lib\nprintf ELF-fixture > lib/libc.so\nchmod 755 lib/libc.so\n')
        make.chmod(0o755)
        self.env = {**os.environ, 'PATH': str(tools) + os.pathsep + os.environ['PATH'], 'BUILD_COUNT': str(self.count)}
        self.section = (self.here / 'build-runtime.sh').read_text().split('# --- musl, patched')[1].split('# --- shim and node-pty')[0]
        # Strip only the remainder of the section heading, not executable code.
        self.section = self.section.split('\n', 1)[1]

    def build(self, variant, enabled=True, collect=False):
        out = self.root / variant
        jni = out / 'jni'
        jni.mkdir(parents=True)
        evidence = out / 'evidence/sysroot'
        evidence.mkdir(parents=True)
        (evidence / 'inputs.json').write_text('{"fixed": "exact sysroot input lock"}\n')
        values = {'HERE': self.here, 'CACHE': self.cache, 'SR': self.sysroot, 'OUT': out, 'JNI': jni, 'MUSL_VERSION': 'fixture'}
        prefix = 'set -euo pipefail\n' + '\n'.join(f'{key}={shlex.quote(str(value))}' for key, value in values.items()) + '\nsay() { :; }\n'
        env = {**self.env, 'YOUCODED_COMMON_NATIVE_CACHE': str(self.root / 'run-local-native') if enabled else '', 'YOUCODED_COLLECT_SOURCES': '1' if collect else '0'}
        subprocess.run(['bash', '-c', prefix + self.section], env=env, check=True, capture_output=True, text=True)
        self.assertEqual((jni / 'libldmusl.so').read_bytes(), b'ELF-fixture')
        self.assertTrue((self.cache / 'musl-fixture/COPYRIGHT').is_file())
        return jni / 'libldmusl.so'

    def test_opt_in_reuses_compile_but_keeps_sources_for_every_variant(self):
        for variant in ('debug', 'releaseTest', 'release'):
            self.build(variant)
        self.assertEqual(self.count.read_text().splitlines(), ['compiled'])

    def test_default_and_source_collection_keep_fresh_compilation(self):
        self.build('default-a', enabled=False)
        self.build('default-b', enabled=False)
        self.build('source-a', collect=True)
        self.build('source-b', collect=True)
        self.assertEqual(len(self.count.read_text().splitlines()), 4)

    def test_changed_sysroot_invalidates_run_local_native_reuse(self):
        self.build('first')
        (self.sysroot / 'libclang_rt.builtins-aarch64.a').write_bytes(b'updated compiler runtime')
        self.build('second')
        self.assertEqual(len(self.count.read_text().splitlines()), 2)


if __name__ == '__main__':
    unittest.main()
