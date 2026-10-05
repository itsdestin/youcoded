// Coverage: every session-scoped push leaves the core through `publish` (one-core R5-1).
//
// WHY: a missed site is a silent gap later — the record would be missing that event, and (R5-3) a phone that only
// receives what it watches would never hear it. Three source scans, each fed by the real tree:
//  1. every push in SESSION_SCOPED_PUSHES is sent by a `publish(...)` call, and by nothing else on the windows' side;
//  2. every phone-side send in src/main is either `publish`, a GLOBAL push (not about one session), or a listed
//     split-delivery exception — so a NEW push has to be classified the day it is added;
//  3. the exceptions are real (a stale entry fails too).
// The ast-grep rule no-paired-session-send-and-broadcast is the same invariant in executable form for a new pair of calls.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { IPC } from '../src/shared/types';
import { SESSION_SCOPED_PUSHES, SPLIT_DELIVERY } from '../src/main/session-record';

const MAIN = join(__dirname, '..', 'src', 'main');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const full = join(dir, n);
  return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
});
const files = walk(MAIN).map((f) => ({ rel: relative(MAIN, f).split('\\').join('/'), text: readFileSync(f, 'utf8') }));
const publishFile = files.find((f) => f.rel === 'publish.ts')!;
const code = files.filter((f) => f.rel !== 'publish.ts');

// How a push's name is spelled at a call site: IPC.<CONSTANT> or the string itself.
const constantFor = (channel: string) => Object.entries(IPC).find(([, v]) => v === channel)?.[0];
const spellings = (channel: string) => [`'${channel}'`, `"${channel}"`, ...(constantFor(channel) ? [`IPC.${constantFor(channel)}`] : [])];

describe('every session-scoped push goes through publish', () => {
  it('scans the real tree (non-vacuity)', () => {
    expect(code.length).toBeGreaterThan(200);
    expect(publishFile.text).toContain('export function createPublish');
  });

  for (const channel of SESSION_SCOPED_PUSHES) {
    it(`${channel}: sent by a publish call, never by a bare sendForSession`, () => {
      const names = spellings(channel);
      const published = code.filter((f) => names.some((n) => new RegExp(`publish\\(\\s*[\\w.?]+,\\s*${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(f.text)));
      expect(published.map((f) => f.rel), `no publish(...) call sends ${channel}`).not.toEqual([]);
      const bare = code.filter((f) => names.some((n) => new RegExp(`sendForSession\\(\\s*[\\w.?]+,\\s*${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(f.text)));
      expect(bare.map((f) => f.rel), `${channel} is still sent to windows by hand`).toEqual([]);
    });
  }
});

// Phone-side sends outside publish. `scope` says why each is allowed.
const PHONE_SEND = /(?:remoteServer\??\.broadcast|this\.broadcast|sendToPhones|remoteBroadcast\??\.?)\(\{\s*type:\s*([^,]+),/g;
const ALLOWED: Array<{ file: string; type: string; scope: 'global' | 'split'; why: string }> = [
  { file: 'social-handlers.ts', type: '"social:presence-event"', scope: 'global', why: 'presence is about people, not a session' },
  { file: 'remote-server.ts', type: "'status:data'", scope: 'global', why: 'the status bar' },
  { file: 'remote-server.ts', type: "'pty:output'", scope: 'split', why: SPLIT_DELIVERY['pty:output'] },
  { file: 'remote-server.ts', type: "'session:created'", scope: 'global', why: 'the session list: everyone needs it' },
  { file: 'remote-server.ts', type: "'session:destroyed'", scope: 'global', why: 'the session list: everyone needs it' },
  { file: 'remote-server.ts', type: 'channel', scope: 'global', why: 'a change a phone made through the channel table, handed to every phone (tags and similar)' },
  { file: 'ipc-handlers.ts', type: 'IPC.TAGS_CHANGED', scope: 'global', why: 'tags are shared by every conversation' },
  { file: 'ipc-handlers.ts', type: 'SESSION_SUMMARY_CHANNEL', scope: 'global', why: 'the per-session summary goes to everyone by design' },
  { file: 'ipc-handlers.ts', type: 'IPC.SESSION_MOVED', scope: 'global', why: 'reaches every main window, not the owner (the 2026-07-18 moved-pill bug)' },
  { file: 'ipc-handlers.ts', type: "'engine:install-progress'", scope: 'global', why: 'the local engine, not a session' },
  { file: 'ipc-handlers.ts', type: "'engine:status-changed'", scope: 'global', why: 'the local engine, not a session' },
  { file: 'ipc-handlers.ts', type: "'models:download-progress'", scope: 'global', why: 'a download, not a session' },
  { file: 'ipc-handlers.ts', type: "'session:renamed'", scope: 'global', why: 'the session list: everyone needs the new name' },
  { file: 'ipc-handlers.ts', type: 'IPC.GITHUB_CONNECT_DONE', scope: 'global', why: 'an account flow' },
  { file: 'ipc-handlers.ts', type: 'ARTIFACT_IPC.CHANGED', scope: 'global', why: 'files, not a session' },
  { file: 'ipc-handlers.ts', type: 'IPC.PAGES_CHANGED', scope: 'global', why: 'pages, not a session' },
  { file: 'ipc-handlers.ts', type: 'channel', scope: 'global', why: 'the channel table\'s own "every screen" push (tags and similar)' },
  { file: 'main.ts', type: "'syncspaces:event'", scope: 'global', why: 'sync, not a session' },
  { file: 'ipc/ui.ts', type: "'ui:action'", scope: 'global', why: 'a screen-level action' },
  { file: 'doc-comments/ipc-handlers.ts', type: 'DOC_COMMENTS_IPC.CHANGED', scope: 'global', why: 'document comments, not a session' },
  { file: 'ipc/appearance.ts', type: 'IPC.APPEARANCE_SYNC', scope: 'global', why: 'the theme' },
];

describe('every other phone-side send is classified', () => {
  const found: Array<{ file: string; type: string }> = [];
  for (const f of code) for (const m of f.text.matchAll(PHONE_SEND)) found.push({ file: f.rel, type: m[1].trim() });

  it('finds the sends (non-vacuity)', () => { expect(found.length).toBeGreaterThanOrEqual(15); });

  it('a phone-side send that is neither global nor a listed split delivery must go through publish', () => {
    const unclassified = found.filter((s) => !ALLOWED.some((a) => a.file === s.file && a.type === s.type));
    expect(unclassified, 'a new phone-side send: send it through publish(sessionId, type, payload) if it is about one session, or add it to ALLOWED as global with a reason').toEqual([]);
  });

  it('no session-scoped push is among them', () => {
    for (const s of found) {
      if (ALLOWED.some((a) => a.file === s.file && a.type === s.type && a.scope === 'split')) continue; // listed, with its reason
      const hit = SESSION_SCOPED_PUSHES.find((c) => spellings(c).includes(s.type));
      expect(hit, `${s.file} sends ${hit} to phones by hand`).toBeUndefined();
    }
  });

  it('lists no stale exception (each allowed send still exists)', () => {
    const stale = ALLOWED.filter((a) => !found.some((s) => s.file === a.file && s.type === a.type));
    expect(stale).toEqual([]);
  });

  it('gives every exception a reason', () => {
    for (const a of ALLOWED) expect(a.why.length, `${a.file} ${a.type}`).toBeGreaterThan(8);
  });
});
