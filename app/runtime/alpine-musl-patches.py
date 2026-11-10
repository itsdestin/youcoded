#!/usr/bin/env python3
"""Alpine's own musl patches, vendored next to this script and applied before ours.

  alpine-musl-patches.py apply <musl source dir> <musl version>   # build time: no network
  alpine-musl-patches.py refresh [<alpine branch>]                # developer time: update the vendored set

WHY (2026-11-10, card #219): the phone's musl is compiled from the upstream musl-<version> download, while
every other bundled program is an Alpine package. Alpine ships musl with security patches on top of the same
upstream version (1.2.6-r3 carried three CVE fixes); building from the plain download silently left them out,
and the daily security watch could not see it because it compares package versions.

WHY vendored rather than fetched at build time: the first version downloaded the patches from Alpine's GitLab
during the CI build and was answered with "418 I'm a teapot" (bot protection). Pinned inputs are the rule for
the phone runtime anyway (pins.env: every bump is a phone test), so the patches live in
`alpine-musl-patches/` with `manifest.json` naming the Alpine package version they came from and each file's
sha512 from Alpine's APKBUILD. `apply` verifies every file against the manifest, checks the manifest's musl
version matches pins.env, and applies the patches in Alpine's order with `patch -p1 --forward`, failing closed
on any mismatch. `refresh` makes a sparse git clone of aports for the pinned branch (git itself, not the web
UI), verifies each patch against the APKBUILD's sha512 line, and rewrites the vendored set. The daily
security watch compares the manifest's version with Alpine's current musl package and opens an issue when a
refresh is due.
"""
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
VENDORED = HERE / 'alpine-musl-patches'
MANIFEST = VENDORED / 'manifest.json'
APORTS_GIT = 'https://gitlab.alpinelinux.org/alpine/aports.git'


def aports_branch(alpine_branch):
    """pins.env ALPINE_BRANCH (v3.24, edge) -> aports git branch (3.24-stable, master)."""
    m = re.fullmatch(r'v(\d+\.\d+)', alpine_branch)
    if m:
        return f'{m.group(1)}-stable'
    if alpine_branch == 'edge':
        return 'master'
    raise ValueError(f'alpine-musl-patches: unknown ALPINE_BRANCH {alpine_branch!r}')


def parse_apkbuild(text):
    """pkgver, pkgrel, the .patch names from source= in order, and name -> sha512 from sha512sums=."""
    def var(name):
        m = re.search(rf'^{name}=(\S+)$', text, re.M)
        if not m:
            raise ValueError(f'alpine-musl-patches: APKBUILD has no {name}=')
        return m.group(1).strip('"')
    pkgver, pkgrel = var('pkgver'), var('pkgrel')
    src = re.search(r'^source="([^"]*)"', text, re.M)
    if not src:
        raise ValueError('alpine-musl-patches: APKBUILD has no source= block')
    patches = [s for s in src.group(1).split() if s.endswith('.patch')]
    sums_block = re.search(r'^sha512sums="([^"]*)"', text, re.M)
    if not sums_block:
        raise ValueError('alpine-musl-patches: APKBUILD has no sha512sums= block')
    sums = {}
    for line in sums_block.group(1).splitlines():
        parts = line.split()
        if len(parts) == 2:
            sums[parts[1]] = parts[0]
    missing = [p for p in patches if p not in sums]
    if missing:
        raise ValueError(f'alpine-musl-patches: APKBUILD lists no sha512 for {", ".join(missing)}')
    return pkgver, pkgrel, patches, sums


def sha512(path):
    return hashlib.sha512(pathlib.Path(path).read_bytes()).hexdigest()


def read_manifest(path=MANIFEST):
    try:
        return json.loads(pathlib.Path(path).read_text())
    except FileNotFoundError:
        sys.exit(f'alpine-musl-patches: {path} is missing; run `alpine-musl-patches.py refresh` and commit the result')


def apply_patch(src, patch_file):
    # WHY -p1 and --forward: abuild applies with -p1; --forward makes an already-applied patch a clear error
    # (exit 1 with "Reversed (or previously applied)") rather than a silent reversal.
    r = subprocess.run(['patch', '-p1', '--forward', '--no-backup-if-mismatch', '-i', str(patch_file)],
                       cwd=src, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f'alpine-musl-patches: {pathlib.Path(patch_file).name} did not apply cleanly:\n{r.stdout}{r.stderr}')


