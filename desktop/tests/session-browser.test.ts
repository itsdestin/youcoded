import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createConversationStore } from '../src/main/conversations/conversation-store';
import { nativeStoreSlug } from '../src/main/slug-encoding';

// Task 7 (store union): session-browser reads the Conversation Store via a
// dynamic import of './conversations/service' inside listPastSessions. The real
// service singleton is only non-null after startConversationStore() runs (which
// drags in the whole sync-spaces graph). We mock the service module to a thin
// facade whose getConversationStore() reads a mutable holder — each store test
// drops a REAL createConversationStore(tempRoot) into the holder, exercising the
// genuine store read path without booting sync-spaces. resetModules re-applies
// vi.mock automatically, so the harness's per-call reset still works.
const storeHolder = vi.hoisted(() => ({ current: null as any }));
// Saved folders the mocked buildLocalProjectResolver resolves against. Empty by
// default → resolution is originalPath-only (the pre-fix behavior most tests
// assume). A cross-OS test drops THIS device's folder in to exercise the
// name/basename fallback that fixes cross-device resume.
const savedHolder = vi.hoisted(() => ({ current: [] as Array<{ path: string }> }));
vi.mock('../src/main/conversations/service', async () => {
  // Reuse the REAL resolver so the mock can't drift from production behavior;
  // managed roots aren't exercised here (empty map), saved folders come from the
  // per-test holder.
  const { resolveLocalProject } = await import('../src/main/conversations/resolve-local-project');
  return {
    getConversationStore: () => storeHolder.current,
    buildLocalProjectResolver: () => (rec: any) => resolveLocalProject(rec, new Map(), savedHolder.current),
  };
});

let tmpHome: string;
let origHomedir: typeof os.homedir;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-browser-'));
  origHomedir = os.homedir;
  (os as any).homedir = () => tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'topics'), { recursive: true });
  // Isolation: a prior store test must not leak its store into the next test
  // (existing legacy-only tests assert the store branch is dormant).
  storeHolder.current = null;
  savedHolder.current = [];
});

afterEach(() => {
  (os as any).homedir = origHomedir;
  try { fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); } catch {}
});

// session-browser captures CLAUDE_DIR from os.homedir() at module load —
// reset + dynamic import per call so the stub applies.
async function listSessions(activeIds?: Set<string>, nativeEntries?: any[]) {
  vi.resetModules();
  const mod = await import('../src/main/session-browser');
  return mod.listPastSessions(activeIds, nativeEntries as any);
}

// Task 5: a fake NativeSessionHost.list() entry — the shape session-browser.ts
// expects (NativeSessionListEntry & {provider:'native'}). `binding` is opaque
// to session-browser (never read), so a minimal stub is enough.
function nativeEntry(overrides: Partial<{
  sessionId: string; title?: string; cwd: string; harnessId: string;
  mtimeMs: number; sizeBytes: number; slug: string;
}> = {}) {
  const cwd = overrides.cwd ?? path.join(tmpHome, 'native-proj');
  return {
    v: 1 as const,
    sessionId: overrides.sessionId ?? 'native-sid',
    harnessId: overrides.harnessId ?? 'assistant',
    binding: { modelId: 'stub', providerId: 'stub' } as any,
    cwd,
    createdAt: Date.parse('2026-06-01T00:00:00Z'),
    title: overrides.title,
    mtimeMs: overrides.mtimeMs ?? Date.parse('2026-06-15T00:00:00Z'),
    sizeBytes: overrides.sizeBytes ?? 4321,
    slug: overrides.slug ?? nativeStoreSlug(cwd),
    provider: 'native' as const,
  };
}

/** Writes a real ~/.youcoded/sessions/<slug>/<id>.jsonl — the file the
 *  notSyncedYet-for-native probe (nativeJsonlPath in session-browser.ts)
 *  checks for, mirroring writeTranscript's CC equivalent above. */
function writeNativeTranscript(cwd: string, sid: string): string {
  const dir = path.join(tmpHome, '.youcoded', 'sessions', nativeStoreSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ v: 1, sessionId: sid, cwd }) + '\n');
  return file;
}

const SID_A = '11111111-1111-4111-8111-111111111111';
const SID_B = '22222222-2222-4222-8222-222222222222';

function jsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n';
}

