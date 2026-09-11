// Slug → path resolution for the Resume Browser (fix 2026-07-12).
// A CC project slug encodes the cwd with '-' for every path separator, so a
// folder whose own name contains a hyphen ('youcoded-dev') is indistinguishable
// from a nested pair ('youcoded/dev'). walkSlugParts must prefer the LONGEST
// leading folder that exists on disk, or a stray sibling ('youcoded') makes it
// greedily resolve to a nonexistent '…/youcoded/dev' — which made resume fall
// back to $HOME (every hyphenated-folder session "resumed from the home dir").
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walkSlugParts, forwardResolveSlug } from '../src/main/session-browser';
import { ccProjectSlug } from '../src/main/slug-encoding';
import { r1CwdForDir } from '../src/main/transcript-cwd';

describe('walkSlugParts', () => {
  let tmp: string;
  beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-')); });
  afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it('prefers a hyphenated folder over a greedy shorter sibling (the home-dir bug)', async () => {
    fs.mkdirSync(path.join(tmp, 'youcoded'));      // the stray sibling that caused the greedy misfire
    fs.mkdirSync(path.join(tmp, 'youcoded-dev'));  // the real project folder
    // Before the fix this returned <tmp>/youcoded/dev (nonexistent); now it must
    // pick the real folder.
    expect(await walkSlugParts(tmp, ['youcoded', 'dev'])).toBe(path.join(tmp, 'youcoded-dev'));
  });

  it('still resolves a genuinely nested path when no hyphenated form exists', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'slug2-'));
    fs.mkdirSync(path.join(base, 'proj', 'sub'), { recursive: true });
    expect(await walkSlugParts(base, ['proj', 'sub'])).toBe(path.join(base, 'proj', 'sub'));
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('resolves a deep hyphenated folder several levels down', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'slug3-'));
    fs.mkdirSync(path.join(base, 'a', 'b', 'my-project'), { recursive: true });
    fs.mkdirSync(path.join(base, 'a', 'b', 'my')); // decoy shorter sibling
    expect(await walkSlugParts(base, ['a', 'b', 'my', 'project'])).toBe(path.join(base, 'a', 'b', 'my-project'));
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('falls back to a naive join when nothing on the path exists', async () => {
    const base = path.join(tmp, 'ghost'); // never created
    expect(await walkSlugParts(base, ['a', 'b'])).toBe(path.join(base, 'a-b'));
  });
});

// forwardResolveSlug's walk enumerates REAL directory entries (fs.readdirSync),
// so its result can only ever match a canonical path — on macOS os.tmpdir() is
// a symlink (/var/folders/... -> /private/var/folders/...) and on Windows CI
// it can resolve through an 8.3 short name, so the RAW mkdtemp path is never
// what the walk finds. Canonicalize once here and derive the walk's root
// override from the SAME canonical value, per-platform (posixRoot is
// meaningless on Windows, where slugs encode a drive letter instead).
function rootsFor(real: string): { posixRoot?: string; winRoot?: string } {
  return process.platform === 'win32'
    ? { winRoot: path.parse(real).root }
    : { posixRoot: '/' };
}

describe('inversion chain (spec §5.4a)', () => {
  it('forward walk recovers a punctuated folder the split walk cannot', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'inv-')));
    const real = path.join(root, 'PAF 574 - Diversity, Ethics, & Public Change');
    fs.mkdirSync(real, { recursive: true });
    const slug = ccProjectSlug(real);
    expect(await forwardResolveSlug(slug, rootsFor(real))).toBe(real);
  });

  it('BACKTRACKS past sibling a to reach a-b (the 57be5e14 failure shape)', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'inv-')));
    fs.mkdirSync(path.join(root, 'a', 'x'), { recursive: true });          // wrong subtree exists
    const real = path.join(root, 'a-b', 'x');
    fs.mkdirSync(real, { recursive: true });
    expect(await forwardResolveSlug(ccProjectSlug(real), rootsFor(real))).toBe(real);
  });

  // The fixture above doesn't actually exercise backtracking: 'a-b' has the
  // LONGER encoding ('a-b', len 3) than 'a' (len 1), so longest-first picks
  // the winner on the very first try — a greedy "take the top sorted
  // candidate, never retry" walk passes it too (verified by hand while
  // implementing). This fixture inverts it: the decoy 'a-b' sorts FIRST
  // (longer encoding) but is a dead end (no child matches what's left of the
  // slug), so only genuine backtracking — unwinding to try the shorter 'a'
  // and descending into its real 'b-c' child — reaches the real path.
  it('BACKTRACKS off a longer-encoded decoy that dead-ends, onto the shorter real path', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'inv-')));
    fs.mkdirSync(path.join(root, 'a-b', 'zzz'), { recursive: true }); // decoy: longer encoding, no matching child
    const real = path.join(root, 'a', 'b-c');
    fs.mkdirSync(real, { recursive: true });
    expect(await forwardResolveSlug(ccProjectSlug(real), rootsFor(real))).toBe(real);
  });

  it('DECLINES on a capped slug instead of returning a plausible wrong path', async () => {
    const long = '/x/' + 'b'.repeat(300);
    const capped = ccProjectSlug(long);
    expect(capped.length).toBeGreaterThan(200);
    expect(await forwardResolveSlug(capped, { posixRoot: '/' })).toBeNull();
  });

  it('over-cap resolves via option 1 (R1 from a recorded cwd)', async () => {
    // build a fake projects dir containing the capped slug dir with one transcript
    const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'projs-'));
    const long = '/x/' + 'b'.repeat(300);
    const dir = path.join(projects, ccProjectSlug(long));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's.jsonl'), JSON.stringify({ type: 'user', cwd: long }) + '\n');
    // Pin platform explicitly: the fixture's local cwd is a POSIX path, so
    // leaving this on process.platform would silently fail on Windows CI
    // (see transcript-cwd.test.ts's same seam — adapted here per Task 8's
    // platform-seam review fix, which the brief's original snippet predates).
    expect(await r1CwdForDir(dir, 'linux')).toBe(long);
  });
});
