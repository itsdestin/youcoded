"""Resolve the cached indexes without silently discarding requirements.

This is deliberately not an APK solver: ambiguous providers/conflicts fail closed.
For Alpine's version ordering use apk itself, not Python/semver approximations.
"""
import functools
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys


def requirement(value):
    match = re.fullmatch(r'([^<>=~!]+)([<>=~]+)?(.*)', value)
    if not match or (match[2] and not match[3]):
        raise ValueError(f'Unsupported dependency: {value}')
    return match.groups()


@functools.lru_cache(None)
def compare(left, right):
    if left == right:
        return '='
    command = shlex.split(os.environ.get('YOUCODED_APK_VERSION', 'apk version -t'))
    try:
        result = subprocess.run(command + [left, right], check=True, capture_output=True, text=True)
    except (OSError, subprocess.CalledProcessError) as error:
        raise ValueError('Versioned dependency requires apk version -t; set YOUCODED_APK_VERSION to an equivalent command') from error
    if result.stdout.strip() not in ('<', '=', '>'):
        raise ValueError(f'Invalid apk version verdict: {result.stdout!r}')
    return result.stdout.strip()


def satisfies(version, operator, wanted):
    if not operator:
        return True
    if operator == '=':
        return version == wanted
    if operator not in ('<', '>', '<=', '>='):
        raise ValueError(f'Unsupported version operator: {operator}')
    return compare(version, wanted) in operator


def resolve(directory, roots, provider_choices=None):
    provider_choices = provider_choices or {}
    packages = {}
    providers = {}
    duplicated = set()
    for repo in ('main', 'community'):
        for block in (Path(directory) / f'{repo}.idx').read_text().split('\n\n'):
            data = dict(line.split(':', 1) for line in block.splitlines() if len(line) > 2 and line[1] == ':')
            if 'P' not in data:
                continue
            data['repo'] = repo
            name = data['P']
            if name in packages:
                # WHY: unrelated packages can occur in both repository snapshots.
                # Reject ambiguous inputs only if this build actually selects them.
                duplicated.add(name)
            packages[name] = data
            for provided in data.get('p', '').split():
                virtual, op, version = requirement(provided)
                if op not in (None, '='):
                    raise ValueError(f'Unsupported provider: {provided}')
                providers.setdefault(virtual, []).append((name, version))
    selected = {}
    edges = []
    pending = [(None, root) for root in roots]
    conflicts = []
    while pending:
        parent, value = pending.pop(0)
        if value.startswith('!'):
            conflicts.append(value[1:])
            continue
        name, operator, version = requirement(value)
        candidates = [(name, packages[name]['V'])] if name in packages else providers.get(name, [])
        candidates = [(pkg, ver) for pkg, ver in candidates if (not operator or ver) and satisfies(ver, operator, version)]
        if name in provider_choices:
            candidates = [(pkg, ver) for pkg, ver in candidates if pkg == provider_choices[name]]
        if len(candidates) > 1:
            # WHY: APKINDEX declares provider_priority as k (busybox-binsh and
            # icu-data-en have higher priority than their alternatives). Honor it
            # instead of treating an explicit repository default as ambiguous.
            priority = max(int(packages[pkg].get('k', '0')) for pkg, _ in candidates)
            candidates = [(pkg, ver) for pkg, ver in candidates if int(packages[pkg].get('k', '0')) == priority]
        if len(candidates) > 1 and all(ver for _, ver in candidates):
            # Versioned virtual providers can coexist (e.g. libisl sonames). Use
            # Alpine's own comparator after priority, not index order or semver.
            newest = candidates[0][1]
            for _, offered in candidates[1:]:
                if compare(offered, newest) == '>':
                    newest = offered
            candidates = [(pkg, ver) for pkg, ver in candidates if compare(ver, newest) == '=']
        # WHY: equally preferred providers still require an explicit build choice.
        if len(candidates) != 1:
            raise ValueError(f'Unresolved or ambiguous dependency {value!r} from {parent!r}: {candidates}')
        actual = candidates[0][0]
        if actual in duplicated:
            raise ValueError(f'Duplicate selected package across indexes: {actual}')
        edges.append({'from': parent, 'requirement': value, 'package': actual})
        if actual not in selected:
            selected[actual] = packages[actual]
            pending.extend((actual, dep) for dep in packages[actual].get('D', '').split())
    for value in conflicts:
        name, operator, version = requirement(value)
        for actual in selected:
            candidates = [(actual, selected[actual]['V'])] if name == actual else [p for p in providers.get(name, []) if p[0] == actual]
            if any(satisfies(ver, operator, version) for _, ver in candidates):
                raise ValueError(f'Conflicting requirement !{value}: {actual}')
    return {'packages': list(selected.values()), 'resolution': edges, 'roots': roots}


if __name__ == '__main__':
    try:
        args = sys.argv[1:]
        as_json = args and args[0] == '--json'
        result = resolve('.', args[1:] if as_json else args)
        if as_json:
            print(json.dumps(result, indent=2))
        else:
            for data in result['packages']:
                print(data['repo'], data['P'], data['V'], data.get('S', ''))
    except ValueError as error:
        sys.exit(f'APK resolution failed: {error}')
