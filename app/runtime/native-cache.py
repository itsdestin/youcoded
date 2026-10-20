#!/usr/bin/env python3
"""Verified run-local reuse for experimental native compilation, never directory trust."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fingerprint(inputs, values):
    if not inputs or not all(isinstance(k, str) and k for k in inputs):
        raise ValueError('Fingerprint requires named source inputs')
    if not all(isinstance(k, str) and isinstance(v, str) for k, v in values.items()):
        raise ValueError('Toolchain/environment fingerprint values must be strings')
    files = {}
    for label, source in inputs.items():
        source = Path(source)
        if not source.is_file():
            raise ValueError(f'Missing native input {label}')
        files[label] = digest(source)
    # WHY: source labels/content and actual toolchain values matter, not variant
    # output directory paths. APP_ID-specific patching happens AFTER this cache.
    payload = json.dumps({'schema': 1, 'inputs': files, 'values': values}, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(payload).hexdigest()


def entry(root, key):
    if not isinstance(key, str) or not re.fullmatch(r'[0-9a-f]{64}', key):
        raise ValueError('Native cache key must be a SHA-256 digest')
    return Path(root) / key


def store(root, key, artifact):
    root, artifact = Path(root), Path(artifact)
    folder = entry(root, key)
    if root.is_symlink() or folder.is_symlink() or artifact.is_symlink() or not artifact.is_file():
        raise ValueError('Native cache refuses redirected or non-regular paths')
    mode = stat.S_IMODE(artifact.stat().st_mode)
    if mode > 0o777:
        raise ValueError('Unexpected privileged native artifact mode')
    folder.mkdir(parents=True, exist_ok=True)
    binary_tmp = manifest_tmp = None
    try:
        with tempfile.NamedTemporaryFile(prefix='.artifact-', dir=folder, delete=False) as temporary:
            binary_tmp = Path(temporary.name)
        shutil.copy2(artifact, binary_tmp)
        manifest = {'schema': 1, 'key': key, 'sha256': digest(binary_tmp), 'size': binary_tmp.stat().st_size, 'mode': mode}
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', prefix='.manifest-', dir=folder, delete=False) as temporary:
            manifest_tmp = Path(temporary.name)
            json.dump(manifest, temporary, sort_keys=True)
            temporary.write('\n')
        # WHY: publish the receipt LAST. Interrupted/racing publication yields a
        # miss, never permission to use an incomplete or hash-mismatched binary.
        os.replace(binary_tmp, folder / 'artifact')
        os.replace(manifest_tmp, folder / 'manifest.json')
    finally:
        for temporary in (binary_tmp, manifest_tmp):
            if temporary is not None:
                temporary.unlink(missing_ok=True)


def restore(root, key, destination):
    root, destination = Path(root), Path(destination)
    folder = entry(root, key)
    artifact, receipt = folder / 'artifact', folder / 'manifest.json'
    if any(path.is_symlink() for path in (root, folder, artifact, receipt)):
        return False
    temporary = None
    try:
        if not receipt.is_file() or receipt.stat().st_size > 65536 or not artifact.is_file():
            return False
        manifest = json.loads(receipt.read_text(encoding='utf-8'))
        if not isinstance(manifest, dict) or set(manifest) != {'schema', 'key', 'sha256', 'size', 'mode'}:
            return False
        if manifest['schema'] != 1 or manifest['key'] != key or not isinstance(manifest['sha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', manifest['sha256']):
            return False
        if type(manifest['mode']) is not int or not 0 <= manifest['mode'] <= 0o777 or type(manifest['size']) is not int:
            return False
        if artifact.stat().st_size != manifest['size'] or stat.S_IMODE(artifact.stat().st_mode) != manifest['mode'] or digest(artifact) != manifest['sha256']:
            return False
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(prefix='.native-restore-', dir=destination.parent, delete=False) as stream:
            temporary = Path(stream.name)
        shutil.copy2(artifact, temporary)
        # Recheck the private copy in case the source changed during the read.
        if digest(temporary) != manifest['sha256'] or stat.S_IMODE(temporary.stat().st_mode) != manifest['mode']:
            return False
        os.replace(temporary, destination)
        return True
    except (OSError, ValueError, TypeError, KeyError):
        return False
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def named(items):
    result = {}
    for item in items:
        label, separator, value = item.partition('=')
        if not separator or not re.fullmatch(r'[A-Za-z0-9_.-]+', label) or label in result:
            raise ValueError('Native cache inputs need unique label=value arguments')
        result[label] = value
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    key = sub.add_parser('key')
    key.add_argument('--input', action='append', default=[], required=True)
    key.add_argument('--value', action='append', default=[])
    for action in ('store', 'restore'):
        command = sub.add_parser(action)
        command.add_argument('root')
        command.add_argument('key')
        command.add_argument('artifact')
    args = parser.parse_args()
    if args.command == 'key':
        print(fingerprint(named(args.input), named(args.value)))
    elif args.command == 'store':
        store(args.root, args.key, args.artifact)
    else:
        return 0 if restore(args.root, args.key, args.artifact) else 1
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(f'native cache: {error}', file=sys.stderr)
        sys.exit(2)
