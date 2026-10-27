import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { applyClaudeCodeWidths } from '../src/shared/terminal-widths';
import { readInputFocus } from '../src/shared/cc-input-focus';

const make = (cols = 80, rows = 4, claude = true) => {
  const t = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  if (claude) applyClaudeCodeWidths(t); else { t.loadAddon(new Unicode11Addon() as never); t.unicode.activeVersion = '11'; }
  return t;
};
const write = (t: Terminal, d: string) => new Promise<void>(r => t.write(d, r));
async function columns(text: string, claude = true): Promise<number> {
  const t = make(80, 2, claude); await write(t, text); const x = t.buffer.active.cursorX; t.dispose(); return x;
}

describe('terminal widths match how Claude Code draws', () => {
  it('falls back to Unicode 11 instead of breaking the terminal when the table cannot be set up', () => {
    const loaded: unknown[] = []; const unicode = { activeVersion: 'x', register: () => { throw Error('unsupported'); } };
    applyClaudeCodeWidths({ unicode, loadAddon: (a: unknown) => { loaded.push(a); } } as never);
    expect(loaded).toHaveLength(1); expect(unicode.activeVersion).toBe('11');
  });
  it('counts an emoji cluster as one 2-column character', async () => {
    for (const [text, width] of [
      ['👨‍👩‍👧', 2], ['👩‍❤️‍👨', 2], ['🏳️‍🌈', 2], ['👍🏽', 2], ['❤️', 2], ['1️⃣', 2],
      ['🙂', 2], ['🇯🇵', 2], ['❤', 1],
    ] as const) expect(await columns(text), JSON.stringify(text)).toBe(width);
  });
  it('leaves letters, accents and text joiners exactly as before', async () => {
    for (const text of ['abc', 'é', '漢字', 'می‌خواهم', 'क्‍ष', 'a‍b', 'a️', '🇯'])
      expect(await columns(text), JSON.stringify(text)).toBe(await columns(text, false));
  });
  it('keeps the message box readable after a real joined-emoji message is sent and answered', async () => {
    const dir = fileURLToPath(new URL('./fixtures/terminal-widths/', import.meta.url));
    const m = JSON.parse(fs.readFileSync(dir + 'marks.json', 'utf8')); const raw = fs.readFileSync(dir + 'terminal.raw', 'utf8');
    const screen = async (offset: number, claude: boolean) => {
      const t = make(m.cols, m.rows, claude); await write(t, raw.slice(0, offset));
      const b = t.buffer.active; const rows: string[] = [];
      for (let i = 0; i < t.rows; i++) rows.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
      t.dispose(); return rows;
    };
    const norm = (x: string) => x.normalize('NFC').replace(/[​-‍⁠﻿️]/g, '');
    for (const mark of m.marks) {
      const rows = await screen(mark.offset, true);
      const box = [...rows].reverse().find(r => r.trim().startsWith('❯')) ?? '';
      const expected = m.results.find((r: { name: string }) => r.name === mark.name)?.text ?? '';
      expect(readInputFocus(rows.join('\n')).kind, mark.name).toBe('message-box');
      expect(norm(box.trim().replace(/^❯\s?/, '')), mark.name).toBe(norm(expected));
    }
    // The capture really is the failure: with Unicode 11 widths alone the box reads as a question being open.
    const after = m.marks.find((x: { name: string }) => x.name === 'sent and answered');
    expect(readInputFocus((await screen(after.offset, false)).join('\n')).kind).not.toBe('message-box');
  });
});
