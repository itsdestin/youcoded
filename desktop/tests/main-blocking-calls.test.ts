/**
 * ONE guard for every blocking call in the Electron main process.
 *
 * The main process runs every window's IPC, every PTY relay and every timer on
 * ONE thread. A blocking call there — `fs.readFileSync`, `fs.existsSync`,
 * `execSync`, any `*Sync` from 'fs' or 'child_process' — freezes every window
 * until it returns. Past incidents: a 6-minute freeze on a sync lease write
 * (2026-09-08), whole-.git walks on the sync poll, Resume-list opens that
 * head-read every transcript.
 *
 * HOW IT WORKS — a ratchet:
 *   1. Every blocking call in src/main/** (tests excluded) must be named in
 *      tests/main-blocking-calls.allowlist.json — keyed by file, the enclosing
 *      function and the call, with a count. A NEW call fails.
 *   2. An allowlist entry that no longer matches (the call was removed or made
 *      async) fails too, as "stale" — delete it. So the list can only shrink.
 *   3. PROTECTED below names hot paths that were already made async. A
 *      blocking call there fails even if someone allowlists it, and each named
 *      function must still exist, as the same kind of thing (a rename would
 *      otherwise quietly un-guard it). Banned calls are matched on the AST.
 *
 * WHY one class-wide test (2026-09-23, Destin: "a small number of generally
 * applicable rules instead of many narrow ones"): this replaces fourteen
 * per-file ast-grep rules (no-sync-fs-*, *-stays-async, read-tool-no-blocking-read,
 * native-session-list-uses-async-form …), each guarding one function and
 * blind to everything else — and all blind to `import { readFileSync }`.
 * Every protection those rules gave is carried in PROTECTED below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { scanMain, scanSource, keyOf, type AllowEntry, type ScannedFile } from './helpers/main-blocking-calls';

const MAIN_DIR = join(__dirname, '..', 'src', 'main');
const ALLOWLIST_PATH = join(__dirname, 'main-blocking-calls.allowlist.json');

/** The allowlist's groups. An entry's group is its review status. */
const GROUPS = ['startup-or-shutdown-only', 'user-rare', 'unreviewed-hot-path-candidate'] as const;

const HOW_TO_FIX = [
  'WHAT TO DO: the Electron main process has one thread; a blocking call there',
  'freezes every window until it returns. Prefer the async form —',
  '`await fs.promises.readFile(...)` (stat, readdir, writeFile, mkdir, rm …), or',
  'an async child process (`execFile` with a callback / util.promisify, `spawn`).',
  'Only if the call truly runs just at startup/shutdown, or is tiny and rare',
  '(a user clicking a button once), add an entry to',
  'desktop/tests/main-blocking-calls.allowlist.json, in the right group, with a',
  'one-line "reason". Never add one inside a PROTECTED hot path (see the test).',
].join('\n');

// ---------------------------------------------------------------------------
// PROTECTED — hot paths already made async. Carried over, one row per retired
// ast-grep rule, so nothing those rules banned can come back via the allowlist.
// ---------------------------------------------------------------------------
/** What a protected name must still BE, not just that something by that name
 *  exists. WHY (review 2026-09-23): the retired rules each required one shape —
 *  `walk` an arrow function held in a const, session-browser's names function
 *  declarations — so turning one into a different kind of thing is drift the
 *  guard must notice, the way the old rule would have. */
type ScopeKind = 'function' | 'method' | 'class' | 'const-arrow';