def apply_all(src, musl_version, vendored=VENDORED, manifest_path=MANIFEST):
    """Apply the vendored patches to a fresh musl tree; returns the Alpine version they came from."""
    src = pathlib.Path(src)
    m = read_manifest(manifest_path)
    if m['musl'] != musl_version:
        sys.exit(f'alpine-musl-patches: the vendored patches are for musl {m["musl"]} but pins.env says MUSL_VERSION={musl_version}; '
                 'run `alpine-musl-patches.py refresh`, then bump MUSL_VERSION after a phone test')
    for entry in m['patches']:
        p = pathlib.Path(vendored) / entry['name']
        if not p.is_file():
            sys.exit(f'alpine-musl-patches: vendored {entry["name"]} is missing; run `alpine-musl-patches.py refresh`')
        if sha512(p) != entry['sha512']:
            sys.exit(f'alpine-musl-patches: vendored {entry["name"]} does not match its sha512 in manifest.json; refusing it')
        apply_patch(src, p)
    (src / '.alpine-patches.json').write_text(json.dumps({'alpine': m['alpine'], 'patches': [e['name'] for e in m['patches']]}) + '\n')
    return m['alpine']


def refresh(alpine_branch, vendored=VENDORED, manifest_path=MANIFEST):
    """Sparse-clone aports for the pinned branch and rewrite the vendored set from its musl/APKBUILD."""
    branch = aports_branch(alpine_branch)
    with tempfile.TemporaryDirectory(prefix='aports-musl-') as tmp:
        subprocess.run(['git', 'clone', '-q', '--depth', '1', '--branch', branch, '--filter=blob:none', '--sparse', APORTS_GIT, tmp], check=True)
        subprocess.run(['git', '-C', tmp, 'sparse-checkout', 'set', 'main/musl'], check=True, capture_output=True)
        commit = subprocess.run(['git', '-C', tmp, 'rev-parse', 'HEAD'], check=True, capture_output=True, text=True).stdout.strip()
        musl_dir = pathlib.Path(tmp) / 'main' / 'musl'
        pkgver, pkgrel, patches, sums = parse_apkbuild((musl_dir / 'APKBUILD').read_text())
        entries = []
        for name in patches:
            p = musl_dir / name
            if sha512(p) != sums[name]:
                raise ValueError(f'alpine-musl-patches: {name} in aports does not match the sha512 in its own APKBUILD; refusing it')
            entries.append({'name': name, 'sha512': sums[name]})
        vendored = pathlib.Path(vendored)
        if vendored.is_dir():
            shutil.rmtree(vendored)
        vendored.mkdir(parents=True)
        for e in entries:
            shutil.copyfile(musl_dir / e['name'], vendored / e['name'])
    manifest = {'alpine': f'{pkgver}-r{pkgrel}', 'musl': pkgver, 'branch': alpine_branch, 'aports_commit': commit, 'patches': entries}
    pathlib.Path(manifest_path).write_text(json.dumps(manifest, indent=1) + '\n')
    return manifest


def main(argv):
    if len(argv) >= 4 and argv[1] == 'apply':
        alpine = apply_all(argv[2], argv[3])
        print(f'alpine-musl-patches: applied Alpine musl {alpine} patches')
    elif len(argv) >= 2 and argv[1] == 'refresh':
        branch = argv[2] if len(argv) > 2 else re.search(r'^ALPINE_BRANCH=(\S+)', (HERE / 'pins.env').read_text(), re.M).group(1)
        m = refresh(branch)
        print(f'alpine-musl-patches: vendored {len(m["patches"])} patches from Alpine musl {m["alpine"]} ({branch}, aports {m["aports_commit"][:12]}); commit app/runtime/alpine-musl-patches/')
    else:
        sys.exit(__doc__.split('\n\n')[0] + '\n\n' + '\n'.join(__doc__.split('\n')[2:4]))


if __name__ == '__main__':
    main(sys.argv)
