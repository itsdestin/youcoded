// Pins the Task 5 unlock: native sessions are real Conversation Store records
// (Task 4), so session:set-flag/set-tag/set-note/get-meta/browse can read and
// write them like any other session instead of refusing up front.
//
// Background: a 2026-07-18 gate correctly stopped native writes from seeding
// mislabeled provider:'claude' phantom records, and a 2026-07-19 stopgap
// (nativeMetaRefusal, session-meta-native-refusal.test.ts — now deleted) made
// that refusal HONEST (ok:false + no broadcast) instead of the silent-loss
// shape it replaced. Retiring that refusal is only safe now that native writes
// land somewhere real — a write-only test would pass against a regression
// where the write silently vanishes into the WRONG bucket, so the acceptance
// here is a full ROUND TRIP: write, then read the SAME value back through BOTH
// session:get-meta AND session:browse.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0-test'), whenReady: vi.fn(() => new Promise(() => {})), on: vi.fn(), quit: vi.fn(), setAppUserModelId: vi.fn(), commandLine: { appendSwitch: vi.fn() }, getGPUInfo: vi.fn(() => new Promise(() => {})) },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } })),
  Menu: { setApplicationMenu: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  clipboard: { readImage: vi.fn(() => ({ isEmpty: () => true })) },
  nativeImage: {},
  shell: { openExternal: vi.fn() },
  powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
}));

import { registerIpcHandlers } from '../src/main/ipc-handlers';
import { startConversationStore, stopConversationStore, getConversationStore, pruneNativePhantomRecords } from '../src/main/conversations/service';

// A persisted native session is one with a file at
// <home>/.youcoded/sessions/<slug>/<sessionId>.jsonl — that's exactly what
// SessionStore.has() scans, and what NativeSessionHost.isNativeSessionId()
// consults for a session that is NOT currently live. Real file, real
// ConversationStore (createConversationStore against a tmpdir, unmocked) —
// no fakes standing in for the thing this test exists to prove works.
const NATIVE_ID = '11111111-2222-3333-4444-555555555555';
const CC_ID = '99999999-8888-7777-6666-555555555555';

let tmpHome: string;
let tmpConvRoot: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

function setup(sessionManagerOverrides: Record<string, unknown> = {}) {
  const mockIpcMain = { handle: vi.fn(), on: vi.fn() };
  const mockSessionManager = {
    createSession: vi.fn(),
    destroySession: vi.fn(() => true),
    listSessions: vi.fn(() => []),
    getSession: vi.fn(() => undefined),
    sendInput: vi.fn(),
    resizeSession: vi.fn(),
    on: vi.fn(),
    ...sessionManagerOverrides,
  };
  const mockWindow = { webContents: { send: vi.fn() }, isDestroyed: () => false };
  const mockSkillProvider = {
    configStore: { getPackages: vi.fn(() => ({})) },
    install: vi.fn(),
    installMany: vi.fn(),
    ensureBundledPluginsInstalled: vi.fn(),
    ensureMigrated: vi.fn(),
  };
  registerIpcHandlers(
    mockIpcMain as any,
    mockSessionManager as any,
    mockWindow as any,
    mockSkillProvider as any,
  );
  const handler = (channel: string) =>
    (mockIpcMain.handle as any).mock.calls.find((c: any) => c[0] === channel)[1];
  return { handler, mockWindow };
}

// One home for the whole file — see session-meta-native-refusal.test.ts's (now
// deleted) rationale for why: registerIpcHandlers kicks off background init
// (ProviderRegistry.init → writes ~/.youcoded) that no test awaits, so deleting
// the dir per-test raced those writes and surfaced as unhandled ENOENT
// rejections. A single dir plus no mid-run deletion avoids it.
beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-meta-parity-'));
  // Redirect the home via $HOME rather than vi.spyOn(os, 'homedir'):
  // native-home.ts does `import * as os`, and the spy does NOT reach that
  // namespace binding — it left the fixture invisible. USERPROFILE is the
  // Windows equivalent and MUST be set too (desktop CI runs windows-latest).
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  // Deliberately not removed — see the native-refusal test's same note: nothing
  // exposes a handle to await ProviderRegistry.init()'s background writes.
});

beforeEach(async () => {
  const slugDir = path.join(tmpHome, '.youcoded', 'sessions', 'test-project');
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(
    path.join(slugDir, `${NATIVE_ID}.jsonl`),
    JSON.stringify({ v: 1, sessionId: NATIVE_ID, harnessId: 'assistant', cwd: '/tmp/test-project', createdAt: Date.now() }) + '\n',
  );
  tmpConvRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-meta-parity-store-'));
  // REAL store (design's acceptance: a fake would let a write-to-wrong-bucket
  // regression pass). noteFlagChanged/noteSessionNote buffer until the store
  // settles 'ready'/'unavailable' (conversations/service.ts) — awaiting start
  // here means every call in a test sees the fast 'ready' path.
  await startConversationStore({
    conversationsRoot: tmpConvRoot,
    projectsDir: path.join(tmpHome, '.claude', 'projects'),
    topicsDir: path.join(tmpHome, '.claude', 'topics'),
    device: 'test-device',
  });
});

