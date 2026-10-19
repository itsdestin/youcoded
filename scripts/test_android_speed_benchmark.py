"""Contracts for Android build experiments; no SDK or real builds required."""
import copy
import subprocess
from unittest.mock import patch
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).with_name('android-speed-benchmark.py')


class AndroidSpeedBenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), 'Android speed benchmark is not implemented')
        spec = importlib.util.spec_from_file_location('android_speed_benchmark', SCRIPT)
        self.bench = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.bench)
        self.temp = tempfile.TemporaryDirectory(prefix='android-benchmark-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_task_profiles_survive_in_the_uploaded_evidence_directory(self):
        self.assertTrue(callable(getattr(self.bench, 'retain_profiles', None)))
        report = self.root / 'build/reports/profile'
        report.mkdir(parents=True)
        (report / 'profile.html').write_text('task duration evidence')
        (report / 'css').mkdir()
        (report / 'css/style.css').write_text('style')
        folder = self.root / 'retained'
        self.bench.retain_profiles(self.root, folder)
        self.assertEqual((folder / 'gradle-profiles/profile.html').read_text(), 'task duration evidence')
        self.assertTrue((folder / 'gradle-profiles/css/style.css').is_file())

    def test_fixed_modes_never_accept_arbitrary_gradle_arguments(self):
        self.assertEqual(self.bench.options('baseline'), {'graph': False, 'native': False, 'heapMb': 2048})
        self.assertEqual(self.bench.options('combined-4g'), {'graph': True, 'native': True, 'heapMb': 4096})
        self.assertTrue(self.bench.options('common-native')['native'])
        self.assertTrue(self.bench.options('packaging-graph')['graph'])
        with self.assertRaises(ValueError):
            self.bench.options('--init-script malicious.gradle')

    def test_optimized_invocations_prove_release_lint_producer_edges(self):
        args = self.bench.gradle_args('combined')
        self.assertIn('--init-script', args)
        script = Path(args[args.index('--init-script') + 1])
        self.assertEqual(script.name, 'android-speed-lint-producers.gradle')
        self.assertTrue(script.is_file())
        self.assertNotIn('--init-script', self.bench.gradle_args('baseline'))

    def unit_graph(self, native):
        names = ['testDebugUnitTest', 'testReleaseUnitTest', 'testReleaseTestUnitTest']
        if native:
            names += ['bundleWebUi', 'buildBackend', 'buildRuntimeDebug', 'buildRuntimeRelease', 'buildRuntimeReleaseTest']
        return '\n'.join(f':app:{name} SKIPPED' for name in names)

    def test_graph_checks_keep_all_jvm_variants_and_reject_unnecessary_payload_work(self):
        self.bench.assert_graph('baseline', self.unit_graph(True), 'unit')
        self.bench.assert_graph('combined', self.unit_graph(False), 'unit')
        with self.assertRaises(ValueError):
            self.bench.assert_graph('combined', self.unit_graph(True), 'unit')
        with self.assertRaises(ValueError):
            self.bench.assert_graph('combined', ':app:testDebugUnitTest SKIPPED', 'unit')

    def test_assembly_graph_never_omits_payloads_or_production_variant_support(self):
        names = ['assembleDebug', 'assembleReleaseTest', 'bundleWebUi', 'buildBackend', 'buildRuntimeDebug', 'buildRuntimeReleaseTest']
        self.bench.assert_graph('combined', '\n'.join(f':app:{x} SKIPPED' for x in names), 'assembly')
        with self.assertRaises(ValueError):
            self.bench.assert_graph('combined', ':app:assembleDebug SKIPPED', 'assembly')
        self.bench.assert_graph('combined', ':app:assembleRelease SKIPPED\n:app:bundleWebUi SKIPPED\n:app:buildBackend SKIPPED\n:app:buildRuntimeRelease SKIPPED', 'release')

    def apk(self, filename, native=b'fixed native ELF', timestamp=1, executable=0o755, signature=b'signature'):
        archive = self.root / filename
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as backend:
            member = tarfile.TarInfo('./dist/main/headless.js')
            member.size = len(b'fixed backend')
            member.mode = executable
            member.mtime = timestamp
            backend.addfile(member, io.BytesIO(b'fixed backend'))
            link = tarfile.TarInfo('./bin/tool')
            link.type = tarfile.SYMTYPE
            link.linkname = '../dist/main/headless.js'
            link.mode = 0o777
            backend.addfile(link)
        with zipfile.ZipFile(archive, 'w') as output:
            output.writestr('lib/arm64-v8a/libldmusl.so', native)
            output.writestr('assets/web/index.html', b'fixed frontend')
            output.writestr('assets/backend.tgz', data.getvalue())
            output.writestr('assets/legal/THIRD-PARTY-NOTICES.txt', b'preserved notices')
            output.writestr('META-INF/CERT.RSA', signature)
        return archive

    def test_payload_comparison_normalizes_only_archive_timestamps_and_signature_receipts(self):
        one = self.bench.apk_manifest(self.apk('one.apk', timestamp=1))
        two = self.bench.apk_manifest(self.apk('two.apk', timestamp=999, signature=b'different signature'))
        self.assertEqual(one, two)
        self.assertEqual(one['assets/backend.tgz::bin/tool']['target'], '../dist/main/headless.js')

    def test_changed_native_bytes_and_backend_modes_are_visible(self):
        one = self.bench.apk_manifest(self.apk('one.apk'))
        self.assertNotEqual(one, self.bench.apk_manifest(self.apk('native.apk', native=b'changed')))
        self.assertNotEqual(one, self.bench.apk_manifest(self.apk('mode.apk', executable=0o644)))

    def test_zip_traversal_and_duplicate_entries_are_not_comparable_payloads(self):
        unsafe = self.root / 'unsafe.apk'
        with zipfile.ZipFile(unsafe, 'w') as archive:
            archive.writestr('../escape', b'bad')
        with self.assertRaises(ValueError):
            self.bench.apk_manifest(unsafe)
        duplicate = self.root / 'duplicate.apk'
        with zipfile.ZipFile(duplicate, 'w') as archive:
            archive.writestr('same', b'one')
            with self.assertWarns(UserWarning):
                archive.writestr('same', b'two')
        with self.assertRaises(ValueError):
            self.bench.apk_manifest(duplicate)

    def junit(self, omitted=None, failure=False):
        root = self.root / 'results'
        for variant in ('Debug', 'Release', 'ReleaseTest'):
            if variant == omitted:
                continue
            folder = root / f'test{variant}UnitTest'
            folder.mkdir(parents=True, exist_ok=True)
            child = '<failure message="broken"/>' if failure else ''
            (folder / 'TEST-Example.xml').write_text(f'<testsuite tests="1" failures="{int(failure)}" errors="0"><testcase classname="Example" name="case">{child}</testcase></testsuite>')
        return root

    def test_junit_requires_every_variant_and_rejects_failed_or_missing_tests(self):
        self.assertEqual(len(self.bench.junit_manifest(self.junit())), 3)
        with self.assertRaises(ValueError):
            self.bench.junit_manifest(self.junit(failure=True))
        other = self.root / 'missing'
        other.mkdir()
        with self.assertRaises(ValueError):
            self.bench.junit_manifest(other)

    def test_junit_rejects_skipped_counts_and_unnamed_cases(self):
        root = self.junit()
        file = root / 'testDebugUnitTest/TEST-Example.xml'
        for xml in ('<testsuite tests="1" skipped="1"><testcase classname="E" name="c"/></testsuite>',
                    '<testsuite tests="1"><testcase classname="E" name="c"><skipped/></testcase></testsuite>',
                    '<testsuite tests="1"><testcase name="c"/></testsuite>'):
            file.write_text(xml)
            with self.subTest(xml=xml), self.assertRaises(ValueError):
                self.bench.junit_manifest(root)

    def test_comparison_rejects_missing_reports_input_changes_and_payload_mismatch(self):
        baseline = self.report()
        trial = json.loads(json.dumps(baseline))
        trial['mode'] = 'combined'
        self.bench.compare_reports([baseline, trial], expected={'baseline', 'combined'})
        with self.assertRaises(ValueError):
            self.bench.compare_reports([baseline], expected={'baseline', 'combined'})
        trial['inputs']['source'] = 'changed'
        with self.assertRaises(ValueError):
            self.bench.compare_reports([baseline, trial], expected={'baseline', 'combined'})
        trial['inputs']['source'] = baseline['inputs']['source']
        trial['payloads']['debug']['assets/web/index.html']['sha256'] = 'b' * 64
        with self.assertRaises(ValueError):
            self.bench.compare_reports([baseline, trial], expected={'baseline', 'combined'})


    def report(self):
        required = {
            'lib/arm64-v8a/libldmusl.so', 'lib/arm64-v8a/libclaude.so', 'lib/arm64-v8a/libptynode.so',
            'lib/arm64-v8a/libycshim.so', 'lib/arm64-v8a/libclaudelaunch.so', 'assets/web/index.html',
            'assets/backend.tgz::dist/main/headless/headless-main.js', 'assets/backend.tgz::legal/npm-components.json',
            'assets/backend.tgz::legal/npm-notices/example.txt', 'assets/legal/runtime-components.json',
            'assets/legal/musl-COPYRIGHT.txt', 'assets/legal/THIRD-PARTY-NOTICES.txt', 'assets/runtime/app-id.txt',
            'lib/arm64-v8a/libnode.so', 'lib/arm64-v8a/libbash.so', 'lib/arm64-v8a/libgit.so',
            'lib/arm64-v8a/libgit_remote_https.so', 'lib/arm64-v8a/librg.so', 'lib/arm64-v8a/libycopen.so',
            'assets/runtime/binmap.txt', 'assets/runtime/libmap.txt', 'assets/runtime/ca-certificates.crt',
            'assets/runtime/claude-code-version.txt', 'assets/runtime/etc-terminfo.tgz::terminfo/x/xterm'}
        payload = {name: {'type': 'file', 'sha256': 'a' * 64, 'size': 1, 'mode': 0o644} for name in required}
        payload['assets/runtime/share.tgz::git-core/templates'] = {'type': 'directory', 'mode': 0o755}
        inputs = {key: 'fixed' for key in ('commit', 'source', 'kotlin', 'lock', 'java', 'node', 'build', 'pins', 'gradle',
                                          'clang', 'linker', 'debug-runtime-inputs', 'releaseTest-runtime-inputs')}
        return {'mode': 'baseline', 'status': 'success', 'inputs': inputs,
                'tests': {f'{v}:Example:case': 'passed' for v in self.bench.VARIANTS},
                'payloads': {v: copy.deepcopy(payload) for v in self.bench.APK_IDS},
                'signatures': {v: 'verified signature' for v in self.bench.APK_IDS}}

    def fragments(self):
        baseline = self.report()
        common = {k: v for k, v in baseline['inputs'].items() if k not in
                  ('clang', 'linker', 'debug-runtime-inputs', 'releaseTest-runtime-inputs')}
        result = []
        for role, seconds in [('unit', 20), ('debug', 40), ('releaseTest', 60)]:
            fragment = {'fragment': role, 'status': 'success', 'options': self.bench.options('combined-4g'), 'inputs': copy.deepcopy(common),
                        'totalSeconds': seconds, 'spans': [{'stage': role, 'seconds': seconds, 'exitCode': 0}],
                        'tests': {}, 'payloads': {}, 'signatures': {}, 'apkBytes': {},
                        'native': {'compilations': 0, 'hits': 0}}
            if role == 'unit':
                fragment['tests'] = baseline['tests']
            else:
                fragment['inputs'].update({k: baseline['inputs'][k] for k in ('clang', 'linker', f'{role}-runtime-inputs')})
                fragment['payloads'][role] = baseline['payloads'][role]
                fragment['signatures'][role] = 'verified signature'
                fragment['apkBytes'][role] = 123
                fragment['native']['compilations'] = 1
            result.append(fragment)
        return result

    def test_fanout_combines_exact_coverage_and_uses_maximum_not_summed_harness_duration(self):
        combined = self.bench.combine_fragments(self.fragments())
        self.assertEqual(combined['mode'], 'fanout')
        self.assertEqual(combined['totalSeconds'], 60)
        self.assertEqual(combined['native'], {'compilations': 2, 'hits': 0})
        self.bench.compare_reports([self.report(), combined], expected={'baseline', 'fanout'})

    def test_fragments_reject_missing_duplicate_failed_extra_and_inconsistent_provenance(self):
        fragments = self.fragments()
        invalid = [fragments[:2], fragments + [fragments[0]]]
        for path, value in [('fragment', 'extra'), ('status', 'failed'), ('totalSeconds', -1)]:
            changed = copy.deepcopy(fragments)
            changed[0][path] = value
            invalid.append(changed)
        for role, field, key, value in [(0, 'inputs', 'java', 'other'), (1, 'inputs', 'clang', 'other'),
                                         (1, 'payloads', 'debug', {}), (0, 'tests', 'Debug:Example:case', 'skipped')]:
            changed = copy.deepcopy(fragments)
            changed[role][field][key] = value
            invalid.append(changed)
        changed = copy.deepcopy(fragments)
        changed[0]['payloads'] = self.report()['payloads']
        invalid.append(changed)
        for index, records in enumerate(invalid):
            with self.subTest(case=index), self.assertRaises(ValueError):
                self.bench.combine_fragments(records)

    def test_comparator_rejects_equally_malformed_baseline_and_candidate(self):
        for field, value in [('tests', {}), ('tests', {'Debug:Example:case': 'passed'}),
                             ('tests', {f'{v}:E:c': 'unknown' for v in self.bench.VARIANTS}),
                             ('tests', {f'{v}:E:c': 'skipped' for v in self.bench.VARIANTS}),
                             ('payloads', {'debug': {}, 'releaseTest': {}}),
                             ('payloads', {'debug': {'bad': {}}, 'releaseTest': {'bad': {}}}),
                             ('inputs', {'source': 'fixed'}), ('signatures', {})]:
            baseline = self.report()
            baseline[field] = value
            candidate = copy.deepcopy(baseline)
            candidate['mode'] = 'combined'
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                self.bench.compare_reports([baseline, candidate], expected={'baseline', 'combined'})

    def test_single_variant_graph_requires_its_producers_and_no_other_native_variant(self):
        for role, variant in [('debug', 'Debug'), ('releaseTest', 'ReleaseTest')]:
            names = ['bundleWebUi', 'buildBackend', f'buildRuntime{variant}', f'assemble{variant}']
            text = '\n'.join(f':app:{name} SKIPPED' for name in names)
            self.bench.assert_graph('combined-4g', text, role)
            with self.assertRaises(ValueError):
                self.bench.assert_graph('combined-4g', text + '\n:app:buildRuntimeRelease SKIPPED', role)
            with self.assertRaises(ValueError):
                self.bench.assert_graph('combined-4g', f':app:assemble{variant} SKIPPED', role)

    def test_unit_provenance_and_execution_never_require_native_tools_or_runtime_inputs(self):
        with patch.object(self.bench, 'output', return_value='fixed') as execute:
            inputs = self.bench.collect_inputs(self.root, native=False)
        self.assertEqual(set(inputs), self.bench.COMMON_INPUTS)
        self.assertFalse(any(call.args[0][0] in ('clang', 'ld.lld') for call in execute.call_args_list))
        with patch.object(self.bench, 'assert_clean_sources'), \
             patch.object(self.bench, 'collect_inputs', return_value=inputs) as provenance, \
             patch.object(self.bench, 'collect_apk') as apk, \
             patch.object(self.bench, 'junit_manifest', return_value=self.report()['tests']), \
             patch.object(self.bench, 'timed', side_effect=[self.unit_graph(False), 'JVM tests passed']) as timed:
            report = self.bench.run_fragment('unit', self.root / 'unit')
        self.assertEqual(report['status'], 'success')
        provenance.assert_called_once_with(SCRIPT.parent.parent, native=False)
        apk.assert_not_called()
        for call in timed.call_args_list:
            self.assertNotIn('YOUCODED_COMMON_NATIVE_CACHE', call.args[4])
            self.assertIn('-PciPackagingDependencies=true', call.args[0])
            self.assertIn('-Dorg.gradle.jvmargs=-Xmx4096m -Dfile.encoding=UTF-8', call.args[0])
            self.assertIn('test', call.args[0])
            self.assertFalse(any('assemble' in arg for arg in call.args[0]))

    def test_apk_fragments_use_private_caches_only_one_variant_and_keep_failure_evidence(self):
        caches = []
        for role, variant in [('debug', 'Debug'), ('releaseTest', 'ReleaseTest')]:
            graph = '\n'.join(f':app:{name} SKIPPED' for name in
                              ('bundleWebUi', 'buildBackend', f'buildRuntime{variant}', f'assemble{variant}'))
            with patch.object(self.bench, 'assert_clean_sources'), \
                 patch.object(self.bench, 'collect_inputs', return_value={}), \
                 patch.object(self.bench, 'collect_apk', side_effect=ValueError('bad signature')), \
                 patch.object(self.bench, 'junit_manifest') as junit, \
                 patch.object(self.bench, 'timed', side_effect=[graph, '[build-runtime] musl compilation\n']) as timed:
                with self.assertRaisesRegex(ValueError, 'bad signature'):
                    self.bench.run_fragment(role, self.root / role)
            junit.assert_not_called()
            self.assertEqual(json.loads((self.root / role / 'fragment.json').read_text())['status'], 'failed')
            command = timed.call_args_list[-1].args[0]
            self.assertIn(f'assemble{variant}', command)
            self.assertNotIn('test', command)
            cache = timed.call_args_list[-1].args[4]['YOUCODED_COMMON_NATIVE_CACHE']
            self.assertFalse(Path(cache).exists(), 'Private native cache must be cleaned after failure')
            caches.append(cache)
        self.assertNotEqual(*caches)

    def test_fragment_and_payload_schema_rejects_malformed_records(self):
        fragments = self.fragments()
        bad = []
        for field, value in [('spans', []), ('spans', [{'stage': 'x', 'seconds': 1, 'exitCode': 1}]),
                             ('native', {'compilations': 0, 'hits': 1}), ('totalSeconds', float('nan')),
                             ('inputs', {}), ('apkBytes', {}), ('signatures', {}), ('options', {}), ('extraField', True)]:
            changed = copy.deepcopy(fragments)
            changed[1][field] = value
            bad.append(changed)
        for record in ({}, {'type': 'file', 'mode': 420, 'size': 1, 'sha256': 'bad'},
                       {'type': 'file', 'mode': -1, 'size': 1, 'sha256': 'a' * 64},
                       {'type': 'other', 'mode': 420}, {'type': 'symlink', 'mode': 420, 'target': ''}):
            changed = copy.deepcopy(fragments)
            changed[1]['payloads']['debug']['assets/web/index.html'] = record
            bad.append(changed)
        for index, records in enumerate(bad):
            with self.subTest(case=index), self.assertRaises(ValueError):
                self.bench.combine_fragments(records)

    def test_cli_aggregation_requires_all_modes_and_all_three_fragments(self):
        for mode in self.bench.MODES:
            report = self.report()
            report.update(mode=mode, totalSeconds=100)
            folder = self.root / mode
            folder.mkdir()
            (folder / 'report.json').write_text(json.dumps(report))
        for fragment in self.fragments():
            folder = self.root / fragment['fragment']
            folder.mkdir()
            (folder / 'fragment.json').write_text(json.dumps(fragment))
        command = ['python3', str(SCRIPT), 'compare', str(self.root)]
        success = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(success.returncode, 0, success.stderr)
        self.assertIn('fanout: build harness 60.0s', success.stdout)
        self.assertIn('not summed work or CI latency', success.stdout)
        summary = json.loads((self.root / 'fanout-summary.json').read_text())
        self.assertEqual(summary['totalSeconds'], 60)
        self.assertIsNone(summary['externalTimings']['setup'])
        self.assertGreaterEqual(summary['externalTimings']['finalValidation'], 0)
        # Failed producers cannot become successful merely because payloads match.
        for failed_mode in self.bench.MODES:
            path = self.root / failed_mode / 'report.json'
            original = path.read_text()
            changed = json.loads(original)
            changed['status'] = 'failed'
            path.write_text(json.dumps(changed))
            failed = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(failed.returncode, 0, failed_mode)
            path.write_text(original)
        (self.root / 'debug/fragment.json').unlink()
        failed = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn('Exactly unit, debug and releaseTest', failed.stderr)

    def test_all_workflow_producer_results_are_executable_fail_closed(self):
        import itertools
        import os
        import yaml
        config = yaml.safe_load((SCRIPT.parent.parent / '.github/workflows/android-speed-benchmark.yml').read_text())
        step = next(s for s in config['jobs']['validation']['steps'] if s.get('name') == 'Require all diagnostic producers to succeed')
        for results in itertools.product(('success', 'failure', 'cancelled', 'skipped'), repeat=3):
            env = {**os.environ, **dict(zip(('CHECKS_RESULT', 'BENCHMARKS_RESULT', 'FANOUT_RESULT'), results))}
            process = subprocess.run(['bash', '-c', step['run']], env=env, capture_output=True)
            self.assertEqual(process.returncode == 0, all(r == 'success' for r in results), results)

    def test_apk_collection_checks_android_manifest_id_not_only_runtime_text(self):
        apk = self.apk('test.apk')
        folder = self.root / 'app/build/outputs/apk/debug'
        folder.mkdir(parents=True)
        apk.rename(folder / 'test.apk')
        report = {'spans': [], 'payloads': {}, 'signatures': {}, 'apkBytes': {}, 'inputs': {}}
        with patch.object(self.bench, 'signer', return_value=Path('/sdk/apksigner')), \
             patch.object(self.bench, 'timed', side_effect=['signature valid', "package: name='com.wrong.app'"]) as timed, \
             patch.object(self.bench, 'apk_manifest', return_value=self.report()['payloads']['debug']), \
             patch.object(self.bench, 'payload_required'):
            with self.assertRaisesRegex(ValueError, 'application ID'):
                self.bench.collect_apk(report, 'debug', self.root, self.root, {})
        self.assertTrue(any('badging' in call.args[0] for call in timed.call_args_list))

    def test_required_runtime_programs_and_data_cannot_disappear_from_both_reports(self):
        for name in ('lib/arm64-v8a/libnode.so', 'lib/arm64-v8a/libbash.so', 'lib/arm64-v8a/libgit.so',
                     'lib/arm64-v8a/libgit_remote_https.so', 'lib/arm64-v8a/librg.so', 'lib/arm64-v8a/libycopen.so',
                     'assets/runtime/binmap.txt', 'assets/runtime/libmap.txt', 'assets/runtime/ca-certificates.crt',
                     'assets/runtime/claude-code-version.txt', 'assets/runtime/share.tgz::git-core/templates',
                     'assets/runtime/etc-terminfo.tgz::terminfo/x/xterm'):
            report = self.report()
            del report['payloads']['debug'][name]
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.bench.compare_reports([report], expected={'baseline'})

    def test_native_work_must_match_the_declared_experiment_not_an_inert_flag(self):
        self.assertTrue(callable(getattr(self.bench, 'native_counts', None)))
        compiled = '[build-runtime] musl compilation\n'
        hit = '[build-runtime] musl verified run-local cache hit\n'
        self.assertEqual(self.bench.native_counts('baseline', compiled * 3)['compilations'], 3)
        self.assertEqual(self.bench.native_counts('combined', compiled + hit)['hits'], 1)
        with self.assertRaises(ValueError):
            self.bench.native_counts('combined', compiled * 3)
        with self.assertRaises(ValueError):
            self.bench.native_counts('common-native', compiled)

    def test_workflow_is_branch_scoped_read_only_and_never_masks_missing_modes(self):
        import yaml
        workflow = SCRIPT.parent.parent / '.github/workflows/android-speed-benchmark.yml'
        self.assertTrue(workflow.is_file(), 'diagnostic workflow is not implemented')
        config = yaml.safe_load(workflow.read_text())
        trigger = config.get('on', config.get(True))
        self.assertEqual(set(trigger), {'pull_request'})
        self.assertEqual(config['permissions'], {'contents': 'read'})
        jobs = config['jobs']
        self.assertEqual(jobs['checks']['if'], "github.head_ref == 'session/29-android-build-bench'")
        self.assertEqual(jobs['benchmarks']['needs'], 'checks')
        self.assertEqual(jobs['benchmarks']['strategy']['matrix']['mode'], list(self.bench.MODES))
        self.assertFalse(jobs['benchmarks']['strategy']['fail-fast'])
        self.assertEqual(jobs['benchmarks']['strategy']['max-parallel'], 2)
        run = next(step for step in jobs['benchmarks']['steps'] if step.get('name') == 'Run complete experiment')
        self.assertEqual(run['env']['MODE'], '${{ matrix.mode }}')
        self.assertIn('python3 scripts/android-speed-benchmark.py run "$MODE"', run['run'])
        self.assertNotIn('continue-on-error', run)
        upload = next(step for step in jobs['benchmarks']['steps'] if str(step.get('uses', '')).startswith('actions/upload-artifact@'))
        self.assertEqual(upload['if'], 'always()')
        self.assertEqual(upload['with']['retention-days'], 1)
        self.assertNotIn('outputs/apk', upload['with']['path'])
        validation = jobs['validation']
        self.assertEqual(validation['if'], "always() && github.head_ref == 'session/29-android-build-bench'")
        self.assertEqual(validation['needs'], ['checks', 'benchmarks', 'fanout'])
        fanout = jobs['fanout']
        self.assertEqual(fanout['needs'], 'checks')
        self.assertFalse(fanout['strategy']['fail-fast'])
        self.assertEqual(fanout['strategy']['matrix']['fragment'], ['unit', 'debug', 'releaseTest'])
        self.assertEqual(fanout['strategy']['max-parallel'], 3)
        for step in fanout['steps']:
            if any(word in str(step) for word in ('apt-get', 'docker', 'actions/cache@')):
                self.assertEqual(step.get('if'), "matrix.fragment != 'unit'")
        execute = next(s for s in fanout['steps'] if s.get('name') == 'Run independent fragment')
        self.assertIn('run-fragment "$FRAGMENT"', execute['run'])
        self.assertNotIn('continue-on-error', execute)
        gate = next(s for s in validation['steps'] if s.get('name') == 'Require all diagnostic producers to succeed')
        for variable in ('CHECKS_RESULT', 'BENCHMARKS_RESULT', 'FANOUT_RESULT'):
            self.assertIn(f'"${variable}" = success', gate['run'])
        self.assertTrue(any(step.get('run') == 'python3 scripts/android-speed-benchmark.py compare reports' for step in validation['steps']))
        self.assertFalse(any('secrets.' in str(job) or 'id-token' in str(job) or 'environment' in job for job in jobs.values()))


if __name__ == '__main__':
    unittest.main()
