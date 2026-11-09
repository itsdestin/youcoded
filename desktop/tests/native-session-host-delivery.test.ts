import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { resolveSpecialist } from '../src/main/harness/specialists/registry';
import { stream, textChunks, finishChunk, toolCallChunk } from './helpers/scripted-model';
import { isAppGenerated } from '../src/main/harness/compaction';
import { createContinuationCollector } from '../test-engine/lab-continuation.mjs';

// WHY: isolate investigation interleavings from the already-modified host suite.
// These are controlled scheduler/fault probes, NOT evidence of a live incident's cause.
// Historical characterization is preserved in the workspace baseline report/logs.
// Always-on assertions below pin the approved delivery guarantees.
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
const reply = (text: string) => ({ stream: simulateReadableStream({ chunks: stream(...textChunks('t', text), finishChunk('stop')) }) });

describe('native host delivery boundaries (offline investigation)', () => {
  let root: string;
  let host: NativeSessionHost;
  const releases: Array<() => void> = [];
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await host?.destroyAll();
    if (vi.isMockFunction(fetch)) expect(fetch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  async function boot(activityDiagnostic?: NativeSessionHost['activityDiagnostic']) {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in offline delivery probe'); }));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-delivery-boundary-'));
    const childEntered = gate(), childRelease = gate(), queued = gate();
    releases.push(childRelease.resolve);
    const parentRequests: any[] = [], events: any[] = [], order: string[] = [];
    const receipts: Array<{ kind: string; at: number }> = [], rootInputs: Array<{ at: number; kind: string }> = [];
    const queueWaiters: Array<() => void> = [];
    let completed = false, queuedAt: number | null = null;
    const collector = createContinuationCollector({ sessionId: 'parent', now: () => performance.now(), verifyWrite: (input: any) => {
      const file = path.join(root, 'continued.txt');
      return input?.file_path === file && fs.existsSync(file) && fs.readFileSync(file, 'utf8') === 'FOLLOWUP-OK\n'
        ? 'fixture:continued.txt=FOLLOWUP-OK' : null;
    } });
    let parentHandler = async (_req: any) => reply('scripted parent response (not verified useful progress)');
    const parentModel = new MockLanguageModelV4({ doStream: async (req: any) => {
      parentRequests.push(req);
      order.push('parent-request');
      collector.request({ id: `req-${parentRequests.length}`, sessionId: 'parent', role: 'main' });
      return parentHandler(req);
    } });
    let childHandler = async () => {
      childEntered.resolve();
      await childRelease.promise;
      return reply('SYNTHETIC-REPORT-TOKEN');
    };
    const childModel = new MockLanguageModelV4({ doStream: async () => childHandler() });
    const home = new NativeHome(root), store = new SessionStore(home);
    host = new NativeSessionHost(store, async (_binding, opts) => opts?.cacheKey === 'parent' ? parentModel : childModel,
      async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, undefined, home);
    host.activityDiagnostic = activityDiagnostic;
    const h = host as any;
    host.on('specialists-event', e => {
      collector.specialist(e);
      if (e.kind === 'run' && e.run.status === 'completed' && !completed) {
        completed = true; order.push('completion'); receipts.push({ kind: 'completion', at: performance.now() });
      }
    });
    host.on('transcript-event', e => {
      events.push(e); collector.transcript(e);
      if (e.type === 'user-message') {
        const kind = e.data.injected ? `injected:${e.data.injected}` : `input:${e.data.text}`;
        order.push(kind); receipts.push({ kind, at: performance.now() });
      }
    });
    const originalQueue = h.queueDelivery.bind(host);
    vi.spyOn(h, 'queueDelivery').mockImplementation((id: any) => {
      order.push('queue'); queuedAt = performance.now(); receipts.push({ kind: 'queue', at: queuedAt });
      originalQueue(id); queued.resolve(); for (const resolve of queueWaiters.splice(0)) resolve();
    });
    const originalDeliver = h.deliverNotice.bind(host);
    vi.spyOn(h, 'deliverNotice').mockImplementation((entry: any, mode: any, text: any, meta: any) => {
      collector.deliveryAttempt(meta, mode); return originalDeliver(entry, mode, text, meta);
    });
    await host.create({ sessionId: 'parent', cwd: root, binding: { providerId: 'openrouter', modelId: 'offline-mock' } });
    const entry = h.live.get('parent');
    return { h, home, store, entry, events, order, collector, parentRequests, childEntered, childRelease, queued,
      handleParent(fn: typeof parentHandler) { parentHandler = fn; },
      handleChild(fn: typeof childHandler) { childHandler = fn; },
      nextQueue() { return new Promise<void>(resolve => { queueWaiters.push(resolve); }); },
      send(text: string) {
        const at = performance.now(), result = host.send('parent', text);
        // WHY: receipt at acceptance, not transcript dispatch after busy/FIFO delay.
        if (result.status !== 'failed') rootInputs.push({ at, kind: rootInputs.length === 0 && !completed ? 'initial' : 'scripted' });
        return result;
      },
      async spawn() {
        const child = await host.spawnSpecialistBackground('parent', { specialist: resolveSpecialist('explorer')!,
          prompt: 'Return the synthetic report token only', workDir: root, parentToolCallId: 'task-synthetic',
          description: 'offline report', token: { parentId: 'parent', writer: false } });
        await childEntered.promise;
        return child.childId;
      },
      injections() { return events.filter(e => e.data?.injected === 'specialist-report'); },
      record(childId: string) { return h.ledger.listFor(root, 'parent').find((r: any) => r.childId === childId); },
      async evidence(label: string, usefulWork = false) {
        const snapshot = collector.finish();
        // WHY: text-only mock output is not useful-work evidence; do not score it as success/failure.
        snapshot.episode.coverage.progress = usefulWork;
        snapshot.episode.fixture.reference = usefulWork ? 'fixture:continued.txt=FOLLOWUP-OK' : 'synthetic transport-only report; no useful-work fixture';
        snapshot.episode.inputs = rootInputs.map(i => ({ ...i }));
        Object.assign(snapshot.episode.evidence, { reportQueuedAt: queuedAt });
        if (entry.quiescing) snapshot.episode.evidence.deliveryContext = 'cancelled';
        const scorerPath = fileURLToPath(new URL('../../../scripts/harness-lab/continuation-metrics.mjs', import.meta.url));
        // WHY: standalone app CI has no workspace scripts; characterize transport there,
        // and explicitly mark scoring unavailable rather than making up a verdict.
        let score: any = { noNudgeContinuation: 'unknown', reason: 'Workspace scorer unavailable in standalone app checkout' };
        if (fs.existsSync(scorerPath)) {
          const { analyzeContinuationEpisodes } = await import(/* @vite-ignore */ scorerPath);
          score = analyzeContinuationEpisodes([snapshot.episode]).episodes[0];
        }
        if (snapshot.episode.evidence.reportDeliveredAt !== null) {
          expect(parentRequests.length).toBeGreaterThan(0);
          expect(JSON.stringify(parentRequests.at(-1).prompt)).toContain('SYNTHETIC-REPORT-TOKEN');
        }
        if (!usefulWork) expect(score.noNudgeContinuation).toBe('unknown');
        else expect(snapshot.episode.evidence.verifiedFollowupAt).not.toBeNull();
        console.log('DELIVERY-EVIDENCE', JSON.stringify({ label, order, receipts, requests: parentRequests.length,
          injections: events.filter(e => e.data?.injected).map(e => e.data.injected),
          pendingSpecialist: h.pendingDeliveryParents.has('parent'), pendingShell: h.pendingHostNotices.has('parent'),
          episode: snapshot.episode, score, limitations: [snapshot.coverageGaps[0], 'Completion is callback-observed; queue timestamp is the actual queueDelivery seam, not wall-clock ledger endedAt.', usefulWork ? 'Filesystem-verified followup; deadline verdict is measured, not asserted as a timing test.' : 'No useful-work verifier; scorer must remain unknown.'] }));
      },
    };
  }

  it('observes real approval and serial execution separately from grouped submissions without payloads', async () => {
    const diagnostics: any[] = [], order: string[] = [];
    const b = await boot(r => { diagnostics.push(r); order.push(r.kind); }); let requests = 0;
    host.on('transcript-event', e => { if (e.type === 'tool-use') order.push('submitted'); });
    host.on('hook-event', e => { if (e.type === 'PermissionRequest') host.respondPermission(e.payload._requestId, {decision:{behavior:'allow'}}); });
    b.entry.session.opts.decide = async () => ({action:'ask'});
    b.handleParent(async () => requests++ === 0 ? {stream: simulateReadableStream({chunks:stream(
      toolCallChunk('one','Write',{file_path:path.join(root,'one.txt'),content:'private-canary'}),
      toolCallChunk('two','Write',{file_path:path.join(root,'two.txt'),content:'private-canary'}), finishChunk('tool-calls'))})} : reply('done'));
    b.send('write files'); await b.entry.running;
    expect(fs.existsSync(path.join(root,'two.txt'))).toBe(true);
    expect(order.slice(0,2)).toEqual(['submitted','submitted']);
    expect(diagnostics.filter(r=>r.kind==='execution-start').map(r=>r.toolCallId)).toEqual(['one','two']);
    expect(diagnostics.filter(r=>r.kind==='ask-start')).toHaveLength(2);
    expect(order.indexOf('ask-end')).toBeLessThan(order.indexOf('execution-start'));
    expect(diagnostics.every(r=>r.scope==='parent')).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain('private-canary');
  });

  it('diagnostic observer failure cannot change real tool results or permission control', async () => {
    const b=await boot(()=>{throw new Error('observer is not control');}); let requests=0;
    b.entry.session.opts.decide=async()=>({action:'allow'});
    b.handleParent(async()=>requests++===0?{stream:simulateReadableStream({chunks:stream(toolCallChunk('write','Write',{file_path:path.join(root,'safe.txt'),content:'ok'}),finishChunk('tool-calls'))})}:reply('done'));
    b.send('write');await b.entry.running;expect(fs.readFileSync(path.join(root,'safe.txt'),'utf8')).toBe('ok');
    expect(b.events.filter(e=>e.type==='session-error')).toHaveLength(0);
  });

  it('wakes an idle parent once without a human message', async () => {
    const b = await boot(), child = await b.spawn();
    b.childRelease.resolve(); await b.queued.promise; await b.entry.running;
    expect(b.injections()).toHaveLength(1);
    expect(b.parentRequests).toHaveLength(1);
    expect(b.record(child).delivered).toBe(true);
    expect(b.order.indexOf('completion')).toBeLessThan(b.order.indexOf('queue'));
    expect(b.order.indexOf('queue')).toBeLessThan(b.order.indexOf('injected:specialist-report'));
    await b.evidence('idle-control');
  });

  it('supplies a completed report before the next busy human FIFO dispatch', async () => {
    const b = await boot(), entered = gate(), release = gate(); releases.push(release.resolve);
    b.handleParent(async () => { entered.resolve(); await release.promise; return reply('busy parent done'); });
    b.send('first'); await entered.promise;
    b.send('second'); b.send('third');
    const child = await b.spawn(); b.childRelease.resolve(); await b.queued.promise;
    expect(b.record(child).status).toBe('completed'); expect(b.injections()).toHaveLength(0);
    release.resolve(); await b.entry.running;
    expect(b.injections()).toHaveLength(1);
    expect(b.order.indexOf('injected:specialist-report')).toBeLessThan(b.order.indexOf('input:second'));
    expect(JSON.stringify(b.parentRequests[1].prompt)).toContain('SYNTHETIC-REPORT-TOKEN');
    expect(b.order.indexOf('queue')).toBeLessThan(b.order.indexOf('input:second'));
    await b.evidence('busy-fifo-safe-boundary-before-human-dispatch');
  });

  it('injects helper and shell results after the complete tool batch before useful followup', async () => {
    const b = await boot(), entered = gate(), release = gate(); releases.push(release.resolve);
    let calls = 0;
    b.handleParent(async req => {
      if (calls++ === 0) {
        entered.resolve(); await release.promise;
        return { stream: simulateReadableStream({ chunks: stream(
          toolCallChunk('glob-one', 'Glob', { pattern: '*.ts' }),
          toolCallChunk('glob-two', 'Glob', { pattern: '*.md' }), finishChunk('tool-calls')) }) };
      }
      if (calls === 2) {
        expect(JSON.stringify(req.prompt)).toContain('SYNTHETIC-REPORT-TOKEN');
        expect(JSON.stringify(req.prompt)).toContain('SYNTHETIC-SHELL-COMPLETE');
        return { stream: simulateReadableStream({ chunks: stream(toolCallChunk('followup', 'Write', {
          file_path: path.join(root, 'continued.txt'), content: 'FOLLOWUP-OK\n',
        }), finishChunk('tool-calls')) }) };
      }
      return reply('done');
    });
    // Test-only explicit allow: synthetic report content must not itself grant permission.
    b.entry.session.opts.decide = async () => ({ action: 'allow' });
    b.send('Use the report and write continued.txt'); await entered.promise;
    await b.spawn(); b.childRelease.resolve(); await b.queued.promise;
    b.h.queueHostNotice('parent', 'SYNTHETIC-SHELL-COMPLETE', { kind: 'shell', runs: [] });
    expect(b.injections()).toHaveLength(0);
    release.resolve(); await b.entry.running;
    expect(fs.readFileSync(path.join(root, 'continued.txt'), 'utf8')).toBe('FOLLOWUP-OK\n');
    const injection = b.events.findIndex(e => e.data?.injected === 'specialist-report');
    expect(injection).toBeGreaterThanOrEqual(0);
    for (const id of ['glob-one', 'glob-two']) {
      const result = b.events.findIndex(e => e.type === 'tool-result' && e.data.toolUseId === id);
      expect(result).toBeGreaterThanOrEqual(0); expect(result).toBeLessThan(injection);
      expect(b.parentRequests[1].prompt.some((m: any) => m.role === 'tool' && m.content.some((p: any) => p.toolCallId === id))).toBe(true);
    }
    expect(b.parentRequests).toHaveLength(3);
    expect(b.injections()).toHaveLength(1);
    const notices = b.entry.session.acceptedHistory().messages.filter((m: any) => m.role === 'user' && typeof m.content === 'string' && /SYNTHETIC-(REPORT|SHELL)/.test(m.content));
    expect(notices).toHaveLength(2);
    expect(notices.every(isAppGenerated)).toBe(true);
    expect(b.events.filter(e => e.type === 'session-error')).toHaveLength(0);
    await b.evidence('tool-batch-filesystem-verified-followup', true);
  });

  it('supplies ready results before retrying the first orderly empty response', async () => {
    const b = await boot(), entered = gate(), release = gate(); releases.push(release.resolve);
    let calls = 0;
    b.handleParent(async () => {
      if (calls++ === 0) { entered.resolve(); await release.promise; return { stream: simulateReadableStream({ chunks: stream(finishChunk('stop')) }) }; }
      return reply('followup');
    });
    b.send('opening'); await entered.promise;
    await b.spawn(); b.childRelease.resolve(); await b.queued.promise;
    release.resolve(); await b.entry.running;
    expect(JSON.stringify(b.parentRequests[1].prompt)).toContain('SYNTHETIC-REPORT-TOKEN');
    expect(b.parentRequests).toHaveLength(2);
    expect(b.injections()).toHaveLength(1);
  });

  it('holds completion after Stop and splices it before the next user turn', async () => {
    const b = await boot(); await b.spawn();
    host.interrupt('parent');
    b.childRelease.resolve(); await b.queued.promise;
    expect(b.entry.inFlight).toBe(false); expect(b.injections()).toHaveLength(0);
    b.send('explicit-resume'); await b.entry.running;
    expect(b.injections()).toHaveLength(1); expect(b.parentRequests).toHaveLength(1);
    expect(b.order.indexOf('injected:specialist-report')).toBeLessThan(b.order.indexOf('input:explicit-resume'));
    const snapshot = b.collector.finish();
    expect(snapshot.episode.evidence.deliveryContext).toBe('held');
    await b.evidence('stop-held-splice-control');
  });

  it('Stop during boundary draining parks remaining reports then splices them before an already queued human request', async () => {
    const b = await boot(), entered = gate(), release = gate(); releases.push(release.resolve);
    b.handleParent(async () => { entered.resolve(); await release.promise; return reply('response done'); });
    b.send('opening'); await entered.promise;
    await b.spawn(); b.childRelease.resolve(); await b.queued.promise;
    b.h.queueHostNotice('parent', 'SYNTHETIC-SHELL-COMPLETE', { kind: 'shell', runs: [] });
    b.send('queued-human');
    // Host readiness is a setImmediate fence; cross that exact fence, not a delay.
    await new Promise<void>(resolve => setImmediate(resolve));
    host.on('transcript-event', e => {
      if (e.type === 'user-message' && e.data.injected === 'shell-complete') host.interrupt('parent');
    });
    release.resolve(); await b.entry.running;
    expect(b.injections()).toHaveLength(1); expect(b.parentRequests).toHaveLength(2);
    expect(b.order.indexOf('injected:specialist-report')).toBeLessThan(b.order.indexOf('input:queued-human'));
    expect(JSON.stringify(b.parentRequests[1].prompt)).toContain('SYNTHETIC-REPORT-TOKEN');
    expect(b.collector.finish().episode.evidence.deliveryContext).toBe('held');
  });

  it('Stop during marker persistence holds uninjected reports for the next human dispatch', async () => {
    const b = await boot(), marked = gate(), release = gate(); releases.push(release.resolve);
    const original = b.h.ledger.markInjectionAttempted.bind(b.h.ledger);
    const marker = vi.spyOn(b.h.ledger, 'markInjectionAttempted').mockImplementation(async (...args: any[]) => {
      await original(...args); marked.resolve(); await release.promise;
    });
    const child = await b.spawn(); b.childRelease.resolve(); await b.queued.promise; await marked.promise;
    host.interrupt('parent'); release.resolve(); await b.entry.running;
    expect(b.injections()).toHaveLength(0); expect(b.parentRequests).toHaveLength(0);
    expect(b.record(child).injectionAttempted).toBe(false);
    marker.mockRestore(); b.send('explicit-resume'); await b.entry.running;
    expect(b.injections()).toHaveLength(1); expect(b.parentRequests).toHaveLength(1);
    expect(b.collector.finish().episode.evidence.deliveryContext).toBe('held');
  });

  it('quiesce during pre-dispatch marker work prevents the captured human request after flush', async () => {
    const b = await boot(); await b.spawn();
    host.interrupt('parent'); b.childRelease.resolve(); await b.queued.promise;
    const marked = gate(), release = gate(); releases.push(release.resolve);
    const original = b.h.ledger.markInjectionAttempted.bind(b.h.ledger);
    vi.spyOn(b.h.ledger, 'markInjectionAttempted').mockImplementation(async (...args: any[]) => {
      await original(...args); marked.resolve(); await release.promise;
    });
    b.send('captured-human'); await marked.promise;
    const quiescing = host.quiesce('parent'); release.resolve(); await quiescing;
    expect(b.parentRequests).toHaveLength(0); expect(b.injections()).toHaveLength(0);
    expect(b.order).not.toContain('input:captured-human');
  });

  it.each([['stop', false], ['quiesce', false], ['stop', true], ['quiesce', true]] as const)('holds fallback when %s races an awaited claim (throws=%s)', async (action, throws) => {
    const b = await boot(), claimed = gate(), release = gate(); releases.push(release.resolve);
    const rec = { childId: 'fallback', parentToolCallId: 'run-a', agentType: 'explorer', title: 'Synthetic',
      workDir: root, description: 'offline', background: true, status: 'completed', startedAt: 0,
      endedAt: 1, rawReport: 'SYNTHETIC-REPORT-TOKEN', delivered: false, missedSteers: [] };
    b.h.inMemoryFallback.set(rec.childId, { parentId: 'parent', rec });
    vi.spyOn(b.h.ledger, 'claimUndelivered').mockImplementationOnce(async () => {
      claimed.resolve(); await release.promise;
      if (throws) throw new Error('Synthetic claim failure');
      return null;
    });
    b.h.queueDelivery('parent'); await claimed.promise;
    const quiescing = action === 'quiesce' ? host.quiesce('parent') : undefined;
    if (action === 'stop') host.interrupt('parent');
    release.resolve(); await b.entry.running; await quiescing;
    expect(b.injections()).toHaveLength(0); expect(b.parentRequests).toHaveLength(0);
    expect(b.h.inMemoryFallback.get(rec.childId)?.rec.parentToolCallId).toBe('run-a');
    if (action === 'quiesce') host.endQuiesce('parent');
    b.send('explicit-resume'); await b.entry.running;
    expect(b.injections()).toHaveLength(1); expect(b.parentRequests).toHaveLength(1);
  });

  it('delivers both runs exactly once when the report turn resumes the same child in background', async () => {
    const b = await boot(), secondStarted = gate(), secondRelease = gate(); releases.push(secondRelease.resolve);
    const child = await b.spawn(); let requests = 0;
    b.handleChild(async () => { await secondRelease.promise; return reply('SYNTHETIC-REPORT-TOKEN-B'); });
    // The actual notice model turn performs the resume, rather than mutating a ledger snapshot.
    b.handleParent(async () => {
      if (requests++ === 0) {
        const result = await host.resumeSpecialist('parent', { childId: child, prompt: 'Second synthetic run',
          parentToolCallId: 'run-b', background: true, reservation: { parentId: 'parent', writer: false } });
        expect(result.status).toBe('ok-background'); secondStarted.resolve();
      }
      return reply('parent response');
    });
    b.childRelease.resolve(); await b.queued.promise; await secondStarted.promise;
    await b.entry.running; // A's confirmation lands while B still owns the running row.
    expect(b.record(child).parentToolCallId).toBe('run-b'); expect(b.record(child).delivered).toBe(false);
    const queuedB = b.nextQueue(); secondRelease.resolve(); await queuedB; await b.entry.running;
    expect(b.injections().map(e => e.data.injectedMeta.parentToolCallId)).toEqual(['task-synthetic', 'run-b']);
    expect(b.record(child).delivered).toBe(true);
    b.send('later'); await b.entry.running; expect(b.injections()).toHaveLength(2);
  });

  it('bounds persistent claim failures without spinning or discarding the durable report', async () => {
    const b = await boot(), child = await b.spawn();
    const claim = vi.spyOn(b.h.ledger, 'claimUndelivered').mockRejectedValue(new Error('synthetic storage outage'));
    b.childRelease.resolve(); await b.queued.promise; await b.entry.running;
    expect(claim).toHaveBeenCalledTimes(1);
    expect(host.isIdle('parent')).toBe(true); expect(b.record(child).delivered).toBe(false);
    claim.mockRestore();
    // A new externally driven queue boundary retries, never a self-sustaining loop.
    b.send('retry-boundary'); await b.entry.running;
    expect(b.injections()).toHaveLength(1);
  });

  it('does not wake a quiesced parent for a queued durable report', async () => {
    const b = await boot();
    await host.quiesce('parent');
    // Seeded durable completion: quiesce intentionally destroys actual running children.
    await b.h.ledger.recordStart(root, 'parent', { childId: 'seed', parentToolCallId: 'task-synthetic', agentType: 'explorer',
      title: 'Synthetic', workDir: root, description: 'offline', background: true, status: 'completed',
      startedAt: 0, endedAt: 1, rawReport: 'SYNTHETIC-REPORT-TOKEN', delivered: false, missedSteers: [] });
    b.h.queueDelivery('parent');
    expect(b.entry.quiescing).toBe(true); expect(b.entry.inFlight).toBe(false);
    expect(b.injections()).toHaveLength(0); expect(b.parentRequests).toHaveLength(0);
    expect(b.send('refused').status).toBe('failed');
    await b.evidence('quiesce-seeded-control');
  });

  it('delivers a report queued after the final drain without another user boundary', async () => {
    const b = await boot(), atBoundary = gate(), releaseBoundary = gate(); releases.push(releaseBoundary.resolve);
    const originalDrain = b.h.drainDeliveries.bind(host);
    let once = true;
    // Controlled widening of the final drain-return boundary; no production change.
    vi.spyOn(b.h, 'drainDeliveries').mockImplementation(async (...args: any[]) => {
      await originalDrain(...args);
      if (once) { once = false; atBoundary.resolve(); await releaseBoundary.promise; }
    });
    b.send('first'); await atBoundary.promise;
    const child = await b.spawn(); b.childRelease.resolve(); await b.queued.promise;
    expect(b.entry.inFlight).toBe(true);
    releaseBoundary.resolve(); await b.entry.running;
    expect(host.isIdle('parent')).toBe(true);
    expect(b.record(child).delivered).toBe(true);
    expect(b.h.pendingDeliveryParents.has('parent')).toBe(false);
    expect(b.injections()).toHaveLength(1);
    await b.evidence('controlled-final-drain-delivered-without-extra-root-input');
    b.send('later-boundary'); await b.entry.running;
    expect(b.injections()).toHaveLength(1); expect(b.record(child).delivered).toBe(true);
    await b.evidence('controlled-final-drain-no-duplicate-after-extra-root-input');
  });

  it('retains the newer pending hint when completion queues during an awaited empty claim', async () => {
    const b = await boot(), emptyClaim = gate(), releaseClaim = gate(); releases.push(releaseClaim.resolve);
    const claim = b.h.ledger.claimUndelivered.bind(b.h.ledger);
    let once = true;
    vi.spyOn(b.h.ledger, 'claimUndelivered').mockImplementation(async (...args: any[]) => {
      const rec = await claim(...args);
      if (once && !rec) { once = false; emptyClaim.resolve(); await releaseClaim.promise; }
      return rec;
    });
    b.h.queueDelivery('parent'); await emptyClaim.promise;
    const nextQueue = b.nextQueue();
    const child = await b.spawn(); b.childRelease.resolve(); await nextQueue;
    releaseClaim.resolve(); await b.entry.running;
    expect(host.isIdle('parent')).toBe(true); expect(b.record(child).delivered).toBe(true);
    expect(b.h.pendingDeliveryParents.has('parent')).toBe(false);
    expect(b.injections()).toHaveLength(1);
    // A later human turn must not duplicate the recovered report.
    b.send('later-boundary'); await b.entry.running;
    expect(b.injections()).toHaveLength(1);
    await b.evidence('controlled-empty-claim-new-arrival-retained');
  });

  it('replays an unmarked completed report when a new host resumes the parent', async () => {
    const b = await boot(), child = await b.spawn();
    host.interrupt('parent'); b.childRelease.resolve(); await b.queued.promise;
    expect(b.record(child).injectionAttempted).not.toBe(true);
    await host.destroyAll();
    const prompts: any[] = [], injected: any[] = [];
    host = new NativeSessionHost(b.store, async () => new MockLanguageModelV4({ doStream: async (req: any) => {
      prompts.push(req.prompt); return reply('restart response');
    } }), async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null,
    undefined, undefined, undefined, undefined, undefined, undefined, b.home);
    host.on('transcript-event', e => { if (e.type === 'user-message' && e.data.injected === 'specialist-report') injected.push(e); });
    expect(await host.resume('parent', root)).toBe(true);
    await (host as any).live.get('parent').running;
    expect(injected).toHaveLength(1); expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).toContain('SYNTHETIC-REPORT-TOKEN');
    expect((host as any).ledger.listFor(root, 'parent').find((r: any) => r.childId === child).delivered).toBe(true);
  });

  it('does not duplicate an injected report when both marker and confirmation writes fail', async () => {
    const b = await boot(); await b.spawn();
    vi.spyOn(b.h.ledger, 'markInjectionAttempted').mockRejectedValue(new Error('marker failed'));
    vi.spyOn(b.h.ledger, 'confirmDelivered').mockRejectedValueOnce(new Error('confirmation failed'));
    b.childRelease.resolve(); await b.queued.promise; await b.entry.running;
    expect(b.injections()).toHaveLength(1);
    b.send('next'); await b.entry.running;
    expect(b.injections()).toHaveLength(1);
  });

  it.each([false, true])('reconciles a marker against durable correlated injection receipt (receipt=%s)', async injectedBeforeRestart => {
    const b = await boot(), child = await b.spawn();
    if (injectedBeforeRestart) {
      vi.spyOn(b.h.ledger, 'confirmDelivered').mockRejectedValue(new Error('ambiguous confirmation failure'));
      b.childRelease.resolve(); await b.queued.promise; await b.entry.running;
      expect(b.injections()).toHaveLength(1);
    } else {
      host.interrupt('parent'); b.childRelease.resolve(); await b.queued.promise;
      await b.h.ledger.markInjectionAttempted(root, 'parent', child);
    }
    expect(b.record(child).injectionAttempted).toBe(true);
    expect(b.record(child).delivered).toBe(false);
    await host.destroyAll();
    let requests = 0, injected = 0;
    host = new NativeSessionHost(b.store, async () => new MockLanguageModelV4({ doStream: async () => { requests++; return reply('resumed'); } }),
      async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, undefined, b.home);
    host.on('transcript-event', e => { if (e.type === 'user-message' && e.data.injected === 'specialist-report') injected++; });
    await host.resume('parent', root); await (host as any).live.get('parent').running;
    expect(injected).toBe(injectedBeforeRestart ? 0 : 1);
    expect(requests).toBe(injectedBeforeRestart ? 0 : 1);
    expect((host as any).ledger.listFor(root, 'parent').find((r: any) => r.childId === child).delivered).toBe(true);
  });

  it('retries a provably pre-injection formatting failure without losing or duplicating the report', async () => {
    const b = await boot(), child = await b.spawn();
    const format = vi.spyOn(b.h, 'formatDelivery').mockImplementationOnce(() => { throw new Error('LAB injected formatting failure'); });
    b.childRelease.resolve(); await b.queued.promise; await b.entry.running;
    expect(b.record(child).injectionAttempted).not.toBe(true); expect(b.record(child).delivered).toBe(false);
    expect(b.injections()).toHaveLength(0); expect(b.parentRequests).toHaveLength(0);
    format.mockRestore();
    b.send('later-boundary'); await b.entry.running;
    expect(b.injections()).toHaveLength(1);
    await b.evidence('controlled-formatting-failure-recovered-before-next-dispatch');
    await host.destroyAll();
    // New real host/ledger reading the same isolated disk, not an actual process crash.
    host = new NativeSessionHost(b.store, async () => new MockLanguageModelV4({ doStream: async () => reply('restart') }),
      async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, undefined, b.home);
    const h2 = host as any;
    await host.resume('parent', root);
    await h2.live.get('parent').running;
    expect(await h2.ledger.claimUndelivered(root, 'parent')).toBeNull();
    expect(h2.ledger.listFor(root, 'parent').find((r: any) => r.childId === child).injectionAttempted).toBe(true);
    expect(h2.ledger.listFor(root, 'parent').find((r: any) => r.childId === child).delivered).toBe(true);
    await host.drain('parent');
    expect(b.store.readEvents('parent', root).filter(e => e.type === 'user-message' && e.data.injected === 'specialist-report')).toHaveLength(1);
  });

  it('supplies late shell context before a human correction absorbed inside a specialist notice turn', async () => {
    const b = await boot(), entered = gate(), release = gate(); releases.push(release.resolve);
    let calls = 0;
    b.handleParent(async () => { if (calls++ === 0) { entered.resolve(); await release.promise; } return reply('response'); });
    await b.spawn(); b.childRelease.resolve(); await b.queued.promise; await entered.promise;
    b.h.queueHostNotice('parent', 'SYNTHETIC-SHELL-COMPLETE', { kind: 'shell', runs: [] });
    b.send('human-correction');
    await new Promise<void>(resolve => setImmediate(resolve));
    release.resolve(); await b.entry.running;
    expect(b.order.indexOf('injected:shell-complete')).toBeLessThan(b.order.indexOf('input:human-correction'));
    expect(JSON.stringify(b.parentRequests[1].prompt)).toContain('SYNTHETIC-SHELL-COMPLETE');
    expect(b.injections()).toHaveLength(1);
    expect(b.events.filter(e => e.data?.injected === 'shell-complete')).toHaveLength(1);
  });

  it('delivers a shell notice queued while the specialist model turn is draining', async () => {
    const b = await boot(), entered = gate(), release = gate(); releases.push(release.resolve);
    b.handleParent(async () => { entered.resolve(); await release.promise; return reply('specialist response'); });
    await b.spawn(); b.childRelease.resolve(); await b.queued.promise; await entered.promise;
    // Synthetic completion notice at the real queue seam; no shell process is launched.
    b.h.queueHostNotice('parent', 'SYNTHETIC-SHELL-COMPLETE', { kind: 'shell', runs: [] });
    release.resolve(); await b.entry.running;
    expect(host.isIdle('parent')).toBe(true); expect(b.h.pendingHostNotices.has('parent')).toBe(false);
    const shell = () => b.events.filter(e => e.data?.injected === 'shell-complete');
    expect(shell()).toHaveLength(1);
    await b.evidence('synthetic-shell-notice-during-real-specialist-drain');
    b.send('later-boundary'); await b.entry.running;
    expect(shell()).toHaveLength(1);
    expect(JSON.stringify(b.parentRequests.at(-1).prompt)).toContain('SYNTHETIC-SHELL-COMPLETE');
    expect(b.order.indexOf('injected:shell-complete')).toBeLessThan(b.order.indexOf('input:later-boundary'));
  });
});