/** A realistic minimal transcript: meta line, user prompt, assistant reply (>500 bytes). */
function writeTranscript(slug: string, sid: string, opts: {
  firstUserText?: string;
  lastTimestamp?: string;
  model?: string;
  /** Lines appended AFTER the assistant reply — e.g. tool traffic, which is
   *  what normally sits between the last assistant message and end-of-file. */
  trailing?: Record<string, unknown>[];
} = {}): string {
  const dir = path.join(tmpHome, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  let content = '';
  content += jsonlLine({ type: 'user', isMeta: true, uuid: 'm1', timestamp: '2026-06-01T10:00:00Z', message: { content: 'meta noise' } });
  content += jsonlLine({
    type: 'user', uuid: 'u1', promptId: 'p1', timestamp: '2026-06-01T10:00:01Z',
    message: { content: opts.firstUserText ?? 'help me fix the spinner regex in the attention classifier please' },
  });
  content += jsonlLine({
    type: 'assistant', uuid: 'a1', timestamp: opts.lastTimestamp ?? '2026-06-01T10:05:00Z',
    message: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'done. '.repeat(40) }],
      ...(opts.model ? { model: opts.model } : {}),
    },
  });
  for (const line of opts.trailing ?? []) content += jsonlLine(line);
  fs.writeFileSync(file, content);
  return file;
}

describe('listPastSessions — fallback titles', () => {
  it('derives the name from the first user message when no topic exists', async () => {
    writeTranscript('C--proj-alpha', SID_A);
    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe('help me fix the spinner regex in the attention…');
  });

  it('prefers the topic file over the derived title', async () => {
    writeTranscript('C--proj-alpha', SID_A);
    fs.writeFileSync(path.join(tmpHome, '.claude', 'topics', `topic-${SID_A}`), 'Spinner Regex Fix');
    const sessions = await listSessions();
    expect(sessions[0].name).toBe('Spinner Regex Fix');
  });

  it('prefers the conversation-index topic over the derived title', async () => {
    writeTranscript('C--proj-alpha', SID_A);
    fs.writeFileSync(path.join(tmpHome, '.claude', 'conversation-index.json'), JSON.stringify({
      version: 1,
      sessions: { [SID_A]: { topic: 'Indexed Name', lastActive: '2026-06-01T10:05:00Z', slug: 'C--proj-alpha', device: 'test' } },
    }));
    const sessions = await listSessions();
    expect(sessions[0].name).toBe('Indexed Name');
  });

  it('skips injected tag-wrapped lines when deriving (e.g. command wrappers)', async () => {
    const dir = path.join(tmpHome, '.claude', 'projects', 'C--proj-alpha');
    fs.mkdirSync(dir, { recursive: true });
    let content = '';
    content += jsonlLine({
      type: 'user', uuid: 'u0', promptId: 'p0', timestamp: '2026-06-01T09:59:59Z',
      message: { content: '<command-name>/model</command-name>' },
    });
    content += jsonlLine({
      type: 'user', uuid: 'u1', promptId: 'p1', timestamp: '2026-06-01T10:00:01Z',
      message: { content: 'real question about themes' },
    });
    content += jsonlLine({
      type: 'assistant', uuid: 'a1', timestamp: '2026-06-01T10:05:00Z',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'x'.repeat(400) }] },
    });
    fs.writeFileSync(path.join(dir, `${SID_A}.jsonl`), content);
    const sessions = await listSessions();
    expect(sessions[0].name).toBe('real question about themes');
  });
});

describe('listPastSessions — content-timestamp ordering', () => {
  it('uses the transcript last timestamp instead of a clobbered mtime', async () => {
    const fileA = writeTranscript('C--proj-alpha', SID_A, { lastTimestamp: '2026-06-10T12:00:00Z' });
    const fileB = writeTranscript('C--proj-beta', SID_B, { lastTimestamp: '2026-06-01T12:00:00Z' });
    // Clobber mtimes in the WRONG order (older content gets newer mtime),
    // simulating what a sync restore does.
    fs.utimesSync(fileA, new Date('2026-01-01'), new Date('2026-01-01'));
    fs.utimesSync(fileB, new Date('2026-06-12'), new Date('2026-06-12'));
    const sessions = await listSessions();
    expect(sessions.map((s: any) => s.sessionId)).toEqual([SID_A, SID_B]);
    expect(sessions[0].lastModified).toBe(Date.parse('2026-06-10T12:00:00Z'));
  });
});

