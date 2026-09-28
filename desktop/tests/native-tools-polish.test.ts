// Ledger items from docs/active/investigations/2026-08-26-native-tools-vs-other-harnesses.md
// (batches A + B). Each `describe` names the ledger id it pins. Wording pins
// assert the NEW sentence is present and the OLD one absent — the description
// is the only place a model learns a tool's rules before it trips one.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReadTool } from '../src/main/harness/tools/read';
import { WriteTool } from '../src/main/harness/tools/write';
import { EditTool } from '../src/main/harness/tools/edit';
import { BashTool } from '../src/main/harness/tools/bash';
import { WebFetchTool } from '../src/main/harness/tools/web-fetch';
import type { ToolContext } from '../src/main/harness/tools/types';

let dir: string;
let ctx: ToolContext;

function makeCtx(cwd: string): ToolContext {
  return { sessionId: 'test', cwd, signal: new AbortController().signal, readRegistry: new Map(), todos: [] };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-polish-'));
  ctx = makeCtx(dir);
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// Batch A — wording
// ---------------------------------------------------------------------------

describe('D-1: Bash no longer tells the model to re-run through head/tail/grep', () => {
  // WHY: there is no `pipefail`, so `npm test | tail -50` reports tail's exit 0
  // and hides a failing test run — the same description already warns there is
  // no `set -e`. The saved full-output file is the honest way to see more.
  it('the description drops the pipe advice and gives the redirect-and-echo-exit shape instead', () => {
    const d = BashTool.description;
    expect(d).not.toMatch(/piped through head\/tail\/grep/);
    expect(d).toMatch(/redirect/i);
    expect(d).toMatch(/echo exit=/);
    expect(d).toMatch(/pipefail/);
  });

  it('a truncated result no longer advises piping the original command', async () => {
    const r = await BashTool.execute(
      { command: `node -e "for(let i=1;i<=120;i++)console.log('L'+i)"` },
      ctx,
    );
    expect((r as any).truncated).toBe(true);
    expect(r.text).not.toMatch(/pipe the ORIGINAL command through head\/tail\/grep/);
    expect(r.text).toMatch(/Read that file/);
  });
});

describe('D-4: the read-gate refusal names a session resume as a cause', () => {
  // WHY: readRegistry resets on resume (types.ts), so the first Edit after
  // resuming is always refused with "not Read in this session" — true, but the
  // model's own memory says it DID read the file, so without this clause it
  // argues instead of re-reading.
  it('Edit says so', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    const r = await EditTool.execute({ file_path: 'a.txt', old_string: 'hello', new_string: 'bye' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/resum/i);
  });

  it('Write says so on its overwrite path', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'old\n');
    const r = await WriteTool.execute({ file_path: 'a.txt', content: 'new\n' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/resum/i);
  });
});

describe('D-6: WebFetch has no `prompt` parameter', () => {
  // WHY: it was only ever echoed back as a header ("Fetched for: …"), which
  // invites the model to expect an answer that never comes.
  it('the schema no longer accepts it and the description does not mention it', () => {
    const shape = (WebFetchTool.inputSchema as any).shape ?? {};
    expect(Object.keys(shape)).not.toContain('prompt');
    expect(WebFetchTool.description).not.toMatch(/\bprompt\b/);
  });
});

describe('G-4: Edit parameters carry descriptions', () => {
  const shape = () => (EditTool.inputSchema as any).shape as Record<string, { description?: string }>;

  it('every parameter is described', () => {
    for (const key of ['file_path', 'old_string', 'new_string', 'replace_all']) {
      expect(shape()[key]?.description, key).toBeTruthy();
    }
  });

  it('old_string warns about the Read line-number prefix and asks for a minimal anchor', () => {
    const d = shape().old_string.description!;
    expect(d).toMatch(/exactly once|unique/i);
    expect(d).toMatch(/line.number/i);   // "line-number prefix" / "line number"
    expect(d).toMatch(/tab/i);
    expect(d).toMatch(/1.3 lines/);
  });
});

