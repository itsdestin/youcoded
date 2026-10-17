"""Offline synthetic fixtures; these tests are NOT release legal clearance."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load('runtime-redistribution')
npm = load('preserve-npm-legal')
COMMIT = 'a' * 40


def entry(root, relative, text):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return {'path': relative, 'sha256': r.digest(path)}


class Fixtures(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def indexes(self, text):
        (self.root / 'main.idx').write_text(text)
        (self.root / 'community.idx').write_text('')

    def package_index(self):
        return {'P': 'bash', 'V': '5.3-r1', 'A': 'aarch64', 'o': 'bash', 'L': 'GPL-3.0-or-later', 'c': COMMIT}

    def pkginfo(self):
        return '\n'.join(f'{field} = {self.package_index()[key]}' for field, key in
                         {'pkgname': 'P', 'pkgver': 'V', 'arch': 'A', 'origin': 'o', 'license': 'L', 'commit': 'c'}.items()) + '\n'

    def apk(self, files):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as tree:
            for name, value in files.items():
                data = value.encode()
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tree.addfile(info, io.BytesIO(data))
        return output.getvalue()

    def dossier(self):
        evidence, sources = self.root / 'evidence', self.root / 'sources'
        evidence.mkdir()
        sources.mkdir()
        r.dump(evidence / 'inputs.json', {'packages': [{'origin': 'bash', 'aports_commit': COMMIT, 'extracted': True}]})
        r.dump(evidence / 'non-apk-inputs.json', {'fixture': 'synthetic local build inputs'})
        archive = entry(sources, 'distfiles/bash.tar.gz', 'synthetic source archive')
        fix = entry(sources, 'recipes/bash/fix.patch', 'synthetic Alpine patch')
        sums = '\n'.join(f'{r.digest(sources / e["path"], "sha512")}  {Path(e["path"]).name}' for e in (archive, fix))
        recipe = entry(sources, 'recipes/bash/APKBUILD', f'pkgname=bash\nsha512sums="\n{sums}\n"\n')
        notice = entry(sources, 'licenses/bash/COPYING', 'synthetic GPL notice fixture')
        aports = sources / 'aports.tar.gz'
        aports.write_bytes(self.apk({f'aports-{COMMIT}/main/bash/APKBUILD': (sources / recipe['path']).read_text(),
                                    f'aports-{COMMIT}/main/bash/fix.patch': 'synthetic Alpine patch'}))
        checksums = entry(sources, 'recipes/bash/sha512sums.txt', sums)
        manifest = {'schema': 2, 'residual': [], 'evidence_sha256': r.digest(evidence / 'inputs.json'),
                    'build_inputs_sha256': r.digest(evidence / 'non-apk-inputs.json'),
                    'origins': [{'origin': 'bash', 'commit': COMMIT, 'inputs': [archive, fix],
                                 'recipe': recipe, 'notices': [notice], 'checksums': checksums,
                                 'recipe_files': [recipe, fix],
                                 'aports_archive': {'path': 'aports.tar.gz', 'sha256': r.digest(aports)},
                                 'aports_url': f'https://github.com/alpinelinux/aports/archive/{COMMIT}.tar.gz'}],
                    'additional_notices': [notice]}
        r.dump(sources / 'coverage.json', manifest)
        return evidence, sources, manifest

    def test_unresolved_requirement_fails(self):
        self.indexes('P:bash\nV:1\nD:missing\n\n')
        with self.assertRaisesRegex(ValueError, 'Unresolved'):
            r.resolver.resolve(self.root, ['bash'])

    def test_exact_constraints_are_not_discarded(self):
        self.indexes('P:bash\nV:1\n\n')
        with patch.object(r.resolver, 'compare', return_value='<'):
            with self.assertRaisesRegex(ValueError, 'Unresolved'):
                r.resolver.resolve(self.root, ['bash>=2'])
        self.assertEqual(r.resolver.resolve(self.root, ['bash=1'])['resolution'][0]['requirement'], 'bash=1')

    def test_versioned_provider(self):
        self.indexes('P:libx\nV:2-r0\np:so:libx.so.1=1\n\nP:app\nV:1\nD:so:libx.so.1=1\n\n')
        result = r.resolver.resolve(self.root, ['app'])
        self.assertEqual([p['P'] for p in result['packages']], ['app', 'libx'])

    def test_ambiguous_provider_and_conflict_fail(self):
        self.indexes('P:a\nV:1\np:cmd:x\n\nP:b\nV:1\np:cmd:x\n\n')
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            r.resolver.resolve(self.root, ['cmd:x'])
        self.indexes('P:a\nV:1\nD:!b\n\nP:b\nV:1\n\n')
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            r.resolver.resolve(self.root, ['a', 'b'])

    def test_bad_comparator_fails_closed(self):
        with patch.dict('os.environ', {'YOUCODED_APK_VERSION': '/not-a-command'}):
            with self.assertRaisesRegex(ValueError, 'apk version'):
                r.resolver.compare('9-unique', '10-unique')

    def test_missing_or_mismatched_metadata(self):
        index = self.package_index()
        metadata = r.metadata(self.pkginfo())
        r.validate_metadata(metadata, index)
        for field in ('commit', 'license', 'origin', 'pkgver', 'arch'):
            with self.subTest(field=field):
                changed = dict(metadata)
                changed[field] = ['wrong']
                with self.assertRaises(ValueError):
                    r.validate_metadata(changed, index)

    def test_install_preserves_control_stream_and_locks_hash(self):
        index = self.package_index()
        self.indexes('\n'.join(f'{k}:{v}' for k, v in index.items()) + '\n\n')
        apk = self.root / 'apk/bash-5.3-r1.apk'
        apk.parent.mkdir()
        # Model APK's signature/control/data concatenated gzip/tar streams.
        apk.write_bytes(self.apk({'.SIGN.fixture': 'signature fixture'}) +
                        self.apk({'.PKGINFO': self.pkginfo()}) + self.apk({'usr/bin/bash': 'binary fixture'}))
        destination, evidence = self.root / 'root', self.root / 'evidence'
        r.install(self.root, destination, evidence, 'v3.24', ['bash'])
        lock = json.loads((evidence / 'inputs.json').read_text())
        self.assertEqual(lock['packages'][0]['version'], '5.3-r1')
        self.assertEqual((evidence / lock['packages'][0]['pkginfo']).read_text(), self.pkginfo())
        self.assertEqual(json.loads((evidence / 'owners.json').read_text())['usr/bin/bash']['package'], 'bash')
        apk.write_bytes(apk.read_bytes() + b'changed')
        with self.assertRaisesRegex(ValueError, 'APK changed'):
            r.install(self.root, destination, evidence, 'v3.24', ['bash'])

    def test_finalize_keeps_local_sources_musl_and_explicit_incomplete_notices(self):
        project = self.root / 'project'
        here = project / 'app/runtime'
        entry(project, 'app/runtime/pins.env', 'fixture pins')
        for relative in ('app/build.gradle.kts', 'app/src/main/kotlin/com/youcoded/app/runtime/RuntimeInstaller.kt',
                         'app/src/main/kotlin/com/youcoded/app/runtime/BackendService.kt',
                         'LICENSE', 'TERMS.md', 'gradle.properties', 'build.gradle.kts', 'settings.gradle.kts',
                         'desktop/package-lock.json', 'desktop/package.json',
                         'desktop/node_modules/node-pty/src/pty.cc',
                         'desktop/node_modules/node-pty/third_party/NOTICE',
                         'desktop/node_modules/node-pty/node_modules/node-addon-api/napi.h'):
            entry(project, relative, 'synthetic local build input')
        entry(project, 'app/build.gradle.kts', 'versionName = "1.2.3-fixture"')
        cache = self.root / 'cache'
        entry(cache, 'musl-1/COPYRIGHT', 'complete synthetic musl notice')
        entry(cache, 'musl-1.tar.gz', 'original synthetic tarball')
        entry(cache, 'claude-code-1.tgz', 'synthetic proprietary input; NOT permission')
        output = self.root / 'out'
        for scope in ('root', 'sysroot'):
            r.dump(output / f'evidence/{scope}/inputs.json', {'packages': [dict(self.package_index(), scope=scope)]})
        entry(output, 'jniLibs/arm64-v8a/libldmusl.so', 'synthetic built musl')
        entry(output, 'assets/runtime/app-id.txt', 'fixture.app')
        with patch.object(r, 'HERE', here), patch.object(r.subprocess, 'run') as run:
            run.return_value.stdout = 'synthetic tool version'
            r.finalize(output, cache, cache / 'musl-1.tar.gz', cache / 'claude-code-1.tgz')
        self.assertIn('DEVELOPMENT BUILD', (output / 'assets/legal/THIRD-PARTY-NOTICES.txt').read_text())
        self.assertIn('YouCoded-1.2.3-fixture-android-corresponding-source.tar.xz', (output / 'assets/legal/SOURCE-CODE.txt').read_text())
        self.assertEqual((output / 'evidence/musl-1.tar.gz').read_text(), 'original synthetic tarball')
        self.assertTrue((output / 'evidence/youcoded-runtime/native-npm/node-pty/src/pty.cc').is_file())
        locks = json.loads((output / 'evidence/inputs.json').read_text())
        self.assertEqual(set(locks['scopes']), {'root', 'sysroot'})
        self.assertIn('jniLibs/arm64-v8a/libldmusl.so', json.loads((output / 'evidence/outputs.json').read_text()))

    def test_original_packaged_file_mapping(self):
        evidence, root = self.root / 'evidence', self.root / 'root'
        evidence.mkdir()
        (root / 'usr/bin').mkdir(parents=True)
        (root / 'usr/bin/bash').write_text('original')
        r.dump(evidence / 'owners.json', {'usr/bin/bash': {'package': 'bash', 'version': '1'}})
        packaged = self.root / 'libbash.so'
        packaged.write_text('adjusted')
        r.record(evidence, root, root / 'usr/bin/bash', packaged)
        result = json.loads((evidence / 'packaged-files.jsonl').read_text())
        self.assertNotEqual(result['input_sha256'], result['output_sha256'])

    def test_source_archive_contains_actual_inputs_and_recipes(self):
        evidence, sources, _ = self.dossier()
        output = self.root / 'source.tar.xz'
        r.archive(evidence, sources, output)
        with tarfile.open(output) as tree:
            self.assertIn('sources/recipes/bash/fix.patch', tree.getnames())
            self.assertIn('sources/distfiles/bash.tar.gz', tree.getnames())
            self.assertIn('build-evidence/inputs.json', tree.getnames())
            self.assertEqual(tree.extractfile('sources/recipes/bash/fix.patch').read(), b'synthetic Alpine patch')

    def test_missing_patch_rejected_even_if_manifest_omits_it(self):
        evidence, sources, manifest = self.dossier()
        manifest['origins'][0]['inputs'].pop()
        r.dump(sources / 'coverage.json', manifest)
        with self.assertRaisesRegex(ValueError, 'Recipe source inputs differ'):
            r.validate_sources(evidence, sources)

    def test_wrong_recipe_checksum_rejected(self):
        evidence, sources, manifest = self.dossier()
        archive = manifest['origins'][0]['inputs'][0]
        archive.update(entry(sources, archive['path'], 'substituted source'))
        r.dump(sources / 'coverage.json', manifest)
        with self.assertRaisesRegex(ValueError, 'SHA512 mismatch'):
            r.validate_sources(evidence, sources)

    def test_missing_origin_notice_and_archive_binding_rejected(self):
        for kind in ('origin', 'notice', 'archive-binding', 'input-binding'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                old = self.root
                self.root = Path(temporary)
                evidence, sources, manifest = self.dossier()
                self.root = old
                if kind == 'origin':
                    manifest['origins'] = []
                elif kind == 'notice':
                    manifest['origins'][0]['notices'] = []
                elif kind == 'archive-binding':
                    manifest['origins'][0]['aports_url'] = 'https://example.invalid/other.tar.gz'
                else:
                    manifest['evidence_sha256'] = '0' * 64
                r.dump(sources / 'coverage.json', manifest)
                with self.assertRaises(ValueError):
                    r.validate_sources(evidence, sources)

    def test_container_output_symlinks_are_rejected_before_host_reads_or_writes(self):
        work = self.root / 'work'
        outside = self.root / 'outside'
        work.mkdir()
        outside.mkdir()
        (work / 'distfiles').symlink_to(outside, target_is_directory=True)
        self.assertTrue(hasattr(r.collector, 'verify_tree'), 'collector needs a post-container ancestry check')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            r.collector.verify_tree(work)

    def test_source_urls_traversal_and_symlinks_are_not_retained_files(self):
        for path in ('https://example.invalid/source.tar.gz', '../outside'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                r.checked_file(self.root, {'path': path, 'sha256': '0' * 64})
        (self.root / 'link').symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):
            r.checked_file(self.root, {'path': 'link', 'sha256': '0' * 64})

    def release_fixtures(self, tamper=None):
        evidence, sources, manifest = self.dossier()
        components = {'components': [{'name': 'a', 'version': '1', 'path': 'a', 'retained_after_platform_trim': True}],
                      'preserved_files': [{'path': 'a/LICENSE.md', 'sha256': hashlib.sha256(b'npm notice').hexdigest()}]}
        inventory = json.dumps(components)
        manifest['backend_inventory_sha256'] = hashlib.sha256(inventory.encode()).hexdigest()
        r.dump(sources / 'coverage.json', manifest)
        backend = self.apk({'./legal/npm-components.json': inventory,
                            './node_modules/a/package.json': '{"name":"a","version":"1"}',
                            './legal/npm-notices/a/LICENSE.md': 'tampered' if tamper == 'backend-notice' else 'npm notice'})
        r.dump(evidence / 'outputs.json', {'jniLibs/arm64-v8a/libbash.so': hashlib.sha256(b'binary fixture').hexdigest()})
        (self.root / 'assets/legal').mkdir(parents=True)
        binaries = []
        for extension, prefix in (('apk', ''), ('aab', 'base/')):
            binary = self.root / f'fixture.{extension}'
            binaries.append(str(binary))
            with zipfile.ZipFile(binary, 'w') as package:
                package.writestr(prefix + 'lib/arm64-v8a/libbash.so', b'wrong binary' if tamper == 'binary' else b'binary fixture')
                if tamper != 'missing-notice':
                    package.writestr(prefix + 'assets/legal/licenses/licenses/bash/COPYING', b'synthetic GPL notice fixture')
                package.writestr(prefix + 'assets/backend.tgz', backend)
        return sources, binaries

    def test_release_gate_inspects_both_final_packages_and_nested_notices(self):
        sources, binaries = self.release_fixtures()
        output = self.root / 'corresponding-source.tar.xz'
        r.release(self.root, sources, output, binaries)
        with tarfile.open(output) as tree:
            self.assertEqual(tree.extractfile('build-evidence/backend-legal/npm-notices/a/LICENSE.md').read(), b'npm notice')
            self.assertIn('build-evidence/release-binaries.json', tree.getnames())
        self.assertEqual(output.with_suffix('.xz.sha256').read_text().split()[0], r.digest(output))

    def test_release_gate_rejects_actual_binary_and_notice_mismatches(self):
        for tamper in ('binary', 'backend-notice', 'missing-notice'):
            with self.subTest(tamper=tamper), tempfile.TemporaryDirectory() as temporary:
                old = self.root
                self.root = Path(temporary)
                sources, binaries = self.release_fixtures(tamper)
                with self.assertRaises((ValueError, KeyError)):
                    r.release(self.root, sources, self.root / 'blocked.tar.xz', binaries)
                self.assertFalse((self.root / 'blocked.tar.xz').exists())
                self.root = old

    def test_missing_dossier_blocks_before_binary_processing(self):
        with self.assertRaises(FileNotFoundError):
            r.release(self.root, self.root / 'no-dossier', self.root / 'source.tar.xz', ['nonexistent.apk'])
        self.assertFalse((self.root / 'source.tar.xz').exists())

    def test_automated_collector_keeps_recipe_patches_sources_notices_and_binding(self):
        evidence, sources, _ = self.dossier()
        source = self.apk({'bash-1/COPYING': 'original notice', 'bash-1/main.c': 'source bytes'})
        source_sha = hashlib.sha512(source).hexdigest()
        patch_sha = hashlib.sha512(b'local patch').hexdigest()
        sums = f'{source_sha}  bash.tar.gz\n{patch_sha}  fix.patch'
        aports = self.apk({f'aports-{COMMIT}/main/bash/APKBUILD': f'pkgname=bash\nsha512sums="{sums}"\n',
                           f'aports-{COMMIT}/main/bash/fix.patch': 'local patch',
                           f'aports-{COMMIT}/main/bash/bash.post-install': 'install script'})
        output = self.root / 'automated'
        def download(url, path):
            self.assertIn(COMMIT, url)
            Path(path).write_bytes(aports)
        def docker(command, **kwargs):
            if command[1] == 'run':
                mount = command[command.index('-v') + 1].removesuffix(':/work')
                work = Path(mount)
                (work / 'distfiles/bash.tar.gz').write_bytes(source)
                (work / 'sha512sums.txt').write_text(sums)
                self.assertIn('--cap-drop=ALL', command)
                self.assertIn('youcoded_collect', command[-1])
        with patch.object(r.collector.urllib.request, 'urlretrieve', side_effect=download), \
                patch.object(r.collector.subprocess, 'run', side_effect=docker):
            manifest = r.collector.collect(evidence, output)
        self.assertFalse(manifest['residual'], 'verified source inputs must not be blocked by unrelated blanket obligations')
        self.assertTrue(manifest['review_notes'])
        self.assertEqual((output / manifest['origins'][0]['inputs'][0]['path']).read_bytes(), source)
        self.assertTrue(any(e['path'].endswith('bash.post-install') for e in manifest['origins'][0]['recipe_files']))
        r.validate_sources(evidence, output)
        self.assertEqual((output / manifest['origins'][0]['notices'][0]['path']).read_bytes(), b'original notice')
        manifest['residual'] = ['a required source file is missing']
        r.dump(output / 'coverage.json', manifest)
        with self.assertRaisesRegex(ValueError, 'Redistribution incomplete'):
            # Objective missing-source residuals still block before binary inspection.
            r.release(self.root, output, self.root / 'blocked.tar.xz', ['missing.apk'])
        entry(evidence, 'non-apk-inputs.json', 'version stamp changed')
        with self.assertRaisesRegex(ValueError, 'different binary inputs'):
            r.validate_sources(evidence, output)

    def test_backend_inventory_is_bound_from_the_built_backend_before_release(self):
        sources, binaries = self.release_fixtures()
        coverage = json.loads((sources / 'coverage.json').read_text())
        expected = coverage.pop('backend_inventory_sha256')
        r.dump(sources / 'coverage.json', coverage)
        backend = self.root / 'built-backend.tgz'
        with zipfile.ZipFile(binaries[0]) as package:
            backend.write_bytes(package.read('assets/backend.tgz'))
        self.assertTrue(hasattr(r, 'bind_backend'), 'generated source manifest needs actual backend binding')
        r.bind_backend(sources, backend)
        self.assertEqual(json.loads((sources / 'coverage.json').read_text())['backend_inventory_sha256'], expected)

    def test_locked_crate_archives_and_original_notices_are_retained(self):
        crate = self.apk({'sample-1.2.3/LICENSE-MIT': 'crate copyright and permission'})
        checksum = hashlib.sha256(crate).hexdigest()
        lock = ('version = 3\n[[package]]\nname = "sample"\nversion = "1.2.3"\n'
                'source = "registry+https://github.com/rust-lang/crates.io-index"\n'
                f'checksum = "{checksum}"\n')
        origin = self.root / 'ripgrep'
        origin.mkdir()
        source = origin / 'ripgrep.tar.gz'
        source.write_bytes(self.apk({'ripgrep/Cargo.lock': lock}))
        with patch.object(r.collector.urllib.request, 'urlretrieve', side_effect=lambda url, out: Path(out).write_bytes(crate)):
            archives, notices = r.collector.cargo_notices(self.root, origin, [source])
        self.assertEqual((self.root / archives[0]['path']).read_bytes(), crate)
        self.assertEqual((self.root / notices[0]['path']).read_text(), 'crate copyright and permission')
        self.assertTrue(hasattr(r.collector, 'validate_cargo_archives'), 'release validation must recheck Cargo.lock, not self-reported manifest hashes')
        r.collector.validate_cargo_archives(self.root, [source], archives)
        with self.assertRaisesRegex(ValueError, 'crate set'):
            r.collector.validate_cargo_archives(self.root, [source], [])
        (self.root / archives[0]['path']).write_bytes(b'changed crate')
        archives[0]['sha256'] = r.digest(self.root / archives[0]['path'])
        with self.assertRaisesRegex(ValueError, 'Cargo.lock checksum'):
            r.collector.validate_cargo_archives(self.root, [source], archives)
        with self.assertRaisesRegex(ValueError, 'Locked crate SHA256 mismatch'):
            r.collector.cargo_notices(self.root, origin, [source])

    def test_recipe_substitution_is_rejected_without_review_paperwork(self):
        evidence, sources, manifest = self.dossier()
        manifest['origins'][0]['recipe'] = entry(sources, 'recipes/bash/APKBUILD', 'substituted recipe')
        manifest['origins'][0]['recipe_files'][0] = manifest['origins'][0]['recipe']
        r.dump(sources / 'coverage.json', manifest)
        with self.assertRaisesRegex(ValueError, 'differs from exact aports archive'):
            r.validate_sources(evidence, sources)

    def test_npm_legal_and_nested_inventory_preserved_before_trimming(self):
        modules, out = self.root / 'node_modules', self.root / 'legal'
        fixtures = {'jose/LICENSE.md': 'copyright', 'jszip/LICENSE.markdown': 'license',
                    'native/docs/README.md': 'terms in docs', 'native/third_party/NOTICE': 'vendored',
                    'a/package.json': '{"name":"a","version":"1","license":"MIT"}',
                    'a/node_modules/b/package.json': '{"name":"b","version":"2"}'}
        for path, text in fixtures.items():
            entry(modules, path, text)
        npm.preserve(modules, out)
        for path, text in fixtures.items():
            if not path.endswith('package.json'):
                self.assertEqual((out / 'npm-notices' / path).read_text(), text)
        inventory = json.loads((out / 'npm-components.json').read_text())
        self.assertEqual([(c['name'], c['version']) for c in inventory['components']], [('b', '2'), ('a', '1')])
        (modules / 'a/node_modules/b/package.json').unlink()
        npm.mark_retained(modules, out)
        retained = json.loads((out / 'npm-components.json').read_text())['components']
        self.assertEqual([c['retained_after_platform_trim'] for c in retained], [False, True])


if __name__ == '__main__':
    unittest.main()
