#!/usr/bin/env python3
"""Matched-host Android controls: opposite orders, fresh outputs, complete equivalence."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('android_speed_benchmark', Path(__file__).with_name('android-speed-benchmark.py'))
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)
ORDERS = {'baseline-first': ('baseline','combined'), 'combined-first': ('combined','baseline')}
OUTPUTS = ('app/build', 'build', 'app/src/main/assets/web')


def order(name):
    if name not in ORDERS:
        raise ValueError('Unknown fixed mode order')
    return ORDERS[name]


def git(root, *args):
    return subprocess.run(['git','-C',str(root),*args],check=True,capture_output=True).stdout


def contained(root, path):
    root, path = Path(root).resolve(), Path(path)
    if not path.resolve().is_relative_to(root) or path.resolve() == root:
        raise ValueError('Generated output escaped disposable checkout')
    current = path
    while current != root:
        if current.is_symlink():
            raise ValueError('Generated output or its parent is a symlink')
        current = current.parent


def assert_ci_checkout(root, env):
    root = Path(root).resolve()
    if env.get('GITHUB_ACTIONS') != 'true' or Path(env.get('GITHUB_WORKSPACE', '/')).resolve() != root or not (root / '.git').exists():
        raise ValueError('Reset requires the exact disposable GitHub checkout')


def clear_outputs(root, env):
    root = Path(root).resolve()
    assert_ci_checkout(root, env)
    # WHY: check EVERY path before deleting any. No git clean/reset, authored
    # sources, dependencies or shared worktrees are ever cleanup candidates.
    for relative in OUTPUTS:
        target = root / relative
        contained(root, target)
        if git(root,'ls-files','-z','--',relative):
            raise ValueError(f'Output contains tracked source files: {relative}')
        if target.exists() and not target.is_dir():
            raise ValueError(f'Output is not a directory: {relative}')
    removed = []
    for relative in OUTPUTS:
        target = root / relative
        if target.exists():
            shutil.rmtree(target)
            removed.append(relative)
    return removed


def relocate_inputs(root, destination):
    root, destination = Path(root).resolve(), Path(destination)
    for relative in OUTPUTS:
        if destination.resolve().is_relative_to(root / relative):
            raise ValueError('Input cache must remain outside cleared outputs')
    if destination.is_symlink() or destination.exists():
        raise ValueError('Paired input cache must start at a fresh path')
    source = root / 'app/build/runtime-cache'
    contained(root, source)
    destination.parent.mkdir(parents=True,exist_ok=True)
    if source.is_dir():
        shutil.move(str(source),str(destination))
    else:
        destination.mkdir()


def compare_pairs(pairs):
    if not isinstance(pairs,list) or len(pairs) != 2 or {p.get('order') for p in pairs} != set(ORDERS):
        raise ValueError('Exactly both opposite-order pair reports are required')
    comparisons, reference = [], None
    for pair in pairs:
        reports = pair.get('reports')
        if not isinstance(reports,list) or [r.get('mode') for r in reports] != list(order(pair['order'])):
            raise ValueError('Pair did not execute its declared order')
        by_mode = bench.compare_reports(reports,expected={'baseline','combined'})
        if reference is None:
            reference = by_mode['baseline']
        for report in reports:
            for field in ('inputs','tests','payloads'):
                if report.get(field) != reference.get(field):
                    raise ValueError(f'Paired hosts differ in {field}; no performance claim')
        base, combined = (by_mode[x]['totalSeconds'] for x in ('baseline','combined'))
        comparisons.append({'order':pair['order'],'baselineSeconds':base,'combinedSeconds':combined,
                            'combinedMinusBaselineSeconds':combined-base,'machine':pair.get('machine')})
    return {'comparisons':comparisons,'note':'Within-host observations in both orders, not a statistical guarantee or a complete winner CI time. Reset/setup/queue and artifact costs are separately recorded.'}


def run_pair(name, folder):
    modes = order(name)
    root = Path(__file__).resolve().parent.parent
    assert_ci_checkout(root, os.environ)
    folder = Path(folder).resolve()
    if folder.is_relative_to(root):
        raise ValueError('Paired evidence must be outside generated build outputs')
    folder.mkdir(parents=True,exist_ok=True)
    report = {'order':name,'status':'failed','reports':[],'resets':[],'machine':bench.machine()}
    # Identical path on each isolated runner avoids build-path byte differences
    # masquerading as mode differences in debug/native provenance.
    cache = Path(os.environ['RUNNER_TEMP']) / 'paired-native-inputs'
    previous = os.environ.get('YOUCODED_RUNTIME_CACHE')
    start = time.monotonic()
    try:
        bench.assert_clean_sources(root)
        relocate_inputs(root,cache)
        os.environ['YOUCODED_RUNTIME_CACHE'] = str(cache)
        for index, mode in enumerate(modes):
            # Stop the old daemon before output cleanup; both modes receive
            # identical dry-run warmup and regenerate all application outputs.
            spans = []
            bench.timed(['./gradlew','--stop'],f'daemon-stop-{index}',root,folder,os.environ.copy(),spans)
            reset_start = time.monotonic()
            removed = clear_outputs(root,os.environ)
            report['resets'].append({'beforeMode':mode,'removed':removed,'seconds':time.monotonic()-reset_start,'daemonSpans':spans})
            report['reports'].append(bench.run(mode,folder / f'{index}-{mode}'))
        bench.compare_reports(report['reports'],expected={'baseline','combined'})
        report['status'] = 'success'
    finally:
        if previous is None:
            os.environ.pop('YOUCODED_RUNTIME_CACHE',None)
        else:
            os.environ['YOUCODED_RUNTIME_CACHE'] = previous
        report['totalSeconds'] = time.monotonic()-start
        (folder/'pair.json').write_text(json.dumps(report,sort_keys=True,indent=2)+'\n')
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='command',required=True)
    run=sub.add_parser('run');run.add_argument('order',choices=tuple(ORDERS));run.add_argument('folder')
    compare=sub.add_parser('compare');compare.add_argument('folder')
    args=parser.parse_args()
    if args.command=='run':
        run_pair(args.order,args.folder)
    else:
        pairs=[json.loads(p.read_text()) for p in Path(args.folder).rglob('pair.json')]
        if any(p.get('status')!='success' for p in pairs):
            raise ValueError('A paired producer failed')
        summary=compare_pairs(pairs)
        (Path(args.folder)/'paired-summary.json').write_text(json.dumps(summary,sort_keys=True,indent=2)+'\n')
        print(json.dumps(summary,indent=2))


if __name__=='__main__':
    try:
        main()
    except (OSError,ValueError,subprocess.SubprocessError) as error:
        print(f'Android paired experiment: {error}',file=sys.stderr)
        sys.exit(1)
