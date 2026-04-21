import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanCommandsFromDir, scanPluginCommandsDir } from './command-scanner';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yc-cmd-test-'));
}

describe('command-scanner', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('returns [] when directory does not exist', () => {
    const out = scanCommandsFromDir(path.join(tmp, 'missing'));
    expect(out).toEqual([]);
  });

  it('returns [] when directory is empty', () => {
    const out = scanCommandsFromDir(tmp);
    expect(out).toEqual([]);
  });

  it('reads .md files and extracts frontmatter description', () => {
    fs.writeFileSync(path.join(tmp, 'foo.md'),
      '---\ndescription: Does the foo thing\n---\n\nbody');
    fs.writeFileSync(path.join(tmp, 'bar.md'),
      '---\ndescription: "Does the bar thing"\n---\n\nbody');
    const out = scanCommandsFromDir(tmp).sort((a, b) => a.name.localeCompare(b.name));
    expect(out).toEqual([
      { name: '/bar', description: 'Does the bar thing', source: 'filesystem', clickable: true },
      { name: '/foo', description: 'Does the foo thing', source: 'filesystem', clickable: true },
    ]);
  });

  it('handles .md files with no frontmatter (empty description)', () => {
    fs.writeFileSync(path.join(tmp, 'nofm.md'), 'just body, no frontmatter');
    const out = scanCommandsFromDir(tmp);
    expect(out).toEqual([
      { name: '/nofm', description: '', source: 'filesystem', clickable: true },
    ]);
  });

  it('ignores non-.md files', () => {
    fs.writeFileSync(path.join(tmp, 'readme.txt'), 'not a command');
    const out = scanCommandsFromDir(tmp);
    expect(out).toEqual([]);
  });

  it('handles CRLF line endings in frontmatter', () => {
    fs.writeFileSync(path.join(tmp, 'crlf.md'),
      '---\r\ndescription: Works on Windows\r\n---\r\n\r\nbody');
    const out = scanCommandsFromDir(tmp);
    expect(out).toEqual([
      { name: '/crlf', description: 'Works on Windows', source: 'filesystem', clickable: true },
    ]);
  });

  it('handles single-quoted description values', () => {
    fs.writeFileSync(path.join(tmp, 'sq.md'),
      "---\ndescription: 'Single-quoted desc'\n---\n");
    const out = scanCommandsFromDir(tmp);
    expect(out).toEqual([
      { name: '/sq', description: 'Single-quoted desc', source: 'filesystem', clickable: true },
    ]);
  });

  it('scanPluginCommandsDir namespaces entries with plugin slug', () => {
    const pluginCmds = path.join(tmp, 'commands');
    fs.mkdirSync(pluginCmds);
    fs.writeFileSync(path.join(pluginCmds, 'brainstorm.md'),
      '---\ndescription: Brainstorm with Claude\n---\n');
    const out = scanPluginCommandsDir(tmp, 'superpowers');
    expect(out).toEqual([
      { name: '/superpowers:brainstorm', description: 'Brainstorm with Claude', source: 'filesystem', clickable: true },
    ]);
  });
});