afterEach(() => {
  stopConversationStore();
  vi.restoreAllMocks();
  try { fs.rmSync(tmpConvRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); } catch {}
});

describe('native session meta — round trip', () => {
  it('tag → persist → get-meta and browse both return it for a native session', async () => {
    const { handler } = setup();

    const setRes = await handler('session:set-tag')({ sender: { id: 1 } }, NATIVE_ID, 'tag_physics', true);
    expect(setRes).toEqual({ ok: true });

    const meta = await handler('session:get-meta')({ sender: { id: 1 } }, NATIVE_ID);
    expect(meta).toMatchObject({ tags: ['tag_physics'], note: '', supported: true });

    const rows = await handler('session:browse')();
    const row = rows.find((r: any) => r.sessionId === NATIVE_ID);
    expect(row).toBeTruthy();
    expect(row.provider).toBe('native');
    expect(row.tags).toEqual(['tag_physics']);
  });

  it('note → persist → get-meta returns it for a native session', async () => {
    const { handler } = setup();

    const setRes = await handler('session:set-note')({ sender: { id: 1 } }, NATIVE_ID, 'debugging the spinner regex');
    expect(setRes).toEqual({ ok: true });

    const meta = await handler('session:get-meta')({ sender: { id: 1 } }, NATIVE_ID);
    expect(meta).toMatchObject({ note: 'debugging the spinner regex', supported: true });
  });

  it('a reserved flag round-trips for a native session (previously refused outright)', async () => {
    const { handler } = setup();

    const setRes = await handler('session:set-flag')({ sender: { id: 1 } }, NATIVE_ID, 'priority', true);
    expect(setRes).toEqual({ ok: true });

    const rows = await handler('session:browse')();
    const row = rows.find((r: any) => r.sessionId === NATIVE_ID);
    expect(row?.flags).toMatchObject({ priority: true });
  });

  it('broadcast fires only after the record is readable', async () => {
    const { handler, mockWindow } = setup();
    const recordPath = path.join(tmpConvRoot, 'native', `${NATIVE_ID}.json`);
    let sawTagAtBroadcastTime: boolean | null = null;

    (mockWindow.webContents.send as any).mockImplementation((channel: string, ...args: any[]) => {
      if (channel !== 'session:meta-changed') return;
      // By the time sendForSession runs, the handler has already AWAITED
      // noteFlagChanged's write — read the file synchronously right here to
      // prove the record landed BEFORE this broadcast, not concurrently with
      // or after it (which would let a listener refetch and "confirm" a
      // change that hadn't actually persisted yet — the exact 2026-07-19
      // incident shape, just for the persistence-timing dimension).
      try {
        const rec = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        sawTagAtBroadcastTime = !!rec?.flags?.['tag:tag_physics']?.value;
      } catch {
        sawTagAtBroadcastTime = false;
      }
    });

    const res = await handler('session:set-tag')({ sender: { id: 1 } }, NATIVE_ID, 'tag_physics', true);
    expect(res.ok).toBe(true);
    expect(sawTagAtBroadcastTime).toBe(true);
  });
});

