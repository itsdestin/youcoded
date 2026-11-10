#!/usr/bin/env python3
"""alpine-musl-patches.py <cache dir> <musl source dir> <alpine branch> <musl version> — apply Alpine's
own musl patches before ours.

WHY (2026-11-10, card #219): the phone's musl is compiled from the upstream musl-<version> download, while
every other bundled program is an Alpine package. Alpine ships musl with security patches on top of the same
upstream version (1.2.6-r3 carried three CVE fixes); building from the plain download silently left them out,
and the daily security watch could not see it because it compares package versions. This fetches the
APKBUILD of the pinned Alpine branch, downloads the patches it lists, verifies each against the APKBUILD's
sha512 line, and applies them in Alpine's order. It fails closed: a missing patch, a checksum mismatch, a
patch that does not apply, or an APKBUILD whose musl version differs from pins.env stops the build with a
message naming the fix (bump MUSL_VERSION after a phone test). Idempotent per extraction: build-runtime.sh
always extracts a fresh tree first.

Writes <musl source dir>/.alpine-patches.json (Alpine version, patch names and hashes) so the native cache
key changes when Alpine's patch set does, and prints the Alpine version it matched.
"""
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import urllib.request

APORTS = 'https://gitlab.alpinelinux.org/alpine/aports/-/raw/{branch}/main/musl/'


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


def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read()


def cached_patch(cache, name, sha, url):
    """The patch bytes, from cache when the hash matches, else downloaded and verified."""
    p = cache / f'{sha[:16]}-{name}'
    if p.is_file() and hashlib.sha512(p.read_bytes()).hexdigest() == sha:
        return p
    data = fetch(url)
    if hashlib.sha512(data).hexdigest() != sha:
        raise ValueError(f'alpine-musl-patches: {name} does not match the sha512 in Alpine\'s APKBUILD; refusing it')
    p.write_bytes(data)
    return p


def apply(src, patch_file):
    # WHY -p1 and --forward: abuild applies with -p1; --forward makes an already-applied patch a clear error
    # (exit 1 with "Reversed (or previously applied)") rather than a silent reversal.
    r = subprocess.run(['patch', '-p1', '--forward', '--no-backup-if-mismatch', '-i', str(patch_file)],
                       cwd=src, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f'alpine-musl-patches: {patch_file.name} did not apply cleanly:\n{r.stdout}{r.stderr}')


def main(argv):
    cache, src, alpine_branch, musl_version = pathlib.Path(argv[1]), pathlib.Path(argv[2]), argv[3], argv[4]
    base = APORTS.format(branch=aports_branch(alpine_branch))
    apkbuild = fetch(base + 'APKBUILD').decode()
    pkgver, pkgrel, patches, sums = parse_apkbuild(apkbuild)
    if pkgver != musl_version:
        sys.exit(f'alpine-musl-patches: Alpine {alpine_branch} builds musl {pkgver} but pins.env says MUSL_VERSION={musl_version}; '
                 f'bump MUSL_VERSION to {pkgver} after a phone test (its patches are written for that version)')
    cache.mkdir(parents=True, exist_ok=True)
    applied = []
    for name in patches:
        apply(src, cached_patch(cache, name, sums[name], base + name))
        applied.append({'name': name, 'sha512': sums[name]})
    (src / '.alpine-patches.json').write_text(json.dumps({'alpine': f'{pkgver}-r{pkgrel}', 'branch': alpine_branch, 'patches': applied}, indent=1) + '\n')
    print(f'alpine-musl-patches: musl {pkgver}-r{pkgrel} ({len(applied)} Alpine patches applied)')


if __name__ == '__main__':
    if len(sys.argv) != 5:
        sys.exit(__doc__.splitlines()[0])
    main(sys.argv)
