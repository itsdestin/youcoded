"""Collect exact aports recipes/distfiles; execute recipes only in a disposable container."""
import hashlib
import json
import os
import posixpath
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tomllib
import urllib.request
import zipfile

IMAGE = 'youcoded-source-collector:alpine3.24'
# certdata.txt carries Mozilla's original MPL notice in the certificate data itself;
# Alpine's CA source has no separate LICENSE file. Keep those original bytes too.
NOTICE = re.compile(r'^(?:(licen[cs]e|copying|copyright|notice|authors|patents)([.\-_].*)?|certdata\.txt)$', re.I)


def sha(path, algorithm='sha256'):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, algorithm).hexdigest()


def reference(root, path):
    return {'path': str(path.relative_to(root)), 'sha256': sha(path)}


def checksum_inputs(text):
    result = {}
    for line in text.strip().splitlines():
        match = re.fullmatch(r'([0-9a-f]{128})  ([^/\s]+)', line.strip())
        if not match or match[2] in result or match[2] in ('.', '..'):
            raise ValueError(f'Unsupported/duplicate source checksum: {line}')
        result[match[2]] = match[1]
    if not result:
        raise ValueError('Empty evaluated sha512sums; source coverage not established')
    return result


def recipe_members(archive, origin):
    # WHY: retain the complete recipe. Alpine legitimately aliases install hooks
    # with relative links (e.g. bash.post-upgrade -> bash.post-install). Materialize
    # only recipe-contained links as bytes; never create archive links on the host.
    members = {}
    with tarfile.open(archive) as tree:
        for member in tree:
            parts = Path(member.name).parts
            if len(parts) >= 4 and parts[1] in ('main', 'community', 'testing') and parts[2] == origin:
                relative = Path(*parts[3:])
                if relative.is_absolute() or '..' in relative.parts or not (member.isfile() or member.isdir() or member.issym()):
                    raise ValueError(f'Unsafe recipe archive member: {member.name}')
                if not member.isdir():
                    name = relative.as_posix()
                    if name in members:
                        raise ValueError(f'Ambiguous duplicate recipe member: {relative}')
                    members[name] = member
        def content(name, visiting):
            if name in visiting:
                raise ValueError(f'Recipe link cycle: {name}')
            member = members.get(name)
            if member is None:
                raise ValueError(f'Unsafe missing recipe link target: {name}')
            if member.isfile():
                return tree.extractfile(member).read()
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
            if posixpath.isabs(member.linkname) or target == '..' or target.startswith('../'):
                raise ValueError(f'Unsafe recipe link: {name} -> {member.linkname}')
            return content(target, visiting | {name})
        if 'APKBUILD' not in members:
            raise ValueError(f'Exact aports archive has no recipe for {origin}')
        return [(name, content(name, set())) for name in members]


def notices(root, origin_dir, inputs):
    output = []
    target = origin_dir / 'notices'
    def save(label, name, content):
        # Use an ordinal rather than upstream paths (which can contain traversal).
        path = target / f'{len(output):05d}-{Path(name).name}'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        output.append(dict(reference(root, path), source=label, member=name))
    for path in inputs:
        if NOTICE.match(path.name):
            save(path.name, path.name, path.read_bytes())
        if tarfile.is_tarfile(path):
            with tarfile.open(path) as tree:
                for member in tree:
                    if member.isfile() and NOTICE.match(Path(member.name).name):
                        save(path.name, member.name, tree.extractfile(member).read())
        elif zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as tree:
                for name in tree.namelist():
                    if not name.endswith('/') and NOTICE.match(Path(name).name):
                        save(path.name, name, tree.read(name))
    return output


def verify_tree(root):
    """Never follow a container-created symlink in subsequent host operations."""
    root = Path(root)
    for path in [root, *root.rglob('*')]:
        if path.is_symlink():
            raise ValueError(f'Container output contains symlink: {path}')
        if not path.is_file() and not path.is_dir():
            raise ValueError(f'Unsupported container output: {path}')


def locked_crates(inputs):
    locks = []
    for source in inputs:
        if not tarfile.is_tarfile(source):
            continue
        with tarfile.open(source) as tree:
            for member in tree:
                if member.isfile() and Path(member.name).name == 'Cargo.lock':
                    locks.append(tomllib.loads(tree.extractfile(member).read().decode()))
    if not locks:
        raise ValueError('ripgrep source has no Cargo.lock for embedded dependency notices')
    result = {}
    for lock in locks:
        for package in lock.get('package', []):
            origin = package.get('source')
            if not origin:  # workspace package: its source/notices are in the origin archive
                continue
            if origin != 'registry+https://github.com/rust-lang/crates.io-index':
                raise ValueError(f'Unsupported embedded crate source: {origin}')
            name, version, checksum = package['name'], package['version'], package.get('checksum', '')
            if not re.fullmatch(r'[A-Za-z0-9_-]+', name) or not re.fullmatch(r'[0-9A-Za-z.+_-]+', version) or not re.fullmatch(r'[0-9a-f]{64}', checksum):
                raise ValueError('Invalid locked crate identity/checksum')
            filename = f'{name}-{version}.crate'
            if filename in result and result[filename][2] != checksum:
                raise ValueError('Conflicting Cargo.lock crate checksums')
            result[filename] = name, version, checksum
    return result


