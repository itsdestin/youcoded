import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { createOpenAI } from '@ai-sdk/openai';
import { wrapLanguageModel } from 'ai';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { AcceptedHistoryStore, type AcceptedHistoryStoreHooks } from '../src/main/harness/accepted-history-store';
import { SpecialistCatalog } from '../src/main/harness/specialists/catalog';
import { resolveSpecialist } from '../src/main/harness/specialists/registry';
import { bindOpenAIContinuationModel } from '../src/main/harness/openai-continuation';
import { chatGptMiddleware } from '../src/main/providers/chatgpt-model';
import { completed, richToolStep, silentReasoningStep, sse, textStep } from './helpers/responses-fakes';

/** The identity string the registry would build for a signed-in ChatGPT account
 *  (`provider\0model\0sha256(accountId)\0credentialEpoch`) — the host never
 *  builds it itself, it asks `continuationIdentityFor`. */
const IDENTITY = 'chatgpt\u0000gpt-test\u0000acct-hash\u0000epoch-1';
const BINDING = { providerId: 'chatgpt', modelId: 'gpt-test' } as const;
const NO_CONTEXT = async () => ({ contextLength: null, totalSlots: null });
/** The shape ProviderRegistry.continuationIdentity builds for ChatGPT, so a
 *  model swap really does change the identity the way production's would. */
const identityFor = (epoch = 'epoch-1') => (binding: { modelId: string }) =>
  `chatgpt\u0000${binding.modelId}\u0000acct-hash\u0000${epoch}`;

interface Deferred { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

type Fetch = typeof fetch;

/** Records every outgoing request body and answers with the next scripted SSE
 *  reply. The bodies ARE the assertion surface: they are what the real
 *  `@ai-sdk/openai` responses provider put on the wire. */
function scriptedFetch(bodies: any[], replies: unknown[][]): Fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = replies.shift();
    if (!next) throw new Error(`scriptedFetch ran out of replies at request ${bodies.length}`);
    return sse(next);
  }) as Fetch;
}

interface HostFixture {
  host: NativeSessionHost;
  sessionStore: SessionStore;
  acceptedHistory: AcceptedHistoryStore;
}

/** A host wired exactly as ipc-handlers wires the real one, except that the
 *  model factory is the REAL Responses provider over an injected fake fetch. */
function makeHost(o: {
  home: string; userData: string; fetchImpl: Fetch;
  identity?: (binding: { modelId: string }) => string; hooks?: AcceptedHistoryStoreHooks;
  contextAndSlots?: () => Promise<{ contextLength: number | null; totalSlots: number | null }>;
  vision?: boolean;
  sessionStore?: SessionStore; acceptedHistory?: AcceptedHistoryStore;
  withoutContinuation?: boolean;
}): HostFixture {
  const nativeHome = new NativeHome(o.home);
  const sessionStore = o.sessionStore ?? new SessionStore(nativeHome);
  const acceptedHistory = o.acceptedHistory ?? new AcceptedHistoryStore(o.userData, o.hooks);
  const identity = o.identity ?? identityFor();
  // The binding the host hands the factory is the session's CURRENT one, so the
  // owner identity moves with a model swap exactly as production's does.
  const factory = async (binding: { modelId: string }) => {
    const provider = createOpenAI({ apiKey: 'fake', baseURL: 'https://fake.invalid/v1', fetch: o.fetchImpl });
    const model = wrapLanguageModel({ model: provider.responses('gpt-test'), middleware: chatGptMiddleware('session') });
    return bindOpenAIContinuationModel(model, () => identity(binding)) as any;
  };
  const host = new NativeSessionHost(
    sessionStore, factory as any, o.contextAndSlots ?? NO_CONTEXT, async () => null, async () => o.vision ?? null,
    undefined, undefined, undefined, undefined, undefined, undefined, nativeHome, undefined,
    new SpecialistCatalog({ claudeUserDir: null }), () => null,
    o.withoutContinuation ? undefined : { acceptedHistory, continuationIdentityFor: identity as any },
  );
  return { host, sessionStore, acceptedHistory };
}

/** Record every publish VERDICT the store returns — the fencing decision itself,
 *  not a proxy for it. */
function recordPublishes(store: AcceptedHistoryStore): string[] {
  const outcomes: string[] = [];
  const original = store.publish.bind(store);
  (store as any).publish = async (proposal: any) => {
    const result = await original(proposal);
    outcomes.push(result.ok ? 'ok' : result.reason);
    return result;
  };
  return outcomes;
}

/** Park the FIRST reference flush until the returned gate is released, so a
 *  publication can be caught mid-flight without a sleep. */