interface Protection {
  /** The retired rule this row replaces — kept so `git log -S` finds the history. */
  was: string;
  file: string;
  why: string;
  /** Named scopes (function, method, class or `const x = () =>`) that must exist
   *  and hold NO blocking call. `'*'` = the whole file. */
  noBlocking: string[];
  /** With `'*'`: scopes inside the file that are exempt. */
  except?: string[];
  /** More names that must still exist in the file. */
  mustExist?: string[];
  /** The kind every name above must be. Required for each name (checked). */
  kinds?: Record<string, ScopeKind>;
  /** Calls banned outright (blocking or not) — a sync twin of an async API.
   *  Matched on the AST, never on source text, so spacing, line breaks and
   *  comments inside the call cannot hide it: `callee` is tested against the
   *  dotted callee path (`fs.statSync`, `this.nativeHost.list`); `args`, when
   *  given, must equal the printed arguments exactly (`[]` = no arguments). */
  bannedCalls?: { scope?: string; callee: RegExp; args?: string[]; what: string }[];
  /** Identifiers / strings banned inside a scope. */
  bannedNames?: { scope: string; re: RegExp; what: string }[];
  /** A call that must still appear, awaited (compared as printed code, so
   *  formatting cannot make it look lost). */
  requiredAwait?: { text: string; what: string };
}