describe('G-13: Bash steers the model to the dedicated tools', () => {
  it('names Read/Grep/Glob/Edit as the alternatives to cat/grep/find/sed', () => {
    const d = BashTool.description;
    expect(d).toMatch(/Read \(not cat\/head\/tail\)/);
    expect(d).toMatch(/Grep \(not grep\/rg\)/);
    expect(d).toMatch(/Glob \(not find\/ls\)/);
    expect(d).toMatch(/Edit \(not sed\/awk\)/);
    expect(d).toMatch(/Edit only accepts files seen via Read/);
  });
});

describe('T-3: Read carries a token-frugality nudge and states both caps', () => {
  it('both full variants say to read only the part you need, and name the ~50 KB cap', () => {
    const textOnly = ReadTool.description;
    const vision = ReadTool.descriptionFor!({ supportsVision: true })!;
    for (const d of [textOnly, vision]) {
      expect(d).toMatch(/When you already know which part you need, read only that part/);
      expect(d).toMatch(/2000 lines or ~50 KB, whichever comes first/);
    }
  });

  it('the short description stays short (small-model variant)', () => {
    expect(ReadTool.shortDescription!.length).toBeLessThan(120);
    expect(ReadTool.shortDescription).not.toMatch(/already know which part/);
  });
});

// ---------------------------------------------------------------------------
// Batch B — small code changes
// ---------------------------------------------------------------------------

