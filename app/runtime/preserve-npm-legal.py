"""Retain npm legal/readme material before trimming, and inventory installed packages."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

LEGAL = re.compile(r'^(licen[cs]e|copying|copyright|notice|authors|patents|readme|legal|third.party)', re.I)


def preserve(node_modules, output):
    node_modules, output = Path(node_modules), Path(output)
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    components = []
    files = []
    # WHY: a notice can be inside docs/ or third_party/; collect before any pruning.
    for path in sorted(node_modules.rglob('*')):
        if path.is_symlink() or not path.is_file():
            continue
        relative = path.relative_to(node_modules)
        parts = relative.parent.parts
        last_modules = max((i for i, part in enumerate(parts) if part == 'node_modules'), default=-1)
        package_parts = parts[last_modules + 1:]
        package_root = len(package_parts) == (2 if package_parts and package_parts[0].startswith('@') else 1)
        if path.name == 'package.json' and package_root:
            package = json.loads(path.read_text())
            if package.get('name') and package.get('version'):
                components.append({'path': str(relative.parent), 'name': package['name'],
                                   'version': package['version'], 'license': package.get('license'),
                                   'repository': package.get('repository')})
        if LEGAL.match(path.name):
            destination = output / 'npm-notices' / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)
            files.append({'path': str(relative), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    (output / 'npm-components.json').write_text(json.dumps({'scope': 'Installed backend production tree before platform trimming; not renderer coverage',
                                                           'components': components, 'preserved_files': files}, indent=2) + '\n')


def mark_retained(node_modules, output):
    path = Path(output) / 'npm-components.json'
    inventory = json.loads(path.read_text())
    for component in inventory['components']:
        manifest = Path(node_modules) / component['path'] / 'package.json'
        component['retained_after_platform_trim'] = manifest.is_file()
    inventory['scope'] = 'Backend production tree, with actual post-trim retention recorded; not renderer coverage'
    path.write_text(json.dumps(inventory, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('node_modules')
    parser.add_argument('output')
    parser.add_argument('--mark-retained', action='store_true')
    args = parser.parse_args()
    if args.mark_retained:
        mark_retained(args.node_modules, args.output)
    else:
        preserve(args.node_modules, args.output)