function gateFirstFlush(store: SessionStore): { entered: Deferred; release: Deferred } {
  const entered = deferred(); const release = deferred();
  const original = store.flushReferences.bind(store);
  let first = true;
  (store as any).flushReferences = async (sessionId: string, uuids: string[]) => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return original(sessionId, uuids);
  };
  return { entered, release };
}

function waitForTurnComplete(host: NativeSessionHost, n = 1): Promise<void> {
  return new Promise((resolve) => {
    let count = 0;
    const onEvent = (e: any) => {
      if (e.type !== 'turn-complete') return;
      count += 1;
      if (count >= n) { host.off('transcript-event', onEvent); resolve(); }
    };
    host.on('transcript-event', onEvent);
  });
}

/** Send one message and wait until the turn AND its publication have settled. */
async function turn(host: NativeSessionHost, sessionId: string, text: string): Promise<void> {
  const done = waitForTurnComplete(host);
  host.send(sessionId, text);
  await done;
  // turn-complete is emitted before runTurns unwinds; wait on the host's own
  // idle state rather than guessing, so a following /compact is never refused.
  await vi.waitFor(() => expect(host.isIdle(sessionId)).toBe(true));
  await host.drain(sessionId);
}

/** The continuation-bearing items of a request body: everything the provider
 *  replays from earlier steps, in wire order. */
function continuationItems(body: any): any[] {
  return body.input.filter((item: any) =>
    item.type === 'reasoning' || item.type === 'function_call'
    || item.type === 'function_call_output' || item.role === 'assistant');
}