const PROTECTED: Protection[] = [
  { was: 'no-sync-fs-in-main-hot-path', file: 'conversations/lease-client.ts', noBlocking: ['createLeaseClient'],
    kinds: { createLeaseClient: 'function' },
    why: 'runs per lease acquire/renew/release; 2026-09-08 a sync lease write froze the app 6+ minutes' },
  { was: 'no-sync-fs-in-main-hot-path-git-transport', file: 'sync-spaces/git-transport.ts', noBlocking: ['gitDirSizeBytes'],
    kinds: { gitDirSizeBytes: 'method' },
    why: "runs from the sync engine's 120 s poll for EVERY space; a sync .git walk held the main thread" },
  ...['conversations/transcript-mirror.ts', 'marketplace-file-reader.ts', 'transcript-cwd.ts',
    'harness/tools/edit.ts', 'harness/tools/write.ts', 'harness/tools/file-fingerprint.ts',
    'conversations/reconciler.ts'].map((file): Protection => ({
    was: 'no-sync-fs-whole-file', file, noBlocking: ['*'],
    why: 'the whole file is on a hot or user-action read path (transcript mirroring, marketplace viewer, ' +
      'Resume Browser, the model file tools several times per turn, the reconciler walk over every transcript)',
  })),
  { was: 'no-sync-fs-in-main-read-path-session-browser', file: 'session-browser.ts', noBlocking: ['*'],
    except: ['loadHistory'], mustExist: ['readIndexMeta'],
    kinds: { loadHistory: 'function', readIndexMeta: 'function' },
    why: "the Resume Browser's listing path runs once per project slug on every open" },
  { was: 'no-sync-fs-in-main-read-path-theme-preview', file: 'theme-preview-generator.ts', noBlocking: ['buildPreviewHTML'],
    kinds: { buildPreviewHTML: 'function' },
    why: 'regenerating a theme preview after a wallpaper edit must not freeze the app' },
  { was: 'no-sync-fs-in-per-session-polls', file: 'ipc-handlers.ts',
    noBlocking: ['buildStatusData', 'readTopicFile', 'startPolling', 'attachTopicWatch'],
    kinds: { buildStatusData: 'function', readTopicFile: 'function', startPolling: 'function', attachTopicWatch: 'function' },
    why: 'per-session timers (status every 10 s, topic every 2 s) for every open session' },
  { was: 'native-session-list-uses-async-form', file: 'ipc-handlers.ts', noBlocking: [],
    bannedCalls: [{ callee: /nativeHost\.list$/, args: [], what: 'nativeHost.list() — use nativeHost.listAsync()' }],
    why: 'the sync list head-reads every native session file on every Resume list open' },
  { was: 'native-session-list-uses-async-form', file: 'remote-server.ts', noBlocking: [],
    bannedCalls: [{ callee: /nativeHost\.list$/, args: [], what: 'nativeHost.list() — use nativeHost.listAsync()' }],
    why: 'the sync list head-reads every native session file on every Resume list open' },
  { was: 'no-sync-fs-in-native-home-async-reads', file: 'native-home.ts',
    noBlocking: ['readSessionLinesAsync', 'listSessionFilesAsync', 'readSessionHeadAsync'],
    kinds: { readSessionLinesAsync: 'method', listSessionFilesAsync: 'method', readSessionHeadAsync: 'method' },
    why: 'every scroll-up page, tear-off and Resume list open; the sync twins stay legal for their sync callers' },
  { was: 'no-sync-fs-in-transcript-global-poll', file: 'transcript-watcher.ts', noBlocking: ['ensureGlobalPoll'],
    kinds: { ensureGlobalPoll: 'method' },
    why: 'safety poll every 2 s for every watched transcript' },
  { was: 'native-host-history-reads-stay-async', file: 'harness/native-session-host.ts',
    noBlocking: ['getHistoryAsync', 'getHistoryPageAsync'], mustExist: ['isLive'],
    kinds: { getHistoryAsync: 'method', getHistoryPageAsync: 'method', isLive: 'method' },
    bannedNames: [{ scope: 'isLive', re: /readEvents|getHistory/, what: 'a history read inside isLive()' }],
    why: 'history pages and tear-offs; isLive is a boolean check that once read a whole history to throw it away' },
  { was: 'no-sync-fs-in-accepted-history-publish', file: 'harness/accepted-history-store.ts',
    noBlocking: ['IncrementalTranscriptReader', 'publish', 'atomicWrite', 'DigestTable',
      'restore', 'restoreNow', 'readBoundedJsonAsync', 'rawTranscript', 'restoreImage', 'restorePart', 'restoreContent'],
    kinds: { IncrementalTranscriptReader: 'class', publish: 'method', atomicWrite: 'method', DigestTable: 'class',
      restore: 'method', restoreNow: 'method', readBoundedJsonAsync: 'method', rawTranscript: 'function',
      restoreImage: 'function', restorePart: 'function', restoreContent: 'function' },
    why: 'publish() runs at EVERY turn boundary (DigestTable reads its attachments); restore() on every Resume of a native chat (2026-09-24 B8)' },
  // 2026-09-24 blocking-calls B8 — the native harness's per-turn / per-tool reads.
  { was: '(none — 2026-09-24 blocking-calls B8)', file: 'harness/pdf-text.ts', noBlocking: ['extract'],
    kinds: { extract: 'function' },
    why: 'every Read of a .pdf read the whole file synchronously' },
  { was: '(none — 2026-09-24 blocking-calls B8)', file: 'harness/injection/path-triggers.ts', noBlocking: ['*'],
    mustExist: ['buildTriggerIndex'], kinds: { buildTriggerIndex: 'function' },
    why: 'the depth-4 project walk runs on every session create/resume AND every specialist spawn mid-turn' },
  { was: '(none — 2026-09-24 blocking-calls B8)', file: 'harness/shell-registry.ts', noBlocking: ['read', 'readOnce', 'unlinkEnvFile'],
    kinds: { read: 'method', readOnce: 'method', unlinkEnvFile: 'method' },
    why: 'BashOutput polls a background shell up to 8 times a turn (once ~150 times in a real incident)' },
  { was: '(none — 2026-09-24 blocking-calls B8)', file: 'providers/secrets-store.ts', noBlocking: ['get', 'readAsync'],
    kinds: { get: 'method', readAsync: 'method' },
    why: 'get() fetches the API key on every cloud model turn' },
  { was: 'read-tool-no-blocking-read', file: 'harness/tools/read.ts', noBlocking: [],
    bannedCalls: [
      { callee: /^fs\.(readFileSync|readdirSync)$/, what: 'fs.readFileSync / fs.readdirSync' },
      { callee: /^fs\.statSync$/, args: ['abs'], what: 'fs.statSync(abs) on the target (the missing-file hint may stat another path)' },
    ],
    why: 'the Read tool runs several times per turn' },
  { was: 'session-store-async-reads-stay-async', file: 'harness/session-store.ts',
    noBlocking: ['readEventsAsync'], mustExist: ['listAsync'],
    kinds: { readEventsAsync: 'method', listAsync: 'method' },
    bannedCalls: [{ scope: 'listAsync', callee: /(^|\.)(readSessionHead|listSessionFiles)$/,
      what: 'the sync readSessionHead()/listSessionFiles() inside listAsync' }],
    why: 'history pages, tear-offs and every Resume list open' },
  { was: 'no-sync-fs-in-glob-walk', file: 'harness/tools/glob.ts', noBlocking: ['walk'],
    kinds: { walk: 'const-arrow' },
    requiredAwait: { text: 'fs.promises.stat(root)', what: 'the async root probe `await fs.promises.stat(root)`' },
    why: "the Glob tool's directory walk ran sync and froze every window, several times per turn" },
  // WHY whole-file: every method of the naming store sits on the per-reply
  // auto-naming check or a rename click (2026-09-24 triage batch B3).
  { was: 'none (new 2026-09-24, main-blocking triage B3)', file: 'conversations/naming-store.ts', noBlocking: ['*'],
    mustExist: ['conflictCopiesIn'], kinds: { conflictCopiesIn: 'function' },
    why: 'get() runs on every completed reply and once listed the whole naming folder synchronously' },
  { was: 'main-blocking-calls B6 (2026-09-24)', file: 'sync-spaces/space-manager.ts',
    noBlocking: ['readDisk', 'writeDisk', 'runFlush', 'mutate', 'maybeRefresh',
      'isEnabled', 'lastSyncFor', 'remoteFor', 'recordSyncSuccess', 'recordRemote', 'setEnabled'],
    kinds: { readDisk: 'method', writeDisk: 'method', runFlush: 'method', mutate: 'method', maybeRefresh: 'method',
      isEnabled: 'method', lastSyncFor: 'method', remoteFor: 'method', recordSyncSuccess: 'method',
      recordRemote: 'method', setEnabled: 'method' },
    why: 'every successful sync of every space rewrote sync-spaces.json, and every status query re-read it — ' +
      'only loadInitial (the first read at sync startup) may block' },
  { was: 'main-blocking-calls B6 (2026-09-24)', file: 'sync-spaces/import-project.ts', noBlocking: ['*'],
    why: "Import existing folder: the file-count walk could hold every window for its 2 s budget, and a " +
      'cross-drive move copied the whole folder synchronously' },
  { was: 'model-poll-stays-async (new 2026-09-24)', file: 'engine/engine-supervisor.ts',
    noBlocking: ['findModelChildRss', 'residentBytesForModel', 'emitModelsIfChanged', 'listModels'],
    kinds: { findModelChildRss: 'function', residentBytesForModel: 'method', emitModelsIfChanged: 'method', listModels: 'method' },
    bannedCalls: [
      { scope: 'listModels', callee: /^(scanGgufCache|scanLocalDownloads)$/, what: 'the sync cache scan inside listModels — use scanGgufCacheAsync' },
      { scope: 'emitModelsIfChanged', callee: /^(scanGgufCache|scanLocalDownloads)$/, what: 'the sync cache scan inside the model poll' },
    ],
    why: 'the local-model poll runs every 10 s, and every 400 ms while a model loads; the /proc search for the progress bar read every process on the machine synchronously each tick' },
  { was: 'model-poll-stays-async (new 2026-09-24)', file: 'engine/cache-scan.ts',
    noBlocking: ['scanLocalDownloadsAsync', 'readDirentsAsync', 'scanOneDirAsync', 'foldOneDir', 'scanGgufCacheAsync'],
    kinds: { scanLocalDownloadsAsync: 'function', readDirentsAsync: 'function', scanOneDirAsync: 'function',
      foldOneDir: 'function', scanGgufCacheAsync: 'function' },
    bannedCalls: [{ scope: 'scanGgufCacheAsync', callee: /^scanLocalDownloads$/, what: 'the sync scan inside the async one' }],
    why: 'the async cache scan is what the model poll runs; the sync twins stay legal for their sync callers' },
  { was: 'blocking-call batch B1 (2026-09-24)', file: 'transcript-page.ts', noBlocking: ['*'],
    mustExist: ['readTranscriptPage', 'readLines'],
    kinds: { readTranscriptPage: 'function', readLines: 'function' },
    why: 'every conversation open, scroll-up and buddy open reads a page (up to 2 MB); it was async in name only' },
  { was: 'blocking-call batch B1 (2026-09-24)', file: 'subagent-watcher.ts',
    noBlocking: ['getHistory', 'readMeta', 'scanDirectory', 'scanOnce'],
    kinds: { getHistory: 'method', readMeta: 'method', scanDirectory: 'method', scanOnce: 'method' },
    why: 'getHistory re-read every helper transcript per history page; scanDirectory runs on every line a helper appends (Linux directory watch)' },
];

