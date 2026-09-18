// Task 19 regression pins, PLUS Task 16's contract-level conformance suite
// (appended below, its own `describe` block and final `afterAll`). Both halves
// asserts PROPERTIES of the bounds contract rather than exact prose — wording
// can change without breaking either suite, but a tool that stops declaring, or
// starts inventing advice it does not have, fails.
//
// Task 19 half: the gap three independent reviews found from three different
// directions. `bounds` (ResultBounds, Task 1) describes what the TOOL dropped;
// `defineTool`'s pipeline cap (registry.ts) is a SEPARATE event that fires on
// its own schedule. The three cases below are the MEASURED instances where
// only the pipeline cap fired — content-mode Grep capped by `maxLines`, Glob
// capped by `maxChars` under its own result limit, and Bash's cwd-reset
// trailer pushing a small body over the cap — each of which used to hand the
// model a bare byte count with no way to widen its next call.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GrepTool } from '../src/main/harness/tools/grep';
import { GlobTool } from '../src/main/harness/tools/glob';
import { BashTool } from '../src/main/harness/tools/bash';
import { ReadTool } from '../src/main/harness/tools/read';
import type { ToolContext } from '../src/main/harness/tools/types';

// Every tool result produced ANYWHERE in this file (both the Task 19 half and
// the Task 16 half below) is recorded here, and checked once at the very end
// by the top-level `afterAll`. This is what makes "no tool result anywhere in
// the suite contains the bare no-advice string" a suite-wide property instead
// of something only true of the handful of results each individual test
// happens to inspect.
const ALL_RESULTS: string[] = [];

// composeNotice's bare no-advice fallback (truncate.ts) — the honest shape when
// NEITHER a per-call bound NOR a tool's static `moreHint` (Task 19) is available.
// None of the cases in this file should ever produce it: each one bottoms out on
// a tool's static hint, which is exactly the gap Task 19 closes.
const BARE_NO_ADVICE = /\[output truncated: showing \d+ of \d+ chars\]/;

function assertAdviceNotBare(text: string) {
  expect(text).toContain('output truncated: showing');
  expect(text).not.toMatch(BARE_NO_ADVICE);
}

function makeCtx(cwd: string): ToolContext {
  return { sessionId: 'test', cwd, signal: new AbortController().signal, readRegistry: new Map(), todos: [] };
}

