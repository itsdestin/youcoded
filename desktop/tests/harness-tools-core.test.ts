import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';

// Spy on child_process.spawn so the Grep cwd regression test can assert the
// exact options the tool passes. `importActual` keeps the REAL implementation —
// the search genuinely runs; we only observe the call. (Mocking process.cwd()
// does NOT work as a pin: Node's spawn reads the inherited cwd via the native
// binding, not the JS process.cwd() we could stub — verified 2026-07-17.)
const spawnSpy = vi.fn();
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (...args: any[]) => {
      spawnSpy(...args);
      return (actual.spawn as any)(...args);
    },
  };
});
import { ReadTool, readSizeError, MAX_READ_BYTES } from '../src/main/harness/tools/read';
import { WriteTool } from '../src/main/harness/tools/write';
import { EditTool } from '../src/main/harness/tools/edit';
import { BashTool, rebaseReportedCwd } from '../src/main/harness/tools/bash';
import { GlobTool } from '../src/main/harness/tools/glob';
import { GrepTool, resolveRgPath } from '../src/main/harness/tools/grep';
import { TodoWriteTool } from '../src/main/harness/tools/todo-write';
import { shellCwdMissHint, workspaceRootMissHint } from '../src/main/harness/tools/guards';
import type { ToolContext } from '../src/main/harness/tools/types';
import { defineTool, SEARCH_TIMEOUT_MS } from '../src/main/harness/tools/registry';

// Each test gets a fresh tmp sandbox + fresh ToolContext (readRegistry/todos maps),
// so read-before-edit state never leaks between cases.
let dir: string;
let ctx: ToolContext;

// PER-PROCESS, not the bare literal 'test'. Bash's spill files land in
// `os.tmpdir()/youcoded-harness-bash-output/<sessionId>` — a fixed path OUTSIDE
// the vitest HOME sandbox (spill-paths.ts resolves it from os.tmpdir() directly,
// which is correct for production). With a shared id, every concurrent vitest
// run wrote spills into ONE directory and the afterEach below deleted it out
// from under the others: six concurrent full suites failed
// `expect(fs.existsSync(r.outputPath)).toBe(true)` on 2026-08-28 — the file had
// been written, then removed by a different run between the write and the read.
// Same shape as the shared TEST_HOME fixed in #362, in a path that redirect
// cannot reach.
const TEST_SESSION_ID = `test-${process.pid}`;

function makeCtx(cwd: string, signal?: AbortSignal): ToolContext {
  return {
    sessionId: TEST_SESSION_ID,
    cwd,
    signal: signal ?? new AbortController().signal,
    readRegistry: new Map(),
    todos: [],
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-tools-'));
  ctx = makeCtx(dir);
});
afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  } catch {
    /* best-effort */
  }
});

