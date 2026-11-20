// @vitest-environment jsdom
// The device table (src/shared/device-table.ts): what works / is hidden / is not yet on the computer, the Android app and a
// remote browser. Review item R-5, phases 1-2 (Destin, 2026-11-18).
//
// What these pin, in plain terms:
//  1. The table is well formed (every row has all three places, a plain name, a note where one is owed).
//  2. Every channel the code marks "computer only" or "not for a paired browser" belongs to exactly one row (or the short
//     plumbing list), so a new such channel cannot be added without saying what each device does with it.
//  3. The table never contradicts the code: a row that owns a refused channel cannot say "works" for a browser, and a row
//     tied to a capability cannot say "works" where capabilities.ts says the device cannot.
//  4. The CHECK (phase 2): a screen that calls a feature the table says does not work somewhere must ask the table first.
//     REPORT-ONLY today (Destin's answer on V-4 was "confused"); flip ENFORCE_DEVICE_TABLE to make it fail the build.
//  5. featureWorks() answers from the right place, and the voice-words editor (V-2) is hidden on the phone app.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEVICE_TABLE, INTERNAL_CHANNELS, isInternalChannel, rowForChannel, type DeviceRow, type Door,
} from '../src/shared/device-table';
import { ANDROID_LOCAL_CAPABILITIES, DESKTOP_WINDOW_CAPABILITIES, REMOTE_SCREEN_CAPABILITIES } from '../src/shared/capabilities';
import { RENDERER, readSource, readStripped, assertScopeIsPopulated } from './helpers/guard-scope';

const SRC = join(RENDERER, '..');
const DOORS: Door[] = ['computer', 'phoneApp', 'remote'];

// ── what the code says about each channel ────────────────────────────────────────────────────────────────────────────
const contract = readSource(join(SRC, 'shared', 'backend-contract.ts'));
interface Flagged { channel: string; family: string; desktopOnly: boolean; refusedForBrowser: boolean }
function channelFlags(): Flagged[] {
  const dir = join(SRC, 'main', 'ipc');
  const out: Flagged[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !['channel-def.ts', 'channel-table.ts', 'file-gates.ts'].includes(f))) {
    const src = readStripped(join(dir, file));
    for (const chunk of src.split('defineChannel({').slice(1)) {
      const konst = /name: IPC\.([A-Z0-9_]+)/.exec(chunk)?.[1];
      const channel = konst ? new RegExp(`\\b${konst}: '([^']+)'`).exec(contract)?.[1] : /name: '([^']+)'/.exec(chunk)?.[1];
      if (!channel) continue; // a name the scan cannot resolve (doc-comments, handoff helpers): none of those carry the flags
      out.push({ channel, family: file, desktopOnly: /desktopOnly: true/.test(chunk), refusedForBrowser: /remoteAllowed: false/.test(chunk) });
    }
  }
  return out;
}
const FLAGGED = channelFlags().filter((c) => c.desktopOnly || c.refusedForBrowser);

describe('the table is well formed', () => {
  it('has rows, unique ids, plain names, all three places and a note where one is owed', () => {
    expect(DEVICE_TABLE.length).toBeGreaterThanOrEqual(40);
    expect(new Set(DEVICE_TABLE.map((r) => r.id)).size).toBe(DEVICE_TABLE.length);
    for (const row of DEVICE_TABLE) {
      expect(row.name.length, row.id).toBeGreaterThan(8);
      expect(row.name, `${row.id}: a plain name, not a channel id`).not.toMatch(/[a-z]:[a-z]/);
      expect(Object.keys(row.doors).sort(), row.id).toEqual([...DOORS].sort());
      for (const d of DOORS) expect(['works', 'hidden', 'not-yet'], `${row.id}.${d}`).toContain(row.doors[d]);
      expect(row.channels.length > 0 || row.capability, `${row.id} owns no channel and no capability`).toBeTruthy();
      expect(row.doors.computer, `${row.id}: every row works on the computer`).toBe('works');
      const owesNote = !row.verified || DOORS.some((d) => row.doors[d] === 'not-yet');
      if (owesNote) expect(row.note.length, `${row.id} owes a note`).toBeGreaterThan(10);
    }
  });

  it('no two rows claim the same channel text', () => {
    const seen = new Map<string, string>();
    for (const row of DEVICE_TABLE) for (const c of row.channels) {
      expect(seen.get(c), `"${c}" claimed by ${seen.get(c)} and ${row.id}`).toBeUndefined();
      seen.set(c, row.id);
    }
  });
});