describe('D-3: Read on a folder is a tool message with a listing, not a raw EISDIR', () => {
  it('names the folder, points at Glob / Bash ls, and lists entries with a trailing slash on sub-folders', async () => {
    fs.mkdirSync(path.join(dir, 'folder', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'folder', 'a.txt'), 'a');
    fs.writeFileSync(path.join(dir, 'folder', 'b.txt'), 'b');
    const r = await ReadTool.execute({ file_path: 'folder' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/EISDIR/);
    expect(r.text).toMatch(/^Read rejected: folder is a folder, not a file — use Glob to find files in it, or Bash `ls`\./);
    expect(r.text).toContain('a.txt');
    expect(r.text).toContain('b.txt');
    expect(r.text).toContain('sub/');
  });

  it('shows the first 50 entries and declares the rest through bounds', async () => {
    fs.mkdirSync(path.join(dir, 'many'));
    for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(dir, 'many', `f${String(i).padStart(2, '0')}.txt`), '');
    const r = await ReadTool.execute({ file_path: 'many' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('f49.txt');
    expect(r.text).not.toContain('f50.txt');
    expect(r.text).toMatch(/\[showing 50 of 60 files — /);
  });
});

describe('D-5: Write preserves CRLF and BOM on overwrite, like Edit', () => {
  it('a CRLF file stays CRLF after a full overwrite with LF content', async () => {
    const p = path.join(dir, 'crlf.txt');
    fs.writeFileSync(p, 'a\r\nb\r\n');
    await ReadTool.execute({ file_path: 'crlf.txt' }, ctx);
    const r = await WriteTool.execute({ file_path: 'crlf.txt', content: 'x\ny\n' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(p, 'utf8')).toBe('x\r\ny\r\n');
  });

  it('a BOM file keeps its BOM after a full overwrite', async () => {
    const p = path.join(dir, 'bom.txt');
    fs.writeFileSync(p, '﻿a\n');
    await ReadTool.execute({ file_path: 'bom.txt' }, ctx);
    const r = await WriteTool.execute({ file_path: 'bom.txt', content: 'b\n' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(p, 'utf8')).toBe('﻿b\n');
  });

  it('a brand-new file is written exactly as given', async () => {
    const r = await WriteTool.execute({ file_path: 'new.txt', content: 'x\ny\n' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8')).toBe('x\ny\n');
  });
});

describe('G-5: Read cuts at ~50 KB on a line boundary with an exact continuation offset', () => {
  // 1,000 lines × 100 chars ≈ 107 KB numbered — under the 2,000-line cap, so
  // only the char cap can stop this read.
  const bigContent = () => Array.from({ length: 1000 }, (_, i) => `L${String(i + 1).padStart(4, '0')}${'x'.repeat(94)}`).join('\n');

  it('stops before 50,000 chars, never mid-line, and says where to continue', async () => {
    fs.writeFileSync(path.join(dir, 'big.txt'), bigContent());
    const r = await ReadTool.execute({ file_path: 'big.txt' }, ctx);
    expect(r.isError).toBeFalsy();
    const body = r.text.split('\n[showing')[0];
    expect(body.length).toBeLessThanOrEqual(50_000);
    const numbered = body.split('\n');
    expect(numbered.length).toBeLessThan(1000);
    expect(numbered.length).toBeGreaterThan(400);
    // Every kept line is whole — the last one ends with its full 94 x's.
    expect(numbered[numbered.length - 1]).toMatch(/x{94}$/);
    const last = numbered.length;
    expect(r.bounds).toEqual(expect.objectContaining({ shown: last, total: 1000, unit: 'lines' }));
    expect(r.text).toContain(`use offset=${last + 1} to continue`);
    // The pipeline's generic 100k notice must be unreachable now.
    expect(r.text).not.toContain('[output truncated');
  });

  it('a continuation from the given offset picks up exactly where the first read stopped', async () => {
    fs.writeFileSync(path.join(dir, 'big.txt'), bigContent());
    const first = await ReadTool.execute({ file_path: 'big.txt' }, ctx);
    const next = Number(/use offset=(\d+) to continue/.exec(first.text)![1]);
    const second = await ReadTool.execute({ file_path: 'big.txt', offset: next }, ctx);
    expect(second.text).toContain(`${String(next).padStart(6)}\tL${String(next).padStart(4, '0')}`);
    expect(first.text).not.toContain(`L${String(next).padStart(4, '0')}`);
  });

  it('the plain line-limit case keeps its exact existing wording', async () => {
    fs.writeFileSync(path.join(dir, 't.txt'), 'a\nb\nc\nd\n');
    const r = await ReadTool.execute({ file_path: 't.txt', limit: 2 }, ctx);
    expect(r.text).toContain('[showing 2 of 4 lines — use offset=3 to continue]');
  });
});

describe('G-10: Write refuses omission placeholders', () => {
  const cases = [
    '// ... rest of code ...',
    '  # ... existing code ...',
    '/* ... unchanged ... */',
    '<!-- ... remaining content ... -->',
    '// rest of the file unchanged ...',
    '... rest of implementation ...',
  ];
  for (const line of cases) {
    it(`rejects an overwrite containing ${JSON.stringify(line)} and quotes the line`, async () => {
      const p = path.join(dir, 'a.ts');
      fs.writeFileSync(p, 'const a = 1;\nconst b = 2;\n');
      await ReadTool.execute({ file_path: 'a.ts' }, ctx);
      const r = await WriteTool.execute({ file_path: 'a.ts', content: `const a = 1;\n${line}\n` }, ctx);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^Write rejected:/);
      expect(r.text).toContain(line.trim());
      expect(r.text).toMatch(/line 2/);
      expect(r.text).toMatch(/complete file/i);
      expect(r.text).toMatch(/Edit/);
      expect(fs.readFileSync(p, 'utf8')).toBe('const a = 1;\nconst b = 2;\n'); // untouched
    });
  }

  it('rejects the same placeholder in a brand-new file with the same message', async () => {
    const r = await WriteTool.execute({ file_path: 'fresh.ts', content: 'a\n// ... existing code ...\n' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/complete file/i);
    expect(fs.existsSync(path.join(dir, 'fresh.ts'))).toBe(false);
  });

  const fine = [
    'foo(...args);',
    'console.log("...");',
    '// see the rest of the docs',           // no ellipsis
    '// ...',                                 // ellipsis, no keyword
    'const x = [1, 2]; // ... and the rest',  // not a comment-only line
    '... and so the rest of the story went on, unchanged, for years', // prose: leading ellipsis only, filler too long
    'remaining = total - used',
  ];
  for (const line of fine) {
    it(`does not trip on ${JSON.stringify(line)}`, async () => {
      const r = await WriteTool.execute({ file_path: `ok-${fine.indexOf(line)}.txt`, content: `${line}\n` }, ctx);
      expect(r.isError).toBeFalsy();
    });
  }
});

describe('G-11: a repeat Read of an unchanged slice returns a short notice', () => {
  const dedupeCtx = (callIndex: number): ToolContext =>
    ({ ...ctx, servedReads: ctx.servedReads ?? new Map(), toolCallIndex: callIndex } as ToolContext);

  it('second identical Read says the earlier content is current and how many calls ago it was served', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\nbravo\n');
    const shared = new Map();
    const first = await ReadTool.execute({ file_path: 'a.txt' }, { ...ctx, servedReads: shared, toolCallIndex: 1 });
    expect(first.text).toContain('alpha');
    const second = await ReadTool.execute({ file_path: 'a.txt' }, { ...ctx, servedReads: shared, toolCallIndex: 3 });
    expect(second.isError).toBeFalsy();
    expect(second.text).not.toContain('alpha');
    expect(second.text).toMatch(/Unchanged since your earlier Read this session \(2 calls ago\)/);
    expect(second.text).toMatch(/the content you already have is current/);
  });

  it('deduplicates unchanged bytes even when the mtime changed', async () => {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'alpha\n');
    const shared = new Map();
    await ReadTool.execute({ file_path: 'a.txt' }, { ...ctx, servedReads: shared, toolCallIndex: 1 });
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(p, future, future);
    const r = await ReadTool.execute({ file_path: 'a.txt' }, { ...ctx, servedReads: shared, toolCallIndex: 2 });
    expect(r.text).toMatch(/Unchanged since your earlier Read/);
    expect(r.text).not.toContain('     1\talpha');
  });

  it('answers an unchanged repeat without loading the whole file again', async () => {
    // WHY: loading + splitting a big file holds the main process that serves
    // every window; an unchanged repeat is checked in pieces instead.
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'alpha\n');
    const shared = new Map();
    const original = fs.promises.readFile;
    const read = vi.spyOn(fs.promises, 'readFile');
    try {
      await ReadTool.execute({ file_path: 'a.txt' }, { ...ctx, servedReads: shared, toolCallIndex: 1 });
      const repeat = await ReadTool.execute({ file_path: 'a.txt' }, { ...ctx, servedReads: shared, toolCallIndex: 2 });
      expect(repeat.text).toMatch(/content you already have is current/);
      expect(read.mock.calls.filter(([name]) => name === p)).toHaveLength(1);
      expect(read.mock.results.every(r => r.type === 'return')).toBe(true);
    } finally {
      read.mockRestore();
      expect(fs.promises.readFile).toBe(original);
    }
  });

  it('changed bytes with the same size and mtime are returned, not called current', async () => {
    const p = path.join(dir, 'a.txt');
    const stamp = new Date('2025-01-01T00:00:00Z');
    fs.writeFileSync(p, 'OLD_CONTENT');
    fs.utimesSync(p, stamp, stamp);
    const shared = new Map();
    await ReadTool.execute({ file_path: 'a.txt' }, { ...ctx, servedReads: shared, toolCallIndex: 1 });
    const oldFingerprint = ctx.readRegistry.get(p);
    fs.writeFileSync(p, 'NEW_CONTENT');
    fs.utimesSync(p, stamp, stamp);
    const second = await ReadTool.execute({ file_path: 'a.txt' }, { ...ctx, servedReads: shared, toolCallIndex: 2 });
    expect(second.text).toContain('NEW_CONTENT');
    expect(second.text).not.toContain('the content you already have is current');
    expect(ctx.readRegistry.get(p)).not.toBe(oldFingerprint);
    const edit = await EditTool.execute({ file_path: 'a.txt', old_string: 'NEW_CONTENT', new_string: 'EDITED_TEXT' }, ctx);
    expect(edit.isError).toBeFalsy();
  });

  it('a binary or missing replacement cannot reuse an old read or restore its write grant', async () => {
    const p = path.join(dir, 'a.txt');
    const stamp = new Date('2025-01-01T00:00:00Z');
    fs.writeFileSync(p, 'OLD_CONTENT');
    fs.utimesSync(p, stamp, stamp);
    const shared = new Map();
    await ReadTool.execute({ file_path: 'a.txt' }, { ...ctx, servedReads: shared, toolCallIndex: 1 });
    const oldFingerprint = ctx.readRegistry.get(p);
    fs.writeFileSync(p, Buffer.from('NEW\0CONTENT'));
    fs.utimesSync(p, stamp, stamp);
    const binary = await ReadTool.execute({ file_path: 'a.txt' }, { ...ctx, servedReads: shared, toolCallIndex: 2 });
    expect(binary.isError).toBe(true);
    expect(binary.text).toContain('binary file');
    expect(ctx.readRegistry.get(p)).toBe(oldFingerprint);
    const edit = await EditTool.execute({ file_path: 'a.txt', old_string: 'OLD_CONTENT', new_string: 'bad' }, ctx);
    expect(edit.isError).toBe(true);
    const write = await WriteTool.execute({ file_path: 'a.txt', content: 'bad' }, ctx);
    expect(write.isError).toBe(true);
    expect(fs.readFileSync(p).includes(0)).toBe(true);
    fs.rmSync(p);
    const missing = await ReadTool.execute({ file_path: 'a.txt' }, { ...ctx, servedReads: shared, toolCallIndex: 3 });
    expect(missing.isError).toBe(true);
    expect(missing.text).not.toContain('content you already have is current');
    expect(ctx.readRegistry.get(p)).toBe(oldFingerprint);
  });

  it('an invalid page never stamps a changed file or reuses its old notice', async () => {
    const p = path.join(dir, 'a.txt');
    const stamp = new Date('2025-01-01T00:00:00Z');
    fs.writeFileSync(p, 'old\n'); fs.utimesSync(p, stamp, stamp);
    const shared = new Map();
    await ReadTool.execute({ file_path: 'a.txt', offset: 1 }, { ...ctx, servedReads: shared, toolCallIndex: 1 });
    const oldFingerprint = ctx.readRegistry.get(p);
    fs.writeFileSync(p, 'new\n'); fs.utimesSync(p, stamp, stamp);
    const rejected = await ReadTool.execute({ file_path: 'a.txt', offset: 9 }, { ...ctx, servedReads: shared, toolCallIndex: 2 });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain('past the end');
    expect(ctx.readRegistry.get(p)).toBe(oldFingerprint);
    const blocked = await EditTool.execute({ file_path: 'a.txt', old_string: 'new', new_string: 'bad' }, ctx);
    expect(blocked.isError).toBe(true);
  });

  it('clearing served slice history serves the full text again', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\n');
    const shared = new Map();
    await ReadTool.execute({ file_path: 'a.txt' }, { ...ctx, servedReads: shared, toolCallIndex: 1 });
    shared.clear(); // HarnessSession clears this on /clear, successful compaction and resume.
    const again = await ReadTool.execute({ file_path: 'a.txt' }, { ...ctx, servedReads: shared, toolCallIndex: 2 });
    expect(again.text).toContain('     1\talpha');
  });

  it('a different slice (offset/limit) is not a repeat', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\nl3\n');
    const shared = new Map();
    await ReadTool.execute({ file_path: 'a.txt', limit: 1 }, { ...ctx, servedReads: shared, toolCallIndex: 1 });
    const r = await ReadTool.execute({ file_path: 'a.txt', offset: 2 }, { ...ctx, servedReads: shared, toolCallIndex: 2 });
    expect(r.text).toContain('l2');
  });

  it('a context without a servedReads map (tests, one-offs) always serves content', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\n');
    await ReadTool.execute({ file_path: 'a.txt' }, dedupeCtx(1) as any);
    const r = await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    expect(r.text).toContain('alpha');
  });
});

describe('G-1: Bash description — background execution', () => {
  it('names run_in_background, BashOutput, KillShell, the hand-off, and the cwd asymmetry; drops SIGKILL and exit 124', () => {
    const d = BashTool.description;
    expect(d).toMatch(/run_in_background/);
    expect(d).toMatch(/BashOutput/);
    expect(d).toMatch(/KillShell/);
    expect(d).toMatch(/handed off to the background/);
    expect(d).toMatch(/only a foreground command changes your working directory/i);
    expect(d).toMatch(/leading `sleep`/);
    expect(d).not.toMatch(/SIGKILL|force-kill/);
    expect(d).not.toMatch(/\b124\b/);
  });
  it('the schema accepts run_in_background and stays strict', () => {
    expect(BashTool.inputSchema.safeParse({ command: 'x', run_in_background: true }).success).toBe(true);
    expect(BashTool.inputSchema.safeParse({ command: 'x', background: true }).success).toBe(false);
  });
});
