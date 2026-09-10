/**
 * Privacy sentinels for the durable accepted history (cache Stage 4).
 *
 * The claim under test is the spec's §3 durability/isolation promise: the
 * reasoning ciphertext a ChatGPT continuation depends on lives in the private
 * 0600 sidecar under `<userData>/private-continuation/` and NOWHERE ELSE the
 * app can read, copy, sync, index or attach to a report.
 *
 * WHY a whole session and real readers instead of a serializer fixture: the
 * ciphertext never passes through the manifest writer alone — it flows through
 * the harness, the transcript event stream, the JSONL on disk and everything
 * downstream of those. A fixture would prove only that one function behaves;
 * this drives a real `NativeSessionHost` over the real `@ai-sdk/openai`
 * responses provider (fake SSE, temp roots) and then hands the artefacts it
 * left on disk to the ACTUAL modules that read them in production.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { createOpenAI } from '@ai-sdk/openai';
import { wrapLanguageModel } from 'ai';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { AcceptedHistoryStore } from '../src/main/harness/accepted-history-store';
import { SpecialistCatalog } from '../src/main/harness/specialists/catalog';
import { bindOpenAIContinuationModel } from '../src/main/harness/openai-continuation';
import { chatGptMiddleware } from '../src/main/providers/chatgpt-model';
import { mirrorIn } from '../src/main/conversations/transcript-mirror';
import { readSessionTranscriptMeta } from '../src/main/session-browser';
import { extractNativeUserTurns } from '../src/main/chatsearch-index/index-core';
import { parseNativeTranscript } from '../src/main/chatsearch-index/transcript-reader';
import { completed, sse } from './helpers/responses-fakes';

/** The one string that must exist in exactly one place on disk. Unique enough
 *  that a substring search over whole files is a sound test. */
const SENTINEL = 'REASONING-SENTINEL-4f1c9ae207b3d6e8';
/** A second sentinel in the visible reasoning SUMMARY — this one is allowed
 *  (and expected) in the transcript, so it is the positive control proving the
 *  searches below are looking at real, populated artefacts. */
const VISIBLE_SUMMARY = 'VISIBLE-SUMMARY-b28f5c';
const USER_TEXT = 'USER-PROMPT-7d0a41';
/** A sentinel carried in a PER-CALL tool input. The transcript owns tool inputs, and
 *  the sidecar cites the tool-use event instead of copying them — the store unit test
 *  proves that for a hand-built proposal, this proves it for a driven session. The one
 *  documented exemption (a parallel-call WRAPPER argument string) is not in play here:
 *  this is a single, unwrapped function call. */
const TOOL_INPUT_SENTINEL = 'TOOL-INPUT-SENTINEL-a71b3e';

const BINDING = { providerId: 'chatgpt', modelId: 'gpt-test' } as const;
const NO_CONTEXT = async () => ({ contextLength: null, totalSlots: null });
const identityFor = (binding: { modelId: string }) =>
  `chatgpt\u0000${binding.modelId}\u0000acct-hash\u0000epoch-1`;

type Fetch = typeof fetch;

/** Step one: encrypted reasoning whose ciphertext is the sentinel, a visible reasoning
 *  summary, and ONE `Read` call whose argument carries the tool-input sentinel. */
function sentinelStep(sentinelFile: string): unknown[] {
  const call = { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'Read', arguments: JSON.stringify({ file_path: sentinelFile }), status: 'completed' };
  return [
    { type: 'response.created', response: { id: 'resp-1', model: 'gpt-test', created_at: 1 } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs-1', encrypted_content: SENTINEL } },
    { type: 'response.reasoning_summary_part.added', item_id: 'rs-1', output_index: 0, summary_index: 0 },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs-1', output_index: 0, summary_index: 0, delta: VISIBLE_SUMMARY },
    { type: 'response.reasoning_summary_part.done', item_id: 'rs-1', output_index: 0, summary_index: 0 },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs-1', encrypted_content: SENTINEL } },
    { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
    { type: 'response.output_item.done', output_index: 1, item: call },
    completed({ output_tokens_details: { reasoning_tokens: 7 } }),
  ];
}

/** Step two: the answer that ends the turn. */
function answerStep(): unknown[] {
  return [
    { type: 'response.created', response: { id: 'resp-2', model: 'gpt-test', created_at: 1 } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-final', role: 'assistant', phase: 'final_answer', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg-final', output_index: 0, content_index: 0, delta: 'answered' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg-final', role: 'assistant', phase: 'final_answer', status: 'completed', content: [] } },
    completed(),
  ];
}

function scriptedFetch(bodies: any[], replies: unknown[][]): Fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = replies.shift();
    if (!next) throw new Error(`scriptedFetch ran out of replies at request ${bodies.length}`);
    return sse(next);
  }) as Fetch;
}