describe('NativeSessionHost durable continuation', () => {
  let home: string; let userData: string; let cwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-cont-home-'));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-cont-ud-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-cont-cwd-'));
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'alpha\n');
    fs.writeFileSync(path.join(cwd, 'b.txt'), 'beta\n');
  });
  afterEach(() => {
    for (const dir of [home, userData, cwd]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  /** One turn's worth of replies: encrypted reasoning + two parallel Read calls,
   *  then the follow-up step that ends the turn. */
  const richTurn = () => [richToolStep(path.join(cwd, 'a.txt'), path.join(cwd, 'b.txt')), textStep('msg-step-2', 'done')];
  const carriesCiphertext = (body: any) => JSON.stringify(body.input).includes('CIPHERTEXT');

  /** Create a session and run one rich turn in a first "app run". */
  async function firstRun(sessionId: string, extra: Partial<Parameters<typeof makeHost>[0]> = {}): Promise<HostFixture> {
    const fx = makeHost({ home, userData, fetchImpl: scriptedFetch([], richTurn()), ...extra });
    await fx.host.create({ sessionId, cwd, binding: BINDING });
    await turn(fx.host, sessionId, 'inspect both');
    return fx;
  }

  /** Reopen in a fresh host over the same roots and send one more message;
   *  returns that message's request body — what the model actually receives. */
  async function reopenAndSend(sessionId: string, extra: Partial<Parameters<typeof makeHost>[0]> & { bindingOverride?: any } = {}): Promise<{ body: any; fx: HostFixture }> {
    const bodies: any[] = [];
    const { bindingOverride, ...hostOpts } = extra;
    const fx = makeHost({ home, userData, fetchImpl: scriptedFetch(bodies, [textStep('msg-next', 'later')]), ...hostOpts });
    expect(await fx.host.resume(sessionId, cwd, bindingOverride)).toBe(true);
    await turn(fx.host, sessionId, 'again');
    await fx.host.destroyAll();
    return { body: bodies[0], fx };
  }

  it('reopening a closed session puts the same reasoning ciphertext, item ids and phases on the wire as an uninterrupted one', async () => {
    const fileA = path.join(cwd, 'a.txt'); const fileB = path.join(cwd, 'b.txt');
    const script = () => [richToolStep(fileA, fileB), textStep('msg-step-2', 'done'), textStep('msg-step-3', 'later')];

    // Control: one process, never closed.
    const liveBodies: any[] = [];
    const live = makeHost({ home, userData, fetchImpl: scriptedFetch(liveBodies, script()) });
    await live.host.create({ sessionId: 'live', cwd, binding: BINDING });
    await turn(live.host, 'live', 'inspect both');
    await turn(live.host, 'live', 'again');
    await live.host.destroyAll();

    // Same script, but the app closes between the two turns.
    const firstBodies: any[] = [];
    const first = makeHost({ home, userData, fetchImpl: scriptedFetch(firstBodies, script().slice(0, 2)) });
    await first.host.create({ sessionId: 'reopened', cwd, binding: BINDING });
    await turn(first.host, 'reopened', 'inspect both');
    await first.host.destroy('reopened');

    const reopenedBodies: any[] = [];
    const second = makeHost({ home, userData, fetchImpl: scriptedFetch(reopenedBodies, [textStep('msg-step-3', 'later')]) });
    expect(await second.host.resume('reopened', cwd)).toBe(true);
    await turn(second.host, 'reopened', 'again');
    await second.host.destroyAll();

    expect(reopenedBodies).toHaveLength(1);
    expect(continuationItems(reopenedBodies[0])).toEqual(continuationItems(liveBodies[2]));
    // And it really is the private continuation, not just matching visible text.
    const reasoning = reopenedBodies[0].input.filter((i: any) => i.type === 'reasoning');
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).toMatchObject({ id: 'rs-1', encrypted_content: 'CIPHERTEXT'.repeat(10_000) });
    expect(reopenedBodies[0].input.filter((i: any) => i.role === 'assistant').map((i: any) => `${i.id}:${i.phase}`))
      .toEqual(['msg-commentary:commentary', 'msg-final:final_answer', 'msg-step-2:final_answer']);
  });
  it('a session with no sidecar rebuilds, and becomes durable at its very next publication', async () => {
    // First run publishes nothing: no continuation options at all.
    const plain = await firstRun('no-sidecar', { withoutContinuation: true });
    await plain.host.destroy('no-sidecar');
    expect(fs.existsSync(plain.acceptedHistory.manifestPath('no-sidecar'))).toBe(false);

    // Second run HAS the store: nothing to restore, so it rebuilds — and the
    // turn it then runs must publish a usable checkpoint even though every
    // accepted uuid predates this process.
    const second = await reopenAndSend('no-sidecar');
    expect(carriesCiphertext(second.body)).toBe(false);
    expect(fs.existsSync(second.fx.acceptedHistory.manifestPath('no-sidecar'))).toBe(true);

    // Third run restores what the second one published.
    const third = await reopenAndSend('no-sidecar');
    expect(JSON.stringify(third.body.input)).toContain('msg-next');
  });

  it('a crash between the transcript flush and the manifest write falls back to a rebuild with every visible message intact', async () => {
    // beforeRename fires for the eligibility fence first, then for the manifest:
    // failing the SECOND is exactly "the transcript is safe, the sidecar is not".
    let writes = 0;
    const fx = await firstRun('crash-b', { hooks: { beforeRename: () => { if (++writes >= 2) throw new Error('power cut'); } } });
    await fx.host.destroy('crash-b');
    // The fence landed, the manifest did not — that IS the crash window.
    expect(fs.existsSync(fx.acceptedHistory.manifestPath('crash-b'))).toBe(false);
    expect(fs.readdirSync(path.join(userData, 'private-continuation')).some((f) => f.endsWith('.eligibility.json'))).toBe(true);

    const { body } = await reopenAndSend('crash-b');
    expect(carriesCiphertext(body)).toBe(false);                       // no faithful restore
    expect(JSON.stringify(body.input)).toContain('both files');        // but nothing visible was lost
    expect(JSON.stringify(body.input)).toContain('inspect both');
  });

  it('reopening under a different credential epoch rebuilds instead of replaying another account\'s ciphertext', async () => {
    const fx = await firstRun('epoch');
    await fx.host.destroy('epoch');
    expect(fs.existsSync(fx.acceptedHistory.manifestPath('epoch'))).toBe(true);   // there IS one to refuse

    const { body } = await reopenAndSend('epoch', { identity: identityFor('epoch-2') });
    expect(carriesCiphertext(body)).toBe(false);
    expect(JSON.stringify(body.input)).toContain('both files');
  });

  it('a transcript that advanced after publication rejects the checkpoint', async () => {
    const fx = await firstRun('advanced');
    await fx.host.destroy('advanced');
    expect(fs.existsSync(fx.acceptedHistory.manifestPath('advanced'))).toBe(true);
    // A line the manifest's byte/digest high-water cannot possibly cover.
    fs.appendFileSync(fx.sessionStore.transcriptPath('advanced', cwd),
      JSON.stringify({ type: 'user-message', uuid: 'stray', sessionId: 'advanced', timestamp: 1, data: { text: 'from another process' } }) + '\n');

    const { body } = await reopenAndSend('advanced');
    expect(carriesCiphertext(body)).toBe(false);
  });

  it('a malformed sidecar falls back without touching the visible transcript', async () => {
    const fx = await firstRun('malformed');
    await fx.host.destroy('malformed');
    expect(fs.existsSync(fx.acceptedHistory.manifestPath('malformed'))).toBe(true);
    fs.writeFileSync(fx.acceptedHistory.manifestPath('malformed'), '{ not json');

    const { body } = await reopenAndSend('malformed');
    expect(carriesCiphertext(body)).toBe(false);
    expect(JSON.stringify(body.input)).toContain('both files');
  });

  it('startup orphan cleanup removes a sidecar whose transcript is gone', async () => {
    const fx = await firstRun('orphan');
    await fx.host.destroy('orphan');
    const manifest = fx.acceptedHistory.manifestPath('orphan');
    expect(fs.existsSync(manifest)).toBe(true);

    fs.rmSync(fx.sessionStore.transcriptPath('orphan', cwd));
    await new AcceptedHistoryStore(userData).cleanupOrphans();
    expect(fs.existsSync(manifest)).toBe(false);
  });

  it('a host built without the continuation options publishes nothing and resumes exactly as before', async () => {
    const fx = await firstRun('plain', { withoutContinuation: true });
    await fx.host.destroy('plain');
    expect(fs.readdirSync(userData)).toEqual([]);   // not even a private directory

    const { body, fx: reopened } = await reopenAndSend('plain', { withoutContinuation: true });
    expect(carriesCiphertext(body)).toBe(false);
    expect(JSON.stringify(body.input)).toContain('both files');
    expect(fs.existsSync(reopened.acceptedHistory.manifestPath('plain'))).toBe(false);
  });
  it('a publication still in flight when /clear runs is fenced, and the reopened session starts empty', async () => {
    const fx = makeHost({ home, userData, fetchImpl: scriptedFetch([], richTurn()) });
    const outcomes = recordPublishes(fx.acceptedHistory);
    const gate = gateFirstFlush(fx.sessionStore);
    await fx.host.create({ sessionId: 'late-clear', cwd, binding: BINDING });
    const done = waitForTurnComplete(fx.host);
    fx.host.send('late-clear', 'inspect both');
    await done;
    // The turn's publication is now parked INSIDE flushReferences: this is the
    // exact window a late write has to lose in.
    await gate.entered.promise;
    await vi.waitFor(() => expect(fx.host.isIdle('late-clear')).toBe(true));

    expect(fx.host.clear('late-clear')).toEqual({ ok: true });
    gate.release.resolve();
    await fx.host.drain('late-clear');
    // The parked one lost; the clear's own (empty) checkpoint won.
    expect(outcomes).toEqual(['stale-generation', 'ok']);
    const manifest = JSON.parse(fs.readFileSync(fx.acceptedHistory.manifestPath('late-clear'), 'utf8'));
    expect(manifest.messages).toEqual([]);
    expect(manifest.eventUuids).toEqual([]);
    await fx.host.destroy('late-clear');

    const { body } = await reopenAndSend('late-clear');
    expect(carriesCiphertext(body)).toBe(false);
    expect(JSON.stringify(body.input)).not.toContain('inspect both');
  });

  it('a publication still in flight when the model is swapped is fenced, and the reopened session rebuilds under the new binding', async () => {
    const fx = makeHost({ home, userData, fetchImpl: scriptedFetch([], richTurn()) });
    const outcomes = recordPublishes(fx.acceptedHistory);
    const gate = gateFirstFlush(fx.sessionStore);
    await fx.host.create({ sessionId: 'late-bind', cwd, binding: BINDING });
    const done = waitForTurnComplete(fx.host);
    fx.host.send('late-bind', 'inspect both');
    await done;
    await gate.entered.promise;

    expect(await fx.host.setBinding('late-bind', { providerId: 'chatgpt', modelId: 'gpt-other' })).toBe(true);
    gate.release.resolve();
    await fx.host.drain('late-bind');
    expect(outcomes).toEqual(['stale-generation', 'ok']);
    await fx.host.destroy('late-bind');

    // The surviving checkpoint still names the OLD identity, so reopening on
    // the new model refuses it rather than replaying another model's ciphertext.
    const { body } = await reopenAndSend('late-bind', { bindingOverride: { providerId: 'chatgpt', modelId: 'gpt-other' } });
    expect(carriesCiphertext(body)).toBe(false);
    expect(JSON.stringify(body.input)).toContain('both files');
  });

  it('an abandoned retry that already reached disk stays visible but never returns to the wire', async () => {
    // A reasoning-only completed response is an EMPTY step: the harness retries
    // it once, abandoning the first attempt's private reasoning.
    const reasoningOnly = (id: string) => [
      { type: 'response.created', response: { id: `resp-${id}`, model: 'gpt-test', created_at: 1 } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id, encrypted_content: `cipher-${id}` } },
      { type: 'response.reasoning_summary_part.added', item_id: id, output_index: 0, summary_index: 0 },
      { type: 'response.reasoning_summary_text.delta', item_id: id, output_index: 0, summary_index: 0, delta: 'abandoned reasoning' },
      { type: 'response.reasoning_summary_part.done', item_id: id, output_index: 0, summary_index: 0 },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id, encrypted_content: `cipher-${id}` } },
      { type: 'response.completed', response: { id: 'resp', status: 'completed', usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28, output_tokens_details: { reasoning_tokens: 2 } } } },
    ];
    const fx = makeHost({ home, userData, fetchImpl: scriptedFetch([], [reasoningOnly('empty-1'), textStep('kept', 'the real answer')]) });
    await fx.host.create({ sessionId: 'abandoned', cwd, binding: BINDING });
    await turn(fx.host, 'abandoned', 'go');
    // It really did reach disk — that is what makes the exclusion meaningful.
    const persisted = JSON.stringify(fx.host.getHistory('abandoned'));
    expect(persisted).toContain('abandoned reasoning');
    await fx.host.destroy('abandoned');

    const { body } = await reopenAndSend('abandoned');
    const wire = JSON.stringify(body.input);
    expect(wire).toContain('the real answer');
    expect(wire).not.toContain('abandoned reasoning');
    expect(wire).not.toContain('cipher-empty-1');
  });
  it('a reasoning item that never emits a summary still publishes, and its ciphertext returns to the wire', async () => {
    // WHY: the SDK opens a reasoning part for an encrypted item even with no summary
    // token, and `ai` keeps that text:'' part. An empty string has no transcript anchor,
    // so before the store's `empty` descriptor this whole turn was unpublishable and the
    // session could never become durable — the ciphertext was lost at every close.
    const fx = makeHost({ home, userData, fetchImpl: scriptedFetch([], [silentReasoningStep('msg-silent', 'answered', 'SILENT-CIPHERTEXT')]) });
    const outcomes = recordPublishes(fx.acceptedHistory);
    await fx.host.create({ sessionId: 'silent', cwd, binding: BINDING });
    await turn(fx.host, 'silent', 'quick one');
    expect(outcomes).toEqual(['ok']);

    const manifest = JSON.parse(fs.readFileSync(fx.acceptedHistory.manifestPath('silent'), 'utf8'));
    const parts = manifest.messages.flatMap((m: any) => m.content?.parts ?? []);
    expect(parts.filter((p: any) => p.kind === 'empty')).toEqual([
      { kind: 'empty', field: 'reasoning-text', providerOptions: { openai: { itemId: 'rs-silent', reasoningEncryptedContent: 'SILENT-CIPHERTEXT' } } },
    ]);
    await fx.host.destroy('silent');

    const { body } = await reopenAndSend('silent');
    expect(body.input.filter((i: any) => i.type === 'reasoning'))
      .toMatchObject([{ id: 'rs-silent', encrypted_content: 'SILENT-CIPHERTEXT' }]);
    expect(JSON.stringify(body.input)).toContain('answered');
  });

  it('a summary compaction restores as the persisted receipt plus the retained suffix', async () => {
    const replies = [
      ...richTurn(),
      textStep('turn-2', 'second answer'),
      textStep('turn-3', 'third answer'),
      textStep('sum', 'Compressed history.'),        // the /compact summary call
    ];
    const fx = makeHost({ home, userData, fetchImpl: scriptedFetch([], replies) });
    await fx.host.create({ sessionId: 'summarised', cwd, binding: BINDING });
    await turn(fx.host, 'summarised', 'inspect both');
    await turn(fx.host, 'summarised', 'and then?');
    await turn(fx.host, 'summarised', 'and after that?');
    expect(await fx.host.compact('summarised')).toEqual({ ok: true });
    await fx.host.drain('summarised');
    const manifest = JSON.parse(fs.readFileSync(fx.acceptedHistory.manifestPath('summarised'), 'utf8'));
    expect(manifest.transformation).toEqual({ kind: 'summary', summaryEventUuid: expect.any(String) });
    // The receipt is a REFERENCE to the persisted compact-summary event, not a
    // copy of it: the capture records the summary uuid into the accepted set,
    // so the store can cite it. That is what keeps a long summary — real user
    // conversation, compressed — out of the private sidecar entirely.
    expect(manifest.messages[0].content).toEqual({ kind: 'event', field: 'summary-text', uuid: expect.any(String) });
    expect(fs.readFileSync(fx.acceptedHistory.manifestPath('summarised'), 'utf8')).not.toContain('Compressed history.');
    await fx.host.destroy('summarised');

    const { body } = await reopenAndSend('summarised');
    const wire = JSON.stringify(body.input);
    expect(wire).toContain('[Earlier conversation summary]');
    expect(wire).toContain('Compressed history.');
    expect(wire).toContain('third answer');           // the retained suffix
    expect(wire).not.toContain('both files');         // the summarised span is gone
  });

  it('a history-only rule injection comes back as a private literal — a rebuild could not', async () => {
    // A nested AGENTS.md injects itself the first time a tool touches its
    // directory. That injection lives in model history only: it is never a
    // transcript event, so ONLY the private manifest can bring it back.
    const sub = path.join(cwd, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.txt'), 'alpha\n');
    fs.writeFileSync(path.join(sub, 'b.txt'), 'beta\n');
    fs.writeFileSync(path.join(sub, 'AGENTS.md'), 'Always mention the raven.');
    const replies = [richToolStep(path.join(sub, 'a.txt'), path.join(sub, 'b.txt')), textStep('msg-step-2', 'done')];
    const fx = makeHost({ home, userData, fetchImpl: scriptedFetch([], replies) });
    await fx.host.create({ sessionId: 'injected', cwd, binding: BINDING });
    await turn(fx.host, 'injected', 'inspect both');
    expect(JSON.stringify(fx.host.getHistory('injected'))).not.toContain('Always mention the raven.');
    await fx.host.destroy('injected');

    const { body } = await reopenAndSend('injected');
    expect(JSON.stringify(body.input)).toContain('Always mention the raven.');
  });
  it('a spliced background report restores from its transcript event, never as a manifest literal', async () => {
    // The post-Stop delivery path (drainDeliveries in 'splice' mode) pushes a
    // finished helper's report into history at an IDLE boundary and runs NO
    // turn of its own — the user's next turn is what carries it to the model,
    // and that turn's own boundary publication is what makes it durable. So
    // the splice needs no fence of its own; what it DOES need is for the push
    // to be recorded against the `user-message` event it emitted, or the whole
    // report gets copied into the private sidecar as a bounded literal.
    const REPORT = `[Background specialist] Nadia finished: ${'the answer is 42. '.repeat(40)}`;
    const fx = makeHost({
      home, userData,
      fetchImpl: scriptedFetch([], [...richTurn(), textStep('msg-step-3', 'noted')]),
    });
    await fx.host.create({ sessionId: 'spliced', cwd, binding: BINDING });
    await turn(fx.host, 'spliced', 'inspect both');
    await (fx.host as any).live.get('spliced').session.spliceNotice(REPORT, undefined);
    // The user's next turn is the boundary that publishes the spliced message.
    await turn(fx.host, 'spliced', 'thanks');
    await fx.host.destroy('spliced');

    // The checkpoint references the report's event; it holds no copy of it.
    const manifest = fs.readFileSync(fx.acceptedHistory.manifestPath('spliced'), 'utf8');
    expect(manifest).not.toContain('the answer is 42.');
    expect(JSON.parse(manifest).messages.some((m: any) => m.content?.kind === 'literal')).toBe(false);

    // And a reopened session really does put the report back on the wire —
    // from the RESTORED checkpoint, proven by the ciphertext riding with it.
    const bodies: any[] = [];
    const reopened = makeHost({ home, userData, fetchImpl: scriptedFetch(bodies, [textStep('msg-next', 'later')]) });
    expect(await reopened.host.resume('spliced', cwd)).toBe(true);
    await turn(reopened.host, 'spliced', 'again');
    await reopened.host.destroyAll();
    expect(JSON.stringify(bodies[0].input)).toContain('the answer is 42.');
    expect(carriesCiphertext(bodies[0])).toBe(true);
  });

  it('an oversized replacement leaves the older checkpoint ineligible, never restorable', async () => {
    // Ciphertext big enough that the manifest cannot be written at all. The
    // measured reasoning count keeps compaction out of it (7 tokens, not 4M).
    const huge = 'Z'.repeat(17 * 1024 * 1024);
    const hugeStep = [
      { type: 'response.created', response: { id: 'resp-huge', model: 'gpt-test', created_at: 1 } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs-huge', encrypted_content: huge } },
      { type: 'response.reasoning_summary_part.added', item_id: 'rs-huge', output_index: 0, summary_index: 0 },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs-huge', output_index: 0, summary_index: 0, delta: 'a summary' },
      { type: 'response.reasoning_summary_part.done', item_id: 'rs-huge', output_index: 0, summary_index: 0 },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs-huge', encrypted_content: huge } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg-huge', role: 'assistant', phase: 'final_answer', content: [] } },
      { type: 'response.output_text.delta', item_id: 'msg-huge', output_index: 1, content_index: 0, delta: 'huge answer' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg-huge', role: 'assistant', phase: 'final_answer', status: 'completed', content: [] } },
      completed({ output_tokens_details: { reasoning_tokens: 7 } }),
    ];
    const fx = makeHost({ home, userData, fetchImpl: scriptedFetch([], [textStep('small', 'first answer'), hugeStep]) });
    const outcomes = recordPublishes(fx.acceptedHistory);
    await fx.host.create({ sessionId: 'oversized', cwd, binding: BINDING });
    await turn(fx.host, 'oversized', 'one');
    await turn(fx.host, 'oversized', 'two');
    expect(outcomes).toEqual(['ok', 'oversized']);
    await fx.host.destroy('oversized');

    // The FIRST turn's perfectly good manifest is still on disk — and must not
    // be used, because the fence that preceded the failed replacement stands.
    const eligibility = JSON.parse(fs.readFileSync(path.join(userData, 'private-continuation', 'oversized.eligibility.json'), 'utf8'));
    expect(eligibility.eligible).toBe(false);

    const { body } = await reopenAndSend('oversized');
    expect(body.input.filter((i: any) => i.type === 'reasoning')).toEqual([]);
    expect(JSON.stringify(body.input)).toContain('first answer');   // nothing visible was lost
    expect(JSON.stringify(body.input)).toContain('huge answer');
  });

  it('a request-only context fit never becomes the durable accepted history', async () => {
    const bodies: any[] = [];
    const fx = makeHost({
      home, userData, fetchImpl: scriptedFetch(bodies, [textStep('long', 'L'.repeat(6_000)), textStep('short', 'brief')]),
      contextAndSlots: async () => ({ contextLength: 300, totalSlots: null }),
    });
    await fx.host.create({ sessionId: 'fitted', cwd, binding: BINDING });
    await turn(fx.host, 'fitted', 'give me a long answer');
    await turn(fx.host, 'fitted', 'now a short one');
    // The SECOND request could not carry the long answer — that is the fit.
    expect(JSON.stringify(bodies[1].input)).not.toContain('L'.repeat(6_000));

    // The checkpoint still describes the whole history, including the message
    // the request had to drop.
    const longUuid = fx.host.getHistory('fitted')!.find((e: any) => e.data?.text?.startsWith('LLL'))!.uuid;
    const manifest = JSON.parse(fs.readFileSync(fx.acceptedHistory.manifestPath('fitted'), 'utf8'));
    expect(manifest.eventUuids).toContain(longUuid);
    expect(JSON.stringify(manifest.messages)).toContain(longUuid);
    await fx.host.destroyAll();
  });
  it('an unchanged attachment restores its bytes; a changed one invalidates the whole checkpoint', async () => {
    // A real 1x1 PNG, so the app's own attachment reader accepts it.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const shot = path.join(cwd, 'shot.png');
    fs.writeFileSync(shot, png);

    const fx = makeHost({ home, userData, fetchImpl: scriptedFetch([], richTurn()), vision: true });
    await fx.host.create({ sessionId: 'pictured', cwd, binding: BINDING });
    const done = waitForTurnComplete(fx.host);
    fx.host.send('pictured', 'look at this', [shot]);
    await done;
    await vi.waitFor(() => expect(fx.host.isIdle('pictured')).toBe(true));
    await fx.host.drain('pictured');
    // The manifest points at the file; it never copies the pixels.
    const manifest = fs.readFileSync(fx.acceptedHistory.manifestPath('pictured'), 'utf8');
    expect(manifest).toContain(shot);
    expect(manifest).not.toContain(png.toString('base64'));
    await fx.host.destroy('pictured');

    const restored = await reopenAndSend('pictured', { vision: true });
    expect(carriesCiphertext(restored.body)).toBe(true);                        // faithful restore
    expect(JSON.stringify(restored.body.input)).toContain(png.toString('base64'));

    // Now the file changes underneath the checkpoint.
    fs.writeFileSync(shot, Buffer.concat([png, Buffer.from([0])]));
    const stale = await reopenAndSend('pictured', { vision: true });
    expect(carriesCiphertext(stale.body)).toBe(false);                          // refused, not approximated
    expect(JSON.stringify(stale.body.input)).toContain('look at this');         // visible content intact
  });
  it('a specialist child publishes and restores its OWN continuation across a resume', async () => {
    const explorer = resolveSpecialist('explorer')!;
    const bodies: any[] = [];
    const replies = [
      ...richTurn(),                                  // the child's first turn
      textStep('child-2', 'looked again'),            // the resumed child's turn
    ];
    const fx = makeHost({ home, userData, fetchImpl: scriptedFetch(bodies, replies) });
    await fx.host.create({ sessionId: 'parent', cwd, binding: BINDING });

    const first = fx.host.reserveSpecialist('parent', { writer: false });
    expect(first.ok).toBe(true);
    const spawned = await fx.host.spawnSpecialist('parent', {
      specialist: explorer, prompt: 'inspect both files', workDir: cwd,
      parentToolCallId: 'tc-1', token: (first as any).token, description: 'inspect both files',
    });
    await fx.host.drain(spawned.childId);
    expect(fs.existsSync(fx.acceptedHistory.manifestPath(spawned.childId))).toBe(true);

    const again = fx.host.reserveSpecialist('parent', { writer: false });
    const outcome = await fx.host.resumeSpecialist('parent', {
      childId: spawned.childId, prompt: 'anything new?', parentToolCallId: 'tc-2', reservation: (again as any).token,
    });
    expect(outcome.status).toBe('ok');
    // The resumed child's request carries its OWN earlier ciphertext.
    expect(carriesCiphertext(bodies.at(-1))).toBe(true);
    await fx.host.destroyAll();
  });
  it('a persistent prune restores its shortened tool output exactly, not the original', async () => {
    fs.writeFileSync(path.join(cwd, 'big.txt'), 'q'.repeat(6_000));
    const readBig = [
      { type: 'response.created', response: { id: 'resp-big', model: 'gpt-test', created_at: 1 } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc-big', call_id: 'call-big', name: 'Read', arguments: '' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc-big', call_id: 'call-big', name: 'Read', arguments: JSON.stringify({ file_path: path.join(cwd, 'big.txt') }), status: 'completed' } },
      completed(),
    ];
    const fx = makeHost({
      home, userData,
      // No reply is scripted for /compact's summary call: it throws, the harness
      // fails safe, and the PRUNED history is what stands — a prune with no
      // summary, which is exactly the transformation under test.
      fetchImpl: scriptedFetch([], [readBig, textStep('after', 'read it'), textStep('turn-2', 'P'.repeat(2_000))]),
      contextAndSlots: async () => ({ contextLength: 300, totalSlots: null }),
    });
    await fx.host.create({ sessionId: 'pruned', cwd, binding: BINDING });
    await turn(fx.host, 'pruned', 'read the big file');
    await turn(fx.host, 'pruned', 'and now?');
    await fx.host.compact('pruned');
    await fx.host.drain('pruned');
    const manifest = JSON.parse(fs.readFileSync(fx.acceptedHistory.manifestPath('pruned'), 'utf8'));
    expect(manifest.transformation).toEqual({ kind: 'pruned' });
    // The shortened text is DESCRIBED (keepChars), never copied.
    expect(JSON.stringify(manifest.messages)).toContain('"pruned":{"keepChars"');
    expect(JSON.stringify(manifest.messages)).not.toContain('qqqq');
    await fx.host.destroy('pruned');

    const { body } = await reopenAndSend('pruned');
    const output = body.input.find((i: any) => i.type === 'function_call_output');
    expect(output.output).toContain('chars of tool output elided to fit context');
    expect(output.output).not.toContain('q'.repeat(3_000));
  });
  it('closing between the last chunk and the turn boundary publishes nothing and still loses no visible text', async () => {
    // The crash window BEFORE the boundary flush: the model streamed, the app
    // went away, and no turn-complete ever ran the publication.
    let stop = () => {};
    const replies = richTurn();
    const fetchImpl = (async (_u: unknown, _init?: RequestInit) => {
      const next = replies.shift();
      if (next) return sse(next);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          const events = [
            { type: 'response.created', response: { id: 'resp-cut', model: 'gpt-test', created_at: 1 } },
            { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'cut', role: 'assistant', phase: 'final_answer', content: [] } },
            { type: 'response.output_text.delta', item_id: 'cut', output_index: 0, content_index: 0, delta: 'half an answer' },
          ];
          controller.enqueue(encoder.encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')));
          stop = () => { try { controller.close(); } catch { /* already gone */ } };
        },
        cancel() { stop = () => {}; },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }) as Fetch;

    const fx = makeHost({ home, userData, fetchImpl });
    const outcomes = recordPublishes(fx.acceptedHistory);
    await fx.host.create({ sessionId: 'cut-off', cwd, binding: BINDING });
    await turn(fx.host, 'cut-off', 'inspect both');
    expect(outcomes).toEqual(['ok']);

    const streaming = new Promise<void>((resolve) => {
      const on = (e: any) => { if (e.type === 'assistant-text') { fx.host.off('transcript-event', on); resolve(); } };
      fx.host.on('transcript-event', on);
    });
    fx.host.send('cut-off', 'keep going');
    await streaming;
    await fx.host.destroy('cut-off');           // the "crash"
    stop();
    expect(outcomes).toEqual(['ok']);            // destroy publishes nothing

    // dispose() flushed the half-written part, so the transcript moved past the
    // checkpoint: it is refused, and the rebuild shows everything the user saw.
    const { body } = await reopenAndSend('cut-off');
    expect(carriesCiphertext(body)).toBe(false);
    expect(JSON.stringify(body.input)).toContain('half an answer');
    expect(JSON.stringify(body.input)).toContain('both files');
  });
});
