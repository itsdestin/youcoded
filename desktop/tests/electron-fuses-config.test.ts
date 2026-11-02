// Pins audit F2/F4 (fuses): the packaged app must not honour NODE_OPTIONS / --inspect, must load code only from
// app.asar, and must keep RunAsNode (the app launches itself as Node in three places).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const yml = fs.readFileSync(path.resolve(__dirname, '../electron-builder.yml'), 'utf8');
// Only the top-level electronFuses block.
const block = /^electronFuses:\n((?:[ \t]+.*\n|\n)+)/m.exec(yml)?.[1] ?? '';
const flag = (name: string) => new RegExp(`^\\s+${name}:\\s*(true|false)\\b`, 'm').exec(block)?.[1];

describe('electron fuses', () => {
  it('turns off the two ways to inject code into the packaged app', () => {
    expect(flag('enableNodeOptionsEnvironmentVariable')).toBe('false');
    expect(flag('enableNodeCliInspectArguments')).toBe('false');
  });
  it('loads app code only from app.asar, and checks it', () => {
    expect(flag('onlyLoadAppFromAsar')).toBe('true');
    expect(flag('enableEmbeddedAsarIntegrityValidation')).toBe('true');
  });
  it('keeps RunAsNode, which the app itself uses', () => {
    expect(flag('runAsNode')).toBe('true');
    // The callers named in electron-builder.yml must still exist, or the comment (and this exception) is stale.
    for (const f of ['src/main/assistant-browser/browser-installer.ts', 'src/main/pages/page-program.ts', 'scripts/askpass/youcoded-askpass']) {
      expect(fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8')).toContain('ELECTRON_RUN_AS_NODE');
    }
  });
});