/** Every file under `dir`, recursively — the search surface for "nowhere else". */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full); else if (e.isFile()) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function readIfExists(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

describe('accepted history privacy sentinels', () => {
  let home: string; let userData: string; let cwd: string; let space: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-priv-home-'));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-priv-ud-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-priv-cwd-'));
    space = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-priv-space-'));
  });
  afterEach(() => {
    for (const dir of [home, userData, cwd, space]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('keeps the reasoning ciphertext in the private manifest and out of every reader the app has', async () => {
    const sessionId = 'privacy';
    const sentinelFile = path.join(cwd, `${TOOL_INPUT_SENTINEL}.txt`);
    fs.writeFileSync(sentinelFile, 'file contents\n');
    const nativeHome = new NativeHome(home);
    const sessionStore = new SessionStore(nativeHome);
    const acceptedHistory = new AcceptedHistoryStore(userData);
    const factory = async (binding: { modelId: string }) => {
      const provider = createOpenAI({ apiKey: 'fake', baseURL: 'https://fake.invalid/v1', fetch: scriptedFetch([], [sentinelStep(sentinelFile), answerStep()]) });
      const model = wrapLanguageModel({ model: provider.responses('gpt-test'), middleware: chatGptMiddleware('session') });
      return bindOpenAIContinuationModel(model, () => identityFor(binding)) as any;
    };
    const host = new NativeSessionHost(
      sessionStore, factory as any, NO_CONTEXT, async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, undefined, nativeHome, undefined,
      new SpecialistCatalog({ claudeUserDir: null }), () => null,
      { acceptedHistory, continuationIdentityFor: identityFor as any },
    );

    // Every event the host forwards to its consumers (renderer, remote-access
    // bridge, conversations service, title feeder) arrives on this one emitter,
    // so recording it from before `create` captures the whole forwarded stream.
    const forwarded: unknown[] = [];
    host.on('transcript-event', (e: unknown) => { forwarded.push(e); });

    await host.create({ sessionId, cwd, binding: BINDING });
    const turnComplete = new Promise<void>((resolve) => {
      const onEvent = (e: any) => { if (e.type === 'turn-complete') { host.off('transcript-event', onEvent); resolve(); } };
      host.on('transcript-event', onEvent);
    });
    host.send(sessionId, USER_TEXT);
    await turnComplete;
    await vi.waitFor(() => expect(host.isIdle(sessionId)).toBe(true));
    await host.drain(sessionId);

    const history = host.getHistory(sessionId);
    await host.destroyAll();

    // ---- The sentinel IS in the private manifest -------------------------
    const manifestPath = acceptedHistory.manifestPath(sessionId);
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = fs.readFileSync(manifestPath, 'utf8');
    expect(manifest).toContain(SENTINEL);
    // ---- and the per-call tool input is in the transcript ONLY ------------
    // End-to-end confirmation of what the store unit test proves in isolation: the
    // manifest cites the tool-use event, it never copies the arguments the model sent.
    expect(fs.readFileSync(sessionStore.transcriptPath(sessionId, cwd), 'utf8')).toContain(TOOL_INPUT_SENTINEL);
    expect(manifest).not.toContain(TOOL_INPUT_SENTINEL);
    expect(path.dirname(manifestPath)).toBe(path.join(userData, 'private-continuation'));
    // 0600 file inside a 0700 directory, on POSIX.
    if (process.platform !== 'win32') {
      expect((fs.statSync(manifestPath).mode & 0o777).toString(8)).toBe('600');
      expect((fs.statSync(path.dirname(manifestPath)).mode & 0o777).toString(8)).toBe('700');
    }
    // WHY this matters more than the mode bits: userData is the Electron
    // profile, which is NOT the NativeHome tree the sync engine and the
    // conversation exporter walk. Nothing that enumerates the transcript tree
    // can reach the sidecar at all.
    expect(path.relative(home, manifestPath).startsWith('..')).toBe(true);

    // ---- Reader 1: the session JSONL on disk -----------------------------
    const transcriptPath = sessionStore.transcriptPath(sessionId, cwd);
    const jsonl = fs.readFileSync(transcriptPath, 'utf8');
    expect(jsonl).toContain(VISIBLE_SUMMARY);   // positive control: it IS populated
    expect(jsonl).toContain(USER_TEXT);
    expect(jsonl).not.toContain(SENTINEL);
    // And nothing ELSE the harness wrote under the (syncable) native home has it.
    for (const file of filesUnder(home)) expect(readIfExists(file)).not.toContain(SENTINEL);

    // ---- Reader 2: getHistory() replay -----------------------------------
    expect(history).not.toBeNull();
    const replay = JSON.stringify(history);
    expect(replay).toContain(VISIBLE_SUMMARY);
    expect(replay).not.toContain(SENTINEL);

    // ---- Reader 3: the forwarded transcript-event stream ------------------
    const stream = JSON.stringify(forwarded);
    expect(forwarded.length).toBeGreaterThan(0);
    expect(stream).toContain(VISIBLE_SUMMARY);
    expect(stream).not.toContain(SENTINEL);

    // ---- Reader 4: the portable conversation export -----------------------
    // conversations/service.ts resolves a native session to exactly this JSONL
    // and mirrorIn copies THAT FILE byte-for-byte into the synced space; the
    // reconciler's metadata comes from readSessionTranscriptMeta over the same
    // file. Both real functions, run over the real transcript this session left.
    const spaceCopy = path.join(space, 'native', 'transcripts', path.basename(cwd), `${sessionId}.jsonl`);
    expect(await mirrorIn({ localJsonlPath: transcriptPath, spaceTranscriptPath: spaceCopy })).toEqual({ copied: true });
    expect(fs.readFileSync(spaceCopy, 'utf8')).not.toContain(SENTINEL);
    const meta = await readSessionTranscriptMeta(transcriptPath, true);
    expect(JSON.stringify(meta)).not.toContain(SENTINEL);

    // ---- Reader 5: the chatsearch index writer's input ---------------------
    // chatsearch-index/index-service.ts reads ONLY
    // `<nativeHome>/sessions/<slug>/<id>.jsonl` and feeds it to these two pure
    // parsers, so the JSONL check above already covers it — this exercises the
    // parsers over the real file to prove nothing is recovered from it.
    expect(JSON.stringify(extractNativeUserTurns(jsonl, sessionId, 0, true))).not.toContain(SENTINEL);
    expect(JSON.stringify(parseNativeTranscript(jsonl))).not.toContain(SENTINEL);

    // ---- Reader 6: the bug-report / diagnostics attachment collector -------
    // dev-tools.ts (gatherDiagnostics + readLogTail) is the whole attachment
    // surface: fixed environment probes plus the tail of ~/.claude/desktop.log.
    // It cannot be run offline (subprocess + network probes), so it is pinned
    // structurally instead: the private directory name exists in exactly ONE
    // module in the app, is not exported, and dev-tools never names userData.
    const srcRoot = path.join(__dirname, '..', 'src');
    const namesPrivateDir = filesUnder(srcRoot)
      .filter((f) => /\.(ts|tsx)$/.test(f) && readIfExists(f).includes('private-continuation'))
      .map((f) => path.relative(srcRoot, f).split(path.sep).join('/'));
    expect(namesPrivateDir).toEqual(['main/harness/accepted-history-store.ts']);
    const devTools = readIfExists(path.join(srcRoot, 'main', 'dev-tools.ts'));
    expect(devTools).not.toContain('private-continuation');
    expect(devTools).not.toContain('userData');
  });
});