describe('every refused channel is owned', () => {
  it('finds the channel flags (the scan itself works)', () => {
    expect(channelFlags().length).toBeGreaterThan(400);
    expect(FLAGGED.length).toBeGreaterThan(150);
  });

  it('every computer-only or browser-refused channel belongs to a row or the plumbing list', () => {
    const orphans = FLAGGED.filter((c) => !rowForChannel(c.channel) && !isInternalChannel(c.channel)).map((c) => `${c.channel} (${c.family})`);
    expect(orphans, 'add a row (or a plumbing entry with its reason) to src/shared/device-table.ts').toEqual([]);
  });

  it('a channel is never both a row\'s and plumbing', () => {
    expect(FLAGGED.filter((c) => rowForChannel(c.channel) && isInternalChannel(c.channel)).map((c) => c.channel)).toEqual([]);
    for (const p of INTERNAL_CHANNELS) expect(p.why.length, p.channel).toBeGreaterThan(10);
  });

  it('a row that owns a refused channel does not say "works" for a remote browser', () => {
    const bad = FLAGGED.map((c) => ({ c, row: rowForChannel(c.channel) })).filter((x) => x.row && x.row.doors.remote === 'works')
      .map((x) => `${x.row!.id} owns ${x.c.channel}`);
    expect(bad).toEqual([]);
  });
});

describe('the table agrees with capabilities.ts', () => {
  // The host overrides these three in its handshake (remote-server.ts authOkMessage), so the conservative default being
  // false does not mean a browser cannot do them.
  const HOST_SAYS_YES_TO_BROWSERS = new Set(['nativeSessions', 'chatgptAccount', 'sessionRecord']);
  const SETS: Record<Door, Record<string, unknown>> = {
    computer: DESKTOP_WINDOW_CAPABILITIES as unknown as Record<string, unknown>,
    phoneApp: ANDROID_LOCAL_CAPABILITIES as unknown as Record<string, unknown>,
    remote: REMOTE_SCREEN_CAPABILITIES as unknown as Record<string, unknown>,
  };
  it('a row tied to a capability is not "works" where the device cannot do it', () => {
    const bad: string[] = [];
    for (const row of DEVICE_TABLE.filter((r) => r.capability)) for (const d of DOORS) {
      const can = SETS[d][row.capability!] === true || (d === 'remote' && HOST_SAYS_YES_TO_BROWSERS.has(row.capability!));
      if (row.doors[d] === 'works' && !can) bad.push(`${row.id} says works on ${d} but ${row.capability} is false there`);
      // The other direction: a device that CAN do it must not be marked hidden/not-yet without the row saying why.
      if (row.doors[d] !== 'works' && can && row.note.length < 10) bad.push(`${row.id} withholds ${row.capability} on ${d} with no note`);
    }
    expect(bad).toEqual([]);
  });
});

// ── phase 2: the check ──────────────────────────────────────────────────────────────────────────────────────────────
/** Flip to true to make a screen that uses a not-everywhere feature without asking the table FAIL the build. Left false:
 *  Destin has not decided how strict the check should be (V-4 on the review deck: "confused"). */
const ENFORCE_DEVICE_TABLE = false;

/** Screens that may use such a feature without asking, each with the reason. Empty at first; the check below only REPORTS. */
const ALLOWED: Array<{ file: string; row: string; why: string }> = [];

/** A file "uses" a row's feature when it reaches window.claude.<one of the row's apis>. It "asks the table" when it names
 *  featureWorks('<row id>') or tests the row's capability. */
