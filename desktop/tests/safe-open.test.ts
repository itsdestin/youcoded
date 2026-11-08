// Pins audit F2/F7: "Open file" never runs a program, and only web (and mail) addresses reach the OS.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const shellMock = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
  openPath: vi.fn(async () => ''),
  showItemInFolder: vi.fn(),
}));
vi.mock('electron', () => ({ shell: shellMock }));

import { isSafeExternalUrl, safeOpenExternal, isRiskyToOpen, openPathSafely, RISKY_OPEN_EXTENSIONS } from '../src/main/safe-open';

beforeEach(() => { vi.clearAllMocks(); });

describe('safeOpenExternal', () => {
  it('opens web and mail addresses', async () => {
    expect(await safeOpenExternal('https://example.com/a?b=1')).toBe(true);
    expect(await safeOpenExternal('http://localhost:3000/')).toBe(true);
    expect(await safeOpenExternal('mailto:a@b.co')).toBe(true);
    expect(shellMock.openExternal).toHaveBeenCalledTimes(3);
  });
  it('can refuse mail links where only web pages make sense', () => {
    expect(isSafeExternalUrl('mailto:a@b.co', { mailto: false })).toBe(false);
  });
  it('refuses every other kind of address', async () => {
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'ms-msdt:/id x', 'vscode://x', 'smb://host/share', 'data:text/html,hi', 'steam://run/1', '', '   ', 'not a url', 'C:\\Windows\\system32\\calc.exe', null, undefined, 5]) {
      expect(await safeOpenExternal(u as unknown)).toBe(false);
    }
    expect(shellMock.openExternal).not.toHaveBeenCalled();
  });
});

describe('opening files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-open-'));
  const make = (name: string, mode = 0o644) => { const p = path.join(dir, name); fs.writeFileSync(p, 'x', { mode }); fs.chmodSync(p, mode); return p; };

  it('covers the program and script types the audit named', () => {
    for (const e of ['exe', 'bat', 'cmd', 'com', 'msi', 'ps1', 'vbs', 'js', 'jse', 'wsf', 'scr', 'lnk', 'sh', 'command', 'app', 'desktop', 'appimage', 'jar']) {
      expect(RISKY_OPEN_EXTENSIONS.has(e), e).toBe(true);
    }
  });
  it('shows a program in its folder instead of running it', async () => {
    for (const n of ['setup.exe', 'RUN.BAT', 'x.Cmd', 'a.ps1', 'a.desktop', 'a.AppImage', 'a.sh', 'tricky.exe.', 'tricky.exe  ', 'x.lnk', 'a.jar']) {
      shellMock.openPath.mockClear(); shellMock.showItemInFolder.mockClear();
      const p = make(n);
      expect(await openPathSafely(p), n).toBe('');
      expect(shellMock.openPath, n).not.toHaveBeenCalled();
      expect(shellMock.showItemInFolder, n).toHaveBeenCalledWith(p);
    }
  });
  it('still opens ordinary documents, pictures and web pages', async () => {
    for (const n of ['notes.md', 'report.docx', 'photo.png', 'page.html', 'sheet.xlsx', 'data.json', 'clip.mp4', 'archive.zip']) {
      shellMock.openPath.mockClear();
      const p = make(n);
      await openPathSafely(p);
      expect(shellMock.openPath, n).toHaveBeenCalledWith(p);
    }
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });
  it('judges where a link really leads', async () => {
    const target = make('real-tool.exe');
    const link = path.join(dir, 'harmless.txt');
    try { fs.symlinkSync(target, link); } catch { return; }   // symlinks need privileges on some systems
    expect(await isRiskyToOpen(link)).toBe(true);
  });
  it.skipIf(process.platform === 'win32')('treats an extensionless runnable file as a program', async () => {
    expect(await isRiskyToOpen(make('mystery-program', 0o755))).toBe(true);
    expect(await isRiskyToOpen(make('README', 0o644))).toBe(false);
    expect(await isRiskyToOpen(make('notes.txt', 0o755))).toBe(false);   // a document on a share that marks everything runnable
  });
});

describe('no raw OS-open calls in the main process', () => {
  // WHY a source scan: the audit found five callers handing server-supplied addresses straight to the OS. A new caller
  // that skips safe-open.ts would reopen that hole, and nothing else would notice.
  it('only safe-open.ts (and the headless stand-in) calls shell.openExternal / shell.openPath', () => {
    const root = path.resolve(__dirname, '../src/main');
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'headless') walk(p); continue; }
        if (!/\.ts$/.test(e.name) || e.name === 'safe-open.ts') continue;
        const code = fs.readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        if (/\bshell\.(openExternal|openPath)\(/.test(code)) offenders.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
