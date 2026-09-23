import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkPathGuard, canonicalize, toPosix, workspaceMatchFor, lunaFixturePathAllowed } from '../src/main/harness/tools/guards';
import { spillDirFor, spillRoot } from '../src/main/harness/tools/spill-paths';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CWD = path.join(os.tmpdir(), 'guard-test-workspace');

describe('Luna fixture path restriction', () => {
  it('allows only real paths inside fixture, including not-yet-created descendants', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-out-'));
    const link = path.join(root, 'link');
    try {
      fs.symlinkSync(outside, link, 'dir');
      expect(lunaFixturePathAllowed(path.join(root, 'new', 'file'), root)).toBe(true);
      expect(lunaFixturePathAllowed(path.join(outside, 'secret'), root)).toBe(false);
      expect(lunaFixturePathAllowed(path.join(link, 'secret'), root)).toBe(false);
      expect(lunaFixturePathAllowed(path.join(root, 'missing', 'ancestor', 'x'), root)).toBe(true);
      expect(lunaFixturePathAllowed(path.join(root, 'anything'), '')).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
const HOME = os.homedir();
const isWin = process.platform === 'win32';

// Adversarial table encoding the guard threat model (spec §2.3): secrets
// hard-deny regardless of case (on the case-insensitive win32 fs), the cwd jail
// is not fooled by `..`, and out-of-jail paths ask rather than silently allow.
const cases: Array<{ name: string; raw: string; want: 'ok' | 'deny' | 'external'; winOnly?: boolean }> = [
  // In-jail, ordinary files → ok
  { name: 'file inside workspace', raw: path.join(CWD, 'src/a.ts'), want: 'ok' },
  { name: 'relative path resolves against cwd', raw: 'src/a.ts', want: 'ok' },
  { name: '.environment (not a dotenv) inside workspace', raw: path.join(CWD, '.environment'), want: 'ok' },

  // Secrets → deny (lowercase forms match everywhere via the segment/basename sets)
  { name: 'workspace .env', raw: path.join(CWD, '.env'), want: 'deny' },
  { name: 'workspace .env.local', raw: path.join(CWD, '.env.local'), want: 'deny' },
  { name: '~/.ssh/id_rsa', raw: path.join(HOME, '.ssh', 'id_rsa'), want: 'deny' },
  { name: '~/.gnupg/x', raw: path.join(HOME, '.gnupg', 'x'), want: 'deny' },
  { name: '~/.aws/credentials', raw: path.join(HOME, '.aws', 'credentials'), want: 'deny' },

  // Case-variant secrets → deny, but only on the case-insensitive win32 fs.
  // On POSIX `.SSH` / `.Env` are genuinely different names and must NOT deny.
  { name: 'case-variant ~/.SSH/id_rsa', raw: path.join(HOME, '.SSH', 'id_rsa'), want: 'deny', winOnly: true },
  { name: 'case-variant workspace .Env', raw: path.join(CWD, '.Env'), want: 'deny', winOnly: true },

  // Out of jail → external (ask), never ok
  { name: 'sibling dir outside workspace', raw: path.join(os.tmpdir(), 'elsewhere', 'x.txt'), want: 'external' },
];

describe('checkPathGuard — threat model table', () => {
  for (const c of cases) {
    const run = c.winOnly && !isWin ? it.skip : it;
    run(`${c.name} -> ${c.want}`, () => {
      expect(checkPathGuard(c.raw, CWD).kind).toBe(c.want);
    });
  }

  // 2026-08-11 review round 8: Bash tells the model to Read its spill file, and
  // the guard used to force an approval ask for it — advice the harness itself
  // then blocked. These pin the exemption AND its limits.
  describe('Bash spill files', () => {
    it('a spill file is readable without an external_directory ask', () => {
      const spill = path.join(spillDirFor('session-1'), 'bash-123-abc.txt');
      expect(checkPathGuard(spill, CWD).kind).toBe('ok');
    });

    it('the exemption is the spill root, not all of tmpdir', () => {
      // A sibling directory under the same tmpdir must still ask — otherwise the
      // exemption would quietly open every temp file on the machine.
      const sibling = path.join(os.tmpdir(), 'not-our-spill', 'x.txt');
      expect(checkPathGuard(sibling, CWD).kind).toBe('external');
    });

    it('cannot be used to reach a credential file by climbing out of the spill root', () => {
      // The credential denies run BEFORE the exemption, so a path carrying a
      // `.ssh` segment is denied even though it is spelled as a spill path.
      // This is the ordering the exemption's placement depends on. Built from
      // segments rather than from HOME so the drive layout can't change the
      // result on Windows.
      const escape = path.join(spillRoot(), '..', 'somewhere', '.ssh', 'id_rsa');
      expect(checkPathGuard(escape, CWD).kind).toBe('deny');
    });
  });

  // Task 10 (plan 1b): a specialist report too big for the parent's headroom
  // is spilled to sessions/<slug>/<childId>.report.md, and the footer tells
  // the model to Read it. That advice is only honest if the guard actually
  // lets the READ through — the parent's own internalReadRoots (wired by
  // NativeSessionHost, per-session) is the mechanism, mirroring the spillRoot
  // exemption above but scoped to whatever roots the CALLER passes in rather
  // than one hardcoded global root.
  describe('internalReadRoots (per-session spill dir exemption)', () => {
    const internalRoot = path.join(os.tmpdir(), 'yc-internal-root', 'proj-slug');

    it('a path under an internal root is readable without an external_directory ask', () => {
      const p = path.join(internalRoot, 'child-1.report.md');
      expect(checkPathGuard(p, CWD, [internalRoot]).kind).toBe('ok');
    });

    it('a sibling directory next to the internal root still asks — the exemption does not widen', () => {
      const sibling = path.join(os.tmpdir(), 'yc-internal-root', 'not-our-slug', 'x.txt');
      expect(checkPathGuard(sibling, CWD, [internalRoot]).kind).toBe('external');
    });

    it('with no internalReadRoots passed, the same path just asks like any other external path', () => {
      const p = path.join(internalRoot, 'child-1.report.md');
      expect(checkPathGuard(p, CWD).kind).toBe('external');
    });

    it('cannot be used to reach a credential file by climbing out of an internal root', () => {
      // Same ordering guarantee as the spillRoot exemption: credential denies
      // run BEFORE internalReadRoots is ever consulted.
      const escape = path.join(internalRoot, '..', '..', '.ssh', 'id_rsa');
      expect(checkPathGuard(escape, CWD, [internalRoot]).kind).toBe('deny');
    });
  });

  it('absolute path with `..` cannot escape the cwd jail (external, not ok)', () => {
    // Lexically "inside" CWD but climbs two levels out — must be normalized,
    // classified external, and NOT silently allowed.
    const escape = path.join(CWD, '..', '..', 'outside.txt');
    const v = checkPathGuard(escape, CWD);
    expect(v.kind).toBe('external');
    // The external verdict must carry the fully-normalized canonicalPath.
    if (v.kind === 'external') {
      expect(v.canonicalPath).toBe(canonicalize(escape, CWD));
      expect(v.canonicalPath).not.toContain('..');
      expect(v.canonicalPath).toContain('outside.txt');
    }
  });
});

describe('toPosix', () => {
  it('converts Windows separators to forward slashes', () => {
    expect(toPosix('src\\a.ts')).toBe('src/a.ts');
  });

  it('leaves an already-posix path untouched', () => {
    expect(toPosix('src/a.ts')).toBe('src/a.ts');
  });

  it('normalizes an absolute Windows path', () => {
    expect(toPosix('C:\\Users\\Dev\\a.ts')).toBe('C:/Users/Dev/a.ts');
  });

  // Regression pin (2026-08-11): toPosix is NOT canonicalize(). canonicalize()
  // ALSO resolves against a cwd, collapses `..`, and lowercases the whole path
  // on win32 — correct for the sensitive-path comparison sets it feeds, and
  // silently destructive for anything a user or model reads back. Anyone
  // reaching for "the path normalizer" must land on the right one.
  it('does not resolve, absolutize, or case-fold — it is not canonicalize()', () => {
    expect(toPosix('SRC/README.md')).toBe('SRC/README.md');
    expect(toPosix('a\\..\\b')).toBe('a/../b');
  });
});

// 2026-08-16: a local model answered "read the roadmap" by Globbing (which
// returns WORKSPACE-RELATIVE paths — "ROADMAP.md") and then inventing an
// absolute path from the project NAME: "/youcoded-dev/ROADMAP.md". That is
// outside the workspace, so checkPathGuard forced an external_directory ask
// for a path that does not exist anywhere — and the turn hung on it. This
// helper is the narrow escape: the ask is skipped ONLY when the outside path
// is fictional AND the real file is confirmed inside the workspace.
describe('workspaceMatchFor — an outside path the model meant to write as a workspace path', () => {
  let root: string;
  const realExists = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-match-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ROADMAP.md'), '# roadmap');
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};');
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); });

  it('recovers the workspace file when the model prefixed the project folder name', () => {
    // The exact live failure: cwd basename repeated as a fake root segment.
    expect(workspaceMatchFor(`/${path.basename(root)}/ROADMAP.md`, root, realExists)).toBe('ROADMAP.md');
  });

  it('prefers the LONGEST matching suffix, not the bare basename', () => {
    fs.writeFileSync(path.join(root, 'index.ts'), 'export {};');
    // Both `src/index.ts` and `index.ts` exist; the deeper one is the honest read
    // of what the model asked for.
    expect(workspaceMatchFor('/elsewhere/src/index.ts', root, realExists)).toBe('src/index.ts');
  });

  it('returns null when the outside path is REAL — that one still deserves an ask', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-outside-'));
    fs.writeFileSync(path.join(outside, 'ROADMAP.md'), '# a genuinely external file');
    try {
      expect(workspaceMatchFor(path.join(outside, 'ROADMAP.md'), root, realExists)).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    }
  });

  it('returns null when nothing inside the workspace matches — no guessing', () => {
    // Per docs/error-message-standards.md (and resolveUnderAlternateCwd's own
    // WHY): a wrong "did you mean" is worse than none. No match → normal ask.
    expect(workspaceMatchFor('/elsewhere/NOPE.md', root, realExists)).toBeNull();
  });

  it('never returns a directory match for a file-shaped question', () => {
    // `exists` is the caller's question. Read/Edit ask "is it a FILE?", so a
    // same-named directory inside the workspace must not be offered.
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    expect(workspaceMatchFor('/elsewhere/docs', root, realExists)).toBeNull();
  });

  it('a `..` path is canonicalized first, so it is matched by where it LANDS', () => {
    // /a/../../etc/passwd lands at /etc/passwd; neither `etc/passwd` nor
    // `passwd` exists in the workspace, so there is nothing to offer.
    expect(workspaceMatchFor('/a/../../etc/passwd', root, realExists)).toBeNull();
  });

  // The isUnderRoot re-check inside the loop is load-bearing on win32 ONLY:
  // there the canonical path's first segment is a DRIVE (`c:`), and
  // path.resolve(cwd, 'c:/windows/...') re-absolutizes rather than nesting, so
  // a suffix can leave the jail. On POSIX every suffix is jail-relative by
  // construction and the check never fires. Pinned so a future "this branch is
  // unreachable" cleanup doesn't delete a real win32 guard.
  (process.platform === 'win32' ? it : it.skip)('a drive-qualified suffix cannot leave the workspace', () => {
    const hosts = 'C:/Windows/System32/drivers/etc/hosts';
    expect(workspaceMatchFor(hosts, root, realExists)).toBeNull();
  });
});