function findUngatedUses(files: Array<{ path: string; code: string }>, rows: DeviceRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.apis.length === 0) continue;
    if (DOORS.every((d) => row.doors[d] === 'works')) continue; // works everywhere: nothing to gate
    const uses = new RegExp(`\\bclaude\\)?\\??\\.(?:${row.apis.join('|')})\\b`);
    for (const f of files) {
      if (!uses.test(f.code)) continue;
      const asks = f.code.includes(`featureWorks('${row.id}')`) || (row.capability && new RegExp(`\\b${row.capability}\\b`).test(f.code));
      if (!asks && !ALLOWED.some((a) => f.path.endsWith(a.file) && a.row === row.id)) out.push(`${f.path} uses "${row.name}" (${row.id}) without asking the table`);
    }
  }
  return out;
}

function renderSources(): Array<{ path: string; code: string }> {
  const out: Array<{ path: string; code: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'dev') walk(p); continue; } // dev = the workbench's fake backend
      if (!/\.tsx?$/.test(name) || /\.test\./.test(name) || name === 'remote-shim.ts' || name === 'feature-gate.ts') continue;
      out.push({ path: p.replace(RENDERER, ''), code: readStripped(p) });
    }
  };
  walk(RENDERER);
  return out;
}

describe('the check: a screen uses a not-everywhere feature only after asking the table', () => {
  it('catches a fake offender, accepts one that asks, and honours the allow-list', () => {
    const row = DEVICE_TABLE.find((r) => r.id === 'voice-words')!;
    const offender = { path: '/components/Fake.tsx', code: 'window.claude.voiceVocabulary.get()' };
    expect(findUngatedUses([offender], [row])).toHaveLength(1);
    expect(findUngatedUses([{ ...offender, code: `if (featureWorks('voice-words')) window.claude.voiceVocabulary.get()` }], [row])).toEqual([]);
    expect(findUngatedUses([{ path: '/components/Other.tsx', code: 'window.claude.voice.start()' }], [row])).toEqual([]);
    // a row that works everywhere is never an offence
    expect(findUngatedUses([offender], [{ ...row, doors: { computer: 'works', phoneApp: 'works', remote: 'works' } }])).toEqual([]);
  });

  it('the real screens: REPORT-ONLY (lists today\'s offenders; fails only when ENFORCE_DEVICE_TABLE is on)', () => {
    const files = renderSources();
    assertScopeIsPopulated(files.map((f) => f.path), 100);
    const offenders = findUngatedUses(files, DEVICE_TABLE);
    if (offenders.length) console.log(`device-table check (report only): ${offenders.length} screen(s) use a not-everywhere feature without asking the table:\n  ${offenders.join('\n  ')}`);
    // The one screen already moved over (V-2) must be clean even in report-only mode.
    expect(offenders.filter((o) => o.includes('(voice-words)'))).toEqual([]);
    if (ENFORCE_DEVICE_TABLE) expect(offenders).toEqual([]);
  });
});

// ── featureWorks() ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('featureWorks answers from the right place', () => {
  afterEach(async () => {
    const { setConnectionMode } = await import('../src/renderer/platform');
    setConnectionMode('local');
    delete (window as unknown as { __PLATFORM__?: string }).__PLATFORM__;
    vi.resetModules();
  });
  const setPlace = async (platform: 'electron' | 'android' | 'browser', mode: 'local' | 'remote') => {
    (window as unknown as { __PLATFORM__?: string }).__PLATFORM__ = platform;
    const { setConnectionMode } = await import('../src/renderer/platform');
    setConnectionMode(mode);
    return (await import('../src/renderer/feature-gate')).featureWorks;
  };

  it('voice words: works on the computer; not on the phone app, a paired phone or a browser; an unknown id never works', async () => {
    expect((await setPlace('electron', 'local'))('voice-words')).toBe(true);
    expect((await setPlace('android', 'local'))('voice-words')).toBe(false);
    expect((await setPlace('android', 'remote'))('voice-words')).toBe(false);
    expect((await setPlace('browser', 'remote'))('voice-words')).toBe(false);
    expect((await setPlace('electron', 'local'))('no-such-feature')).toBe(false);
  });

  it('a feature that works on the phone app is true there, and false on a browser', async () => {
    expect((await setPlace('android', 'local'))('voice-typing')).toBe(true);
    expect((await setPlace('browser', 'remote'))('voice-typing')).toBe(false);
  });
});