// ---------------------------------------------------------------------------

function loadAllowlist(): { entries: (AllowEntry & { group: string })[]; raw: Record<string, unknown> } {
  const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as Record<string, unknown>;
  const entries: (AllowEntry & { group: string })[] = [];
  for (const g of GROUPS) {
    for (const e of (raw[g] as AllowEntry[] | undefined) ?? []) entries.push({ ...e, group: g });
  }
  return { entries, raw };
}

/** Every function-like node in `sf` whose scope name is `name`. */
function scopeNodes(sf: ts.SourceFile, name: string): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    const nm = (n as { name?: ts.Node }).name;
    const direct = nm && (ts.isIdentifier(nm) || ts.isPrivateIdentifier(nm)) ? nm.text : undefined;
    let found = direct;
    if (!found && (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent) &&
        ts.isIdentifier(n.parent.name)) found = n.parent.name.text;
    if (found === name && (ts.isFunctionLike(n) || ts.isClassLike(n))) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function eachDescendant(n: ts.Node, fn: (d: ts.Node) => void): void {
  ts.forEachChild(n, (c) => { fn(c); eachDescendant(c, fn); });
}

function isKind(n: ts.Node, kind: ScopeKind): boolean {
  switch (kind) {
    case 'function': return ts.isFunctionDeclaration(n);
    case 'method': return ts.isMethodDeclaration(n);
    case 'class': return ts.isClassDeclaration(n);
    case 'const-arrow': return ts.isArrowFunction(n) && ts.isVariableDeclaration(n.parent);
  }
}