describe('Read', () => {
  it('returns numbered lines', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\nbravo\ncharlie\n');
    const r = await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('     1\talpha');
    expect(r.text).toContain('     2\tbravo');
    expect(r.text).toContain('     3\tcharlie');
  });

  it('paging trailer appears when more lines remain (offset/limit)', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
    fs.writeFileSync(path.join(dir, 'big.txt'), lines);
    const r = await ReadTool.execute({ file_path: 'big.txt', offset: 1, limit: 5 }, ctx);
    expect(r.text).toContain('     1\tline1');
    expect(r.text).toContain('     5\tline5');
    expect(r.text).not.toContain('line6');
    expect(r.text).toMatch(/use offset=6 to continue/);
  });

  it('refuses binary files', async () => {
    fs.writeFileSync(path.join(dir, 'bin'), Buffer.from([0x41, 0x00, 0x42]));
    const r = await ReadTool.execute({ file_path: 'bin' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('binary file');
  });

  it('registers the file in readRegistry', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
    await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    // canonicalize lower-cases the whole path on win32
    const key = process.platform === 'win32'
      ? path.resolve(dir, 'a.txt').replace(/\\/g, '/').toLowerCase()
      : path.resolve(dir, 'a.txt');
    expect(ctx.readRegistry.has(key)).toBe(true);
  });

  it('size guard refuses files over MAX_READ_BYTES with an actionable message', () => {
    // Unit-test the exact refusal branch without writing a 50 MB fixture.
    expect(readSizeError(1000, 'small.log')).toBeNull();
    expect(readSizeError(MAX_READ_BYTES, 'edge.log')).toBeNull();
    const msg = readSizeError(MAX_READ_BYTES + 1, 'huge.log');
    expect(msg).toBeTruthy();
    expect(msg).toContain('huge.log');
    expect(msg).toContain('limit 50 MB');
    expect(msg).toMatch(/Grep|head\/tail/);
  });

  it('trailer line count is honest for a file ending in \\n (no phantom line)', async () => {
    fs.writeFileSync(path.join(dir, 't.txt'), 'a\nb\nc\n'); // 3 real lines, trailing \n
    const r = await ReadTool.execute({ file_path: 't.txt', offset: 1, limit: 2 }, ctx);
    // 3 total, not 4 — the phantom empty split element is dropped.
    expect(r.text).toContain('of 3 lines —');
    expect(r.text).not.toContain('of 4');
  });

  it('offset past EOF returns a friendly message, not empty text', async () => {
    fs.writeFileSync(path.join(dir, 't.txt'), 'a\nb\nc\n');
    const r = await ReadTool.execute({ file_path: 't.txt', offset: 99 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('offset 99 is past the end of the file (3 lines)');
  });

  // Regression pin (2026-08-10 review, Claim 10): Read's isError messages used
  // THREE unreconciled shapes -- "Read failed: ..." (thrown exceptions, via
  // registry.ts's catch-all), "Cannot read ...: ..." (binary/size refusals), and
  // a bare "Read <path>: offset N is past the end..." (past-EOF, no "failed"/
  // "Cannot" prefix at all). Opus flagged the last one specifically: the
  // prefixes are "otherwise a reliable signal for 'did this succeed'". House
  // pattern (from Edit: "rejected" for a guard declining to act at all, "failed"
  // for a bad request against an otherwise-permitted action) maps size/binary to
  // "Read rejected:" (we refuse to read this file, full stop) and past-EOF to
  // "Read failed:" (the specific offset requested is invalid) -- unifying with
  // the SAME two prefixes the thrown-exception path (registry.ts) already uses.
  it('unifies Read refusals into two dialects: "Read rejected:" for a file we refuse to read at all, "Read failed:" for a bad request', async () => {
    fs.writeFileSync(path.join(dir, 'bin'), Buffer.from([0x41, 0x00, 0x42]));
    const binR = await ReadTool.execute({ file_path: 'bin' }, ctx);
    expect(binR.isError).toBe(true);
    expect(binR.text.startsWith('Read rejected:')).toBe(true);

    fs.writeFileSync(path.join(dir, 't2.txt'), 'a\nb\nc\n');
    const eofR = await ReadTool.execute({ file_path: 't2.txt', offset: 99 }, ctx);
    expect(eofR.isError).toBe(true);
    expect(eofR.text.startsWith('Read failed:')).toBe(true);

    const sizeMsg = readSizeError(MAX_READ_BYTES + 1, 'huge.log');
    expect(sizeMsg).toBeTruthy();
    expect(sizeMsg!.startsWith('Read rejected:')).toBe(true);
  });

  it('Read declares bounds with an offset hint when a page is partial', async () => {
    const f = path.join(dir, 'big.txt');
    fs.writeFileSync(f, Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'));
    const r = await ReadTool.execute({ file_path: f, offset: 1, limit: 20 }, ctx);
    expect(r.text).toContain('[showing 20 of 100 lines — use offset=21 to continue]');
  });

  it('Read declares no bounds when the whole file fits', async () => {
    const f = path.join(dir, 'small.txt');
    fs.writeFileSync(f, 'a\nb\nc');
    const r = await ReadTool.execute({ file_path: f }, ctx);
    expect(r.text).not.toContain('[showing');
  });

  // Fix (two independent 2026-08 harness reviews, Grok 4.5 + Qwen 3.8 Max --
  // see guards.ts's WHY block above shellCwdMissHint): Read always resolves a
  // relative path from the workspace root; Bash's cwd persists across calls
  // and `cd` moves it. Grok's half of the finding: a model that just `cd`-ed
  // Bash elsewhere can wrongly assume Read followed it.
  describe('shell-cwd miss hint (Grok 4.5 / Qwen 3.8 Max asymmetry)', () => {
    it('names the path when it exists relative to the persisted shell cwd', async () => {
      const shellCwd = path.join(dir, 'sub');
      fs.mkdirSync(shellCwd);
      const target = path.join(shellCwd, 'note.txt');
      fs.writeFileSync(target, 'hello');
      const c: ToolContext = { ...ctx, shellCwd };
      const r = await ReadTool.execute({ file_path: 'note.txt' }, c);
      expect(r.isError).toBe(true);
      expect(r.text.startsWith('Read failed: ENOENT')).toBe(true);
      expect(r.text).toContain(target);
      expect(r.text).toContain(shellCwd);
    });

    it('adds no hint when the file exists nowhere', async () => {
      const shellCwd = path.join(dir, 'sub');
      fs.mkdirSync(shellCwd);
      const c: ToolContext = { ...ctx, shellCwd };
      const r = await ReadTool.execute({ file_path: 'ghost.txt' }, c);
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain("It exists relative to the shell's current directory");
    });

    it('adds no hint for an absolute-path miss', async () => {
      const shellCwd = path.join(dir, 'sub');
      fs.mkdirSync(shellCwd);
      const c: ToolContext = { ...ctx, shellCwd };
      const absGhost = path.join(dir, 'ghost-abs.txt');
      const r = await ReadTool.execute({ file_path: absGhost }, c);
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain("It exists relative to the shell's current directory");
    });

    it('adds no hint when the shell cwd equals the workspace root', async () => {
      const c: ToolContext = { ...ctx, shellCwd: dir };
      const r = await ReadTool.execute({ file_path: 'ghost.txt' }, c);
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain("It exists relative to the shell's current directory");
    });
  });
});

describe('Read: image delivery', () => {
  it('returns the image path in payload.images for a vision model', async () => {
    const p = path.join(dir, 'shot.png');
    fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = await ReadTool.execute({ file_path: p }, { ...makeCtx(dir), supportsVision: true });
    expect(r.isError).toBeFalsy();
    expect(r.images).toEqual([p]);
    expect(r.text).toContain('Read image');
    expect(r.text).toContain('image/png');
  });

  it('refuses honestly for a non-vision model (no images field)', async () => {
    const p = path.join(dir, 'shot2.png');
    fs.writeFileSync(p, Buffer.from([1]));
    const r = await ReadTool.execute({ file_path: p }, { ...makeCtx(dir), supportsVision: false });
    expect(r.isError).toBe(true);
    expect(r.images).toBeUndefined();
    expect(r.text).toContain('cannot view images');
  });

  it('refuses an undeliverable image format by name, never promising it', async () => {
    const p = path.join(dir, 'vector.svg');
    fs.writeFileSync(p, '<svg/>');
    const r = await ReadTool.execute({ file_path: p }, { ...makeCtx(dir), supportsVision: true });
    expect(r.isError).toBe(true);
    // Assert the actual refusal WORDING, not just that 'svg' appears somewhere —
    // the echoed file path (".../vector.svg") alone would satisfy a bare
    // `toContain('svg')` even with the format-named refusal deleted entirely
    // (2026-08-11 review, Fix 2: the implementer's own RED evidence showed this
    // test passing before the refusal branch existed).
    expect(r.text).toMatch(/cannot be delivered/i);
    expect(r.text).toContain('svg');
    expect(r.images).toBeUndefined();
  });

  it('refuses an oversized image with the real size and limit', async () => {
    const p = path.join(dir, 'huge.png');
    fs.writeFileSync(p, Buffer.alloc(11 * 1024 * 1024));
    const r = await ReadTool.execute({ file_path: p }, { ...makeCtx(dir), supportsVision: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/11(\.\d)? MB.*10 MB/s);
    // A refusal must never also promise the image (2026-08-11 review, Fix 5) —
    // the sibling refusal tests above pin this; this one didn't.
    expect(r.images).toBeUndefined();
  });

  it('advertises image reading only to vision models', () => {
    // Assert the LOAD-BEARING phrases, not the bare plural 'images' (2026-08-11
    // review, Fix 3): the vivid "actual picture" framing and the "screenshot"
    // example are what actually stop a vision model from never trying an image
    // read — a substring check on 'images' alone would keep passing even if
    // that framing were deleted.
    expect(ReadTool.descriptionFor!({ supportsVision: true })).toMatch(/actual picture/);
    expect(ReadTool.descriptionFor!({ supportsVision: true })).toMatch(/screenshot/);
    expect(ReadTool.descriptionFor!({ supportsVision: false })).toBeUndefined();
  });

  it('advertises image reading in the SHORT description too, for simplified presentation', () => {
    // Same failure mode as descriptionFor above, but for the small-local-model path
    // (spec §4.2): a vision model that only ever sees shortDescription must still be
    // told Read returns images, or the Roo Code #10440 gap reopens for that tier.
    // Assert the specific clause added (2026-08-11), not the bare word 'images' —
    // that alone could come from unrelated text and wouldn't catch the wording
    // being deleted (2026-08-11 review, Fix 3's lesson applied here too).
    expect(ReadTool.shortDescriptionFor!({ supportsVision: true })).toMatch(/come back as the actual picture/);
    expect(ReadTool.shortDescriptionFor!({ supportsVision: false })).toBeUndefined();
  });
});

describe('Edit', () => {
  it('rejects an edit without a prior Read', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    const r = await EditTool.execute({ file_path: 'a.txt', old_string: 'hello', new_string: 'bye' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/read .* first/i);
  });

  // 2026-09-16: the gate compares CONTENTS, not modification times (closing
  // docs/active/investigations/2026-09-01-write-edit-mtime-staleness.md). The
  // two cases below are the two ways the old mtime check lied.
  it('rejects an edit when the file’s contents changed since Read, even with the SAME mtime', async () => {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'hello\n');
    await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    // A real outside edit inside one clock tick: rewrite the bytes, then put
    // the ORIGINAL timestamp back — an mtime check would wave this through.
    const { atime, mtime } = fs.statSync(p);
    fs.writeFileSync(p, 'hello world\n');
    fs.utimesSync(p, atime, mtime);
    const r = await EditTool.execute({ file_path: 'a.txt', old_string: 'hello', new_string: 'bye' }, ctx);
    expect(r.isError).toBe(true);
    // Must name the mechanism, not just "changed" — the gate's invisibility is
    // what four round-8 models misdiagnosed.
    expect(r.text).toMatch(/changed on disk since you last Read or Wrote it/i);
    expect(r.text).toMatch(/contents no longer match/i);
    expect(fs.readFileSync(p, 'utf8')).toBe('hello world\n');
  });

  it('allows an edit after a touch or checkout that changed no bytes (mtime moved, contents did not)', async () => {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'hello\n');
    await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(p, future, future);
    const r = await EditTool.execute({ file_path: 'a.txt', old_string: 'hello', new_string: 'bye' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(p, 'utf8')).toBe('bye\n');
  });

  it('non-unique old_string message includes the count', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\nx\nx\n');
    await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    const r = await EditTool.execute({ file_path: 'a.txt', old_string: 'x', new_string: 'y' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('matches 3 times');
  });

  it('replace_all replaces every occurrence', async () => {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'x\nx\nx\n');
    await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    const r = await EditTool.execute({ file_path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(p, 'utf8')).toBe('y\ny\ny\n');
  });

  it('preserves CRLF line endings after an edit', async () => {
    const p = path.join(dir, 'crlf.txt');
    fs.writeFileSync(p, 'a\r\nb\r\n');
    await ReadTool.execute({ file_path: 'crlf.txt' }, ctx);
    const r = await EditTool.execute({ file_path: 'crlf.txt', old_string: 'b', new_string: 'c' }, ctx);
    expect(r.isError).toBeFalsy();
    const after = fs.readFileSync(p, 'utf8');
    expect(after).toBe('a\r\nc\r\n');
    expect(after).toContain('\r\n');
  });

  it('multi-line edit on a CRLF file matches in LF space and preserves CRLF', async () => {
    const p = path.join(dir, 'multi.txt');
    fs.writeFileSync(p, 'a\r\nb\r\nc\r\n');
    await ReadTool.execute({ file_path: 'multi.txt' }, ctx);
    // old_string/new_string use \n (what the model sees in Read output) — must match
    // despite the file's invisible \r, and the write must stay CRLF end-to-end.
    const r = await EditTool.execute({ file_path: 'multi.txt', old_string: 'a\nb', new_string: 'a\nX\nb' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(p, 'utf8')).toBe('a\r\nX\r\nb\r\nc\r\n');
    // Hunks reflect the one-line insertion, not a whole-file line-ending churn.
    expect(r.structuredPatch).toBeDefined();
    expect(r.structuredPatch!.length).toBeGreaterThan(0);
    const changed = r.structuredPatch!.flatMap((h) => h.lines).filter((l) => l.startsWith('+') || l.startsWith('-'));
    expect(changed.every((l) => !l.includes('\r'))).toBe(true);
    expect(changed.some((l) => l === '+X')).toBe(true);
  });

  it('keeps a CRLF file uniformly CRLF even when new_string contains \\r\\n', async () => {
    const p = path.join(dir, 'crlf2.txt');
    fs.writeFileSync(p, 'a\r\nb\r\nc\r\n');
    await ReadTool.execute({ file_path: 'crlf2.txt' }, ctx);
    // new_string carries its own \r\n — the file must not go mixed-ending.
    const r = await EditTool.execute({ file_path: 'crlf2.txt', old_string: 'b', new_string: 'X\r\nY' }, ctx);
    expect(r.isError).toBeFalsy();
    const bytes = fs.readFileSync(p, 'utf8');
    expect(bytes).toBe('a\r\nX\r\nY\r\nc\r\n');
    // No bare LF anywhere (every \n is preceded by \r) → uniform CRLF.
    expect(/[^\r]\n/.test(bytes)).toBe(false);
    expect(bytes.startsWith('\n')).toBe(false);
  });

  it('returns non-empty structuredPatch hunks', async () => {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'hello\nworld\n');
    await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    const r = await EditTool.execute({ file_path: 'a.txt', old_string: 'world', new_string: 'there' }, ctx);
    expect(r.structuredPatch).toBeDefined();
    expect(r.structuredPatch!.length).toBeGreaterThan(0);
    expect(r.structuredPatch![0]).toHaveProperty('oldStart');
    expect(r.structuredPatch![0]).toHaveProperty('lines');
  });

  it('inserts a new_string containing $& literally (String.replace footgun)', async () => {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'TOKEN\n');
    await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    const r = await EditTool.execute({ file_path: 'a.txt', old_string: 'TOKEN', new_string: 'a$&b$1c$$d' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(p, 'utf8')).toBe('a$&b$1c$$d\n');
  });

  // Regression pin (2026-08-10 review, Claim 6): Grok set old_string ===
  // new_string with replace_all: true and got the generic 'Edited X.' text --
  // textually identical to a real edit. structuredPatch already carried zero
  // hunks (the true empty-diff signal), but the model only reads r.text. Surface
  // the zero-change fact explicitly instead of a success message indistinguishable
  // from a real edit.
  it('reports zero changes explicitly for a no-op edit (old_string === new_string)', async () => {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'shared token\n');
    await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    const r = await EditTool.execute(
      { file_path: 'a.txt', old_string: 'shared token', new_string: 'shared token', replace_all: true },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(r.text).not.toBe('Edited a.txt.');
    expect(r.text).toMatch(/0 replacements|no changes|identical/i);
    expect(r.structuredPatch).toEqual([]);
    // The file's bytes are untouched -- no pointless rewrite of identical content.
    expect(fs.readFileSync(p, 'utf8')).toBe('shared token\n');
  });
});

describe('Write', () => {
  it('rejects overwriting an existing file without a prior Read', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'old\n');
    const r = await WriteTool.execute({ file_path: 'a.txt', content: 'new\n' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Read it first/i);
  });

  it('creates parent directories', async () => {
    const r = await WriteTool.execute({ file_path: 'deep/nested/x.txt', content: 'hi\n' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, 'deep/nested/x.txt'), 'utf8')).toBe('hi\n');
  });

  it('attaches a structuredPatch for a new file', async () => {
    const r = await WriteTool.execute({ file_path: 'x.txt', content: 'line1\nline2\n' }, ctx);
    expect(r.structuredPatch).toBeDefined();
    expect(r.structuredPatch!.length).toBeGreaterThan(0);
  });

  // Regression pin (2026-08-10 review, Claim 2 -- THE HEADLINE ITEM): Write's
  // overwrite guard only checked registry PRESENCE ("was this path ever Read
  // this session"), never freshness -- unlike Edit. Opus 5's transcript
  // demonstrated it: a Read at tool-call 11, an unrelated Write at tool-call 38
  // (27 calls later, file changed on disk in between) still succeeded with "no
  // complaint". Mirrors Edit's check; since 2026-09-16 both compare CONTENTS
  // (see tools/file-fingerprint.ts), so the same-mtime edit below is the case
  // that matters.
  it('rejects overwriting a file whose contents changed since it was read, even with the same mtime (mirrors Edit)', async () => {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'old\n');
    await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    const { atime, mtime } = fs.statSync(p);
    fs.writeFileSync(p, 'old but different\n');
    fs.utimesSync(p, atime, mtime);
    const r = await WriteTool.execute({ file_path: 'a.txt', content: 'new\n' }, ctx);
    expect(r.isError).toBe(true);
    // Must name the mechanism, not just "changed" — the gate's invisibility is
    // what four round-8 models misdiagnosed.
    expect(r.text).toMatch(/changed on disk since you last Read or Wrote it/i);
    expect(r.text).toMatch(/contents no longer match/i);
    // The file on disk must be untouched by the rejected write.
    expect(fs.readFileSync(p, 'utf8')).toBe('old but different\n');
  });

  it('allows overwriting after a touch that changed no bytes', async () => {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'old\n');
    await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(p, future, future);
    const r = await WriteTool.execute({ file_path: 'a.txt', content: 'new\n' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(p, 'utf8')).toBe('new\n');
  });

  it('allows overwriting when the read is still fresh (no intervening on-disk change)', async () => {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'old\n');
    await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    const r = await WriteTool.execute({ file_path: 'a.txt', content: 'new\n' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(p, 'utf8')).toBe('new\n');
  });

  it('allows writing a brand-new file with no prior read (nothing to be stale about)', async () => {
    const r = await WriteTool.execute({ file_path: 'brand-new.txt', content: 'hi\n' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, 'brand-new.txt'), 'utf8')).toBe('hi\n');
  });

  it('editing a just-Written file still works (Write plants a fresh read-registry entry)', async () => {
    await WriteTool.execute({ file_path: 'w.txt', content: 'v1\n' }, ctx);
    const r = await EditTool.execute({ file_path: 'w.txt', old_string: 'v1', new_string: 'v2' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, 'w.txt'), 'utf8')).toBe('v2\n');
  });
});