describe('listPastSessions — degradation paths', () => {
  it('handles CRLF transcripts (Windows line endings) for both title and timestamp', async () => {
    const dir = path.join(tmpHome, '.claude', 'projects', 'C--proj-alpha');
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', promptId: 'p1', timestamp: '2026-06-01T10:00:01Z', message: { content: 'crlf transcript question' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-06-03T10:05:00Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'y'.repeat(500) }] } }),
    ];
    fs.writeFileSync(path.join(dir, `${SID_A}.jsonl`), lines.join('\r\n') + '\r\n');
    const sessions = await listSessions();
    expect(sessions[0].name).toBe('crlf transcript question');
    expect(sessions[0].lastModified).toBe(Date.parse('2026-06-03T10:05:00Z'));
  });

  it('falls back to Untitled + file mtime when no prompt or timestamp is usable', async () => {
    const dir = path.join(tmpHome, '.claude', 'projects', 'C--proj-alpha');
    fs.mkdirSync(dir, { recursive: true });
    // No qualifying user line (meta only) and no timestamp on any line.
    const file = path.join(dir, `${SID_A}.jsonl`);
    fs.writeFileSync(file, jsonlLine({ type: 'user', isMeta: true, uuid: 'm1', message: { content: 'z'.repeat(600) } }));
    const mtime = new Date('2026-05-05T00:00:00Z');
    fs.utimesSync(file, mtime, mtime);
    const sessions = await listSessions();
    expect(sessions[0].name).toBe('Untitled');
    expect(sessions[0].lastModified).toBe(mtime.getTime());
  });
});

describe('listPastSessions — existing gates still hold', () => {
  it('skips sub-500-byte files and active sessions, dedups by longest slug', async () => {
    // Empty stub (0 bytes)
    const stubDir = path.join(tmpHome, '.claude', 'projects', 'C--home');
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(path.join(stubDir, `${SID_A}.jsonl`), '');
    // Real file for the same id under a longer slug
    writeTranscript('C--home-project-deep', SID_A);
    // Another real file, but active
    writeTranscript('C--proj-beta', SID_B);
    const sessions = await listSessions(new Set([SID_B]));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(SID_A);
    expect(sessions[0].projectSlug).toBe('C--home-project-deep');
  });
});