// C1 (final review): a native record can exist in the store WITHOUT a local
// ~/.youcoded/sessions file — the record synced from a peer but its transcript
// hasn't been materialized here yet (Task 5 exposes full meta controls on such
// store-only browse rows). isNativeSessionId() returns FALSE for it (SessionStore
// .has() is live/on-disk only), so the OLD sessionProviderFor(isNativeSessionId
// ? 'native' : 'claude') tagged it 'claude' → SEEDED a claude/<id>.json phantom
// (blank transcriptRef, EPOCH lastActive) that syncs out and shadows the real
// native record. The fix probes the store's native bucket before defaulting.
describe('store-only native record — meta routes to the native bucket (C1)', () => {
  // UUID-shaped so it passes the store id guard; deliberately NOT the NATIVE_ID
  // that beforeEach lays a sessions file down for — this id has a store record
  // but NO ~/.youcoded/sessions file, so isNativeSessionId() answers false.
  const STORE_ONLY_ID = '22222222-3333-4444-5555-666666666666';

  async function seedStoreOnlyNative() {
    const store = getConversationStore()!;
    // A realistic synced-but-not-materialized native record: real activity, a
    // native-lane transcriptRef pointing at the space copy that hasn't been
    // pulled to ~/.youcoded/sessions on THIS device yet.
    await store.upsert({
      id: STORE_ONLY_ID,
      provider: 'native',
      lastActive: new Date().toISOString(),
      title: 'synced native session',
      transcriptRef: `native/transcripts/test-project/${STORE_ONLY_ID}.jsonl`,
    });
  }

  it('set-tag writes native/, creates NO claude phantom, and survives phantom-prune', async () => {
    const { handler } = setup();
    await seedStoreOnlyNative();
    // Precondition: no sessions file for this id, so it is NOT isNativeSessionId.
    const sessionsFile = path.join(tmpHome, '.youcoded', 'sessions', 'test-project', `${STORE_ONLY_ID}.jsonl`);
    expect(fs.existsSync(sessionsFile)).toBe(false);

    const res = await handler('session:set-tag')({ sender: { id: 1 } }, STORE_ONLY_ID, 'tag_physics', true);
    expect(res).toEqual({ ok: true });

    // The tag landed in the NATIVE bucket...
    const nativePath = path.join(tmpConvRoot, 'native', `${STORE_ONLY_ID}.json`);
    const nativeRec = JSON.parse(fs.readFileSync(nativePath, 'utf8'));
    expect(nativeRec.flags['tag:tag_physics']?.value).toBe(true);
    // ...and NO claude phantom was seeded.
    const claudePath = path.join(tmpConvRoot, 'claude', `${STORE_ONLY_ID}.json`);
    expect(fs.existsSync(claudePath)).toBe(false);

    // get-meta reads it back from the native bucket (same routing on the read).
    const meta = await handler('session:get-meta')({ sender: { id: 1 } }, STORE_ONLY_ID);
    expect(meta).toMatchObject({ tags: ['tag_physics'], supported: true });

    // pruneNativePhantomRecords (which only ever touches the claude bucket)
    // leaves the correctly-routed native record untouched.
    const pruned = await pruneNativePhantomRecords({ nativeHomeRoot: tmpHome });
    expect(pruned).toBe(0);
    expect(fs.existsSync(nativePath)).toBe(true);
    const stillTagged = JSON.parse(fs.readFileSync(nativePath, 'utf8'));
    expect(stillTagged.flags['tag:tag_physics']?.value).toBe(true);
  });

  it('set-note routes to the native bucket too', async () => {
    const { handler } = setup();
    await seedStoreOnlyNative();
    const res = await handler('session:set-note')({ sender: { id: 1 } }, STORE_ONLY_ID, 'peer-synced note');
    expect(res).toEqual({ ok: true });
    const nativeRec = JSON.parse(fs.readFileSync(path.join(tmpConvRoot, 'native', `${STORE_ONLY_ID}.json`), 'utf8'));
    expect(nativeRec.note).toBe('peer-synced note');
    expect(fs.existsSync(path.join(tmpConvRoot, 'claude', `${STORE_ONLY_ID}.json`))).toBe(false);
  });
});

describe('Claude Code sessions — unaffected by the native unlock (regression)', () => {
  it('set-flag on a CC id still succeeds', async () => {
    const { handler } = setup();
    const res = await handler('session:set-flag')({ sender: { id: 1 } }, CC_ID, 'complete', true);
    expect(res.ok).toBe(true);
  });

  it('set-flag on a LIVE CC session with no hook mapping yet still returns ok:true', async () => {
    // The pre-existing phantom-record gate skips the store WRITE here (the
    // desktop id isn't mapped to a claude id yet), but the flag re-applies
    // once the SessionStart hook lands the mapping — so this must NOT surface
    // as a failure the renderer reverts. Regression guard carried forward from
    // the retired stopgap test: canWriteStoreRecord's CC live-before-mapping
    // gate is untouched by this task, only its native-false branch was removed.
    const { handler } = setup({
      getSession: vi.fn(() => ({ id: CC_ID, name: 'live', cwd: '/tmp', status: 'active' })),
    });
    const res = await handler('session:set-flag')({ sender: { id: 1 } }, CC_ID, 'priority', true);
    expect(res.ok).toBe(true);
    expect(res.unsupported).toBeUndefined();
  });

  it('get-meta on a CC id reports supported:true', async () => {
    const { handler } = setup();
    const meta = await handler('session:get-meta')({ sender: { id: 1 } }, CC_ID);
    expect(meta.supported).toBe(true);
  });

  it('an unknown flag name is still rejected before any provider logic', async () => {
    // Validation error, not a provider-derived path — ordering matters so a
    // typo surfaces as a typo even on a native session id.
    const { handler } = setup();
    const res = await handler('session:set-flag')({ sender: { id: 1 } }, NATIVE_ID, 'bogus', true);
    expect(res.ok).toBe(false);
    expect(res.unsupported).toBeUndefined();
    expect(res.error).toContain('bogus');
  });
});
