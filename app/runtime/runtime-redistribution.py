"""Build-input evidence and a fail-closed Android redistribution gate (stdlib only).

Hashes bind evidence to a build; they do NOT authenticate Alpine signatures or
constitute a legal opinion. See docs/android-redistribution.md for remaining gates.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('resolve_apk', HERE / 'resolve-apk.py')
resolver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolver)
collector_spec = importlib.util.spec_from_file_location('collect_aports', HERE / 'collect-aports.py')
collector = importlib.util.module_from_spec(collector_spec)
collector_spec.loader.exec_module(collector)


def digest(path, algorithm='sha256'):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, algorithm).hexdigest()


def dump(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def metadata(text):
    result = {}
    for line in text.splitlines():
        if ' = ' in line and not line.startswith('#'):
            key, value = line.split(' = ', 1)
            result.setdefault(key, []).append(value)
    return result


def validate_metadata(data, index):
    fields = {'pkgname': 'P', 'pkgver': 'V', 'arch': 'A', 'origin': 'o', 'license': 'L', 'commit': 'c'}
    for field, key in fields.items():
        # WHY: an architecture-neutral APK can be indexed in the arm repository
        # with A:aarch64 while its original control metadata correctly says noarch.
        accepted = {index.get(key)} | ({'noarch'} if field == 'arch' else set())
        if len(data.get(field, [])) != 1 or not index.get(key) or data[field][0] not in accepted:
            raise ValueError(f'Missing or mismatched APK provenance {field}: {index.get("P")}')
    if not re.fullmatch('[0-9a-f]{40}', data['commit'][0]):
        raise ValueError('Missing exact aports commit')
    if index['A'] not in ('aarch64', 'noarch'):
        raise ValueError('Unexpected runtime architecture')


def install(cache, destination, evidence, branch, roots):
    cache, destination, evidence = map(Path, (cache, destination, evidence))
    # WHY: preserve the existing build's busybox-binsh metadata choice, which is
    # explicitly excluded below. Android supplies the actual shell; do not pick
    # dash/yash from repository order or start shipping another executable.
    resolution = resolver.resolve(cache, roots, provider_choices={'/bin/sh': 'busybox-binsh'})
    evidence.mkdir(parents=True, exist_ok=True)
    for repo in ('main', 'community'):
        shutil.copyfile(cache / f'{repo}.idx', evidence / f'{repo}.idx')
    records, owners = [], {}
    # Pin once per cache: later variants must reuse the same exact indexes and APK hashes.
    old_path = cache / f'{destination.name}-inputs.json'
    old = json.loads(old_path.read_text()) if old_path.exists() else None
    indexes = {repo: digest(cache / f'{repo}.idx') for repo in ('main', 'community')}
    if old and (old['indexes'] != indexes or old['roots'] != roots):
        raise ValueError('Cached input lock differs; use a fresh YOUCODED_RUNTIME_CACHE, do not overwrite release evidence')
    # WHY: reproducible builds. Alpine's index only lists the newest build of each package, so an
    # unlocked build silently drifts (Node went 24.18 -> 24.22 between two phone tests). When the
    # build points at the committed lock (alpine-lock.json), any version or file-hash difference stops
    # the build and names the fix: run app/runtime/update-pins.py, then test on a phone.
    lock_file = os.environ.get('YOUCODED_ALPINE_LOCK')
    locked = json.loads(Path(lock_file).read_text()) if lock_file else None
    if locked:
        if locked.get('branch') != branch:
            raise ValueError(f"alpine-lock.json is for {locked.get('branch')}, build uses {branch}; run update-pins.py")
        for index in resolution['packages']:
            entry = locked['packages'].get(index['P'])
            if not entry or entry['version'] != index['V']:
                raise ValueError(f"{index['P']} {index['V']} differs from alpine-lock.json "
                                 f"({entry['version'] if entry else 'not listed'}); run app/runtime/update-pins.py and test on a phone")
    destination.mkdir(parents=True, exist_ok=True)
    for index in resolution['packages']:
        name, version, repo = index['P'], index['V'], index['repo']
        url = f'https://dl-cdn.alpinelinux.org/alpine/{branch}/{repo}/aarch64/{name}-{version}.apk'
        apk = cache / 'apk' / f'{name}-{version}.apk'
        apk.parent.mkdir(parents=True, exist_ok=True)
        if not apk.exists():
            temporary = apk.with_suffix('.partial')
            urllib.request.urlretrieve(url, temporary)
            temporary.replace(apk)
        sha = digest(apk)
        if locked and locked['packages'][name]['sha256'] != sha:
            raise ValueError(f'{name} {version} file differs from alpine-lock.json (changed upstream?); run update-pins.py')
        if old:
            previous = next((p for p in old['packages'] if p['name'] == name), None)
            if not previous or previous['sha256'] != sha:
                raise ValueError(f'APK changed against input lock: {name}')
        # APK v2 consists of concatenated gzip/tar streams; GNU tar --ignore-zeros
        # reads the control stream before anything can overwrite .PKGINFO in the root.
        raw = subprocess.run(['tar', '--ignore-zeros', '-xzOf', str(apk), '.PKGINFO'], capture_output=True, check=True).stdout
        data = metadata(raw.decode())
        validate_metadata(data, index)
        metadata_path = f'pkginfo/{name}-{version}.PKGINFO'
        (evidence / 'pkginfo').mkdir(exist_ok=True)
        (evidence / metadata_path).write_bytes(raw)
        excluded = name in ('busybox', 'busybox-binsh', 'apk-tools') or name.startswith('alpine-baselayout')
        record = {'name': name, 'version': version, 'repository': repo, 'architecture': data['arch'][0], 'repository_architecture': index['A'],
                  'origin': index['o'], 'license': index['L'], 'aports_commit': index['c'],
                  'url': url, 'sha256': sha, 'index_checksum': index.get('C'),
                  'pkginfo': metadata_path, 'pkginfo_sha256': digest(evidence / metadata_path),
                  'extracted': not excluded}
        records.append(record)
        if excluded:
            continue
        with tempfile.TemporaryDirectory(dir=cache) as temporary:
            stage = Path(temporary)
            subprocess.run(['tar', '--ignore-zeros', '-xzf', str(apk), '-C', temporary], check=True, capture_output=True)
            for path in stage.rglob('*'):
                if path.is_file() or path.is_symlink():
                    relative = path.relative_to(stage).as_posix()
                    if relative.startswith('.'):
                        continue
                    owners[relative] = {'package': name, 'version': version,
                                        'symlink': str(path.readlink()) if path.is_symlink() else None,
                                        'sha256': None if path.is_symlink() else digest(path)}
            subprocess.run(['tar', '--ignore-zeros', '-xzf', str(apk), '-C', str(destination)], check=True, capture_output=True)
    lock = {'schema': 1, 'branch': branch, 'roots': roots, 'indexes': indexes,
            'packages': records, 'resolution': resolution['resolution'],
            'authentication': 'HTTPS download; APK signatures NOT yet verified'}
    dump(evidence / 'inputs.json', lock)
    dump(evidence / 'owners.json', owners)
    if not old:
        dump(old_path, lock)


def record(evidence, root, original, packaged):
    evidence, root, original, packaged = map(Path, (evidence, root, original, packaged))
    owners = json.loads((evidence / 'owners.json').read_text())
    originals = [p for p in sorted(original.rglob('*')) if p.is_file()] if original.is_dir() else [original]
    # A terminfo tree can contain thousands of files; hash its output tar only once.
    output_sha = digest(packaged)
    with (evidence / 'packaged-files.jsonl').open('a') as stream:
        for source in originals:
            relative = source.relative_to(root).as_posix()
            resolved = source.resolve().relative_to(root.resolve()).as_posix()
            if relative not in owners or resolved not in owners:
                raise ValueError(f'No original APK owner: {relative} -> {resolved}')
            value = {'input': relative, 'input_owner': owners[relative], 'content_owner': owners[resolved],
                     'input_sha256': digest(source), 'output': str(packaged), 'output_sha256': output_sha,
                     'modifications': ('Compiled/link input; see musl build and patch-musl.py'
                                       if source.suffix in ('.a', '.o') else
                                       'Interpreter/RUNPATH and/or DT_NEEDED adjusted; see build-runtime.sh'
                                       if packaged.suffix == '.so' else 'Copied data; possibly included in tar archive')}
            stream.write(json.dumps(value, sort_keys=True) + '\n')


def finalize(output, cache, musl_archive, claude_archive):
    output, cache, musl_archive, claude_archive = map(Path, (output, cache, musl_archive, claude_archive))
    evidence = output / 'evidence'
    locks = {name: json.loads((evidence / name / 'inputs.json').read_text()) for name in ('root', 'sysroot')}
    dump(evidence / 'inputs.json', {'schema': 1, 'scopes': locks,
                                   'packages': [dict(p, scope=name) for name, lock in locks.items() for p in lock['packages']]})
    local = evidence / 'youcoded-runtime'
    shutil.copytree(HERE, local, ignore=shutil.ignore_patterns('__pycache__'), dirs_exist_ok=True)
    repo = HERE.parent.parent
    for relative in ('build.gradle.kts', 'src/main/kotlin/com/youcoded/app/runtime/RuntimeInstaller.kt',
                     'src/main/kotlin/com/youcoded/app/runtime/BackendService.kt'):
        destination = local / 'app' / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(HERE.parent / relative, destination)
    for relative in ('LICENSE', 'NOTICE', 'TERMS.md', 'gradle.properties', 'build.gradle.kts', 'settings.gradle.kts',
                     'desktop/package-lock.json', 'desktop/package.json'):
        destination = local / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(repo / relative, destination)
    for relative in ('node-pty/src', 'node-pty/third_party', 'node-pty/node_modules/node-addon-api'):
        source = repo / 'desktop/node_modules' / relative
        if not source.is_dir():
            raise ValueError(f'Missing native npm source input: {source}')
        shutil.copytree(source, local / 'native-npm' / relative, dirs_exist_ok=True)
    # Keep the actual custom-musl input and full version-specific copyright.
    musl = cache / musl_archive.name.removesuffix('.tar.gz') / 'COPYRIGHT'
    shutil.copyfile(musl_archive, evidence / musl_archive.name)
    shutil.copyfile(musl, evidence / 'musl-COPYRIGHT')
    dump(evidence / 'non-apk-inputs.json', {'musl_archive': digest(evidence / musl_archive.name),
                                          'claude_archive': {'name': claude_archive.name, 'sha256': digest(claude_archive)},
                                          'local_sources': {str(p.relative_to(local)): digest(p) for p in local.rglob('*') if p.is_file()}})
    tools = {}
    for command in (['clang', '--version'], ['ld.lld', '--version'], ['python3', '--version']):
        tools[command[0]] = subprocess.run(command, check=True, capture_output=True, text=True).stdout
    dump(evidence / 'build-tools.json', tools)
    dump(evidence / 'outputs.json', {str(p.relative_to(output)): digest(p) for subtree in ('jniLibs', 'assets/runtime')
                                    for p in (output / subtree).rglob('*') if p.is_file()})
    legal = output / 'assets/legal'
    legal.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(evidence / 'inputs.json', legal / 'runtime-components.json')
    shutil.copyfile(repo / 'LICENSE', legal / 'YouCoded-LICENSE.txt')
    # WHY: LICENSE is now the bare MIT text (so GitHub detects MIT); the scope
    # and third-party note it used to carry lives in NOTICE and must still ship.
    shutil.copyfile(repo / 'NOTICE', legal / 'YouCoded-NOTICE.txt')
    shutil.copyfile(musl, legal / 'musl-COPYRIGHT.txt')
    # WHY: collect only after resolution and stamped build inputs exist; never
    # require an unpopulated, hand-authored pre-build dossier.
    sources = output / 'sources'
    if os.environ.get('YOUCODED_COLLECT_SOURCES') == '1':
        collector.collect(evidence, sources)
    ready = (sources / 'coverage.json').is_file()
    if ready:
        validate_sources(evidence, sources)
        # Original notices (including full embedded notices) remain byte-for-byte.
        manifest = json.loads((sources / 'coverage.json').read_text())
        notices = manifest['additional_notices'] + [entry for origin in manifest['origins'] for entry in origin['notices']]
        for entry in notices:
            destination = legal / 'licenses' / entry['path']
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(checked_file(sources, entry), destination)
    (legal / 'THIRD-PARTY-NOTICES.txt').write_text(
        'YouCoded-authored code is MIT; bundled components retain their own licenses.\n'
        'runtime-components.json records exact selected Alpine inputs (including build-only sysroot).\n'
        'Backend npm notices and inventory are in backend.tgz under legal/.\n'
        'Runtime changes: musl resolver patched; executable interpreter/RUNPATH and shim dependency adjusted.\n'
        + ('Exact aports recipe/source checks passed; collection is NOT complete corresponding source.\n'
           + '\n'.join(manifest['residual']) + '\n' if ready else
           'DEVELOPMENT BUILD: automated source collection not run; redistribution incomplete.\n'))
    version_match = re.search(r'versionName\s*=\s*"([^"]+)"', (repo / 'app/build.gradle.kts').read_text())
    if not version_match:
        raise ValueError('Cannot identify release-specific source asset name')
    (legal / 'SOURCE-CODE.txt').write_text(
        f'For a distributed release, obtain YouCoded-{version_match[1]}-android-corresponding-source.tar.xz\n'
        'beside the matching APK/AAB at https://github.com/itsdestin/youcoded/releases .\n'
        'A development build does not establish that sources have been published.\n'
        'Upstream URLs or GitHub automatic app-only archives are not the runtime source distribution.\n')


def validate_sources(evidence, sources):
    """Check exact archive recipes and every evaluated SHA512 input, not attestations."""
    evidence, sources = Path(evidence), Path(sources)
    manifest = json.loads((sources / 'coverage.json').read_text())
    if (manifest.get('evidence_sha256') != digest(evidence / 'inputs.json') or
            manifest.get('build_inputs_sha256') != digest(evidence / 'non-apk-inputs.json')):
        raise ValueError('Source dossier is for different binary inputs')
    inputs = json.loads((evidence / 'inputs.json').read_text())
    expected = {(p['origin'], p['aports_commit']) for p in inputs['packages'] if p['extracted']}
    if manifest.get('schema') != 2 or not isinstance(manifest.get('residual'), list):
        raise ValueError('Expected automated collection manifest with explicit residuals')
    actual = set()
    for origin in manifest.get('origins', []):
        key = (origin['origin'], origin['commit'])
        if key in actual:
            raise ValueError(f'Duplicate source origin: {key}')
        actual.add(key)
        if not origin.get('inputs') or not origin.get('notices') or not origin.get('recipe'):
            raise ValueError(f'Missing actual source inputs/recipe/notices: {key}')
        for entry in origin['inputs'] + origin['notices'] + origin.get('embedded_inputs', []) + [origin['recipe']]:
            checked_file(sources, entry)
        if not origin['recipe']['path'].endswith('/APKBUILD'):
            raise ValueError('Source recipe must be an exact APKBUILD')
        archive_path = checked_file(sources, origin['aports_archive'])
        expected_url = f'https://github.com/alpinelinux/aports/archive/{origin["commit"]}.tar.gz'
        if origin.get('aports_url') != expected_url:
            raise ValueError('Recipe archive is not bound to the selected aports commit')
        original_files = dict(collector.recipe_members(archive_path, origin['origin']))
        recipe_root = checked_file(sources, origin['recipe']).parent
        retained_files = {str(checked_file(sources, entry).relative_to(recipe_root)): checked_file(sources, entry).read_bytes()
                          for entry in origin['recipe_files']}
        if original_files != retained_files:
            raise ValueError(f'Recipe directory differs from exact aports archive: {key}')
        required = collector.checksum_inputs(checked_file(sources, origin['checksums']).read_text())
        supplied = {Path(entry['path']).name: checked_file(sources, entry) for entry in origin['inputs']}
        if set(required) != set(supplied):
            raise ValueError(f'Recipe source inputs differ (including patches): {key}')
        for name, sha in required.items():
            if digest(supplied[name], 'sha512') != sha:
                raise ValueError(f'Recipe source SHA512 mismatch: {key}: {name}')
        if origin['origin'] == 'ripgrep':
            collector.validate_cargo_archives(sources, list(supplied.values()), origin.get('embedded_inputs', []))
    if expected != actual:
        raise ValueError(f'Source origins differ: missing={sorted(expected - actual)}, extra={sorted(actual - expected)}')
    for entry in manifest['additional_notices']:
        checked_file(sources, entry)
    return manifest


def checked_file(root, entry):
    relative = Path(entry['path'])
    path = root / relative
    if relative.is_absolute() or '..' in relative.parts or path.is_symlink() or not path.is_file() or not path.stat().st_size:
        raise ValueError(f'Missing/unsafe retained source file: {relative}')
    if not path.resolve().is_relative_to(root.resolve()) or digest(path) != entry['sha256']:
        raise ValueError(f'Source checksum mismatch: {relative}')
    return path


def archive(evidence, sources, output):
    validate_sources(evidence, sources)
    # WHY: validate every file that will enter the archive, including files not
    # directly named in coverage.json. Do not accidentally ship private symlinks.
    for root in (Path(evidence), Path(sources)):
        if any(p.is_symlink() for p in root.rglob('*')):
            raise ValueError('Source archives may not contain symlinks')
    with tarfile.open(output, 'w:xz') as stream:
        stream.add(evidence, arcname='build-evidence')
        stream.add(sources, arcname='sources')
    return digest(output)


def bind_backend(sources, backend):
    """Bind generated coverage after the independent backend packaging task finishes."""
    sources, backend = Path(sources), Path(backend)
    manifest = json.loads((sources / 'coverage.json').read_text())
    with tarfile.open(backend, 'r:gz') as tree:
        inventory = tree.extractfile('./legal/npm-components.json').read()
    manifest['backend_inventory_sha256'] = hashlib.sha256(inventory).hexdigest()
    dump(sources / 'coverage.json', manifest)


def release(runtime, sources, output, binaries):
    runtime, sources, output = Path(runtime), Path(sources), Path(output)
    evidence = runtime / 'evidence'
    # Validate before opening any binary; a missing dossier is an explicit release blocker.
    manifest = validate_sources(evidence, sources)
    if manifest['residual']:
        raise ValueError('Redistribution incomplete: ' + '; '.join(manifest['residual']))
    expected = json.loads((evidence / 'outputs.json').read_text())
    for binary in binaries:
        with zipfile.ZipFile(binary) as package:
            prefix = 'base/' if str(binary).endswith('.aab') else ''
            notices = manifest['additional_notices'] + [entry for origin in manifest['origins'] for entry in origin['notices']]
            for entry in notices:
                member = prefix + 'assets/legal/licenses/' + entry['path']
                if package.read(member) != checked_file(sources, entry).read_bytes():
                    raise ValueError(f'Final package missing matching reviewed notice: {member}')
            for relative, sha in expected.items():
                member = prefix + relative.replace('jniLibs/', 'lib/', 1)
                if hashlib.sha256(package.read(member)).hexdigest() != sha:
                    raise ValueError(f'Packaged runtime differs from evidence: {binary}: {member}')
            for path in (runtime / 'assets/legal').rglob('*'):
                if path.is_file():
                    member = prefix + 'assets/legal/' + str(path.relative_to(runtime / 'assets/legal'))
                    if package.read(member) != path.read_bytes():
                        raise ValueError(f'Packaged legal assets differ: {member}')
            backend = package.read(prefix + 'assets/backend.tgz')
            with tempfile.TemporaryFile() as stream:
                stream.write(backend)
                stream.seek(0)
                with tarfile.open(fileobj=stream, mode='r:gz') as tree:
                    names = tree.getnames()
                    if './legal/npm-components.json' not in names or not any('/legal/npm-notices/' in n for n in names):
                        raise ValueError('APK backend missing preserved npm notices/inventory')
                    inventory_bytes = tree.extractfile('./legal/npm-components.json').read()
                    if manifest.get('backend_inventory_sha256') != hashlib.sha256(inventory_bytes).hexdigest():
                        raise ValueError('Source dossier is for a different backend npm tree')
                    inventory = json.loads(inventory_bytes)
                    for component in inventory['components']:
                        if not component.get('retained_after_platform_trim'):
                            continue
                        member = f'./node_modules/{component["path"]}/package.json'
                        installed = json.load(tree.extractfile(member))
                        if (installed['name'], installed['version']) != (component['name'], component['version']):
                            raise ValueError(f'Backend npm inventory mismatch: {member}')
                    for entry in inventory['preserved_files']:
                        relative = Path(entry['path'])
                        if relative.is_absolute() or '..' in relative.parts:
                            raise ValueError('Unsafe backend notice path')
                        content = tree.extractfile('./legal/npm-notices/' + entry['path']).read()
                        if hashlib.sha256(content).hexdigest() != entry['sha256']:
                            raise ValueError(f'Backend legal file changed: {relative}')
                        destination = evidence / 'backend-legal/npm-notices' / relative
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        destination.write_bytes(content)
                    dump(evidence / 'backend-legal/npm-components.json', inventory)
    dump(evidence / 'release-binaries.json', {Path(p).name: digest(p) for p in binaries})
    output.parent.mkdir(parents=True, exist_ok=True)
    archive(evidence, sources, output)
    output.with_suffix(output.suffix + '.sha256').write_text(f'{digest(output)}  {output.name}\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    install_parser = commands.add_parser('install')
    for name in ('cache', 'destination', 'evidence', 'branch'):
        install_parser.add_argument(name)
    install_parser.add_argument('roots', nargs='+')
    record_parser = commands.add_parser('record')
    for name in ('evidence', 'root', 'original', 'packaged'):
        record_parser.add_argument(name)
    collect_parser = commands.add_parser('collect')
    for name in ('evidence', 'sources'):
        collect_parser.add_argument(name)
    archive_parser = commands.add_parser('archive')
    for name in ('evidence', 'sources', 'output'):
        archive_parser.add_argument(name)
    finalize_parser = commands.add_parser('finalize')
    for name in ('output', 'cache', 'musl_archive', 'claude_archive'):
        finalize_parser.add_argument(name)
    bind_parser = commands.add_parser('bind_backend')
    for name in ('sources', 'backend'):
        bind_parser.add_argument(name)
    release_parser = commands.add_parser('release')
    for name in ('runtime', 'sources', 'output'):
        release_parser.add_argument(name)
    release_parser.add_argument('binaries', nargs='+')
    args = vars(parser.parse_args())
    command = args.pop('command')
    try:
        result = collector.collect(**args) if command == 'collect' else globals()[command](**args)
        if result:
            print(result)
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Redistribution gate: {error}\n')


if __name__ == '__main__':
    main()