def validate_cargo_archives(root, inputs, entries):
    required = locked_crates(inputs)
    actual = {Path(entry['path']).name: Path(root) / entry['path'] for entry in entries}
    if len(actual) != len(entries) or set(actual) != set(required):
        raise ValueError('Retained embedded crate set differs from Cargo.lock')
    for name, archive in actual.items():
        if archive.is_symlink() or not archive.resolve().is_relative_to(Path(root).resolve()) or sha(archive) != required[name][2]:
            raise ValueError(f'Embedded Cargo.lock checksum mismatch: {name}')


def upstream_crate_notice(root, output, archive):
    """Recover an offered MIT notice from the exact upstream commit, never invent it."""
    with tarfile.open(archive) as tree:
        manifests = [m for m in tree if m.isfile() and len(Path(m.name).parts) == 2 and Path(m.name).name == 'Cargo.toml']
        if len(manifests) != 1:
            raise ValueError(f'No unique crate manifest for missing notice: {archive.name}')
        member = manifests[0]
        metadata = tomllib.loads(tree.extractfile(member).read().decode())['package']
        vcs = json.load(tree.extractfile(str(Path(member.name).parent / '.cargo_vcs_info.json')))
    commit = vcs.get('git', {}).get('sha1', '')
    repository = re.fullmatch(r'https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?', metadata.get('repository', ''))
    if (not repository or any(part in ('.', '..') for part in repository.groups()) or
            not re.fullmatch(r'[0-9a-f]{40}', commit) or vcs.get('git', {}).get('dirty', False) or
            'MIT' not in re.split(r'\s+OR\s+', metadata.get('license', ''))):
        raise ValueError(f'Missing notice requires a verified exact-commit MIT source: {archive.name}')
    url = f'https://raw.githubusercontent.com/{repository[1]}/{repository[2]}/{commit}/LICENSE-MIT'
    with urllib.request.urlopen(url, timeout=60) as response:
        content = response.read()
    if b'Permission is hereby granted' not in content:
        raise ValueError(f'Upstream file is not the offered MIT notice: {url}')
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    destination = output / 'upstream-LICENSE-MIT'
    destination.write_bytes(content)
    return [dict(reference(root, destination), source=url, member='LICENSE-MIT',
                 upstream_commit=commit, license_choice='MIT')]


def cargo_notices(root, origin_dir, inputs):
    """Keep locked crate archives and their original notices; never run Cargo code."""
    archives = []
    for filename, (name, version, checksum) in locked_crates(inputs).items():
        target = origin_dir / 'crates' / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            temporary = target.with_suffix('.partial')
            urllib.request.urlretrieve(f'https://static.crates.io/crates/{name}/{name}-{version}.crate', temporary)
            temporary.replace(target)
        if target.is_symlink() or sha(target) != checksum:
            raise ValueError(f'Locked crate SHA256 mismatch: {name}@{version}')
        archives.append(target)
    embedded_notices = []
    for index, archive in enumerate(archives):
        found = notices(root, origin_dir / 'embedded' / str(index), [archive])
        if not found:
            # WASI-related packages in Cargo.lock can omit LICENSE files from
            # their .crate. Preserve their real upstream notice at the crate's
            # own recorded commit, with its explicitly offered MIT alternative.
            found = upstream_crate_notice(root, origin_dir / 'embedded' / str(index), archive)
        embedded_notices.extend(found)
    return [reference(root, archive) for archive in archives], embedded_notices


