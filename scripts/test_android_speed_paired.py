"""Matched-runner Android experiment contracts; no real builds required."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('android-speed-paired.py')


class PairedTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), 'paired experiment helper is not implemented')
        spec = importlib.util.spec_from_file_location('paired', SCRIPT)
        self.paired = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.paired)
        self.temp = tempfile.TemporaryDirectory(prefix='paired-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        self.env = {'GITHUB_ACTIONS': 'true', 'GITHUB_WORKSPACE': str(self.root)}

    def test_only_fixed_opposite_orders_are_allowed(self):
        self.assertEqual(self.paired.order('baseline-first'), ('baseline', 'combined'))
        self.assertEqual(self.paired.order('combined-first'), ('combined', 'baseline'))
        with self.assertRaises(ValueError):
            self.paired.order('baseline; rm -rf anything')

    def output(self, relative, text='generated'):
        file = self.root / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)
        return file

    def test_reset_clears_only_known_generated_outputs_and_preserves_dependencies(self):
        files = [self.output('app/build/runtime/output'), self.output('build/reports/profile.html'), self.output('app/src/main/assets/web/index.html')]
        keep = self.output('desktop/node_modules/tool/file')
        self.paired.clear_outputs(self.root, self.env)
        self.assertTrue(all(not p.exists() for p in files))
        self.assertTrue(keep.is_file())

    def test_reset_requires_exact_disposable_ci_checkout(self):
        file = self.output('app/build/keep')
        for env in [{}, {**self.env, 'GITHUB_ACTIONS': 'false'}, {**self.env, 'GITHUB_WORKSPACE': str(self.root / 'other')}]:
            with self.assertRaises(ValueError):
                self.paired.clear_outputs(self.root, env)
            self.assertTrue(file.is_file())

    def test_pair_cli_cannot_start_any_build_or_cache_move_outside_disposable_ci(self):
        folder = self.root / 'no-output'
        with patch.dict(os.environ, {}, clear=True), patch.object(self.paired.bench, 'timed') as build:
            with self.assertRaises(ValueError):
                self.paired.run_pair('baseline-first', folder)
            build.assert_not_called()
            self.assertFalse(folder.exists())

    def test_reset_checks_all_paths_before_deleting_any_tracked_input(self):
        keep = self.output('app/build/keep')
        tracked = self.output('app/src/main/assets/web/authored.html')
        subprocess.run(['git', '-C', str(self.root), 'add', '-f', str(tracked.relative_to(self.root))], check=True)
        with self.assertRaises(ValueError):
            self.paired.clear_outputs(self.root, self.env)
        self.assertTrue(keep.is_file())
        self.assertTrue(tracked.is_file())

    def test_reset_refuses_symlinked_output_or_parent(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'keep').write_text('must survive')
        (self.root / 'app').mkdir()
        (self.root / 'app/build').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.paired.clear_outputs(self.root, self.env)
        self.assertTrue((outside / 'keep').is_file())

    def test_inputs_are_relocated_before_any_reset_and_remain_outside_outputs(self):
        source = self.output('app/build/runtime-cache/root-inputs.json', '{"fixed":true}')
        target = self.root / 'separate-inputs'
        self.paired.relocate_inputs(self.root, target)
        self.assertEqual((target / source.name).read_text(), '{"fixed":true}')
        self.paired.clear_outputs(self.root, self.env)
        self.assertTrue((target / source.name).is_file())
        with self.assertRaises(ValueError):
            self.paired.relocate_inputs(self.root, self.root / 'app/build/not-safe')

    def test_real_pair_orchestration_runs_both_modes_after_fresh_outputs_and_stops_daemons(self):
        repo = self.root / 'repo'
        repo.mkdir()
        subprocess.run(['git','init','-q',str(repo)],check=True)
        calls = []
        def trial(mode, folder):
            self.assertFalse((repo/'app/build/previous').exists())
            file = repo/'app/build/previous'
            file.parent.mkdir(parents=True,exist_ok=True)
            file.write_text(mode)
            calls.append(mode)
            return {'mode':mode,'status':'success'}
        env = {'GITHUB_ACTIONS':'true','GITHUB_WORKSPACE':str(repo),'RUNNER_TEMP':str(self.root/'job-temp')}
        with patch.dict(os.environ,env,clear=True), patch.object(self.paired,'__file__',str(repo/'scripts/android-speed-paired.py')), \
             patch.object(self.paired.bench,'assert_clean_sources'), patch.object(self.paired.bench,'timed') as command, \
             patch.object(self.paired.bench,'machine',return_value={}), patch.object(self.paired.bench,'run',side_effect=trial), \
             patch.object(self.paired.bench,'compare_reports'):
            result = self.paired.run_pair('combined-first',self.root/'reports')
        self.assertEqual(calls,['combined','baseline'])
        self.assertEqual(result['status'],'success')
        self.assertEqual(command.call_count,2)
        self.assertTrue(all(call.args[0] == ['./gradlew','--stop'] for call in command.call_args_list))
        self.assertEqual(len(result['resets']),2)

    def test_both_orders_are_required_and_source_tests_payload_changes_reject(self):
        base = {'mode':'baseline','inputs':{'fixed':'input'},'tests':{'case':'passed'},'payloads':{'debug':{'a':1}},'totalSeconds':100}
        trial = {**base, 'mode':'combined', 'totalSeconds':80}
        pairs = [{'order':'baseline-first','reports':[base,trial]}, {'order':'combined-first','reports':[trial,base]}]
        with patch.object(self.paired.bench, 'compare_reports', side_effect=lambda reports, **kw: {r['mode']:r for r in reports}) as verify:
            result = self.paired.compare_pairs(pairs)
            self.assertEqual(len(result['comparisons']), 2)
            self.assertEqual(verify.call_count, 2)
            self.assertEqual(result['comparisons'][0]['combinedMinusBaselineSeconds'], -20)
            with self.assertRaises(ValueError):
                self.paired.compare_pairs(pairs[:1])
            bad = json.loads(json.dumps(pairs))
            bad[1]['reports'][0]['payloads'] = {'changed':True}
            with self.assertRaises(ValueError):
                self.paired.compare_pairs(bad)

    def test_workflow_uses_same_runner_pairs_and_does_not_relaunch_factorial_controls(self):
        import yaml
        file = SCRIPT.parent.parent / '.github/workflows/android-speed-paired.yml'
        self.assertTrue(file.is_file(), 'paired workflow is not implemented')
        config = yaml.safe_load(file.read_text())
        self.assertEqual(set(config.get('on', config.get(True))), {'pull_request'})
        self.assertEqual(config['permissions'], {'contents':'read'})
        jobs = config['jobs']
        self.assertEqual(jobs['checks']['if'], "github.head_ref == 'session/29-android-paired-bench'")
        self.assertEqual(jobs['pairs']['strategy']['matrix']['order'], ['baseline-first','combined-first'])
        self.assertEqual(jobs['pairs']['strategy']['max-parallel'], 2)
        self.assertFalse(jobs['pairs']['strategy']['fail-fast'])
        run = next(s for s in jobs['pairs']['steps'] if s.get('name') == 'Run both cold-output modes on this same runner')
        self.assertIn('python3 scripts/android-speed-paired.py run "$ORDER"', run['run'])
        self.assertEqual(run['env']['ORDER'], '${{ matrix.order }}')
        self.assertEqual(jobs['validation']['needs'], ['checks','pairs'])
        self.assertEqual(jobs['validation']['if'], "always() && github.head_ref == 'session/29-android-paired-bench'")
        self.assertTrue(any(s.get('run') == 'python3 scripts/android-speed-paired.py compare reports' for s in jobs['validation']['steps']))
        self.assertFalse(any('secrets.' in str(j) or 'id-token' in str(j) or 'environment' in j for j in jobs.values()))


if __name__ == '__main__':
    unittest.main()
