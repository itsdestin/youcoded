#!/usr/bin/env python3
"""Isolated Android speed experiments: full tests, payload proofs and measured spans."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile

MODES = ('baseline', 'common-native', 'packaging-graph', 'combined', 'combined-4g')
VARIANTS = ('Debug', 'Release', 'ReleaseTest')
APK_IDS = {'debug': 'com.youcoded.app.dev', 'releaseTest': 'com.youcoded.app.releasetest'}


def options(mode):
    if mode not in MODES:
        raise ValueError(f'Unsupported experiment mode: {mode}')
    return {'graph': mode in ('packaging-graph', 'combined', 'combined-4g'),
            'native': mode in ('common-native', 'combined', 'combined-4g'),
            'heapMb': 4096 if mode == 'combined-4g' else 2048}


def tasks(text):
    return set(re.findall(r'^(?:> Task )?:app:([A-Za-z0-9_]+)\b', text, re.MULTILINE))


def assert_graph(mode, text, phase):
    actual = tasks(text)
    common = {'bundleWebUi', 'buildBackend'}
    if phase == 'unit':
        required = {f'test{variant}UnitTest' for variant in VARIANTS}
        payload = common | {f'buildRuntime{variant}' for variant in VARIANTS}
        if not required <= actual:
            raise ValueError(f'Unit graph omits JVM variants: {sorted(required - actual)}')
        if options(mode)['graph'] and payload & actual:
            raise ValueError(f'Packaging graph still builds unit-only payloads: {sorted(payload & actual)}')
        if not options(mode)['graph'] and not payload <= actual:
            raise ValueError('Baseline unit graph no longer contains its original payload work')
    elif phase in ('assembly', 'release', 'debug', 'releaseTest'):
        variants = {'assembly': ('Debug', 'ReleaseTest'), 'release': ('Release',),
                    'debug': ('Debug',), 'releaseTest': ('ReleaseTest',)}[phase]
        required = common | {f'assemble{variant}' for variant in variants} | {f'buildRuntime{variant}' for variant in variants}
        if not required <= actual:
            raise ValueError(f'Assembly graph lacks payload producers: {sorted(required - actual)}')
        if options(mode)['graph']:
            unrelated = {f'buildRuntime{v}' for v in VARIANTS if v not in variants}
            if unrelated & actual:
                raise ValueError(f'Assembly graph builds unrelated native variants: {sorted(unrelated & actual)}')
    else:
        raise ValueError(f'Unknown graph phase: {phase}')


def stream_hash(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(chunk)
    return digest.hexdigest()


def safe_name(name):
    path = PurePosixPath(name)
    if not isinstance(name, str) or '\0' in name or path.is_absolute() or '..' in path.parts:
        raise ValueError(f'Unsafe archive path: {name!r}')
    return '' if str(path) == '.' else str(path)


def tar_manifest(stream, prefix):
    result = {}
    with tarfile.open(fileobj=stream, mode='r|gz') as archive:
        for member in archive:
            name = safe_name(member.name)
            if not name:
                continue
            key = prefix + '::' + name
            if key in result:
                raise ValueError(f'Duplicate backend/archive entry: {key}')
            record = {'mode': member.mode & 0o7777}
            if member.isfile():
                content = archive.extractfile(member)
                record.update(type='file', sha256=stream_hash(content), size=member.size)
            elif member.issym() or member.islnk():
                record.update(type='symlink' if member.issym() else 'hardlink', target=member.linkname)
            elif member.isdir():
                record.update(type='directory')
            else:
                raise ValueError(f'Unsupported packaged backend entry: {key}')
            result[key] = record
    return result


def apk_manifest(path):
    result, seen = {}, set()
    nested = {'assets/backend.tgz', 'assets/runtime/share.tgz', 'assets/runtime/etc-terminfo.tgz'}
    # WHY: cryptographic JAR receipts cover archive bytes, including benign TAR
    # timestamps. The collector independently verifies APK signatures first.
    signing = re.compile(r'^META-INF/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC))$', re.IGNORECASE)
    with zipfile.ZipFile(path) as archive:
        for member in archive.infolist():
            name = safe_name(member.filename)
            if not name or name in seen:
                raise ValueError(f'Empty/duplicate APK entry: {name}')
            seen.add(name)
            if member.is_dir() or signing.fullmatch(name):
                continue
            with archive.open(member) as content:
                if name in nested:
                    result.update(tar_manifest(content, name))
                else:
                    result[name] = {'type': 'file', 'sha256': stream_hash(content), 'size': member.file_size,
                                    'mode': (member.external_attr >> 16) & 0o7777}
    return result


def junit_manifest(root):
    result = {}
    for variant in VARIANTS:
        files = sorted((Path(root) / f'test{variant}UnitTest').glob('TEST-*.xml'))
        if not files:
            raise ValueError(f'Missing JVM test reports for {variant}')
        count = 0
        for file in files:
            suite = ET.parse(file).getroot()
            cases = list(suite.iter('testcase'))
            if suite.tag != 'testsuite' or int(suite.get('tests', '-1')) != len(cases):
                raise ValueError(f'Untrustworthy JUnit counts: {file.name}')
            if any(int(suite.get(field, '0')) != 0 for field in ('failures', 'errors', 'skipped')):
                raise ValueError(f'Failed/skipped JVM tests: {variant}/{file.name}')
            for case in cases:
                key = f'{variant}:{case.get("classname")}:{case.get("name")}'
                if key in result or case.find('failure') is not None or case.find('error') is not None:
                    raise ValueError(f'Duplicate/failed JVM case: {key}')
                if not case.get('classname') or not case.get('name') or case.find('skipped') is not None:
                    raise ValueError(f'Unnamed/skipped JVM case: {key}')
                result[key] = 'passed'
                count += 1
        if count == 0:
            raise ValueError(f'No executed/discovered JVM cases: {variant}')
    return result


def native_counts(mode, text):
    config = options(mode)
    compiled = len(re.findall(r'^\[build-runtime\] musl compilation$', text, re.MULTILINE))
    hits = len(re.findall(r'^\[build-runtime\] musl verified run-local cache hit$', text, re.MULTILINE))
    variants = 2 if config['graph'] else 3
    expected = (1, variants - 1) if config['native'] else (variants, 0)
    if (compiled, hits) != expected:
        raise ValueError(f'{mode} did not perform the declared native work: compiles={compiled}, hits={hits}, expected={expected}')
    return {'compilations': compiled, 'hits': hits}


COMMON_INPUTS = {'commit', 'source', 'kotlin', 'lock', 'java', 'node', 'build', 'pins', 'gradle'}
NATIVE_INPUTS = {'clang', 'linker'}
FRAGMENTS = ('unit', 'debug', 'releaseTest')


def validate_inputs(inputs, required):
    if not isinstance(inputs, dict) or set(inputs) != required or any(not isinstance(v, str) or not v.strip() for v in inputs.values()):
        raise ValueError('Missing/malformed source, package-input or tool provenance')


def validate_tests(tests):
    if not isinstance(tests, dict) or not tests:
        raise ValueError('Empty JVM test manifest')
    variants = set()
    for key, status in tests.items():
        parts = key.split(':') if isinstance(key, str) else []
        if len(parts) < 3 or not all(parts) or status != 'passed':
            raise ValueError('Malformed, failed, skipped or unknown JVM test status')
        variants.add(parts[0])
    if variants != set(VARIANTS):
        raise ValueError('JVM manifest does not cover every original variant')


def validate_payload(manifest):
    if not isinstance(manifest, dict) or not manifest:
        raise ValueError('Empty/malformed APK payload manifest')
    for name, record in manifest.items():
        if not isinstance(name, str) or not name or not isinstance(record, dict):
            raise ValueError('Malformed APK payload entry')
        for part in name.split('::'):
            if safe_name(part) != part or not part:
                raise ValueError('Unsafe/noncanonical APK payload entry')
        kind = record.get('type')
        fields = {'type', 'mode'}
        if kind == 'file':
            fields |= {'sha256', 'size'}
            if not isinstance(record.get('sha256'), str) or not re.fullmatch(r'[0-9a-f]{64}', record['sha256']) or type(record.get('size')) is not int or record['size'] < 0:
                raise ValueError('Malformed APK file hash/size')
        elif kind in ('symlink', 'hardlink'):
            fields.add('target')
            if not isinstance(record.get('target'), str) or not record['target'] or '\0' in record['target']:
                raise ValueError('Malformed APK link')
        elif kind != 'directory':
            raise ValueError('Unknown APK payload entry type')
        if set(record) != fields or type(record.get('mode')) is not int or not 0 <= record['mode'] <= 0o7777:
            raise ValueError('Malformed APK payload mode/fields')
    required_payload(manifest)


def validate_apks(report, variants):
    for field in ('payloads', 'signatures'):
        if not isinstance(report.get(field), dict) or set(report[field]) != set(variants):
            raise ValueError(f'Wrong APK variant coverage: {field}')
    for variant in variants:
        validate_payload(report['payloads'][variant])
        if not isinstance(report['signatures'][variant], str) or not report['signatures'][variant].strip():
            raise ValueError('Missing verified APK signature evidence')


def combine_fragments(records):
    # WHY: independently successful jobs are not a successful experiment unless
    # their exact union proves the original JVM and both APK contracts.
    by_role = {}
    for record in records:
        if not isinstance(record, dict):
            raise ValueError('Malformed fragment')
        required = {'fragment', 'status', 'options', 'inputs', 'totalSeconds', 'spans', 'tests',
                    'payloads', 'signatures', 'apkBytes', 'native'}
        optional = {'machine', 'harnessStartedEpoch', 'harnessFinishedEpoch'}
        if not required <= set(record) or set(record) - required - optional or record.get('options') != options('combined-4g'):
            raise ValueError('Fragment schema/options do not describe the combined-4g hypothesis')
        role = record.get('fragment')
        if role not in FRAGMENTS or role in by_role or record.get('status') != 'success' or 'mode' in record:
            raise ValueError('Missing, duplicate, extra or failed fragment')
        native = set() if role == 'unit' else NATIVE_INPUTS | {f'{role}-runtime-inputs'}
        validate_inputs(record.get('inputs'), COMMON_INPUTS | native)
        duration = record.get('totalSeconds')
        spans = record.get('spans')
        if type(duration) not in (int, float) or not math.isfinite(duration) or duration <= 0 or not isinstance(spans, list) or not spans:
            raise ValueError('Missing/invalid fragment harness spans')
        for span in spans:
            if not isinstance(span, dict) or not isinstance(span.get('stage'), str) or not span['stage'] or span.get('exitCode') != 0 or type(span.get('seconds')) not in (int, float) or not math.isfinite(span['seconds']) or not 0 <= span['seconds'] <= duration:
                raise ValueError('Failed/malformed fragment span')
        validate_apks(record, () if role == 'unit' else (role,))
        if role == 'unit':
            validate_tests(record.get('tests'))
            if record.get('apkBytes') != {}:
                raise ValueError('Unit fragment contains APK work')
        else:
            if record.get('tests') != {} or not isinstance(record.get('apkBytes'), dict) or set(record['apkBytes']) != {role} or type(record['apkBytes'][role]) is not int or record['apkBytes'][role] <= 0:
                raise ValueError('APK fragment has unexpected tests or missing APK size')
        if record.get('native') != {'compilations': 0 if role == 'unit' else 1, 'hits': 0}:
            raise ValueError('Fanout native work does not match isolated runners')
        by_role[role] = record
    if set(by_role) != set(FRAGMENTS):
        raise ValueError('Exactly unit, debug and releaseTest fragments required')
    common = {k: by_role['unit']['inputs'][k] for k in COMMON_INPUTS}
    inputs = dict(common)
    for role in APK_IDS:
        record = by_role[role]
        if {k: record['inputs'][k] for k in COMMON_INPUTS} != common:
            raise ValueError('Fanout source/JDK/lock provenance differs between runners')
        for key in NATIVE_INPUTS | {f'{role}-runtime-inputs'}:
            value = record['inputs'][key]
            if key in inputs and inputs[key] != value:
                raise ValueError('Fanout native toolchains differ')
            inputs[key] = value
    combined = {'mode': 'fanout', 'status': 'success', 'options': options('combined-4g'), 'inputs': inputs,
                'tests': by_role['unit']['tests'], 'native': {'compilations': 2, 'hits': 0},
                'fragments': by_role, 'totalSeconds': max(r['totalSeconds'] for r in records),
                'timingBasis': 'maximum independent harness span; NOT total CI latency',
                'externalTimings': {'setup': None, 'queue': None, 'upload': None, 'finalValidation': None}}
    for field in ('payloads', 'signatures', 'apkBytes'):
        combined[field] = {role: by_role[role][field][role] for role in APK_IDS}
    return combined


def compare_reports(reports, expected=None):
    expected = set(MODES) | {'fanout'} if expected is None else set(expected)
    by_mode = {}
    for report in reports:
        if not isinstance(report, dict):
            raise ValueError('Malformed experiment report')
        mode = report.get('mode')
        if mode not in expected or mode in by_mode or report.get('status') != 'success':
            raise ValueError('Missing, duplicate, unexpected or failed experiment report')
        by_mode[mode] = report
    if set(by_mode) != expected or 'baseline' not in by_mode:
        raise ValueError('Not all experiment reports, including baseline, are present')
    baseline = by_mode['baseline']
    for mode, report in by_mode.items():
        validate_inputs(report.get('inputs'), COMMON_INPUTS | NATIVE_INPUTS | {f'{v}-runtime-inputs' for v in APK_IDS})
        validate_tests(report.get('tests'))
        validate_apks(report, APK_IDS)
        for field in ('inputs', 'tests', 'payloads'):
            if not report.get(field) or report[field] != baseline.get(field):
                raise ValueError(f'{mode} differs from baseline in {field}; no comparable speed claim')
        if set(report['payloads']) != set(APK_IDS):
            raise ValueError(f'{mode} does not contain both APK variants')
    return by_mode


def output(command, cwd, env=None):
    return subprocess.run(command, cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout.strip()


def timed(command, label, root, folder, env, spans):
    start = time.monotonic()
    log = folder / f'{label}.log'
    with log.open('w', encoding='utf-8') as stream:
        process = subprocess.Popen(command, cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in process.stdout:
            stream.write(line)
            print(line, end='', flush=True)
        code = process.wait()
    spans.append({'stage': label, 'seconds': round(time.monotonic() - start, 3), 'exitCode': code})
    if code:
        raise ValueError(f'{label} failed with exit {code}')
    return log.read_text(encoding='utf-8')


def required_payload(manifest):
    required = {'lib/arm64-v8a/libldmusl.so', 'lib/arm64-v8a/libclaude.so', 'lib/arm64-v8a/libptynode.so',
                'lib/arm64-v8a/libycshim.so', 'lib/arm64-v8a/libclaudelaunch.so', 'assets/web/index.html',
                'assets/backend.tgz::dist/main/headless/headless-main.js', 'assets/backend.tgz::legal/npm-components.json',
                'assets/legal/runtime-components.json', 'assets/legal/musl-COPYRIGHT.txt', 'assets/legal/THIRD-PARTY-NOTICES.txt',
                'assets/runtime/app-id.txt', 'lib/arm64-v8a/libnode.so', 'lib/arm64-v8a/libbash.so',
                'lib/arm64-v8a/libgit.so', 'lib/arm64-v8a/libgit_remote_https.so', 'lib/arm64-v8a/librg.so',
                'lib/arm64-v8a/libycopen.so', 'assets/runtime/binmap.txt', 'assets/runtime/libmap.txt',
                'assets/runtime/ca-certificates.crt', 'assets/runtime/claude-code-version.txt'}
    if not required <= set(manifest) or any(manifest[n].get('type') != 'file' or manifest[n].get('size', 0) <= 0 for n in required):
        raise ValueError(f'APK lacks required nonempty runtime/legal payload: {sorted(required - set(manifest))}')
    # WHY: equality of two incomplete APKs is not proof of a usable runtime.
    # The pinned Alpine payload puts real terminfo files in /etc/terminfo;
    # /usr/share/git-core/templates is intentionally an empty directory. This
    # layout was verified in the unchanged control APK, not inferred from a name.
    template = manifest.get('assets/runtime/share.tgz::git-core/templates')
    if not template or template.get('type') != 'directory':
        raise ValueError('Packaged git template directory is absent')
    for prefix in ('assets/backend.tgz::legal/npm-notices/', 'assets/runtime/etc-terminfo.tgz::terminfo/'):
        if not any(name.startswith(prefix) and record.get('type') == 'file' and record.get('size', 0) > 0
                   for name, record in manifest.items()):
            raise ValueError(f'Required packaged notices/runtime data absent: {prefix}')


def payload_required(manifest, variant, apk):
    validate_payload(manifest)
    with zipfile.ZipFile(apk) as archive:
        if archive.read('assets/runtime/app-id.txt').decode().strip() != APK_IDS[variant]:
            raise ValueError('Wrong application-ID-specific runtime')


def signer():
    home = os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT')
    if not home:
        raise ValueError('Android SDK not provided')
    tools = sorted((Path(home) / 'build-tools').glob('*/apksigner'), key=lambda p: tuple(int(n) for n in re.findall(r'\d+', p.parent.name)))
    if not tools:
        raise ValueError('No APK signature verifier available')
    return tools[-1]


def gradle_args(mode):
    config = options(mode)
    args = ['./gradlew', '--console=plain', '--profile']
    if config['graph']:
        args.append('-PciPackagingDependencies=true')
    if config['heapMb'] == 4096:
        args.append('-Dorg.gradle.jvmargs=-Xmx4096m -Dfile.encoding=UTF-8')
    return args


def collect_inputs(root, native=True):
    # WHY: JVM-only jobs must not probe clang, the sysroot or runtime evidence.
    refs = {'commit': 'HEAD', 'source': 'HEAD:desktop/src', 'kotlin': 'HEAD:app/src',
            'lock': 'HEAD:desktop/package-lock.json', 'build': 'HEAD:app/runtime',
            'pins': 'HEAD:app/runtime/pins.env', 'gradle': 'HEAD:gradle'}
    inputs = {key: output(['git', 'rev-parse', ref], root) for key, ref in refs.items()}
    # Include build wiring as well as the runtime tree in the common fingerprint.
    inputs['build'] += '\n' + output(['git', 'rev-parse', 'HEAD:app/build.gradle.kts', 'HEAD:build.gradle.kts', 'HEAD:settings.gradle.kts'], root)
    inputs['java'] = output(['java', '--version'], root)
    inputs['node'] = output(['node', '--version'], root)
    if native:
        inputs['clang'] = output(['clang', '--version'], root)
        inputs['linker'] = output(['ld.lld', '--version'], root)
    return inputs


def collect_apk(report, variant, root, folder, env):
    apks = list((root / f'app/build/outputs/apk/{variant}').glob('*.apk'))
    if len(apks) != 1:
        raise ValueError(f'Expected exactly one {variant} APK')
    apk = apks[0]
    verifier = signer()
    verification = timed([str(verifier), 'verify', '--verbose', '--print-certs', str(apk)], f'verify-{variant}', root, folder, env, report['spans'])
    # WHY: the runtime's app-id.txt alone cannot prove Android's installed ID.
    badging = timed([str(verifier.with_name('aapt')), 'dump', 'badging', str(apk)], f'identity-{variant}', root, folder, env, report['spans'])
    identity = re.search(r"^package: name='([^']+)'", badging, re.MULTILINE)
    if identity is None or identity.group(1) != APK_IDS[variant]:
        raise ValueError(f'Wrong Android application ID for {variant}')
    manifest = apk_manifest(apk)
    payload_required(manifest, variant, apk)
    report['signatures'][variant] = verification
    report['payloads'][variant] = manifest
    report['apkBytes'][variant] = apk.stat().st_size
    with (root / f'app/build/runtime/{variant}/evidence/inputs.json').open('rb') as stream:
        report['inputs'][f'{variant}-runtime-inputs'] = stream_hash(stream)


def assert_clean_sources(root):
    output(['git', 'diff', 'HEAD', '--exit-code', '--', 'desktop/src', 'desktop/package-lock.json',
            'app/src', 'app/runtime', 'app/build.gradle.kts', 'build.gradle.kts', 'settings.gradle.kts', 'gradle'], root)


def retain_profiles(root, folder):
    # WHY: invocation totals hide the slow tasks. Retain Gradle's actual task
    # profiles in the same short-lived evidence artifact, including failures.
    source = Path(root) / 'build/reports/profile'
    if source.is_dir():
        shutil.copytree(source, Path(folder) / 'gradle-profiles', dirs_exist_ok=True)


def machine():
    return {'platform': platform.platform(), 'cpus': os.cpu_count(),
            'cpuInfo': Path('/proc/cpuinfo').read_text()[:4096], 'memInfo': Path('/proc/meminfo').read_text()[:2048]}


def run_fragment(role, folder):
    if role not in FRAGMENTS:
        raise ValueError('Unknown fragment role')
    root = Path(__file__).resolve().parent.parent
    folder = Path(folder).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    report = {'fragment': role, 'status': 'failed', 'options': options('combined-4g'), 'spans': [],
              'tests': {}, 'payloads': {}, 'signatures': {}, 'apkBytes': {}, 'native': {'compilations': 0, 'hits': 0}}
    start = time.monotonic()
    report['harnessStartedEpoch'] = time.time()
    env = {**os.environ, 'YOUCODED_COLLECT_SOURCES': '0'}
    env.pop('YOUCODED_COMMON_NATIVE_CACHE', None)
    native = None
    try:
        assert_clean_sources(root)
        if role != 'unit':
            native = tempfile.TemporaryDirectory(prefix=f'android-native-{role}-', dir=os.environ.get('RUNNER_TEMP'))
            env['YOUCODED_COMMON_NATIVE_CACHE'] = native.name
        args = gradle_args('combined-4g')
        selected = ['test'] if role == 'unit' else ['assembleDebug' if role == 'debug' else 'assembleReleaseTest']
        text = timed([*args, *selected, '--dry-run'], f'graph-{role}', root, folder, env, report['spans'])
        assert_graph('combined-4g', text, role)
        text = timed([*args, *selected], role, root, folder, env, report['spans'])
        if role == 'unit':
            if re.search(r'^\[build-runtime\]', text, re.MULTILINE):
                raise ValueError('JVM-only runner unexpectedly performed native work')
            report['tests'] = junit_manifest(root / 'app/build/test-results')
            validate_tests(report['tests'])
        else:
            compiled = len(re.findall(r'^\[build-runtime\] musl compilation$', text, re.MULTILINE))
            hits = len(re.findall(r'^\[build-runtime\] musl verified run-local cache hit$', text, re.MULTILINE))
            if (compiled, hits) != (1, 0):
                raise ValueError('Single APK runner must compile musl exactly once with no cross-run cache')
            report['native'] = {'compilations': compiled, 'hits': hits}
        report['inputs'] = collect_inputs(root, native=role != 'unit')
        if role != 'unit':
            collect_apk(report, role, root, folder, env)
        assert_clean_sources(root)
        report['machine'] = machine()
        report['status'] = 'success'
    finally:
        retain_profiles(root, folder)
        report['totalSeconds'] = round(time.monotonic() - start, 3)
        report['harnessFinishedEpoch'] = time.time()
        (folder / 'fragment.json').write_text(json.dumps(report, sort_keys=True, indent=2) + '\n')
        if native is not None:
            native.cleanup()
    return report


def run(mode, folder):
    config = options(mode)
    root = Path(__file__).resolve().parent.parent
    folder = Path(folder).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    report = {'mode': mode, 'status': 'failed', 'options': config, 'spans': []}
    start = time.monotonic()
    env = {**os.environ, 'YOUCODED_COLLECT_SOURCES': '0'}
    env.pop('YOUCODED_COMMON_NATIVE_CACHE', None)
    native = tempfile.TemporaryDirectory(prefix='android-native-run-', dir=os.environ.get('RUNNER_TEMP'))
    try:
        if config['native']:
            env['YOUCODED_COMMON_NATIVE_CACHE'] = native.name
        assert_clean_sources(root)
        args = gradle_args(mode)
        for phase, selected in [('unit', ['test']), ('assembly', ['assembleDebug', 'assembleReleaseTest']), ('release', ['assembleRelease'])]:
            text = timed([*args, *selected, '--dry-run'], f'graph-{phase}', root, folder, env, report['spans'])
            assert_graph(mode, text, phase)
        native_logs = []
        for label, selected in [('jvm-tests', ['test']), ('debug-apk', ['assembleDebug']), ('r8-apk', ['assembleReleaseTest'])]:
            native_logs.append(timed([*args, *selected], label, root, folder, env, report['spans']))
        report['native'] = native_counts(mode, '\n'.join(native_logs))
        report['tests'] = junit_manifest(root / 'app/build/test-results')
        report['inputs'] = collect_inputs(root)
        report['payloads'], report['apkBytes'], report['signatures'] = {}, {}, {}
        for variant in APK_IDS:
            collect_apk(report, variant, root, folder, env)
        assert_clean_sources(root)
        validate_tests(report['tests'])
        validate_apks(report, APK_IDS)
        report['machine'] = machine()
        report['status'] = 'success'
    finally:
        retain_profiles(root, folder)
        report['totalSeconds'] = round(time.monotonic() - start, 3)
        (folder / 'report.json').write_text(json.dumps(report, sort_keys=True, indent=2) + '\n')
        native.cleanup()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    trial = sub.add_parser('run')
    trial.add_argument('mode', choices=MODES)
    trial.add_argument('folder')
    graph = sub.add_parser('assert-graph')
    graph.add_argument('mode', choices=MODES)
    graph.add_argument('phase', choices=('unit', 'assembly', 'release', 'debug', 'releaseTest'))
    fragment = sub.add_parser('run-fragment')
    fragment.add_argument('fragment', choices=FRAGMENTS)
    fragment.add_argument('folder')
    graph.add_argument('log')
    compare = sub.add_parser('compare')
    compare.add_argument('folder')
    args = parser.parse_args()
    if args.command == 'run':
        run(args.mode, args.folder)
    elif args.command == 'run-fragment':
        run_fragment(args.fragment, args.folder)
    elif args.command == 'assert-graph':
        assert_graph(args.mode, Path(args.log).read_text(), args.phase)
    else:
        start = time.monotonic()
        summary = Path(args.folder) / 'fanout-summary.json'
        summary.unlink(missing_ok=True)
        reports = [json.loads(path.read_text()) for path in Path(args.folder).rglob('report.json')]
        fragments = [json.loads(path.read_text()) for path in Path(args.folder).rglob('fragment.json')]
        combined = combine_fragments(fragments)
        reports.append(combined)
        by_mode = compare_reports(reports)
        combined['externalTimings']['finalValidation'] = round(time.monotonic() - start, 3)
        summary.write_text(json.dumps(combined, sort_keys=True, indent=2) + '\n')
        print('All JVM cases, runtime/native/frontend/backend/legal payloads match baseline.')
        print('Fanout: maximum independent harness span, not summed work or CI latency; 2 musl compiles versus serial combined 1.')
        print('Queue/setup/upload remain unmeasured until GitHub timestamps are collected; final comparator time is recorded separately in fanout-summary.json.')
        for mode, report in by_mode.items():
            print(f'{mode}: build harness {report["totalSeconds"]:.1f}s (setup/upload/queue timings additionally recorded by GitHub)')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError, ET.ParseError, zipfile.BadZipFile, tarfile.TarError) as error:
        print(f'Android benchmark: {error}', file=sys.stderr)
        sys.exit(1)