// 2026-08-11 review round 8: the read-before-edit gate was correct in every
// transcript, and four of six models still misdiagnosed it — as broken, as
// Grep-transparent, as "inconsistent, priority fix". The gate's STATE is
// invisible: nothing tells a model which paths are registered or with what
// stamp. These pin the in-band signals that make it predictable. They assert on
// message CONTENT deliberately — the content IS the fix here, not incidental.
describe('the read gate explains itself', () => {
  it('the refusal names both tools that satisfy the gate, and says a shell view does not', async () => {
    fs.writeFileSync(path.join(dir, 'ungated.txt'), 'hello\n');
    const r = await EditTool.execute({ file_path: 'ungated.txt', old_string: 'hello', new_string: 'bye' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Read or Written/);
    expect(r.text).toMatch(/cat.*grep|grep.*cat/);
    // The mechanism, not just the rule — this is what Opus 5 alone worked out.
    expect(r.text).toMatch(/records the file.s contents/);
  });

  it('a successful Write says out loud that it counts as a Read', async () => {
    const r = await WriteTool.execute({ file_path: 'fresh.txt', content: 'v1\n' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/counts as having Read it/);
  });

  it('both tools describe the same gate in the same terms', () => {
    for (const d of [EditTool.description, WriteTool.description]) {
      expect(d).toMatch(/Read or Written/);
      expect(d).toMatch(/record the file.s contents/);
    }
  });
});

describe('Bash', () => {
  it('echo round-trips through the shell', async () => {
    const r = await BashTool.execute({ command: 'echo hello-world' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('hello-world');
  });

  it('a non-zero exit is an error and reports the code', async () => {
    const r = await BashTool.execute({ command: 'exit 3' }, ctx);
    expect(r.isError).toBe(true);
    // The exit code now lives in the metadata line, not a leading prefix — it
    // used to duplicate the same fact in two places once Task 4 added the line.
    expect(r.text).toContain('· exit 3]');
    expect(r.text).not.toContain('(exit code 3)');
  });

  it('Bash reports the TRUE output size, not the size of its retained buffer', async () => {
    // 400k of output — past the old 200k accumulator ceiling. The old code
    // reported the CAPPED buffer's length as "chars total", i.e. a number it
    // invented. Regression pin for the 2026-08-01 review finding.
    const r = await BashTool.execute(
      { command: `node -e "process.stdout.write('z'.repeat(400000))"` },
      ctx,
    );
    // Fix (2026-08-06): was labeled 'bytes' but always counted JS string
    // length (UTF-16 code units) — see the two tests below for the mismatch
    // this produced on multi-byte and coloured output.
    expect(r.bounds?.unit).toBe('chars');
    expect(r.bounds?.total).toBe(400_000);
    // D-1 (2026-08-26): the hint used to say "pipe through head/tail/grep",
    // which hides the exit code (no pipefail). It now points at the saved file.
    expect(r.bounds?.moreHint).toMatch(/Read that file/);
    expect(r.bounds?.moreHint).not.toMatch(/head\/tail\/grep/);
    expect(r.text).not.toContain('204800');
  }, 30_000);

  // Fix (2026-08-06 review, elevated minor's Bash sibling finding): the unit
  // said 'bytes' but the code always counted `.length` on the JS string
  // `String(d)` decodes stdout into — UTF-16 code units, not real UTF-8 bytes.
  // For any character outside the ASCII range those two numbers diverge.
  it('labels a multi-byte-character run in the currency it actually counted (chars, not inflated bytes)', async () => {
    // U+4F60 ("you") is one UTF-16 code unit but three UTF-8 bytes: 60,000
    // repeats is 60,000 chars but 180,000 real bytes. Reporting either number
    // is defensible; reporting 60,000 while LABELING it "bytes" is not.
    const r = await BashTool.execute(
      { command: `node -e "process.stdout.write('\\u4f60'.repeat(60000))"` },
      ctx,
    );
    expect(r.bounds?.unit).toBe('chars');
    // Not an exact 60,000: a multi-byte character CAN straddle a pipe chunk
    // boundary and decode to a stray replacement char, so pin a tight range
    // instead of a brittle exact count. The number that matters is that it is
    // nowhere near the real UTF-8 byte count (180,000) — a wire-byte number
    // would be a lie under the label 'chars', and a char-count under the
    // label 'bytes' (the pre-fix bug) is the lie this test guards against.
    expect(r.bounds?.total).toBeGreaterThan(55_000);
    expect(r.bounds?.total).toBeLessThan(65_000);
    expect(r.text).toContain('chars output');
    expect(r.text).not.toContain('bytes output');
  }, 30_000);

  // Fix (2026-08-06 review): `shown` used to be measured AFTER stripAnsi ran
  // (on the text the model actually reads) while `total` (totalChars) was
  // measured BEFORE it, as raw chunks streamed in — two different currencies
  // in the same "showing N of M" line. A coloured 3,000-line run pinned the
  // symptom directly: "showing 21491 of 117000 bytes", where 117000 counted
  // escape sequences 21491 did not. This pins that shown and total are now
  // measured at the SAME point (before the ANSI strip), by checking that
  // `shown` is honest about still including the colour-code overhead — i.e.
  // it is NOT silently equal to the length of the ANSI-free text the model
  // actually sees, which is what the old post-strip `shown` was.
  it('measures shown and total in the same currency for coloured output that crosses the retention window', async () => {
    const r = await BashTool.execute(
      {
        command: `node -e "for(let i=0;i<3000;i++)process.stdout.write('\\u001b[32mline'+i+'\\u001b[39m\\n')"`,
      },
      ctx,
    );
    expect(r.bounds).toBeDefined();
    expect(r.bounds?.unit).toBe('chars');
    expect(r.bounds!.total as number).toBeGreaterThanOrEqual(r.bounds!.shown);
    // The ANSI-free body the model actually reads (metadata line split off).
    const visibleBody = r.text.split('\n[cwd:')[0];
    expect(r.text).not.toMatch(/\x1b\[/); // colour codes never reach the model
    // `shown` still counts the stripped-out escape sequences (same currency
    // as `total`), so it must exceed the length of what's actually visible —
    // the pre-fix bug was `shown === visibleBody.length` exactly.
    expect(r.bounds!.shown).toBeGreaterThan(visibleBody.length);
  }, 30_000);

  it('Bash declares no bounds for small output', async () => {
    const r = await BashTool.execute({ command: 'echo hi' }, ctx);
    expect(r.bounds).toBeUndefined();
  });

  // Regression pin for the 30k-71.5k "dead zone" (2026-08-06 review): the old
  // `if (head.length < HEAD_CHARS) head += s` guard checked BEFORE appending, so
  // a chunk that crossed the boundary was retained whole — a single pipe read
  // could push retention past 71k before Bash's own `dropped` flag ever tripped,
  // while defineTool's pipeline cap (30_000) fired regardless. Everything in
  // between landed in composeNotice's no-bounds fallback: a bare "[output
  // truncated: showing N of M chars]" with NO moreHint. 50,000 chars sits
  // squarely inside that old dead zone (above the 30k pipeline cap, below the
  // ~71.5k the old accumulator actually retained) — this pins that Bash now
  // declares its own bounds there instead of falling through to the pipeline's
  // uninformative notice.
  it('Bash declares bounds (not the bare pipeline notice) for output in the old 30k-71.5k dead zone', async () => {
    const r = await BashTool.execute(
      { command: `node -e "process.stdout.write('z'.repeat(50000))"` },
      ctx,
    );
    expect(r.bounds).toBeDefined();
    expect(r.bounds?.moreHint).toBeTruthy();
    expect(r.bounds?.moreHint?.length).toBeGreaterThan(0);
    // The bare no-bounds fallback string from composeNotice (truncate.ts) —
    // must NOT appear once Bash declares its own bounds for this size.
    expect(r.text).not.toContain('[output truncated: showing');
  }, 30_000);

  it('Bash always states the cwd and exit code', async () => {
    const r = await BashTool.execute({ command: 'echo hi' }, ctx);
    expect(r.text).toContain(`[cwd: ${dir} · exit 0]`);
  });

  it('Bash states a non-zero exit in the metadata line, not as a prefix', async () => {
    const r = await BashTool.execute({ command: 'exit 42' }, ctx);
    expect(r.text).toContain('· exit 42]');
    expect(r.text).not.toContain('(exit code 42)');
  });

  // Regression pin: the original "(no output, exit N)" fallback text was lost
  // when the unconditional metadata line replaced the old block — a command
  // that produced NO stdout/stderr resolved to a bare leading blank line
  // followed only by the metadata line, giving no positive signal that the
  // command ran and simply produced nothing.
  it('a command that exits non-zero with no output gets a readable "(no output)" body, not a leading blank line', async () => {
    const r = await BashTool.execute({ command: 'exit 3' }, ctx);
    expect(r.text).toContain('(no output)');
    expect(r.text).not.toMatch(/^\n/);
    expect(r.text.startsWith('(no output)')).toBe(true);
  });

  it('Bash reports the tracked cwd after a cd, so the model never has to guess', async () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    let tracked: string | undefined;
    const c: ToolContext = { ...makeCtx(dir), shellCwd: undefined, setShellCwd: (n) => { tracked = n; } };
    const r = await BashTool.execute({ command: 'cd sub' }, c);
    expect(tracked).toBe(path.join(dir, 'sub'));
    expect(r.text).toContain(`[cwd: ${path.join(dir, 'sub')} · exit 0]`);
  });

  it('Bash still reports the cwd when the command timed out', async () => {
    const r = await BashTool.execute({ command: 'sleep 5', timeout: 500 }, ctx);
    expect(r.text).toContain('Command timed out after 500ms.');
    expect(r.text).toContain('[cwd:');
  }, 15_000);

  it('Bash strips ANSI colour codes from output', async () => {
    const r = await BashTool.execute(
      { command: `node -e "process.stdout.write('\\u001b[32m✓\\u001b[39m passed')"` },
      ctx,
    );
    expect(r.text).toContain('✓ passed');
    expect(r.text).not.toContain('\x1b[');
  });

  it('Bash sets NO_COLOR so tools emit plain output in the first place', async () => {
    const r = await BashTool.execute({ command: 'echo "NO_COLOR=$NO_COLOR FORCE_COLOR=$FORCE_COLOR"' }, ctx);
    expect(r.text).toContain('NO_COLOR=1');
    expect(r.text).toContain('FORCE_COLOR=0');
  });

  it('ANSI stripping does not disturb the cwd sentinel', async () => {
    fs.mkdirSync(path.join(dir, 'coloured'));
    let tracked: string | undefined;
    const c: ToolContext = { ...makeCtx(dir), setShellCwd: (n) => { tracked = n; } };
    await BashTool.execute(
      { command: `node -e "process.stdout.write('\\u001b[31mred\\u001b[0m')" && cd coloured` },
      c,
    );
    expect(tracked).toBe(path.join(dir, 'coloured'));
  });

  it('times out and reports it', async () => {
    const r = await BashTool.execute({ command: 'node -e "setTimeout(()=>{},10000)"', timeout: 50 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/timed out/i);
  });

  it('a spawn-level failure resolves a structured error that names the cwd', async () => {
    // A bad startCwd makes spawn fail. The PATH differs by platform: on POSIX a
    // file-cwd throws SYNCHRONOUSLY (before the 'error' handler can attach — the
    // trap the try/catch guards); on Windows the shell spawn fails ASYNCHRONOUSLY
    // via 'error' (ENOENT). Either way the result must be a structured error that
    // NAMES the offending cwd — never a context-free `Bash failed: spawn <CODE>`.
    // (ctx.cwd = a FILE reaches spawn because bash.ts only guards shellCwd.)
    const fileCwd = path.join(dir, 'not-a-dir.txt');
    fs.writeFileSync(fileCwd, 'x');
    const r = await BashTool.execute({ command: 'echo hi' }, makeCtx(fileCwd));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Failed to start shell/);
    expect(r.text).toContain(fileCwd); // named on BOTH the sync and async paths
  });

  // Scoped persistence (ROADMAP 2026-07-17). Before this, every call spawned
  // fresh at the session root and `cd` silently evaporated — the failure mode
  // that burned ~6 tool calls in the 2026-07-17 session.
  describe('scoped cwd persistence', () => {
    function trackingCtx(root: string): ToolContext {
      const c = makeCtx(root);
      c.setShellCwd = (next) => {
        c.shellCwd = next;
      };
      return c;
    }

    // Must mirror withCwdProbe()'s `pwd -W 2>/dev/null || pwd` — a bare `pwd`
    // makes these assertions fail on WINDOWS ONLY. Git Bash mounts %TEMP% at
    // /tmp, so inside a mkdtemp sandbox bare `pwd` prints /tmp/native-tools-xxx;
    // fs.realpathSync() then resolves that leading slash against the runner's
    // CURRENT DRIVE (D: on GitHub's windows-latest) -> ENOENT 'D:\tmp'. `pwd -W`
    // is the MSYS builtin that emits a real Win32 path instead. Broke the
    // 2026-07-19 beta build; the tool itself was never wrong. (POSIX: -W is
    // invalid, the `|| pwd` fallback takes over, stderr suppressed.)
    const PWD = 'pwd -W 2>/dev/null || pwd';

    // Same 8.3 trap the tool itself hit: plain fs.realpathSync leaves a SHORT
    // root (C:\Users\RUNNER~1\...) short while `pwd -W` reports the LONG form
    // (C:\Users\runneradmin\...) for the very same directory, so comparing the
    // two never matches on Windows. .native canonicalizes both. Compare paths
    // through this, never through raw realpathSync.
    const canon = (p: string) => {
      try {
        return fs.realpathSync.native(p);
      } catch {
        return fs.realpathSync(p);
      }
    };

    // Task 4 appends an unconditional `\n[cwd: ... · exit N]` metadata line after
    // the command's own output, so a raw `.trim()` on `r.text` is no longer just
    // the command's stdout — it also swallows the metadata line, which broke
    // every one of these tests' path comparisons (ENOENT on a two-line string).
    // Split it back off so these tests keep checking the actual command output.
    const cmdOutput = (text: string) => text.split('\n[cwd:')[0].trim();

    it('a cd carries to the next call and the sentinel never reaches the model', async () => {
      fs.mkdirSync(path.join(dir, 'sub'));
      const c = trackingCtx(dir);
      const first = await BashTool.execute({ command: 'cd sub && echo moved' }, c);
      expect(first.text).toContain('moved');
      expect(first.text).not.toContain('__YC_CWD__');
      const second = await BashTool.execute({ command: PWD }, c);
      // A cd INTO a workspace subdir must never trip the scope guard. Windows-only
      // regression (2026-07-19): isInside() compared an 8.3 SHORT root against a
      // LONG candidate, so this fired on every cd and reverted it. The two
      // assertions below can't catch that alone — they expect the ROOT, which is
      // also what a fully broken persistence returns, so they passed vacuously.
      expect(first.text).not.toMatch(/Shell cwd was reset/);
      expect(canon(cmdOutput(second.text))).toBe(canon(path.join(dir, 'sub')));
    });

    it('a cd outside the workspace is reverted WITH a notice (never silent)', async () => {
      const c = trackingCtx(dir);
      const r = await BashTool.execute({ command: `cd ${JSON.stringify(os.tmpdir())}` }, c);
      expect(r.text).toMatch(/Shell cwd was reset to/);
      const after = await BashTool.execute({ command: PWD }, c);
      expect(canon(cmdOutput(after.text))).toBe(canon(dir));
    });

    // 2026-08-11 review round 8: the notice used to trail the output, so a model
    // reading top-down acted on results from a directory it no longer sat in
    // before reaching the line saying so. It must LEAD.
    it('the reset notice comes before the command output, not after it', async () => {
      const c = trackingCtx(dir);
      const r = await BashTool.execute(
        { command: `cd ${JSON.stringify(os.tmpdir())} && echo MARKER_AFTER_THE_CD` },
        c,
      );
      const noticeAt = r.text.indexOf('Shell cwd was reset to');
      const outputAt = r.text.indexOf('MARKER_AFTER_THE_CD');
      expect(noticeAt).toBeGreaterThanOrEqual(0);
      expect(outputAt).toBeGreaterThanOrEqual(0);
      expect(noticeAt).toBeLessThan(outputAt);
    });

    it('the probe preserves the command exit code', async () => {
      const r = await BashTool.execute({ command: 'exit 3' }, trackingCtx(dir));
      expect(r.isError).toBe(true);
      expect(r.text).toContain('· exit 3]');
    });

    it('falls back to the root when the tracked dir was deleted', async () => {
      const gone = path.join(dir, 'gone');
      fs.mkdirSync(gone);
      const c = trackingCtx(dir);
      await BashTool.execute({ command: 'cd gone' }, c);
      fs.rmSync(gone, { recursive: true });
      const r = await BashTool.execute({ command: PWD }, c);
      expect(r.isError).toBeFalsy();
      expect(canon(cmdOutput(r.text))).toBe(canon(dir));
    });

    // Regression (2026-07-18): without a trailing newline after the sentinel, a
    // background writer's output concatenated onto the path — garbage cwd, a
    // spurious reset notice, and the late text silently dropped from the result.
    it('output arriving AFTER the sentinel is preserved and does not corrupt the cwd', async () => {
      fs.mkdirSync(path.join(dir, 'sub'));
      const c = trackingCtx(dir);
      const r = await BashTool.execute(
        { command: 'cd sub && { sleep 0.2; echo LATE-OUTPUT >&2; } &' },
        c,
      );
      expect(r.text).toContain('LATE-OUTPUT'); // not swallowed
      expect(r.text).not.toMatch(/Shell cwd was reset/); // no spurious notice
      expect(String(c.shellCwd ?? dir)).not.toContain('LATE-OUTPUT'); // path never corrupted
    });

    // Regression (2026-07-18): the 200KB accumulator cap dropped the trailing
    // sentinel on chatty commands, silently losing the cd.
    it('a cd survives a command that blows past the output cap', async () => {
      fs.mkdirSync(path.join(dir, 'sub'));
      const c = trackingCtx(dir);
      await BashTool.execute(
        { command: `cd sub && node -e "for(let i=0;i<3000;i++)console.log('X'.repeat(100))"` },
        c,
      );
      const after = await BashTool.execute({ command: PWD }, c);
      expect(canon(cmdOutput(after.text))).toBe(canon(path.join(dir, 'sub')));
    });

    // Regression (2026-07-18): a dangling `&&` absorbs the probe's `__yc_rc=$?`
    // line, so `exit $__yc_rc` fell through to printf's status — a FAILED
    // command reported success. Malformed commands must skip the probe.
    it('a dangling && does not mask a failing command as success', async () => {
      const r = await BashTool.execute({ command: 'false &&' }, trackingCtx(dir));
      expect(r.isError).toBe(true);
    });

    it('a context without setShellCwd still works (stateless fallback)', async () => {
      const r = await BashTool.execute({ command: 'echo plain' }, makeCtx(dir));
      expect(cmdOutput(r.text)).toBe('plain');
    });
  });

  // 17/17 harness reviews across four rounds (2026-08-01 through 2026-08-09)
  // flagged the same thing: cwd persists between calls but env does not, and the
  // failure is SILENT — the second call just runs without the state and nothing
  // says why. Two fixes: a warning at the moment of the mistake, and an opt-in
  // `persistent_env` escape hatch. Default behavior (env stays ephemeral) must
  // not change — Opus 5 was the one dissenting voice defending that tradeoff.
  describe('env-state warning + opt-in persistence (persistent_env)', () => {
    function envTrackingCtx(root: string): ToolContext {
      const c = makeCtx(root);
      c.setShellCwd = (next) => {
        c.shellCwd = next;
      };
      c.setShellEnv = (next) => {
        c.shellEnv = next;
      };
      return c;
    }

    it('warns when an exported var is never used in the same call', async () => {
      const r = await BashTool.execute({ command: 'export FOO=bar' }, ctx);
      expect(r.text).toContain('export FOO');
      expect(r.text).toMatch(/won't persist/);
    });

    it('does NOT warn when the exported var is consumed in the same call (correct usage, not a mistake)', async () => {
      const r = await BashTool.execute({ command: 'export FOO=bar && echo $FOO' }, ctx);
      expect(r.text).not.toMatch(/won't persist/);
    });

    it('does NOT warn when persistent_env is on for that call', async () => {
      const r = await BashTool.execute(
        { command: 'export FOO=bar', persistent_env: true },
        envTrackingCtx(dir),
      );
      expect(r.text).not.toMatch(/won't persist/);
    });

    it('warns on a bare `source` (the venv case) when nothing after it consumes the activation', async () => {
      // No real venv needed — the warning fires on the shape of the command
      // (a bare source/. as the last statement), not on venv-specific detection.
      fs.writeFileSync(path.join(dir, 'act.sh'), 'export ACTIVATED=1\n');
      const r = await BashTool.execute({ command: 'source act.sh' }, ctx);
      expect(r.text).toMatch(/won't persist/);
    });

    it('a persistent_env call carries an exported var to the NEXT call', async () => {
      const c = envTrackingCtx(dir);
      const first = await BashTool.execute(
        { command: 'export MY_TOKEN=abc123', persistent_env: true },
        c,
      );
      expect(first.isError).toBeFalsy();
      const second = await BashTool.execute({ command: 'echo "got:$MY_TOKEN"' }, c);
      expect(second.text).toContain('got:abc123');
    });

    it('a normal call (no persistent_env) does NOT carry an exported var to the next call — default behavior unchanged', async () => {
      const c = envTrackingCtx(dir);
      await BashTool.execute({ command: 'export MY_TOKEN=abc123' }, c);
      const second = await BashTool.execute({ command: 'echo "got:$MY_TOKEN"' }, c);
      expect(second.text).toContain('got:');
      expect(second.text).not.toContain('abc123');
    });

    it('cwd persistence is unaffected by env persistence running in the same call', async () => {
      fs.mkdirSync(path.join(dir, 'sub'));
      const c = envTrackingCtx(dir);
      await BashTool.execute(
        { command: 'cd sub && export MY_TOKEN=abc123', persistent_env: true },
        c,
      );
      const second = await BashTool.execute({ command: 'pwd -W 2>/dev/null || pwd' }, c);
      const secondOutput = second.text.split('\n[cwd:')[0].trim();
      expect(secondOutput.replace(/\\/g, '/')).toContain('/sub');
      expect(second.text).not.toMatch(/Shell cwd was reset/);
    });
  });

  it('an aborted signal kills the child', async () => {
    const ac = new AbortController();
    const actx = makeCtx(dir, ac.signal);
    const promise = BashTool.execute({ command: 'node -e "setTimeout(()=>{},10000)"' }, actx);
    setTimeout(() => ac.abort(), 100);
    const r = await promise;
    // Killed → non-zero/null exit surfaces as an error result, not a hang.
    expect(r.isError).toBe(true);
  });

  // Pin for the PowerShell fallback (Windows without Git Bash): probe === false,
  // so the tool must be stateless — no __YC_CWD__ wrapping — and effectiveCwd
  // must fall back to startCwd unconditionally, since PowerShell has no cwd
  // tracking. Same fs/which-mocking technique as
  // tests/harness-bash-shell-detect.test.ts, but scoped to THIS ONE test via
  // vi.doMock + vi.resetModules + a dynamic import — a file-level vi.mock('fs')
  // here would silently break every other test in this file that writes real
  // fixtures with fs.writeFileSync (Read/Write/Edit/Glob/Grep all do). The
  // statically-imported `BashTool` used by every other test in this file is
  // bound at file-load time and is unaffected by resetModules mid-run.
  describe('on Windows without Git Bash (probe === false)', () => {
    const realPlatform = process.platform;
    afterEach(async () => {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      vi.doUnmock('fs');
      vi.doUnmock('which');
      vi.resetModules();
    });

    it('runs stateless: no cwd-probe wrapping, and the metadata line still reports the start directory', async () => {
      vi.doMock('fs', async (importActual) => {
        const actual = await importActual<typeof import('fs')>();
        return { ...actual, existsSync: () => false }; // no Git Bash anywhere on the machine
      });
      vi.doMock('which', () => ({ sync: () => null })); // git itself not on PATH either
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      vi.resetModules();
      vi.spyOn(console, 'warn').mockImplementation(() => {}); // detectShell's fallback warning
      spawnSpy.mockClear();

      const winBash = await import('../src/main/harness/tools/bash');
      winBash.resetShellCache();
      expect(winBash.getShell().label).toBe('PowerShell'); // confirms the fallback actually engaged

      const r = await winBash.BashTool.execute({ command: 'echo hi' }, ctx);

      // Stateless: the command must reach spawn() UNWRAPPED — no CWD_SENTINEL,
      // no `pwd -W` probe appended. PowerShell has no $PWD-persistence story
      // (tracksCwdFor() explicitly excludes it), so shipping it a bash-shaped
      // wrapper would be a syntax error, not a no-op.
      const call = spawnSpy.mock.calls.at(-1);
      expect(call?.[1]?.at(-1)).toBe('echo hi');

      // effectiveCwd falls back to startCwd unconditionally when !probe (the
      // `if (probe) {...}` cwd-extraction block never runs) — the metadata line
      // must still name the directory the command actually ran in, regardless of
      // whether spawning powershell.exe itself succeeds on this machine.
      expect(r.text).toContain(`[cwd: ${dir} ·`);
    }, 30_000);
    // ^ WHY the explicit timeout: on a real Windows runner this test genuinely
    // spawns powershell.exe (spawnSpy is a passthrough), after resetModules +
    // a cold re-import of the bash module. A cold PowerShell start on a CI box
    // routinely blows vitest's 5,000ms default — Windows CI failed here as
    // "Test timed out in 5000ms", never on an assertion. Same precedent as the
    // wrap-up tests in harness-review-runner.test.ts (16a9adb5).
  });

  // 2026-08-10 review: reviewers measured a `seq 1 20000` costing ~7k tokens
  // of pure noise at the OLD ~28,000-char cap ("more expensive than everything
  // else combined"). New contract: ~4,000-char head+tail sandwich, line-aware
  // cut, full output always spilled to disk on overflow, path named in the
  // notice. See docs/active/investigations/2026-08-10-harness-output-truncation-prior-art.md.
  describe('output cap tightening', () => {
    const seqCmd = `node -e "for(let i=1;i<=20000;i++)console.log(i)"`;
    const visibleBody = (text: string) => text.split('\n[cwd:')[0];

    afterEach(() => {
      // Best-effort: don't leave spill files behind between test runs.
      try {
        // THIS run's spill dir only — never the shared parent, and never
        // another process's sibling (see TEST_SESSION_ID above).
        fs.rmSync(path.join(os.tmpdir(), 'youcoded-harness-bash-output', TEST_SESSION_ID), { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
      } catch {
        /* best-effort */
      }
    });

    it('caps the visible slice at roughly 4,000 chars, not the old ~28,000', async () => {
      const r = await BashTool.execute({ command: seqCmd }, ctx);
      // Generous margin over the 4,000-char target (marker + minor overhead),
      // but must be an order of magnitude below the old ~28,000-char body.
      expect(visibleBody(r.text).length).toBeLessThan(4_500);
    }, 30_000);

    it('keeps BOTH ends — the head+tail sandwich, not tail-only or head-only', async () => {
      const r = await BashTool.execute({ command: seqCmd }, ctx);
      const body = visibleBody(r.text);
      expect(body.startsWith('1\n')).toBe(true); // the very first line the command printed
      expect(body.trimEnd().endsWith('20000')).toBe(true); // the very last line
      expect(body).toContain('[...]'); // the elision marker sits between them
    }, 30_000);

    it('the cut is line-aware: no line at the boundary is corrupted mid-token', async () => {
      const r = await BashTool.execute({ command: seqCmd }, ctx);
      const body = visibleBody(r.text);
      for (const line of body.split('\n')) {
        if (line === '[...]' || line === '') continue;
        // A character-based cut (the old bug) would produce a truncated
        // numeral like '46' where '4621' should be — every surviving line
        // must be a clean, complete integer.
        expect(line).toMatch(/^\d+$/);
      }
    }, 30_000);

    it('spills the full output to disk on overflow and names the real path in the result', async () => {
      const r: any = await BashTool.execute({ command: seqCmd }, ctx);
      expect(r.truncated).toBe(true);
      expect(r.outputPath).toBeTruthy();
      expect(fs.existsSync(r.outputPath)).toBe(true);
      const spilled = fs.readFileSync(r.outputPath, 'utf8');
      // The elided middle (e.g. line 10000) is NOT in the visible slice but
      // MUST be present in the spill file — that's the whole point of spilling.
      expect(visibleBody(r.text)).not.toContain('\n10000\n');
      expect(spilled).toContain('10000');
      expect(spilled).toContain('1\n2\n3'); // head survives in the file too
      expect(r.text).toContain(r.outputPath); // the notice names the real path
    }, 30_000);

    it('does not spill and declares no bounds when output fits inline', async () => {
      const r: any = await BashTool.execute({ command: 'echo hi' }, ctx);
      expect(r.truncated).toBe(false);
      expect(r.outputPath).toBeUndefined();
      expect(r.bounds).toBeUndefined();
    });

    // 2026-08-11 review round 8: truncation trips on chars OR lines, but the
    // metadata only ever quoted chars — a short, line-capped result announced
    // "900 chars output, showing 900" and read as complete.
    // The description is the ONLY place a model learns what "truncated" means
    // before it sees one. It named the char cap and not the line cap, which is
    // the one that usually fires first.
    it('the description names BOTH truncation triggers', () => {
      const d = BashTool.description;
      expect(d).toContain('4,000 chars');
      expect(d).toContain('100 lines');
    });

    it('a line-capped result reports the line dimension, not just chars', async () => {
      // 120 short lines: ~700 chars total, nowhere near the 4,000-char cap, so
      // LINES are the only reason this is truncated.
      const r = await BashTool.execute(
        { command: `node -e "for(let i=1;i<=120;i++)console.log('L'+i)"` },
        ctx,
      );
      expect(r.truncated).toBe(true);
      // Exactly 120 — not 121 (trailing-newline overcount) and not 123 (probe sentinel).
      // The LINE count is pinned exactly (that is the fix); the char count is
      // not, because it is platform-sensitive and pinning it would put this
      // suite back on the Windows-red list it has been on twice this month.
      expect(r.text).toMatch(/\d+ chars \/ 120 lines output, showing \d+ chars \/ 100 lines/);
      // …and the elision hint must agree with it: 120 total - 100 shown.
      expect(r.bounds?.moreHint).toContain('20 lines elided');
    }, 30_000);

    it('a single-huge-line result stays in chars and never claims "0 lines shown"', async () => {
      // One 60,000-char line trips only the char cap; head/tail each take a
      // partial line, so a line count here would read as "showing 0 lines"
      // beside 4,000 visible chars.
      const r = await BashTool.execute(
        { command: `node -e "process.stdout.write('x'.repeat(60000))"` },
        ctx,
      );
      expect(r.truncated).toBe(true);
      expect(r.text).toContain('chars output, showing');
      expect(r.text).not.toMatch(/showing \d+ chars \/ 0 lines/);
    }, 30_000);

    it('the notice names the elided line count, the total, and a next action', async () => {
      const r = await BashTool.execute({ command: seqCmd }, ctx);
      expect(r.bounds?.moreHint).toMatch(/lines elided/);
      expect(r.bounds?.moreHint).toMatch(/head|tail|grep/);
      expect(r.text).toMatch(/lines elided/);
    }, 30_000);

    // vi.spyOn cannot override an ESM named export directly ("Module namespace
    // is not configurable"), so this uses the same vi.doMock + vi.resetModules +
    // dynamic-import technique the "on Windows without Git Bash" suite below
    // already relies on — scoped to THIS ONE test, restored in the finally, so
    // it can't leak into any other test in this file that writes real fixtures.
    it('is honest when the spill write itself fails, instead of claiming a fake path', async () => {
      vi.doMock('fs', async (importActual) => {
        const actual = await importActual<typeof import('fs')>();
        return {
          ...actual,
          mkdirSync: () => {
            throw new Error('EACCES: permission denied (simulated)');
          },
        };
      });
      vi.resetModules();
      try {
        const failing = await import('../src/main/harness/tools/bash');
        const r: any = await failing.BashTool.execute({ command: seqCmd }, ctx);
        expect(r.outputPath).toBeUndefined();
        expect(r.text).toMatch(/could NOT be saved to disk/);
        expect(r.text).toContain('EACCES');
      } finally {
        vi.doUnmock('fs');
        vi.resetModules();
      }
    }, 30_000);
  });

  describe('timeout representation', () => {
    it('reports a sentinel exit code (124), a typed timedOut flag, and SIGKILL-aware prose', async () => {
      const r: any = await BashTool.execute({ command: 'sleep 5', timeout: 500 }, ctx);
      expect(r.isError).toBe(true);
      expect(r.text).toContain('· exit 124]');
      expect(r.timedOut).toBe(true);
      expect(r.text).toMatch(/force-killed|SIGKILL/);
      expect(r.text).toMatch(/incomplete/);
    }, 15_000);

    it('a normal non-zero exit is NOT reported as timedOut', async () => {
      const r: any = await BashTool.execute({ command: 'exit 3' }, ctx);
      expect(r.timedOut).toBe(false);
      expect(r.text).toContain('· exit 3]');
    });
  });

  // Requirement B (2026-08-10, this fix) -- the harder mirror image of
  // shellCwdMissHint (guards.ts): Bash resolves a relative path from its OWN
  // persisted cwd, not the workspace root, so a `cd` several calls back can
  // make a previously-safe relative path miss with no clue why. Qwen 3.8 Max
  // hit exactly this: `cd config` several calls earlier, then `grep -n port
  // config/app.toml` failed because the shell was already IN config/. The
  // failure happens INSIDE the child process, so the harness only ever sees a
  // non-zero exit and the child's own stderr -- deliberately narrow, per the
  // review requirement: fires only on a genuine non-zero close whose own
  // output names a missing path in the one unambiguous coreutils shape
  // (`tool: path: No such file or directory`), confirmed to exist under the
  // workspace root.
  describe('workspace-root miss hint (Qwen 3.8 Max asymmetry)', () => {
    it("names the workspace-root path when the shell has cd'd elsewhere and a command misses", async () => {
      fs.mkdirSync(path.join(dir, 'config'));
      fs.writeFileSync(path.join(dir, 'config', 'app.toml'), 'port = 1\n');
      const c = makeCtx(dir);
      c.setShellCwd = (next) => {
        c.shellCwd = next;
      };
      await BashTool.execute({ command: 'cd config' }, c);
      expect(c.shellCwd).toBe(path.join(dir, 'config'));
      const r = await BashTool.execute({ command: 'cat config/app.toml' }, c);
      expect(r.isError).toBe(true);
      expect(r.text).toContain(path.join(dir, 'config', 'app.toml'));
      expect(r.text).toContain('workspace root');
    });

    it('adds no hint when the missing path does not exist under the workspace root either', async () => {
      fs.mkdirSync(path.join(dir, 'config'));
      const c = makeCtx(dir);
      c.setShellCwd = (next) => {
        c.shellCwd = next;
      };
      await BashTool.execute({ command: 'cd config' }, c);
      const r = await BashTool.execute({ command: 'cat config/ghost.toml' }, c);
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain('workspace root');
    });

    it('adds no hint when the shell cwd is still the workspace root', async () => {
      const r = await BashTool.execute({ command: 'cat ghost.toml' }, ctx);
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain('workspace root');
    });
  });
});

// Defect 1 (2026-08-11): `pwd` prints the PHYSICAL path, so on a symlinked
// workspace root (macOS /var → /private/var; any symlinked project dir) or a
// Windows 8.3 short root (RUNNER~1 → runneradmin) the shell named the same
// directory a different way than ctx.cwd did. bash.ts compared the two with
// path.resolve, which follows neither symlinks nor 8.3 names, so one directory
// read as a change and the canonical spelling leaked into setShellCwd and the
// [cwd: …] metadata line — handing the model a workspace root it was never
// given, which is the exact confusion that line exists to remove.
describe('Bash cwd vocabulary', () => {
  let real: string;
  let link: string;

  beforeEach(() => {
    real = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-real-'));
    link = path.join(os.tmpdir(), `cwd-link-${process.pid}-${Math.random().toString(36).slice(2)}`);
    fs.symlinkSync(real, link);
    fs.mkdirSync(path.join(real, 'sub'));
  });

  afterEach(() => {
    try { fs.unlinkSync(link); } catch { /* best-effort */ }
    try { fs.rmSync(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); } catch { /* best-effort */ }
  });

  it('rebaseReportedCwd returns the ROOT spelling when the shell reports the resolved one', () => {
    expect(rebaseReportedCwd(link, real)).toBe(link);
  });

  it('rebaseReportedCwd keeps the root spelling for a subdirectory', () => {
    expect(rebaseReportedCwd(link, path.join(real, 'sub'))).toBe(path.join(link, 'sub'));
  });

  it('rebaseReportedCwd returns null for a path outside the root, so the scope guard still fires', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-outside-'));
    try {
      expect(rebaseReportedCwd(link, outside)).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    }
  });

  it('rebaseReportedCwd rejects a sibling directory whose name merely starts with the root name', () => {
    // Fix: the containment check uses `+ path.sep` to prevent a sibling directory
    // whose name is the root's real path with one character appended (e.g., real=/a/b,
    // sibling=/a/bc) from passing the startsWith check and being treated as inside
    // the workspace. Dropping `+ path.sep` would silently widen the scope guard,
    // allowing the session to escape into that sibling. This test pins that invariant.
    const sibling = real + 'c';
    let created = false;
    try {
      fs.mkdirSync(sibling);
      created = true;
      expect(rebaseReportedCwd(link, sibling)).toBeNull();
    } finally {
      if (created) {
        try {
          fs.rmSync(sibling, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
        } catch {
          /* best-effort */
        }
      }
    }
  });

  it('the metadata line names the workspace root the model was given, not the resolved one', async () => {
    const r = await BashTool.execute({ command: 'echo hi' }, makeCtx(link));
    expect(r.text).toContain(`[cwd: ${link} · exit 0]`);
    expect(r.text).not.toContain(real);
  });

  it('a cd inside a symlinked root tracks in the root spelling, and emits no reset notice', async () => {
    let tracked: string | undefined;
    const c: ToolContext = { ...makeCtx(link), shellCwd: undefined, setShellCwd: (n) => { tracked = n; } };
    const r = await BashTool.execute({ command: 'cd sub' }, c);
    expect(tracked).toBe(path.join(link, 'sub'));
    expect(r.text).not.toMatch(/Shell cwd was reset/);
  });

  it('a cd OUTSIDE a symlinked root is still reverted with a notice', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-outside-'));
    try {
      const c: ToolContext = { ...makeCtx(link), shellCwd: undefined, setShellCwd: () => {} };
      const r = await BashTool.execute({ command: `cd ${JSON.stringify(outside)}` }, c);
      expect(r.text).toMatch(/Shell cwd was reset to/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    }
  });
});

describe('Glob', () => {
  it('matches **/*.ts at top level AND in nested dirs, skipping node_modules', async () => {
    fs.writeFileSync(path.join(dir, 'top.ts'), '');
    fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a/b/deep.ts'), '');
    fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/pkg/ignored.ts'), '');
    const r = await GlobTool.execute({ pattern: '**/*.ts' }, ctx);
    expect(r.text).toContain('top.ts');
    expect(r.text).toContain('a/b/deep.ts');
    expect(r.text).not.toContain('ignored.ts');
  });

  it('src/**/*.ts matches both shallow and deep files', async () => {
    fs.mkdirSync(path.join(dir, 'src/deep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/f.ts'), '');
    fs.writeFileSync(path.join(dir, 'src/deep/g.ts'), '');
    const r = await GlobTool.execute({ pattern: 'src/**/*.ts' }, ctx);
    expect(r.text).toContain('src/f.ts');
    expect(r.text).toContain('src/deep/g.ts');
  });

  it('reports no matches with friendly text', async () => {
    const r = await GlobTool.execute({ pattern: '**/*.nomatch' }, ctx);
    expect(r.text).toBe('No files matched.');
  });

  // Ledger G-8 (2026-08-26 native-tools investigation, §6/§8): a bare "*.ts"
  // used to match ONLY files sitting directly in the search root, because the
  // hand-rolled matcher anchors the pattern to the root-relative path. Every
  // model expects Claude Code's behaviour ("*.ts" finds nested files too —
  // Cursor auto-prepends "**/"), and nothing in the description said
  // otherwise, so a model got "No files matched." for files that existed.
  describe('a pattern with no "/" searches every folder (G-8)', () => {
    it('bare *.ts finds nested files, like **/*.ts', async () => {
      fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'top.ts'), '');
      fs.writeFileSync(path.join(dir, 'a/b/deep.ts'), '');
      const r = await GlobTool.execute({ pattern: '*.ts' }, ctx);
      expect(r.text).toContain('top.ts');
      expect(r.text).toContain('a/b/deep.ts');
    });

    it('a pattern containing "/" is matched as written: src/*.ts does NOT recurse', async () => {
      fs.mkdirSync(path.join(dir, 'src/deep'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/f.ts'), '');
      fs.writeFileSync(path.join(dir, 'src/deep/g.ts'), '');
      const r = await GlobTool.execute({ pattern: 'src/*.ts' }, ctx);
      expect(r.text).toContain('src/f.ts');
      expect(r.text).not.toContain('src/deep/g.ts');
    });
  });

  // Ledger G-8, second half: hidden entries (".git/", ".cache/", dotfiles)
  // were the bulk of the walks that hit WALK_CEILING. They are now skipped
  // unless the pattern itself names a dot-leading segment.
  describe('hidden files and folders are skipped unless the pattern names them (G-8)', () => {
    it('**/*.ts skips a hidden folder and a hidden file by default', async () => {
      fs.mkdirSync(path.join(dir, '.cache/sub'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.cache/sub/cached.ts'), '');
      fs.writeFileSync(path.join(dir, '.hidden.ts'), '');
      fs.writeFileSync(path.join(dir, 'shown.ts'), '');
      const r = await GlobTool.execute({ pattern: '**/*.ts' }, ctx);
      expect(r.text).toContain('shown.ts');
      expect(r.text).not.toContain('cached.ts');
      expect(r.text).not.toContain('.hidden.ts');
    });

    it('.github/**/*.yml opts the named hidden folder back in (and no other)', async () => {
      fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.github/workflows/ci.yml'), '');
      fs.mkdirSync(path.join(dir, '.other'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.other/x.yml'), '');
      const r = await GlobTool.execute({ pattern: '.github/**/*.yml' }, ctx);
      expect(r.text).toContain('.github/workflows/ci.yml');
      expect(r.text).not.toContain('.other/x.yml');
    });

    it('**/.env* finds dotfiles at any depth inside visible folders', async () => {
      fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.env'), '');
      fs.writeFileSync(path.join(dir, 'app/.env.local'), '');
      fs.writeFileSync(path.join(dir, 'app/config.ts'), ''); // must NOT match
      // A hidden FOLDER the pattern does not name stays skipped even when it
      // holds a file the last segment would match.
      fs.mkdirSync(path.join(dir, '.cache'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.cache/.env'), '');
      const r = await GlobTool.execute({ pattern: '**/.env*' }, ctx);
      expect(r.text).toContain('.env');
      expect(r.text).toContain('app/.env.local');
      expect(r.text).not.toContain('config.ts');
      expect(r.text).not.toContain('.cache/.env');
    });

    it('the tool and the pattern parameter both say so', () => {
      // The no-slash rule is the surprising one — it belongs on the parameter
      // the model fills in, not only in the tool blurb.
      expect(GlobTool.inputSchema.shape.pattern.description).toMatch(/no "\/"/);
      expect(GlobTool.description).toMatch(/no "\/"/);
      expect(GlobTool.description).toMatch(/hidden files and folders are skipped unless the pattern names them/i);
    });
  });

  // Regression pin (2026-08-10 review, Claim 3): our hand-rolled glob->regex
  // converter used to ESCAPE '{'/'}' as literal characters, so
  // '**/*.{ts,kt,toml}' compiled to a regex requiring the literal substring
  // ".{ts,kt,toml}" in the path -- no real file ever has that -- and the tool
  // returned "No files matched." even though matching files existed. Two
  // reviewing models hit this independently (Kimi K3, Grok 4.5); Kimi called
  // it "the only result in the whole battery I'd call misleading" -- a false
  // negative indistinguishable from a genuinely empty result. See
  // docs/active/investigations/2026-08-10-harness-search-tools-prior-art.md item 1.
  it('expands non-nested brace alternation ({a,b,c}), matching ripgrep/Claude Code semantics', async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), '');
    fs.writeFileSync(path.join(dir, 'b.kt'), '');
    fs.writeFileSync(path.join(dir, 'c.toml'), '');
    fs.writeFileSync(path.join(dir, 'd.json'), ''); // must NOT match
    const r = await GlobTool.execute({ pattern: '**/*.{ts,kt,toml}' }, ctx);
    expect(r.text).toContain('a.ts');
    expect(r.text).toContain('b.kt');
    expect(r.text).toContain('c.toml');
    expect(r.text).not.toContain('d.json');
  });

  // Regression pin (2026-08-10 review, item 4 -- superseding the prior fix's
  // fallback): nested braces are NOT expanded, matching ripgrep's own
  // pre-15.0.0 restriction (the shape our converter follows) -- but a plain
  // "No files matched." is EXACTLY the defect class the original brace finding
  // was about: a syntax failure wearing the costume of an empty result. Kimi K3
  // called that shape "the only result in the whole battery I'd call
  // misleading." Glob must now detect the nested construct and say so
  // specifically, rather than silently compiling a can't-ever-match regex and
  // reporting a plausible-looking empty result.
  it('rejects a nested brace group with a specific message instead of a misleading "No files matched."', async () => {
    fs.writeFileSync(path.join(dir, 'x.ts'), '');
    const r = await GlobTool.execute({ pattern: '**/*.{a,{b,c}}' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).not.toBe('No files matched.');
    expect(r.text).toMatch(/nested/i);
  });

  // Two SEPARATE non-nested groups in one pattern must not false-positive the
  // nested-brace detector (a naive "does the pattern contain more than one {"
  // check would wrongly reject this).
  it('does not flag two separate, non-nested brace groups as nested', async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), '');
    fs.writeFileSync(path.join(dir, 'b.spec.ts'), '');
    const r = await GlobTool.execute({ pattern: '{a,b}*.{ts,tsx}' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('a.ts');
  });

  // Fix (two independent 2026-08 harness reviews, Grok 4.5 + Qwen 3.8 Max --
  // see guards.ts's WHY block above shellCwdMissHint): a missing search root
  // used to fall silently through walk()'s per-directory catch and come back
  // as "No files matched." -- indistinguishable from a genuinely empty, valid
  // directory (the exact defect SHAPE the nested-brace fix above closed for
  // glob syntax).
  describe('shell-cwd miss hint (Grok 4.5 / Qwen 3.8 Max asymmetry)', () => {
    it('a missing search root is now a named miss, not "No files matched."', async () => {
      const r = await GlobTool.execute({ pattern: '*.ts', path: 'ghost-dir' }, ctx);
      expect(r.isError).toBe(true);
      expect(r.text).not.toBe('No files matched.');
      expect(r.text).toContain('does not exist');
    });

    it('names the path when the search root exists relative to the persisted shell cwd', async () => {
      const shellCwd = path.join(dir, 'sub');
      fs.mkdirSync(shellCwd);
      const target = path.join(shellCwd, 'inner');
      fs.mkdirSync(target);
      const c: ToolContext = { ...ctx, shellCwd };
      const r = await GlobTool.execute({ pattern: '*.ts', path: 'inner' }, c);
      expect(r.isError).toBe(true);
      expect(r.text).toContain(target);
      expect(r.text).toContain(shellCwd);
    });

    it('adds no hint when the directory exists nowhere', async () => {
      const shellCwd = path.join(dir, 'sub');
      fs.mkdirSync(shellCwd);
      const c: ToolContext = { ...ctx, shellCwd };
      const r = await GlobTool.execute({ pattern: '*.ts', path: 'ghost-dir' }, c);
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain("It exists relative to the shell's current directory");
    });

    it('adds no hint when the shell cwd equals the workspace root', async () => {
      const c: ToolContext = { ...ctx, shellCwd: dir };
      const r = await GlobTool.execute({ pattern: '*.ts', path: 'ghost-dir' }, c);
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain("It exists relative to the shell's current directory");
    });

    it('still reports the friendly "No files matched." for a real, empty directory', async () => {
      const emptyDir = path.join(dir, 'empty');
      fs.mkdirSync(emptyDir);
      const r = await GlobTool.execute({ pattern: '*.nomatch', path: 'empty' }, ctx);
      expect(r.text).toBe('No files matched.');
      expect(r.isError).toBeFalsy();
    });
  });
});

describe('Grep', () => {
  it('content mode returns line numbers', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'nope\nfindme here\nnope\n');
    const r = await GrepTool.execute({ pattern: 'findme', output_mode: 'content' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/2:.*findme/);
  });

  it('no matches returns friendly text, not an error', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'nothing to see\n');
    const r = await GrepTool.execute({ pattern: 'zzzznotpresent', output_mode: 'content' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('No matches found.');
  });

  it('an aborted search surfaces a cancellation error, not partial success', async () => {
    // Give rg a big tree so it is still running when we abort.
    for (let i = 0; i < 200; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.txt`), Array.from({ length: 500 }, () => 'needle line here').join('\n'));
    }
    const ac = new AbortController();
    const actx = makeCtx(dir, ac.signal);
    const promise = GrepTool.execute({ pattern: 'needle', output_mode: 'content' }, actx);
    ac.abort();
    const r = await promise;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Canceled: the user interrupted this search/);
  });

  it('spawns rg with an explicit cwd of ctx.cwd (never inherits ambient cwd)', async () => {
    // Regression pin for the `spawn ENOTDIR` bug: Grep used to omit `cwd` from
    // spawn(), so rg inherited the Electron main process's ambient cwd — which in
    // the packaged app was not a usable directory and failed EVERY search. The
    // fix passes `cwd: ctx.cwd` explicitly (same pattern as BashTool). Assert the
    // contract directly: the spawn call for THIS search must carry ctx.cwd.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'findme here\n');
    spawnSpy.mockClear();
    const r = await GrepTool.execute({ pattern: 'findme', output_mode: 'content' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/findme/);
    // Find the spawn invocation that ran ripgrep and inspect its options arg.
    const rgCall = spawnSpy.mock.calls.find(
      (c) => Array.isArray(c[1]) && c[1].includes('findme'),
    );
    expect(rgCall, 'expected a spawn call running ripgrep for the search').toBeTruthy();
    const opts = rgCall![2] as { cwd?: string };
    expect(opts?.cwd, 'rg must be spawned with an explicit cwd (ctx.cwd), not inherit ambient cwd').toBe(ctx.cwd);
  });

  it('resolveRgPath rewrites an inside-asar rgPath to the unpacked binary', () => {
    // THE actual `spawn ENOTDIR` root cause (2026-07-20): in the packaged app,
    // @vscode/ripgrep resolves rgPath INSIDE app.asar (a FILE), and spawn() of a
    // command whose path prefix is a file throws ENOTDIR synchronously. The binary
    // IS unpacked to app.asar.unpacked/ — the tool just has to point there. Pin
    // the rewrite against BOTH separators and the no-op cases.
    //
    // Build a real on-disk fixture so the existsSync guard passes: mirror the
    // packaged layout under a tmp dir (.../app.asar.unpacked/.../bin/rg).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rgpath-'));
    const asarPath = path.join(root, 'app.asar', 'node_modules', '@vscode', 'ripgrep-linux-x64', 'bin', 'rg');
    const unpackedPath = path.join(root, 'app.asar.unpacked', 'node_modules', '@vscode', 'ripgrep-linux-x64', 'bin', 'rg');
    fs.mkdirSync(path.dirname(unpackedPath), { recursive: true });
    fs.writeFileSync(unpackedPath, '#!/bin/sh\n');
    try {
      expect(resolveRgPath(asarPath)).toBe(unpackedPath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    }
    // Already-unpacked input is returned unchanged (no app.asar.unpacked.unpacked):
    // the (?!\.unpacked) lookahead must not match. With no unpacked file on disk
    // the guard falls through to returning the input, so this doubles as the pin.
    const rootW = fs.mkdtempSync(path.join(os.tmpdir(), 'rgpath-w-'));
    try {
      const already = path.join(rootW, 'app.asar.unpacked', 'node_modules', '@vscode', 'ripgrep-linux-x64', 'bin', 'rg');
      expect(resolveRgPath(already)).toBe(already);
    } finally {
      fs.rmSync(rootW, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    }
  });

  it('resolveRgPath falls back to the bundled path when no unpacked copy exists', () => {
    // Dev checkout: no asar at all → returned unchanged.
    const devPath = '/home/dev/youcoded/desktop/node_modules/@vscode/ripgrep-linux-x64/bin/rg';
    expect(resolveRgPath(devPath)).toBe(devPath);
    // Packaged-style path but the unpacked binary is ABSENT → keep the bundled
    // path (spawn will error, but with the real path surfaced, not a silent
    // rewrite). Uses a tmp dir so it can't collide with a real install.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rgpath-m-'));
    try {
      const missing = path.join(root, 'app.asar', 'node_modules', '@vscode', 'ripgrep-linux-x64', 'bin', 'rg');
      expect(resolveRgPath(missing)).toBe(missing);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    }
  });

  it('a synchronous spawn throw resolves an error result (never escapes to defineTool)', async () => {
    // spawn() throws SYNCHRONOUSLY when the command path or cwd has a non-directory
    // prefix. cwd = a FILE is the easiest way to force it cross-platform. The
    // 'error' handler (attached after spawn) cannot catch a sync throw, so without
    // the try/catch this escaped as a context-free `Grep failed: spawn ENOTDIR`.
    // Pin: the tool resolves a structured error that NAMES the failing cwd.
    const fileCwd = path.join(dir, 'not-a-dir.txt');
    fs.writeFileSync(fileCwd, 'x');
    const r = await GrepTool.execute({ pattern: 'findme', output_mode: 'content' }, makeCtx(fileCwd));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/could not start ripgrep/);
    expect(r.text).toContain(fileCwd); // the offending path is surfaced, not hidden
  });

  // Regression pin (2026-08-10 review, Claim 4): grep.ts used to pass
  // `--max-count 500` to ripgrep ITSELF for every output_mode, including
  // count -- so ripgrep stopped counting at 500 and the true total was never
  // computed anywhere in the pipeline. 2,400 mirrors fixture-workspace.ts's
  // BIG_MODULE generator (`Array.from({ length: 2_400 }, ...)`), verified by
  // reading that file, not assumed.
  it('count mode reports the true exhaustive total, not the 500-per-file cap', async () => {
    const lines = Array.from({ length: 2_400 }, (_, i) => `export const value${i} = ${i};`);
    fs.writeFileSync(path.join(dir, 'big.ts'), lines.join('\n') + '\n');
    const r = await GrepTool.execute({ pattern: 'export const value', output_mode: 'count' }, ctx);
    expect(r.text).toContain('2400');
    expect(r.text).not.toContain(':500');
  });

  // Same shape as the filesAtMaxCount unit test in harness-tool-bounds.test.ts,
  // exercised end-to-end: `path` naming a single FILE (not a directory) means
  // ripgrep's single-file output format omits the filename column entirely, so
  // the old parser silently never populated its per-file map and the "hit the
  // limit" note never rendered -- same wrong number, minus the disclosure.
  it('the cap-hit disclosure note fires for content mode even when path names a single file', async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `MATCH line ${i}`);
    fs.writeFileSync(path.join(dir, 'single.ts'), lines.join('\n') + '\n');
    const r = await GrepTool.execute({ pattern: 'MATCH', path: 'single.ts', output_mode: 'content' }, ctx);
    expect(r.text).toContain('Note:');
    expect(r.text).toContain('single.ts');
  });

  // Compatibility gap flagged independently by two reviewing models (2026-08-10
  // review): Claude Code exposes -A/-B/-C verbatim and we had no context
  // parameter at all, forcing a follow-up Read after every Grep hit. Wired
  // straight through to ripgrep, matching CC's exact parameter names (not a
  // synthesized `context` field).
  it('context lines: -C adds symmetric context around a match', async () => {
    const lines = ['one', 'two', 'MATCH', 'four', 'five'];
    fs.writeFileSync(path.join(dir, 'ctx.txt'), lines.join('\n') + '\n');
    const r = await GrepTool.execute({ pattern: 'MATCH', output_mode: 'content', '-C': 1 }, ctx);
    expect(r.text).toContain('two');
    expect(r.text).toContain('MATCH');
    expect(r.text).toContain('four');
    expect(r.text).not.toContain('one');
    expect(r.text).not.toContain('five');
  });

  it('context lines: -A and -B are independently honored', async () => {
    const lines = ['one', 'two', 'MATCH', 'four', 'five'];
    fs.writeFileSync(path.join(dir, 'ctx2.txt'), lines.join('\n') + '\n');
    const r = await GrepTool.execute({ pattern: 'MATCH', output_mode: 'content', '-A': 2, '-B': 0 }, ctx);
    expect(r.text).toContain('four');
    expect(r.text).toContain('five');
    expect(r.text).not.toContain('two');
  });

  // Fix (two independent 2026-08 harness reviews, Grok 4.5 + Qwen 3.8 Max --
  // see guards.ts's WHY block above shellCwdMissHint): grepErrorMessage
  // already names the workspace root when a search path is missing; this adds
  // the OTHER root to the same message, but only when the alternative is
  // confirmed to exist on disk.
  describe('shell-cwd miss hint (Grok 4.5 / Qwen 3.8 Max asymmetry)', () => {
    it('names the path when the search target exists relative to the persisted shell cwd', async () => {
      const shellCwd = path.join(dir, 'sub');
      fs.mkdirSync(shellCwd);
      const target = path.join(shellCwd, 'app.toml');
      fs.writeFileSync(target, 'port = 1\n');
      const c: ToolContext = { ...ctx, shellCwd };
      const r = await GrepTool.execute({ pattern: 'port', path: 'app.toml' }, c);
      expect(r.isError).toBe(true);
      expect(r.text).toContain(target);
      expect(r.text).toContain(shellCwd);
    });

    it('adds no hint when the search target exists nowhere', async () => {
      const shellCwd = path.join(dir, 'sub');
      fs.mkdirSync(shellCwd);
      const c: ToolContext = { ...ctx, shellCwd };
      const r = await GrepTool.execute({ pattern: 'port', path: 'ghost.toml' }, c);
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain("It exists relative to the shell's current directory");
    });

    it('adds no hint when the shell cwd equals the workspace root', async () => {
      const c: ToolContext = { ...ctx, shellCwd: dir };
      const r = await GrepTool.execute({ pattern: 'port', path: 'ghost.toml' }, c);
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain("It exists relative to the shell's current directory");
    });
  });
});

// Regression pin (2026-08-10 review): DeepSeek reported "`path` for Grep is a
// directory, but `path` on Glob is a base" -- verification REFUTED this: the
// parameter means the identical thing (search-root directory) in both tools'
// code. The confusion came from neither schema having a description at all,
// letting the model infer a difference that isn't there. Fix the cause
// (describe both, with the SAME string) rather than the symptom.
// Ledger G-7 (2026-08-26 native-tools investigation): the four ripgrep flags
// every other harness exposes. Each test checks BOTH the flag reached rg
// (spawnSpy) and the observable search result, so a typo in the flag name
// can't pass on the spy alone.
describe('Grep flags (G-7): ignore_case, literal, type, multiline', () => {
  function rgArgsFor(pattern: string): string[] {
    const call = spawnSpy.mock.calls.find((c) => Array.isArray(c[1]) && c[1].includes(pattern));
    expect(call, 'expected a spawn call running ripgrep for the search').toBeTruthy();
    return call![1] as string[];
  }

  it('without ignore_case the search is case-sensitive; with it, -i is passed and case is ignored', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'FindMe here\n');
    const strict = await GrepTool.execute({ pattern: 'findme', output_mode: 'content' }, ctx);
    expect(strict.text).toBe('No matches found.');
    spawnSpy.mockClear();
    const loose = await GrepTool.execute({ pattern: 'findme', output_mode: 'content', ignore_case: true }, ctx);
    expect(loose.text).toMatch(/1:FindMe here/);
    expect(rgArgsFor('findme')).toContain('-i');
  });

  it('literal: true passes -F so regex metacharacters match themselves', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'call foo.bar(x)\ncall fooXbar(x)\n');
    spawnSpy.mockClear();
    const r = await GrepTool.execute({ pattern: 'foo.bar(', output_mode: 'content', literal: true }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/1:call foo\.bar\(x\)/);
    expect(r.text).not.toMatch(/fooXbar/);           // the "." was literal, not "any char"
    expect(rgArgsFor('foo.bar(')).toContain('-F');
  });

  it('type: "ts" passes --type and searches only that file type', async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'needle\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'needle\n');
    spawnSpy.mockClear();
    const r = await GrepTool.execute({ pattern: 'needle', type: 'ts' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('a.ts');
    expect(r.text).not.toContain('b.txt');
    expect(rgArgsFor('needle')).toContain('--type=ts');   // one token, so a value can never read as a flag
  });

  it('an unknown type surfaces ripgrep\'s own error verbatim plus how to fix it', async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'needle\n');
    const r = await GrepTool.execute({ pattern: 'needle', type: 'notatype' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('unrecognized file type: notatype');   // rg's words, not a guess
    expect(r.text).toMatch(/glob/);                                  // and the way out
  });

  it('multiline: true passes -U --multiline-dotall so a pattern can span lines', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'start\nmiddle\nend\n');
    const single = await GrepTool.execute({ pattern: 'start.*end', output_mode: 'content' }, ctx);
    expect(single.text).toBe('No matches found.');
    spawnSpy.mockClear();
    const multi = await GrepTool.execute({ pattern: 'start.*end', output_mode: 'content', multiline: true }, ctx);
    expect(multi.isError).toBeFalsy();
    expect(multi.text).toMatch(/start/);
    const args = rgArgsFor('start.*end');
    expect(args).toContain('-U');
    expect(args).toContain('--multiline-dotall');
  });

  it('none of the flags is passed when the parameters are omitted (default behaviour unchanged)', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'plain\n');
    spawnSpy.mockClear();
    await GrepTool.execute({ pattern: 'plain' }, ctx);
    const args = rgArgsFor('plain');
    for (const flag of ['-i', '-F', '-U', '--multiline-dotall']) expect(args).not.toContain(flag);
    expect(args.some((a) => a.startsWith('--type='))).toBe(false);
  });

  it('the permission subject is still the search path, untouched by the new flags', () => {
    expect(GrepTool.permissionSubject({ pattern: 'x', ignore_case: true, literal: true, type: 'ts', multiline: true } as any)).toBe('.');
    expect(GrepTool.permissionSubject({ pattern: 'x', path: 'src', ignore_case: true } as any)).toBe('src');
  });
});

describe('Grep/Glob schema descriptions', () => {
  it('path means the same thing on both tools and both schemas say so, in the same words', () => {
    const grepPath = GrepTool.inputSchema.shape.path;
    const globPath = GlobTool.inputSchema.shape.path;
    expect(grepPath.description).toBeTruthy();
    expect(globPath.description).toBeTruthy();
    expect(grepPath.description).toBe(globPath.description);
  });

  it('every Grep parameter has a description', () => {
    const shape = GrepTool.inputSchema.shape;
    for (const key of Object.keys(shape)) {
      expect((shape as any)[key].description, key).toBeTruthy();
    }
  });

  it('every Glob parameter has a description', () => {
    const shape = GlobTool.inputSchema.shape;
    for (const key of Object.keys(shape)) {
      expect((shape as any)[key].description, key).toBeTruthy();
    }
  });
});

// Fix (two independent 2026-08 harness reviews, Grok 4.5 + Qwen 3.8 Max):
// direct unit coverage of the two guards.ts primitives that back the
// per-tool integration tests above/below (Read/Glob/Grep's shell-cwd hint
// describes, Bash's workspace-root hint describe). These pin the boundary
// conditions precisely -- equal roots, absolute path, no persisted shell cwd
// -- independent of any one tool's wiring.
describe('shellCwdMissHint / workspaceRootMissHint (path-resolution asymmetry hint)', () => {
  it('shellCwdMissHint names the path when it is confirmed to exist under the shell cwd', () => {
    const shellCwd = path.join(dir, 'sub');
    fs.mkdirSync(shellCwd);
    const target = path.join(shellCwd, 'note.txt');
    fs.writeFileSync(target, '');
    const hint = shellCwdMissHint('note.txt', { cwd: dir, shellCwd }, (p) => fs.existsSync(p));
    expect(hint).toContain(target);
    expect(hint).toContain(shellCwd);
  });

  it('shellCwdMissHint returns nothing when the alternative does not exist either', () => {
    const shellCwd = path.join(dir, 'sub');
    fs.mkdirSync(shellCwd);
    expect(shellCwdMissHint('ghost.txt', { cwd: dir, shellCwd }, (p) => fs.existsSync(p))).toBe('');
  });

  it('shellCwdMissHint returns nothing for an absolute path, even if exists() would say yes', () => {
    // exists() is a constant `true` here specifically to prove the guard
    // fires on path.isAbsolute() BEFORE ever asking the disk -- an absolute
    // path does not depend on either cwd, so there is nothing to explain.
    const shellCwd = path.join(dir, 'sub');
    fs.mkdirSync(shellCwd);
    const absGhost = path.join(dir, 'ghost-abs.txt');
    expect(shellCwdMissHint(absGhost, { cwd: dir, shellCwd }, () => true)).toBe('');
  });

  it('shellCwdMissHint returns nothing when the shell cwd IS the workspace root', () => {
    // exists() always true -- the equal-roots short circuit must fire before
    // exists() is ever consulted, not because nothing happens to exist.
    expect(shellCwdMissHint('note.txt', { cwd: dir, shellCwd: dir }, () => true)).toBe('');
  });

  it('shellCwdMissHint returns nothing when there is no persisted shell cwd', () => {
    expect(shellCwdMissHint('note.txt', { cwd: dir }, () => true)).toBe('');
  });

  it('workspaceRootMissHint is the mirror image: names the path when confirmed under the workspace root', () => {
    const shellCwd = path.join(dir, 'sub');
    fs.mkdirSync(shellCwd);
    const target = path.join(dir, 'app.toml');
    fs.writeFileSync(target, '');
    const hint = workspaceRootMissHint('app.toml', shellCwd, { cwd: dir }, (p) => fs.existsSync(p));
    expect(hint).toContain(target);
    expect(hint).toContain(dir);
  });

  it('workspaceRootMissHint returns nothing when the failed cwd already IS the workspace root', () => {
    expect(workspaceRootMissHint('app.toml', dir, { cwd: dir }, () => true)).toBe('');
  });
});

describe('Luna experiment file path restriction', () => {
  it('fails closed on outside targets across model-visible file tools', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    const link = path.join(dir, 'outside-link');
    fs.symlinkSync(outside, link, 'dir');
    vi.stubEnv('YOUCODED_LUNA_EXPERIMENT', '1');
    vi.stubEnv('LUNA_FIXTURE_ROOT', dir);
    try {
      const results = await Promise.all([
        ReadTool.execute({ file_path: path.join(link, 'secret.txt') }, ctx),
        WriteTool.execute({ file_path: path.join(outside, 'new.txt'), content: 'bad' }, ctx),
        EditTool.execute({ file_path: path.join(link, 'secret.txt'), old_string: 'secret', new_string: 'bad' }, ctx),
        GlobTool.execute({ pattern: '*', path: link }, ctx),
        GrepTool.execute({ pattern: 'secret', path: path.join(link, 'secret.txt') }, ctx),
      ]);
      expect(results.every((result) => result.isError)).toBe(true);
      expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
      expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('allows a new file under the fixture when the experiment is enabled', async () => {
    vi.stubEnv('YOUCODED_LUNA_EXPERIMENT', '1');
    vi.stubEnv('LUNA_FIXTURE_ROOT', dir);
    try {
      const r = await WriteTool.execute({ file_path: 'new/sub/file.txt', content: 'ok' }, ctx);
      expect(r.isError).toBeFalsy();
      expect(fs.readFileSync(path.join(dir, 'new/sub/file.txt'), 'utf8')).toBe('ok');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('TodoWrite', () => {
  it('replaces the list in ctx', async () => {
    ctx.todos.push({ content: 'stale', status: 'pending', activeForm: 'Staling' });
    const r = await TodoWriteTool.execute(
      {
        todos: [
          { content: 'One', status: 'completed', activeForm: 'Doing one' },
          { content: 'Two', status: 'in_progress', activeForm: 'Doing two' },
        ],
      },
      ctx,
    );
    expect(ctx.todos.length).toBe(2);
    expect(ctx.todos[0].content).toBe('One');
    expect(r.text).toContain('2 items, 1 completed');
  });
});

// The 2026-08-26 incident: one Grep from a home-folder conversation sat 4 hours
// in a network-mounted Google Drive until Stop killed it. A search now has a
// deadline that ends the SEARCH with an error the model can act on — never the
// turn (the turn's own signal must stay un-aborted).
describe('search deadline (Grep and Glob)', () => {
  it('Grep and Glob both declare the shared search deadline', () => {
    expect((GrepTool as any).caps?.timeoutMs).toBe(SEARCH_TIMEOUT_MS);
    expect((GlobTool as any).caps?.timeoutMs).toBe(SEARCH_TIMEOUT_MS);
  });

  it('a tool that never finishes ends with a timed-out error, and the turn signal is not aborted', async () => {
    let toolSignal: AbortSignal | undefined;
    const stuck = defineTool<Record<string, never>>({
      name: 'Stuck',
      description: 'never resolves',
      inputSchema: undefined as any,
      caps: { maxChars: 1000, timeoutMs: 20 },
      permissionSubject: () => undefined,
      execute(_a, c) {
        toolSignal = c.signal;
        return new Promise(() => {});
      },
    });
    const turn = new AbortController();
    const r = await stuck.execute({}, makeCtx(dir, turn.signal));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Stuck timed out after/);
    expect(toolSignal?.aborted).toBe(true); // the tool's own kill wiring fires
    expect(turn.signal.aborted).toBe(false); // the conversation keeps going
  });

  it('a tool with no declared deadline is never given one, even by the test override', async () => {
    const plain = defineTool<Record<string, never>>({
      name: 'Plain',
      description: 'resolves late',
      inputSchema: undefined as any,
      permissionSubject: () => undefined,
      execute: () => new Promise((res) => setTimeout(() => res({ text: 'late' }), 30)),
    });
    const r = await plain.execute({}, { ...makeCtx(dir), toolTimeoutMs: 1 });
    expect(r.text).toBe('late');
  });

  it('a user interrupt still reaches a tool that has a deadline', async () => {
    const waits = defineTool<Record<string, never>>({
      name: 'Waits',
      description: 'ends on abort',
      inputSchema: undefined as any,
      caps: { maxChars: 1000, timeoutMs: 60_000 },
      permissionSubject: () => undefined,
      execute: (_a, c) => new Promise((res) => {
        c.signal.addEventListener('abort', () => res({ text: 'stopped', isError: true }), { once: true });
      }),
    });
    const turn = new AbortController();
    const pending = waits.execute({}, makeCtx(dir, turn.signal));
    turn.abort();
    expect((await pending).text).toBe('stopped');
  });

  // POSIX-only: a FIFO nobody writes to makes ripgrep block on its read
  // forever — a deterministic stand-in for a hung network mount.
  it.skipIf(process.platform === 'win32')('a real Grep stuck on an unreadable file is stopped at the deadline', async () => {
    childProcess.execFileSync('mkfifo', [path.join(dir, 'stuck-pipe')]);
    const turn = new AbortController();
    const r = await GrepTool.execute({ pattern: 'x', path: 'stuck-pipe' }, { ...makeCtx(dir, turn.signal), toolTimeoutMs: 200 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Grep timed out after/);
    expect(turn.signal.aborted).toBe(false);
  });
});
