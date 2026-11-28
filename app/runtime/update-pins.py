#!/usr/bin/env python3
"""Refresh the Android runtime's locked program versions to the latest available (run at each release).

WHY: the phone's programs (Node, git, bash, ...) come from Alpine packages. alpine-lock.json is the exact
list the build must use (build-runtime.sh refuses anything else), so builds are reproducible. This script
is the one deliberate way to move that list forward: it reads Alpine's current package lists, works out
the exact packages the phone needs, downloads them to record their file hashes, and rewrites the lock.
It also reports (and with --apply-claude, applies) a newer Claude Code release.
Afterwards: build, then run the app on a real phone before shipping - a new lock is a phone test.
Needs: python3, network, and `apk version -t` (or YOUCODED_APK_VERSION) as runtime-redistribution does.
"""
import argparse, hashlib, importlib.util, json, re, shlex, subprocess, sys, tarfile, tempfile, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('resolve_apk', HERE / 'resolve-apk.py')
resolver = importlib.util.module_from_spec(spec); spec.loader.exec_module(resolver)


def read_pins():
    pins = {}
    for line in (HERE / 'pins.env').read_text().splitlines():
        m = re.match(r'^([A-Z_]+)=(.*)$', line)
        if m:
            pins[m[1]] = ' '.join(shlex.split(m[2]))
    return pins


def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--apply-claude', action='store_true', help='also rewrite CLAUDE_CODE_VERSION in pins.env')
    ap.add_argument('--cache', help='folder for downloaded packages (default: a temp folder)')
    args = ap.parse_args()
    pins = read_pins()
    branch = pins['ALPINE_BRANCH']
    base = f'https://dl-cdn.alpinelinux.org/alpine/{branch}'
    work = Path(args.cache or tempfile.mkdtemp(prefix='yc-pins-')); (work / 'apk').mkdir(parents=True, exist_ok=True)
    for repo in ('main', 'community'):
        data = fetch(f'{base}/{repo}/aarch64/APKINDEX.tar.gz')
        (work / f'{repo}.tgz').write_bytes(data)
        with tarfile.open(work / f'{repo}.tgz') as t:
            (work / f'{repo}.idx').write_bytes(t.extractfile('APKINDEX').read())
    chosen = {}
    for scope in ('RUNTIME_PACKAGES', 'SYSROOT_PACKAGES'):
        result = resolver.resolve(work, pins[scope].split(), provider_choices={'/bin/sh': 'busybox-binsh'})
        for p in result['packages']:
            chosen[p['P']] = p
    old_path = HERE / 'alpine-lock.json'
    old = json.loads(old_path.read_text())['packages'] if old_path.exists() else {}
    packages = {}
    for name, p in sorted(chosen.items()):
        apk = work / 'apk' / f"{name}-{p['V']}.apk"
        if not apk.exists():
            apk.write_bytes(fetch(f"{base}/{p['repo']}/aarch64/{name}-{p['V']}.apk"))
        packages[name] = {'version': p['V'], 'sha256': hashlib.sha256(apk.read_bytes()).hexdigest()}
    old_path.write_text(json.dumps({'schema': 1, 'branch': branch, 'packages': packages}, indent=1) + '\n')
    changes = [f"  {n}: {old[n]['version'] if n in old else '(new)'} -> {v['version']}"
               for n, v in packages.items() if n not in old or old[n]['version'] != v['version']]
    changes += [f"  {n}: {old[n]['version']} -> (removed)" for n in old if n not in packages]
    print(f'alpine-lock.json: {len(packages)} packages, {len(changes)} changed')
    print('\n'.join(changes) or '  (already up to date)')
    # Claude Code: the musl build is what the phone runs.
    latest = json.loads(fetch('https://registry.npmjs.org/@anthropic-ai/claude-code-linux-arm64-musl/latest'))['version']
    current = pins['CLAUDE_CODE_VERSION']
    if latest == current:
        print(f'Claude Code: {current} is the latest')
    elif args.apply_claude:
        text = (HERE / 'pins.env').read_text()
        (HERE / 'pins.env').write_text(re.sub(r'^CLAUDE_CODE_VERSION=.*$', f'CLAUDE_CODE_VERSION={latest}', text, flags=re.M))
        print(f'Claude Code: {current} -> {latest} (pins.env updated)')
    else:
        print(f'Claude Code: {current} -> {latest} available (re-run with --apply-claude)')
    print('Next: build, then test on a real phone before shipping.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError) as e:
        sys.exit(f'update-pins failed: {e}')