describe('pipeline cap fires with no tool-declared bounds, but advice still arrives', () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('content-mode Grep over 100 matches now self-bounds by match count, closing this gap at the SOURCE', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-maxlines-'));
    // 400 matching lines in ONE file — the exact shape of the case this test
    // used to pin: well under Grep's own 24k retention window (nothing dropped
    // at the byte level) but over caps.maxLines: 250, so at the time this was
    // written the generic PIPELINE cap was the ONLY thing that fired, and Grep
    // itself declared no bounds (the Task 19 gap).
    //
    // SUPERSEDED (2026-08-10 review, following the prior-art doc's Grep-
    // specific recommendation): a live run measured 17,860-17,898 chars from
    // ONE search — this exact shape — flagged by name (Grok 4.5). Grep now
    // caps content mode by MATCH COUNT (~100) in grep.ts itself, so this
    // scenario no longer reaches the generic pipeline fallback at all — it's a
    // strictly better outcome (match-count semantics instead of a raw line
    // count) but it DOES mean the old "bounds stays undefined" premise is now
    // false. Updated to pin the new, better behavior rather than deleted,
    // since the underlying fixture is still worth guarding.
    const lines = Array.from({ length: 400 }, (_, i) => `export const MATCH_${i} = ${i};`);
    fs.writeFileSync(path.join(dir, 'big.ts'), lines.join('\n') + '\n');
    const r = await GrepTool.execute({ pattern: 'MATCH', output_mode: 'content' }, makeCtx(dir));
    ALL_RESULTS.push(r.text);
    expect(r.bounds).toEqual({
      shown: 100,
      total: 400,
      unit: 'matches',
      moreHint: 'narrow the pattern, add a glob filter, or use output_mode: "count"',
    });
    // NOT assertAdviceNotBare(): that helper checks composeNotice's NO-BOUNDS
    // branch ("[output truncated: showing N of M chars]"), which is exactly
    // the branch this scenario used to hit and no longer does — Grep declares
    // real bounds now, so composeNotice takes the bounds-present branch
    // instead ("[showing N of M matches — hint]"). Assert that shape directly.
    expect(r.text).toMatch(/\[showing 100 of 400 matches — narrow the pattern/);
    expect(r.text).not.toMatch(BARE_NO_ADVICE);
    expect(r.text).toContain('narrow the pattern');
  });

  it('Glob capped by maxChars while hits.length <= RESULT_LIMIT still carries widening advice', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-maxchars-'));
    // Exactly 2,000 files == RESULT_LIMIT, so `hits.length > shown.length` is
    // false and Glob declares no bounds — but names long enough that the joined
    // path list exceeds caps.maxChars (30k) on sheer length alone.
    for (let i = 0; i < 2_000; i++) {
      fs.writeFileSync(path.join(dir, `moderately-long-filename-${String(i).padStart(4, '0')}.ts`), '');
    }
    const r = await GlobTool.execute({ pattern: '*.ts' }, makeCtx(dir));
    ALL_RESULTS.push(r.text);
    expect(r.bounds).toBeUndefined();
    assertAdviceNotBare(r.text);
    expect(r.text).toContain('narrow the glob pattern');
  }, 30_000);

  // Additional case (per the Task 19 assignment, beyond the brief's two Step-5
  // cases): the ONE instance per-tool arithmetic already missed once — bash.ts's
  // HEAD_CHARS/TAIL_CHARS rework closed the body-only overflow, but the cwd-reset
  // notice AND the metadata line both embed ctx.cwd a SECOND time, outside that
  // budget. A long workspace root can push the total past the pipeline's 30k cap
  // while Bash's own head+tail capture stays comfortably inside its budget —
  // this is the argument for a STRUCTURAL fix (tool-level static hint) over
  // fixing each tool's arithmetic again, which is exactly what got missed before.
  //
  // HISTORY (2026-08-06 review, when this test was written): Bash's own
  // head+tail budget was ~28,000 chars at the time — just above this scenario's
  // 27,000-char body — so Bash's own `dropped` flag stayed false and `bounds`
  // stayed undefined, and ONLY the pipeline's 30,000-char cap could fire,
  // because the reset notice + metadata trailer embed the ~2,300-char root
  // TWICE, outside Bash's per-call budget.
  //
  // WHY the assertions below changed (2026-08-10 review): Bash's own cap was
  // separately tightened from ~28,000 to ~4,000 chars — reviewers measured a
  // `seq 1 20000` costing ~7k tokens of "pure noise... more expensive than
  // everything else combined" at the old cap (see bash.ts's HEAD_CHARS_TARGET/
  // TAIL_CHARS_TARGET WHY block). At 4,000 chars, Bash's own budget is now FAR
  // below this scenario's 27,000-char body, so Bash declares its OWN bounds —
  // {shown: 4_000, total: 27_000} — long before the trailer's extra ~5,000
  // chars (the doubled root + reset notice + metadata) could matter: total
  // response text stays under 10,000 chars end to end, nowhere near the
  // 30,000-char pipeline cap. **The exact scenario this test used to reproduce
  // is UNREACHABLE via Bash today** — the smaller per-call cap closed the gap
  // by making Bash bound itself much earlier, not by changing the trailer's
  // arithmetic (which is unchanged and still embeds the root twice).
  //
  // This test still earns its place as a GUARD, not just a fossil: if Bash's
  // own cap is ever raised back above roughly 25,000 chars (i.e. back near
  // this scenario's 27,000-char body), the gap reopens — Bash's own budget
  // would again exceed the body, `bounds` would again go undefined, and the
  // doubled-root trailer could again push the pipeline cap past 30,000 with no
  // tool-declared bounds to fall back on.
  it.skipIf(process.platform !== 'linux')(
    'Bash: the tightened ~4k cap makes Bash declare its own bounds on a 27k-char body, well before the doubled-root trailer could reach the pipeline cap',
    async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-longroot-'));
      // Build a REAL, deeply nested directory so ctx.cwd itself is long — this
      // reproduces the actual scenario (the trailer embeds the genuine
      // ctx.cwd, not a stand-in string the tool never touches). Linux-only:
      // PATH_MAX headroom (4096) comfortably fits ~2.3k chars; macOS (1024)
      // and Windows (MAX_PATH 260) impose OS-level limits that would make this
      // an OS-specific reproduction, not evidence of the underlying gap.
      let root = dir;
      const seg = 'a'.repeat(200);
      while (root.length < 2_300) {
        const next = path.join(root, seg);
        fs.mkdirSync(next);
        root = next;
      }
      const ctx = makeCtx(root);
      // 27,000 chars of stdout — still nearly 7x Bash's OWN ~4,000-char
      // visible budget, so Bash's own `dropped` check trips on the body alone
      // now, independent of the trailer. `cd /` is genuinely outside this
      // workspace root, so the scope guard still fires and the reset notice +
      // metadata line still embed the ~2,300-char root TWICE — that part of
      // the scenario is unchanged; it's just no longer enough to matter.
      const r = await BashTool.execute(
        { command: `cd / && node -e "process.stdout.write('x'.repeat(27000))"` },
        ctx,
      );
      ALL_RESULTS.push(r.text);
      expect(r.text).toMatch(/Shell cwd was reset to/);
      expect(r.bounds).toEqual({
        shown: 4_000,
        total: 27_000,
        unit: 'chars',
        moreHint: expect.stringMatching(/\d+ lines? elided/),
      });
      // NOT assertAdviceNotBare(): that helper checks the OTHER composeNotice
      // branch ("[output truncated: showing N of M chars]" — fires when the
      // PIPELINE cap trips with no tool-declared bounds, Task 19's gap). Bash
      // declares its own bounds here, so composeNotice takes the
      // bounds-present branch instead ("[showing N of M chars — hint]") — a
      // real notice with real advice, just a different shape. Assert that
      // shape directly, and confirm the bare no-advice string is still absent
      // either way.
      expect(r.text).toMatch(/\[showing 4000 of 27000 chars — \d+ lines? elided/);
      expect(r.text).not.toMatch(BARE_NO_ADVICE);
      // The whole point of the recalibration: total response text (body +
      // reset notice + metadata trailer + Bash's own notice) never approaches
      // the pipeline's 30,000-char cap — verified at under half of it, with
      // generous margin, so this doesn't become a new flaky boundary check.
      expect(r.text.length).toBeLessThan(15_000);
    },
    30_000,
  );
});