// A Claude Code conversation has no provider binding to resolve, so the ONLY
// place its model is recorded is `message.model` on each assistant line in the
// transcript. Reading it here is what puts a model on a CC card in the Resume
// Browser; without it the chip is native-only. The read piggybacks on the tail
// chunk that was already being scanned for the last timestamp.
describe('listPastSessions — last model used (Claude Code)', () => {
  it('derives lastUsedModel from the last assistant message', async () => {
    writeTranscript('C--proj-alpha', SID_A, { model: 'claude-sonnet-4-5-20250929' });
    const sessions = await listSessions();
    expect(sessions[0].lastUsedModel).toEqual({
      modelId: 'claude-sonnet-4-5-20250929',
      // NOT a native provider type — the resume prefill matches
      // providerType+modelId against the local model catalog, and a CC session
      // must never match there. It resumes on an alias, not a binding.
      providerType: 'claude-code',
      providerLabel: 'Claude Code',
    });
  });

  it('finds the model when tool traffic sits between it and end-of-file', async () => {
    // The realistic shape: the last LINE of a transcript is almost never the
    // assistant message. A scan that stopped at the first parseable line (as
    // the timestamp scan did) would find nothing here.
    writeTranscript('C--proj-alpha', SID_A, {
      model: 'claude-opus-4-7-20260115',
      trailing: [
        { type: 'user', uuid: 'tr1', timestamp: '2026-06-01T10:06:00Z', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
        { type: 'user', uuid: 'tr2', timestamp: '2026-06-01T10:06:01Z', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      ],
    });
    const sessions = await listSessions();
    expect(sessions[0].lastUsedModel?.modelId).toBe('claude-opus-4-7-20260115');
  });

  it('omits lastUsedModel entirely when no assistant line carries a model', async () => {
    // Older transcripts predate the field. Absent must stay absent — the card
    // shows no chip rather than a guessed default.
    writeTranscript('C--proj-alpha', SID_A);
    const sessions = await listSessions();
    expect(sessions[0].lastUsedModel).toBeUndefined();
  });

  it('skips CC\'s <synthetic> placeholder and reports the real model behind it', async () => {
    // Regression (2026-08-26): Claude Code stamps `"model": "<synthetic>"` on
    // assistant lines IT composed — "You've hit your session limit", "You're
    // out of usage credits", "Please run /login · API Error: 401". Those land
    // LAST, so the card labelled a 308-turn Opus conversation `<synthetic>`.
    writeTranscript('C--proj-alpha', SID_A, {
      model: 'claude-opus-5',
      trailing: [
        {
          type: 'assistant', uuid: 'syn1', timestamp: '2026-06-01T10:06:00Z',
          message: { model: '<synthetic>', stop_reason: 'end_turn', content: [{ type: 'text', text: "You've hit your session limit · resets 3:50am" }] },
        },
        {
          type: 'assistant', uuid: 'syn2', timestamp: '2026-06-01T10:06:01Z',
          message: { model: '<synthetic>', stop_reason: 'end_turn', content: [{ type: 'text', text: "You've hit your session limit · resets 3:50am" }] },
        },
      ],
    });
    const sessions = await listSessions();
    expect(sessions[0].lastUsedModel?.modelId).toBe('claude-opus-5');
  });

  it('omits lastUsedModel when EVERY assistant line is a placeholder', async () => {
    // A session that died on the very first turn (limit/auth) has no real model
    // to report. No chip is the honest answer; a fallback to the app default
    // would be a guess dressed as history.
    writeTranscript('C--proj-alpha', SID_A, {
      trailing: [{
        type: 'assistant', uuid: 'syn1', timestamp: '2026-06-01T10:06:00Z',
        message: { model: '<synthetic>', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Please run /login · API Error: 401' }] },
      }],
    });
    const sessions = await listSessions();
    expect(sessions[0].lastUsedModel).toBeUndefined();
  });

  it('still reports the last timestamp when the tail ends on a placeholder', async () => {
    // The two values share one backwards pass. Skipping a line for the MODEL
    // must not skip it for the TIMESTAMP — the placeholder line is still the
    // last thing that happened in the conversation.
    writeTranscript('C--proj-alpha', SID_A, {
      model: 'claude-opus-5',
      trailing: [{
        type: 'assistant', uuid: 'syn1', timestamp: '2026-06-03T09:15:00Z',
        message: { model: '<synthetic>', stop_reason: 'end_turn', content: [{ type: 'text', text: 'out of credits' }] },
      }],
    });
    const sessions = await listSessions();
    expect(sessions[0].lastModified).toBe(Date.parse('2026-06-03T09:15:00Z'));
    expect(sessions[0].lastUsedModel?.modelId).toBe('claude-opus-5');
  });

  it('still reports the last timestamp when a model is present', async () => {
    // Both values come from one backwards pass now; a regression in either
    // could silently break the other.
    writeTranscript('C--proj-alpha', SID_A, {
      model: 'claude-sonnet-4-5-20250929',
      lastTimestamp: '2026-06-02T08:30:00Z',
    });
    const sessions = await listSessions();
    expect(sessions[0].lastModified).toBe(Date.parse('2026-06-02T08:30:00Z'));
  });
});

describe('listPastSessions — Conversation Store union (Phase 2a)', () => {
  // Build a real store rooted under the stubbed home and stash it in the holder
  // the mocked service reads. Records live at <root>/claude/<id>.json.
  function seedStore(): ReturnType<typeof createConversationStore> {
    const root = path.join(tmpHome, 'YouCoded', 'Personal', 'Conversations');
    const store = createConversationStore(root);
    storeHolder.current = store;
    return store;
  }

  // A path guaranteed NOT to exist on this device — stands in for the
  // originalPath of a conversation that only ran on another machine.
  const absentProject = () => path.join(tmpHome, 'not-on-this-device', 'remote-proj');

  it('a record poisoned with <synthetic> does not override the transcript scan', async () => {
    // The bug the FIRST placeholder fix missed. The store overlay assigns
    // rec.lastUsedModel over the freshly-scanned transcript value
    // (session-browser.ts, `if (rec.lastUsedModel)`), so a record written
    // before the writer was guarded defeated the transcript-side fix entirely
    // — and 3 of Destin's 1,855 real records were in exactly that state,
    // including the card that started this whole investigation. The read-side
    // filter in store-core's sanitizeModelRef is what heals them.
    const store = seedStore();
    writeTranscript('C--proj-alpha', SID_A, { model: 'claude-opus-5' });
    await store.upsert({
      id: SID_A,
      provider: 'claude',
      projectName: 'proj-alpha',
      originalPath: path.join(tmpHome, 'proj-alpha'),
      title: 'Poisoned Record',
      lastActive: '2026-06-20T10:00:00Z',
      lastUsedModel: { modelId: '<synthetic>', providerType: 'claude-code', providerLabel: 'Claude Code' },
    } as any);

    const sessions = await listSessions();
    expect(sessions[0].lastUsedModel?.modelId).toBe('claude-opus-5');
  });

  it('a record with a REAL model still overrides the transcript scan', async () => {
    // Without this, the test above passes on a sanitizer that drops every
    // model ref. The store legitimately wins for a synced conversation whose
    // local transcript is stale or absent.
    const store = seedStore();
    writeTranscript('C--proj-alpha', SID_A, { model: 'claude-opus-5' });
    await store.upsert({
      id: SID_A,
      provider: 'claude',
      projectName: 'proj-alpha',
      originalPath: path.join(tmpHome, 'proj-alpha'),
      title: 'Clean Record',
      lastActive: '2026-06-20T10:00:00Z',
      lastUsedModel: { modelId: 'claude-fable-5', providerType: 'claude-code', providerLabel: 'Claude Code' },
    } as any);

    const sessions = await listSessions();
    expect(sessions[0].lastUsedModel?.modelId).toBe('claude-fable-5');
  });

  it('surfaces a remote-device conversation (no local transcript) with resume gated off', async () => {
    const store = seedStore();
    await store.upsert({
      id: SID_A,
      provider: 'claude',
      projectName: 'remote-proj',
      originalPath: absentProject(),
      title: 'Remote Conversation',
      lastActive: '2026-06-20T10:00:00Z',
      device: 'other-laptop',
    });
    await store.setFlag('claude', SID_A, 'priority', true);

    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    const row = sessions[0];
    expect(row.sessionId).toBe(SID_A);
    expect(row.name).toBe('Remote Conversation');
    expect(row.lastModified).toBe(Date.parse('2026-06-20T10:00:00Z'));
    expect(row.flags).toEqual({ priority: true });
    expect(row.device).toBe('other-laptop');
    expect(row.provider).toBe('claude');
    expect(row.missingProject).toBe(true);
    // No local project → empty slug (resume has no cwd to resume into here).
    expect(row.projectSlug).toBe('');
  });

  it('collapses a store record + local transcript into ONE row (store metadata wins, local slug kept)', async () => {
    seedStore();
    // Legacy transcript under a real slug, older content timestamp.
    writeTranscript('C--proj-alpha', SID_A, {
      firstUserText: 'the original local prompt for this session',
      lastTimestamp: '2026-06-01T10:05:00Z',
    });
    const store = storeHolder.current;
    await store.upsert({
      id: SID_A,
      provider: 'claude',
      title: 'Store Title Wins',
      lastActive: '2026-06-25T00:00:00Z',
      device: 'phone',
    });

    const sessions = await listSessions();
    expect(sessions).toHaveLength(1); // ONE row, not two
    const row = sessions[0];
    // Store wins on display metadata...
    expect(row.name).toBe('Store Title Wins');
    expect(row.lastModified).toBe(Date.parse('2026-06-25T00:00:00Z'));
    expect(row.device).toBe('phone');
    expect(row.provider).toBe('claude');
    // ...but the LOCAL transcript keeps the resume slug/path working.
    expect(row.projectSlug).toBe('C--proj-alpha');
    // A both-sources row is resumable here, so it's not flagged missing.
    expect(row.missingProject).toBeUndefined();
  });

  it('leaves a legacy row untouched when the store is off (regression guard)', async () => {
    // storeHolder.current stays null (sync off / store unavailable).
    const file = writeTranscript('C--proj-alpha', SID_A, {
      firstUserText: 'legacy only conversation with no store record',
      lastTimestamp: '2026-06-08T09:00:00Z',
    });
    const { size } = fs.statSync(file);

    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    const row = sessions[0];
    expect(row.sessionId).toBe(SID_A);
    expect(row.name).toBe('legacy only conversation with no store record');
    expect(row.projectSlug).toBe('C--proj-alpha');
    expect(row.lastModified).toBe(Date.parse('2026-06-08T09:00:00Z'));
    expect(row.size).toBe(size);
    // Store-only fields never set on a pure legacy row.
    expect(row.device).toBeUndefined();
    expect(row.provider).toBeUndefined();
    expect(row.missingProject).toBeUndefined();
  });

  it('sorts by lastModified desc across BOTH sources', async () => {
    const store = seedStore();
    // Legacy transcript — OLDER.
    writeTranscript('C--proj-beta', SID_B, { lastTimestamp: '2026-06-01T00:00:00Z' });
    // Store-only remote conversation — NEWER.
    await store.upsert({
      id: SID_A,
      provider: 'claude',
      projectName: 'remote-proj',
      originalPath: absentProject(),
      title: 'Newer Remote',
      lastActive: '2026-06-30T00:00:00Z',
      device: 'other-laptop',
    });

    const sessions = await listSessions();
    expect(sessions.map((s: any) => s.sessionId)).toEqual([SID_A, SID_B]);
  });

  it('never resurfaces a LIVE session from the store (double-attach hazard)', async () => {
    const store = seedStore();
    // A live session gains a store record within seconds of starting (live
    // intake upserts on transcript events). The union must honor the same
    // activeSessionIds exclusion the legacy scan applies — otherwise the
    // running session shows up as a resumable store-only row, and resuming it
    // spawns a second `claude --resume` against the transcript the live
    // session is appending to.
    await store.upsert({
      id: SID_A,
      provider: 'claude',
      projectName: 'proj-alpha',
      originalPath: absentProject(),
      title: 'Currently Running',
      lastActive: '2026-06-28T00:00:00Z',
      device: 'this-machine',
    });
    const sessions = await listSessions(new Set([SID_A]));
    expect(sessions).toHaveLength(0);
  });

  it('gates resume on a store-only row whose folder is local but transcript is not materialized yet', async () => {
    const store = seedStore();
    // Project folder EXISTS on this device, but the transcript hasn't been
    // materialized into ~/.claude/projects yet — `claude --resume` would error.
    const localProj = path.join(tmpHome, 'local-proj');
    fs.mkdirSync(localProj, { recursive: true });
    await store.upsert({
      id: SID_A,
      provider: 'claude',
      projectName: 'local-proj',
      originalPath: localProj,
      title: 'Folder Here, Transcript Pending',
      lastActive: '2026-06-22T00:00:00Z',
      device: 'other-laptop',
    });
    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    const row = sessions[0];
    // Distinct sub-case: the folder is here, sync just hasn't delivered the
    // transcript — renderer shows "Not synced to this device yet".
    expect(row.notSyncedYet).toBe(true);
    expect(row.missingProject).toBeUndefined();
  });

  it('resolves a CROSS-OS store-only record by saved-folder basename', async () => {
    const store = seedStore();
    // THIS device's copy of the project. Its basename ('youcoded-dev') matches
    // the record's projectName; the record's originalPath is the OTHER device's
    // path (a Linux /home/... on the real machine), modeled here as an absolute
    // path that does not exist locally.
    const localProj = path.join(tmpHome, 'youcoded-dev');
    fs.mkdirSync(localProj, { recursive: true });
    savedHolder.current = [{ path: localProj }];
    const foreignOriginalPath = path.join(tmpHome, 'other-device-home', 'youcoded-dev'); // never created
    await store.upsert({
      id: SID_A,
      provider: 'claude',
      projectName: 'youcoded-dev',
      originalPath: foreignOriginalPath,
      title: 'Cross-Device Sync Test',
      lastActive: '2026-07-12T10:43:00Z',
      device: 'destinsZ13',
    });
    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    const row = sessions[0];
    // Before the fix, the foreign originalPath resolved to null → the row was
    // (wrongly) missingProject and, if launched, resume ran in the foreign cwd →
    // blank spawn + exit. Now it resolves to THIS device's folder: an accurate
    // 'not synced yet' row (transcript not materialized in this test) carrying a
    // LOCAL cwd, never the foreign path.
    expect(row.missingProject).toBeUndefined();
    expect(row.notSyncedYet).toBe(true);
    expect(row.projectPath).toBe(localProj);
  });

  it('ignores a literal Untitled store title when the legacy row has a real name', async () => {
    const store = seedStore();
    writeTranscript('C--proj-alpha', SID_A, {
      firstUserText: 'derived name beats the placeholder',
      lastTimestamp: '2026-06-01T10:05:00Z',
    });
    // Older clients synced literal 'Untitled' topic content; a record seeded
    // fresh through upsert carries it verbatim (only the merge-override path
    // rejects the placeholder, not first-write). The union must not let it
    // clobber a real derived name.
    await store.upsert({
      id: SID_A,
      provider: 'claude',
      title: 'Untitled',
      lastActive: '2026-06-26T00:00:00Z',
      device: 'old-client',
    });
    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe('derived name beats the placeholder');
  });

  it('degrades to the legacy list when store.list() throws', async () => {
    // A store whose list rejects — the union must swallow it, not fail the call.
    storeHolder.current = { list: () => Promise.reject(new Error('store dir unreadable')) };
    writeTranscript('C--proj-alpha', SID_A, {
      firstUserText: 'survives a broken store read',
      lastTimestamp: '2026-06-05T00:00:00Z',
    });

    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(SID_A);
    expect(sessions[0].name).toBe('survives a broken store read');
  });
});

describe('listPastSessions — native rows join the SAME overlay', () => {
  function seedStore(): ReturnType<typeof createConversationStore> {
    const root = path.join(tmpHome, 'YouCoded', 'Personal', 'Conversations');
    const store = createConversationStore(root);
    storeHolder.current = store;
    return store;
  }

  it('lists a bare native row when there is no store record yet', async () => {
    const entries = [nativeEntry({ sessionId: 'native-1', title: 'Native Chat' })];
    const sessions = await listSessions(undefined, entries);
    expect(sessions).toHaveLength(1);
    const row = sessions[0];
    expect(row.provider).toBe('native');
    expect(row.sessionId).toBe('native-1');
    expect(row.name).toBe('Native Chat');
    expect(row.harnessId).toBe('assistant');
  });

  it('falls back to Untitled when the header has no title and no store record exists', async () => {
    const entries = [nativeEntry({ sessionId: 'native-2', title: undefined })];
    const sessions = await listSessions(undefined, entries);
    expect(sessions[0].name).toBe('Untitled');
  });

  it('excludes a LIVE native session (Bug 1 parity — resuming it would spawn a second writer)', async () => {
    const entries = [nativeEntry({ sessionId: 'native-live' })];
    const sessions = await listSessions(new Set(['native-live']), entries);
    expect(sessions).toHaveLength(0);
  });

  it('enriches a matching native row with its store record: flags, tags, note, device, title, lastUsedModel', async () => {
    const store = seedStore();
    await store.upsert({
      id: 'native-3',
      provider: 'native',
      projectName: 'native-proj',
      originalPath: path.join(tmpHome, 'native-proj'),
      title: 'Native Store Title',
      lastActive: '2026-07-01T00:00:00Z',
      device: 'phone',
      lastUsedModel: { modelId: 'gpt-5', providerType: 'openrouter', providerLabel: 'OpenRouter' },
    });
    await store.setFlag('native', 'native-3', 'priority', true);
    await store.setFlag('native', 'native-3', 'tag:tag_1', true);
    await store.setNote('native', 'native-3', 'left off here');

    const entries = [nativeEntry({ sessionId: 'native-3', title: 'Header Title' })];
    const sessions = await listSessions(undefined, entries);
    expect(sessions).toHaveLength(1);
    const row = sessions[0];
    // Store title wins over the header/nativeEntries-derived title...
    expect(row.name).toBe('Native Store Title');
    expect(row.device).toBe('phone');
    expect(row.flags).toEqual({ priority: true });
    expect(row.tags).toEqual(['tag_1']);
    expect(row.note).toBe('left off here');
    expect(row.lastUsedModel).toEqual({ modelId: 'gpt-5', providerType: 'openrouter', providerLabel: 'OpenRouter' });
    expect(row.provider).toBe('native');
    // ...but the row is still resumable (native transcript already listed locally).
    expect(row.missingProject).toBeUndefined();
  });

  it('does not let a literal "Untitled" store title clobber a real header/derived title', async () => {
    const store = seedStore();
    await store.upsert({
      id: 'native-3b',
      provider: 'native',
      title: 'Untitled',
      lastActive: '2026-07-01T00:00:00Z',
      device: 'phone',
    });
    const entries = [nativeEntry({ sessionId: 'native-3b', title: 'Real Header Title' })];
    const sessions = await listSessions(undefined, entries);
    expect(sessions[0].name).toBe('Real Header Title');
  });

  it('gates resume on a store-only native record whose project folder is not on this device (missingProject)', async () => {
    const store = seedStore();
    await store.upsert({
      id: 'native-4',
      provider: 'native',
      projectName: 'native-proj-foreign',
      originalPath: path.join(tmpHome, 'not-on-this-device', 'native-proj-foreign'),
      title: 'Foreign Native Session',
      lastActive: '2026-07-05T00:00:00Z',
      device: 'other-device',
    });
    // No matching nativeEntries row — this session never ran on this device.
    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    const row = sessions[0];
    expect(row.provider).toBe('native');
    expect(row.missingProject).toBe(true);
    expect(row.projectSlug).toBe('');
  });

  it('flags notSyncedYet for a store-only native record using the NATIVE probe path (~/.youcoded/sessions), not the CC one', async () => {
    const store = seedStore();
    const localProj = path.join(tmpHome, 'native-local-proj');
    fs.mkdirSync(localProj, { recursive: true });
    await store.upsert({
      id: 'native-5',
      provider: 'native',
      projectName: 'native-local-proj',
      originalPath: localProj,
      title: 'Native Folder Here',
      lastActive: '2026-07-06T00:00:00Z',
      device: 'other-device',
    });
    // Deliberately no ~/.youcoded/sessions/... file yet (sync hasn't delivered
    // the transcript) — and deliberately no ~/.claude/projects/... file either,
    // which would be the WRONG probe for a native record.
    const sessions = await listSessions();
    const row = sessions.find((s: any) => s.sessionId === 'native-5');
    expect(row?.notSyncedYet).toBe(true);
    expect(row?.missingProject).toBeUndefined();
  });

  it('clears notSyncedYet once the native transcript materializes locally', async () => {
    const store = seedStore();
    const localProj = path.join(tmpHome, 'native-local-proj-2');
    fs.mkdirSync(localProj, { recursive: true });
    await store.upsert({
      id: 'native-6',
      provider: 'native',
      projectName: 'native-local-proj-2',
      originalPath: localProj,
      title: 'Native Materialized',
      lastActive: '2026-07-07T00:00:00Z',
      device: 'other-device',
    });
    writeNativeTranscript(localProj, 'native-6');

    const sessions = await listSessions();
    const row = sessions.find((s: any) => s.sessionId === 'native-6');
    expect(row?.notSyncedYet).toBeUndefined();
    expect(row?.missingProject).toBeUndefined();
    expect(row?.projectSlug).toBe(nativeStoreSlug(localProj));
    expect(row?.projectPath).toBe(localProj);
  });

  it('overrides a native row\'s local project/slug from the store when the resolved folder holds the transcript (cross-device)', async () => {
    const store = seedStore();
    const resolvedLocal = path.join(tmpHome, 'native-resolved-proj');
    fs.mkdirSync(resolvedLocal, { recursive: true });
    writeNativeTranscript(resolvedLocal, 'native-7');
    savedHolder.current = [{ path: resolvedLocal }];

    await store.upsert({
      id: 'native-7',
      provider: 'native',
      projectName: 'native-resolved-proj',
      originalPath: path.join(tmpHome, 'not-on-this-device', 'native-resolved-proj'),
      title: 'Cross Device Native',
      lastActive: '2026-07-08T00:00:00Z',
      device: 'other-device',
    });

    // The legacy (nativeEntries) row carries a STALE cwd/slug — the kind a
    // session recorded before a folder move would leave behind.
    const staleCwd = path.join(tmpHome, 'stale-legacy-cwd');
    const entries = [nativeEntry({ sessionId: 'native-7', cwd: staleCwd })];
    const sessions = await listSessions(undefined, entries);
    const row = sessions.find((s: any) => s.sessionId === 'native-7');
    expect(row?.projectPath).toBe(resolvedLocal);
    expect(row?.projectSlug).toBe(nativeStoreSlug(resolvedLocal));
  });

  it('degrades to bare native rows when store.list() throws', async () => {
    storeHolder.current = { list: () => Promise.reject(new Error('store dir unreadable')) };
    const entries = [nativeEntry({ sessionId: 'native-8', title: 'Survives Broken Store' })];
    const sessions = await listSessions(undefined, entries);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe('Survives Broken Store');
  });
});

describe('extractStoreMeta', () => {
  it('surfaces tag:<id> flags as tags[] and note from the store record', async () => {
    const rec: any = {
      flags: {
        priority: { value: true, updatedAt: 'x' },
        helpful: { value: true, updatedAt: 'x' },          // ignored now
        'tag:tag_1': { value: true, updatedAt: 'x' },
        'tag:tag_2': { value: false, updatedAt: 'x' },     // off — excluded
      },
      note: 'left off mid-refactor',
    };
    const { extractStoreMeta } = await import('../src/main/session-browser');
    const meta = extractStoreMeta(rec);
    expect(meta.flags).toEqual({ priority: true });        // helpful dropped
    expect(meta.tags).toEqual(['tag_1']);
    expect(meta.note).toBe('left off mid-refactor');
  });
});