/** The callee as a dotted path built from the AST (`fs.statSync`,
 *  `this.nativeHost.list`), so no spacing or comment can change it. Wrappers
 *  that do not change what is called (`( … )`, `x!`, `x as T`) are looked
 *  through; any other segment reads `(…)`. */
function calleePath(e: ts.Expression): string {
  if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) return calleePath(e.expression);
  if (ts.isIdentifier(e) || ts.isPrivateIdentifier(e)) return e.text;
  if (e.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(e)) return `${calleePath(e.expression)}.${e.name.text}`;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    return `${calleePath(e.expression)}.${e.argumentExpression.text}`;
  }
  return '(…)';
}

// Prints a node as canonical code: fixed spacing, no comments.
const printer = ts.createPrinter({ removeComments: true });
const printed = (n: ts.Node, sf: ts.SourceFile): string => printer.printNode(ts.EmitHint.Unspecified, n, sf);

function callMatches(d: ts.CallExpression, sf: ts.SourceFile, b: { callee: RegExp; args?: string[] }): boolean {
  if (!b.callee.test(calleePath(d.expression))) return false;
  if (!b.args) return true;
  return d.arguments.length === b.args.length && d.arguments.every((a, i) => printed(a, sf) === b.args![i]);
}

describe('main-process blocking calls (one allowlist, ratcheted)', () => {
  const scanned = scanMain(MAIN_DIR);
  const { entries, raw } = loadAllowlist();

  it('allowlist is well-formed: known groups, unique keys, positive counts', () => {
    const problems: string[] = [];
    for (const k of Object.keys(raw)) {
      if (k !== 'README' && !(GROUPS as readonly string[]).includes(k)) problems.push(`unknown group "${k}"`);
    }
    const seen = new Set<string>();
    for (const e of entries) {
      const k = keyOf(e);
      if (seen.has(k)) problems.push(`duplicate entry ${k}`);
      seen.add(k);
      if (!Number.isInteger(e.count) || e.count < 1) problems.push(`${k}: count must be a whole number ≥ 1`);
      if (e.group !== 'unreviewed-hot-path-candidate' && !e.reason) problems.push(`${k}: a reviewed entry needs a "reason"`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('every blocking call in src/main is on the allowlist (new ones fail)', () => {
    const allowed = new Map(entries.map((e) => [keyOf(e), e.count]));
    const actual = new Map<string, { count: number; lines: string[] }>();
    for (const f of scanned.values()) {
      for (const c of f.calls) {
        const k = keyOf(c);
        const a = actual.get(k) ?? { count: 0, lines: [] };
        a.count++; a.lines.push(`${c.file}:${c.line}`);
        actual.set(k, a);
      }
    }
    const added: string[] = [];
    for (const [k, a] of actual) {
      const n = allowed.get(k) ?? 0;
      if (a.count > n) {
        const [file, fn, call] = k.split('|');
        added.push(`  ${a.lines.join(', ')} — ${a.count - n} new \`${call}(...)\` in ${fn}` +
          `\n    allowlist entry, if it truly qualifies: {"file": "${file}", "fn": "${fn}", "call": "${call}", "count": ${a.count}, "reason": "..."}`);
      }
    }
    expect(added, `New blocking call(s) in the Electron main process:\n${added.join('\n')}\n\n${HOW_TO_FIX}`).toEqual([]);
  });

  it('no allowlist entry outlives its call (the list only shrinks)', () => {
    const actual = new Map<string, number>();
    for (const f of scanned.values()) for (const c of f.calls) actual.set(keyOf(c), (actual.get(keyOf(c)) ?? 0) + 1);
    const stale: string[] = [];
    for (const e of entries) {
      const n = actual.get(keyOf(e)) ?? 0;
      if (n < e.count) {
        stale.push(n === 0
          ? `  STALE entry ${keyOf(e)} — no such call any more: delete this entry.`
          : `  STALE count ${keyOf(e)} — allowlist says ${e.count}, source has ${n}: lower "count" to ${n}.`);
      }
    }
    expect(stale, `Allowlist entries that no longer match anything in desktop/tests/main-blocking-calls.allowlist.json ` +
      `(good news — a blocking call went away; shrink the list so it cannot come back):\n${stale.join('\n')}`).toEqual([]);
  });

  describe.each(PROTECTED.map((p) => [`${p.file} (${p.noBlocking.join(', ') || p.was})`, p] as const))(
    'protected hot path %s', (_label, p) => {
      it('still exists and holds no blocking call, allowlisted or not', () => {
        const f = scanned.get(p.file) as ScannedFile | undefined;
        expect(f, `${p.file} is gone — point this PROTECTED row at its new path (or drop it if the code is gone on purpose)`).toBeDefined();
        const problems: string[] = [];
        for (const name of [...p.noBlocking, ...(p.except ?? []), ...(p.mustExist ?? [])]) {
          if (name === '*') continue;
          if (!f!.scopes.has(name)) {
            problems.push(`\`${name}\` no longer exists in ${p.file} — renamed? Update PROTECTED so the guard follows it.`);
            continue;
          }
          const kind = p.kinds?.[name];
          if (!kind) {
            problems.push(`PROTECTED row for ${p.file} names \`${name}\` without its kind — add it to \`kinds\`.`);
          } else if (!scopeNodes(f!.source, name).some((n) => isKind(n, kind))) {
            problems.push(`\`${name}\` in ${p.file} is no longer a ${kind} — the guard was written for that shape; ` +
              `check the change keeps the path async, then update \`kinds\`.`);
          }
        }
        for (const c of f!.calls) {
          const inScope = p.noBlocking.includes('*')
            ? !(p.except ?? []).some((x) => c.chain.includes(x))
            : p.noBlocking.some((x) => c.chain.includes(x));
          if (inScope) problems.push(`${p.file}:${c.line} \`${c.call}(...)\` in ${c.fn} — this path must stay async (${p.why}).`);
        }
        for (const b of p.bannedCalls ?? []) {
          const roots = b.scope ? scopeNodes(f!.source, b.scope) : [f!.source];
          for (const r of roots) {
            eachDescendant(r, (d) => {
              if (ts.isCallExpression(d) && callMatches(d, f!.source, b)) {
                const line = f!.source.getLineAndCharacterOfPosition(d.getStart(f!.source)).line + 1;
                problems.push(`${p.file}:${line} ${b.what} is banned here (${p.why}).`);
              }
            });
          }
        }
        for (const b of p.bannedNames ?? []) {
          for (const r of scopeNodes(f!.source, b.scope)) {
            eachDescendant(r, (d) => {
              if ((ts.isIdentifier(d) || ts.isStringLiteralLike(d)) && b.re.test(d.text)) {
                const line = f!.source.getLineAndCharacterOfPosition(d.getStart(f!.source)).line + 1;
                problems.push(`${p.file}:${line} ${b.what} (\`${d.text}\`) is banned (${p.why}).`);
              }
            });
          }
        }
        if (p.requiredAwait) {
          let found = false;
          eachDescendant(f!.source, (d) => {
            if (ts.isAwaitExpression(d) && printed(d.expression, f!.source) === p.requiredAwait!.text) found = true;
          });
          if (!found) problems.push(`${p.file} lost ${p.requiredAwait.what} (${p.why}).`);
        }
        expect(problems, `${problems.join('\n')}\n\nThis replaced ast-grep rule ${p.was}. ${HOW_TO_FIX}`).toEqual([]);
      });
    });

  it('a banned call is found however it is spaced, wrapped or commented, and a lookalike is not', () => {
    // Self-test for bannedCalls: they used to be matched as whitespace-collapsed
    // text, so `fs.statSync( abs )` slipped past a ban on `fs.statSync(abs)`.
    const src = [
      'fs.statSync( abs );', 'fs.statSync(/* target */ abs);', 'fs\n  .statSync(\n    abs,\n  );',
      'this.nativeHost . list( );', "deps.nativeHost['list']();", '(nativeHost as any).list();',
      // Lookalikes — NOT the banned call:
      'fs.statSync(other);', 'fs.statSync(abs, opts);', 'nativeHost.list(filter);', 'nativeHost.listAsync();',
    ];
    const statBan = { callee: /^fs\.statSync$/, args: ['abs'] };
    const listBan = { callee: /nativeHost\.list$/, args: [] as string[] };
    const hits = src.map((line) => {
      const sf = ts.createSourceFile('probe.ts', line, ts.ScriptTarget.Latest, true);
      let hit = false;
      eachDescendant(sf, (d) => {
        if (ts.isCallExpression(d) && (callMatches(d, sf, statBan) || callMatches(d, sf, listBan))) hit = true;
      });
      return hit;
    });
    expect(hits).toEqual([true, true, true, true, true, true, false, false, false, false]);
  });

  it('the scanner catches every spelling of a blocking call and nothing else', () => {
    // Self-test in place of an ast-grep fixture: proves each import shape is
    // resolved, so the guard cannot silently go blind to one.
    const src = [
      "import * as fs from 'fs';",
      "import nodeFs from 'node:fs';",
      "import { readFileSync, existsSync as exists, promises } from 'fs';",
      "import { execSync, execFile } from 'child_process';",
      "const cp = require('node:child_process');",
      "const { statSync } = require('fs');",
      'export function a() { fs.readdirSync(x); nodeFs.writeFileSync(x, y); readFileSync(x); exists(x); }',
      'export class K { m() { execSync(c); cp.spawnSync(c); statSync(x); fs.realpathSync.native(x); require("fs").mkdirSync(x); } }',
      'const arrow = () => { ipcMain.handle(IPC.FOO, async () => fs.rmSync(x)); };',
      // Not blocking — must NOT be reported:
      'async function ok() { await fs.promises.readFile(x); await promises.stat(x); execFile(c, cb); zlib.gzipSync(b); other.readSync(); }',
    ].join('\n');
    const got = scanSource('probe.ts', src).calls.map((c) => `${c.fn}|${c.call}`);
    expect(got).toEqual([
      'a|fs.readdirSync', 'a|nodeFs.writeFileSync', 'a|readFileSync', 'a|exists',
      'K.m|execSync', 'K.m|cp.spawnSync', 'K.m|statSync', 'K.m|fs.realpathSync.native', 'K.m|require("fs").mkdirSync',
      'arrow.handle(IPC.FOO)|fs.rmSync',
    ]);
  });
});