// Task 16: contract-level conformance suite. Where the block above pins the
// three MEASURED cases where the pipeline cap fires alone, this block asserts
// the general PROPERTIES of the bounds contract (types.ts) that those cases are
// instances of — so a future tool, or a future edit to an existing one, is
// checked against the contract itself rather than only against history's three
// known failures. Each `it` name states the property, not the scenario.
describe('bounds contract conformance', () => {
  let dir: string;
  let ctx: ToolContext;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-'));
    ctx = { sessionId: 't', cwd: dir, signal: new AbortController().signal, readRegistry: new Map(), todos: [] };
  });
  // Fixtures live under os.tmpdir() only (never the repo) and are removed here
  // even when an assertion above threw, so a failing run can't leak a temp tree.
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a declared total is never smaller than what was shown', async () => {
    // 500 lines, limit 10: `bounds.total` must report the file's real 500 —
    // reporting anything less than `shown` would mean the tool claims to have
    // displayed more than it says exists, i.e. a fabricated number. This is the
    // guarantee `total: null` (types.ts) exists to protect: an UNKNOWN total is
    // spelled `null`, never an undercount.
    fs.writeFileSync(path.join(dir, 'f.txt'), Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n'));
    const r = await ReadTool.execute({ file_path: 'f.txt', limit: 10 }, ctx);
    ALL_RESULTS.push(r.text);
    expect(r.bounds).toBeDefined();
    expect(r.bounds!.total).not.toBeNull();
    expect(r.bounds!.total as number).toBeGreaterThanOrEqual(r.bounds!.shown);
  });

  it('every declared moreHint is non-empty and names no parameter the tool lacks', async () => {
    // 2,100 empty files exceed Glob's own RESULT_LIMIT (2,000), so Glob bounds
    // itself and must supply advice. Glob's inputSchema accepts only `pattern`
    // and `path` — a hint mentioning offset/limit would be inventing a
    // capability the tool does not have, the exact failure mode Task 1 replaced
    // the old single shared advice string to prevent (that string told every
    // tool's caller to "use offset/limit" whether or not it had one).
    for (let i = 0; i < 2_100; i++) fs.writeFileSync(path.join(dir, `g${i}.ts`), '');
    const r = await GlobTool.execute({ pattern: '*.ts' }, ctx);
    ALL_RESULTS.push(r.text);
    expect(r.bounds).toBeDefined();
    expect(r.bounds!.moreHint.trim().length).toBeGreaterThan(0);
    expect(r.bounds!.moreHint).not.toMatch(/\boffset\b|\blimit\b/);
  }, 60_000);

  it('no tool result ever contains the old shared advice string', async () => {
    // Small, un-truncated inputs across all four tools. None of these results
    // should mention "offset/limit" AT ALL — that phrase was the pre-Task-1
    // hardcoded default composeNotice used to append to every tool's output
    // regardless of whether the tool accepted those parameters. A regression to
    // a shared default (instead of each tool's own declared hint) reintroduces
    // that string here first, on tools (Bash, Glob, Grep) that have never taken
    // offset/limit.
    fs.writeFileSync(path.join(dir, 'x.txt'), 'hello');
    const results = [
      await ReadTool.execute({ file_path: 'x.txt' }, ctx),
      await GlobTool.execute({ pattern: '*.txt' }, ctx),
      await GrepTool.execute({ pattern: 'hello' }, ctx),
      await BashTool.execute({ command: 'echo hi' }, ctx),
    ];
    for (const r of results) {
      ALL_RESULTS.push(r.text);
      expect(r.text).not.toContain('offset/limit');
    }
  }, 30_000);

  it('a result that shows everything declares no bounds at all', async () => {
    // The converse of the three properties above: `bounds` is a structural fact
    // (this call genuinely omitted something), not decoration attached to every
    // response. A tool that declares bounds when nothing was cut would be
    // inventing a limitation the caller doesn't actually have — the same
    // dishonesty this whole contract exists to rule out, just in the other
    // direction.
    fs.writeFileSync(path.join(dir, 'small.txt'), 'one\ntwo');
    const r = await ReadTool.execute({ file_path: 'small.txt' }, ctx);
    ALL_RESULTS.push(r.text);
    expect(r.bounds).toBeUndefined();
  });
});

// The branch's whole thesis, checked once against EVERY result recorded above
// by BOTH describe blocks: a tool may say nothing was omitted, and it may say
// something was omitted AND how to get more — but it may never say something
// was omitted with no way to get more. `BARE_NO_ADVICE` matches only the
// closed form "[output truncated: showing N of M chars]" (bracket closes
// immediately after "chars"); any result that appends " — <hint>]" instead
// does not match, so this assertion is silent on every advice-bearing result
// and loud on exactly the regression Task 19 fixed and this suite pins.
afterAll(() => {
  // A suite that recorded nothing would make every assertion below vacuously
  // true — guard against a refactor accidentally routing results around
  // ALL_RESULTS.push and leaving this check checking an empty array.
  expect(ALL_RESULTS.length).toBeGreaterThan(0);
  for (const text of ALL_RESULTS) {
    expect(text).not.toMatch(BARE_NO_ADVICE);
  }
});