def collect(evidence, sources):
    evidence, sources = Path(evidence), Path(sources)
    inputs = json.loads((evidence / 'inputs.json').read_text())
    keys = sorted({(p['origin'], p['aports_commit']) for p in inputs['packages'] if p['extracted']})
    sources.mkdir(parents=True, exist_ok=True)
    verify_tree(sources)
    # No host shell eval, docker socket mount, privileges, or host source-tree mount.
    subprocess.run(['docker', 'build', '-t', IMAGE, '-'], input=(
        'FROM alpine:3.24\nRUN apk add --no-cache abuild build-base git curl\n'
        f'RUN addgroup -g {os.getgid()} collector && adduser -D -u {os.getuid()} -G collector collector\n'
        'ENV HOME=/tmp CARCH=aarch64 CHOST=aarch64-alpine-linux-musl\n').encode(), check=True)
    origins = []
    for origin, commit in keys:
        if origin in ('.', '..') or not re.fullmatch(r'[a-zA-Z0-9+_.-]+', origin) or not re.fullmatch(r'[0-9a-f]{40}', commit):
            raise ValueError('Invalid aports identity')
        archive = sources / 'aports' / f'{commit}.tar.gz'
        archive.parent.mkdir(exist_ok=True)
        url = f'https://github.com/alpinelinux/aports/archive/{commit}.tar.gz'
        if not archive.exists():
            temporary = archive.with_suffix('.partial')
            urllib.request.urlretrieve(url, temporary)
            temporary.replace(archive)
        work = sources / 'origins' / origin / commit
        recipe = work / 'recipe'
        recipe.mkdir(parents=True, exist_ok=True)
        for name, content in recipe_members(archive, origin):
            destination = recipe / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        (work / 'distfiles').mkdir(exist_ok=True)
        # Append a collector command only to a disposable recipe copy: abuild
        # fetch/verify and checksum capture then use the SAME evaluated variables.
        evaluation = work / 'evaluation'
        if evaluation.exists():
            shutil.rmtree(evaluation)
        shutil.copytree(recipe, evaluation)
        with (evaluation / 'APKBUILD').open('a') as stream:
            stream.write('\nyoucoded_collect() { printf "%s\\n" "$sha512sums" > /work/sha512sums.txt; }\n')
        # WHY: Alpine's official distfile mirror serves the exact checksummed
        # sources when an upstream forge refuses automated fetches (HTTP 418).
        # abuild still validates the unchanged recipe SHA512 and can fall back upstream.
        command = ('cd /work/evaluation && export SRCDEST=/work/distfiles '
                   'DISTFILES_MIRROR=https://distfiles.alpinelinux.org/distfiles/v3.24 && '
                   'abuild fetch verify youcoded_collect')
        subprocess.run(['docker', 'run', '--rm', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                        '--user', f'{os.getuid()}:{os.getgid()}', '-v', f'{work.resolve()}:/work',
                        IMAGE, 'sh', '-ec', command], check=True)
        shutil.rmtree(evaluation)  # abuild's working src/ symlinks are not retained source files.
        # WHY: upstream recipes ran in a writable mount. Validate all ancestry
        # before copying local distfiles or reading/writing notices on the host.
        verify_tree(work)
        sums = checksum_inputs((work / 'sha512sums.txt').read_text())
        retained = []
        for name, expected in sums.items():
            path = work / 'distfiles' / name
            if not path.exists() and (recipe / name).is_file():
                shutil.copyfile(recipe / name, path)
            if not path.is_file() or path.is_symlink() or sha(path, 'sha512') != expected:
                raise ValueError(f'Missing or changed abuild input: {origin}: {name}')
            retained.append(path)
        found = notices(sources, work, retained + [p for p in recipe.rglob('*') if p.is_file()])
        embedded = []
        if origin == 'ripgrep':
            embedded, crate_notices = cargo_notices(sources, work, retained)
            found.extend(crate_notices)
        origins.append({'origin': origin, 'commit': commit, 'aports_archive': reference(sources, archive),
                        'aports_url': url, 'recipe': reference(sources, recipe / 'APKBUILD'),
                        'recipe_files': [reference(sources, p) for p in sorted(recipe.rglob('*')) if p.is_file()],
                        'checksums': reference(sources, work / 'sha512sums.txt'),
                        'inputs': [reference(sources, p) for p in retained], 'notices': found,
                        'embedded_inputs': embedded})
    # WHY: objective missing inputs/checksums/notices fail above. MIT/Apache code
    # does not acquire a source-delivery obligation merely by accompanying GPL
    # subprocesses; provenance and legal judgments are not fake automated failures.
    residual = []
    manifest = {'schema': 2, 'evidence_sha256': sha(evidence / 'inputs.json'),
                'build_inputs_sha256': sha(evidence / 'non-apk-inputs.json'),
                'origins': origins, 'additional_notices': [], 'residual': residual,
                'review_notes': [
                    'Verify version-specific component notices, license choices and actual linked combinations.',
                    'Claude preinstallation is subject to its published Commercial Terms, unchanged binary/authentication and users own billing.',
                    'APK authentication and fully offline rebuilds are separate security/reproducibility checks, not blanket license requirements.',
                ]}
    (sources / 'coverage.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    return manifest
