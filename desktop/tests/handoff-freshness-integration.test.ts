import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { GitTransport } from '../src/main/sync-spaces/git-transport';
import type { SyncSpace } from '../src/main/sync-spaces/types';
import { createConversationStore } from '../src/main/conversations/conversation-store';
import type { ConversationRecord } from '../src/main/conversations/store-core';
import type { TransferContext } from '../src/main/conversations/handoff-receipt';
import { publishHandoffTranscript, importHandoffTranscript } from '../src/main/conversations/handoff-transcript';
import { materializeOut } from '../src/main/conversations/transcript-mirror';
import { createHandoffAttempts } from '../src/main/conversations/handoff-attempt';
import { createResumeAdmission } from '../src/main/conversations/resume-admission';
import { pinHandoffDestination, startConversationStore, stopConversationStore, resumeSweeps } from '../src/main/conversations/service';
// WHY: service project resolution must never consult the real user's saved folders.
vi.mock('../src/main/saved-folders', async (original) => ({ ...await original<typeof import('../src/main/saved-folders')>(), readFolders: () => [] }));
import { ccProjectSlug } from '../src/main/slug-encoding';
import { MAX_SYNC_FILE_BYTES, conflictCopyName } from '../src/main/sync-spaces/guards';

// Real subprocess Git tests have a generous failure ceiling; progress is driven by promises, never sleeps.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const roots: string[] = [];
afterEach(() => { stopConversationStore(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; };

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-fresh-transfer-')); roots.push(root);
  const bare = path.join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  // WHY: two transport objects retain independent installation state, rather than
  // sharing one in-memory Git client across the two disposable roots.
  const senderTransport = new GitTransport({ deviceName: 'Sender' });
  const receiverTransport = new GitTransport({ deviceName: 'Receiver' });
  const sessionId = randomUUID();
  const context: TransferContext = { sessionId, provider: 'claude', transferNonce: randomUUID(), senderDeviceId: 'sender-install', requesterDeviceId: 'receiver-install' };
  async function device(name: string) {
    const home = path.join(root, name, 'home');
    const personalRoot = path.join(home, 'YouCoded', 'Personal');
    const conversationsRoot = path.join(personalRoot, 'Conversations');
    const runtimeRoot = path.join(home, '.claude', 'projects');
    const project = path.join(home, 'Projects', 'project');
    const transcript = path.join(runtimeRoot, ccProjectSlug(project), `${sessionId}.jsonl`);
    const mirror = path.join(conversationsRoot, 'claude', 'transcripts', 'project', `${sessionId}.jsonl`);
    const receipt = path.join(personalRoot, 'Handoffs', 'claude', `${sessionId}.json`);
    fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.mkdirSync(personalRoot, { recursive: true });
    const space: SyncSpace = { id: 'personal', kind: 'personal', root: personalRoot };
    const transport = name === 'sender' ? senderTransport : receiverTransport;
    await transport.init(space); await transport.setRemote(space, bare);
    const store = createConversationStore(conversationsRoot);
    const record: ConversationRecord = { schema: 1, id: sessionId, provider: 'claude', projectName: 'project',
      originalPath: project, title: 'Transfer', lastActive: '2026-09-23T00:00:00.000Z', device: name,
      flags: {}, transcriptRef: `claude/transcripts/project/${sessionId}.jsonl`,
      createdAt: '2026-09-23T00:00:00.000Z', note: '', noteUpdatedAt: '2026-09-23T00:00:00.000Z' };
    await store.upsert(record);
    const base = () => ({ context, record: JSON.parse(fs.readFileSync(path.join(conversationsRoot, 'claude', `${sessionId}.json`), 'utf8')) as ConversationRecord,
      personalRoot, conversationsRoot, runtimeRoot, resolveRecord: () => store.get('claude', sessionId) });
    return { home, personalRoot, conversationsRoot, runtimeRoot, project, transcript, mirror, receipt, space, store, record, base };
  }
  const sender = await device('sender'); const receiver = await device('receiver');
  // WHY: the remote record carries the sender's path; this device resolves its own project,
  // not a peer-supplied absolute destination. Keep independent on-disk stores throughout.
  const writer = { provider: 'claude' as const, sessionId, transcriptPath: sender.transcript, projectCwd: sender.project };
  let stopped = false;
  const publish = () => publishHandoffTranscript({ ...sender.base(), writer, stopped: () => stopped, currentWriter: () => true });
  const imported = (mayCommit = () => true) => importHandoffTranscript({ ...receiver.base(), destination: receiver.transcript, projectPath: receiver.project, mayCommit });
  const push = () => senderTransport.push(sender.space, 'final snapshot');
  const pull = () => receiverTransport.pull(receiver.space);
  return { root, bare, senderTransport, receiverTransport, sender, receiver, context, publish, imported, push, pull, stop: () => { stopped = true; } };
}

describe('two-root handoff transfer', () => {
  it('waits for final writer bytes, publishes through bare Git, and starts only with exact runtime-local bytes', async () => {
    const f = await fixture(); const first = 'user: first\n'; const final = 'assistant: last message\n';
    fs.writeFileSync(f.sender.transcript, first);
    expect((await f.publish()).status).toBe('incomplete');
    expect(fs.existsSync(f.sender.receipt)).toBe(false);
    fs.appendFileSync(f.sender.transcript, final); // simulate the final append before stop evidence
    f.stop();
    expect((await f.publish()).status).toBe('published');
    expect((await f.push()).pushed).toBe(true);
    const pulled = await f.pull(); expect(pulled).toBeDefined();
    expect(fs.readFileSync(f.receiver.mirror, 'utf8')).toBe(first + final);
    expect(fs.existsSync(f.receiver.receipt)).toBe(true);
    // Git may bring the sender's originalPath in the synced record; the receiver
    // must still use its own resolved project and runtime destination.
    const admitted: string[] = []; let live: { id: string } | undefined;
    const admission = createResumeAdmission({ acquire: async () => ({ ok: true }), release: async () => {}, getLive: () => live });
    let queried = 0;
    const attempts = createHandoffAttempts({ deviceId: f.context.requesterDeviceId, admission,
      query: async () => ++queried === 1 ? { held: true, deviceId: f.context.senderDeviceId, source: 'hub' as const } : { held: false, source: 'hub' as const },
      takeover: async () => null, sync: f.pull, confirm: (context, _pin, mayCommit) => importedWithContext(context, mayCommit),
      pin: () => pinHandoffDestination(f.context.sessionId), project: async () => f.receiver.project,
      start: async (_owner, _context, cwd, check) => {
        check(); expect(cwd).toBe(f.receiver.project);
        const bytes = fs.readFileSync(f.receiver.transcript, 'utf8'); admitted.push(bytes);
        live = { id: f.context.sessionId }; return live;
      }, dispose: async () => { live = undefined; }, delay: async () => {}, pollCount: 1 });
    // A receipt from a DIFFERENT nonce cannot admit this new attempt. Replace it with
    // the attempt's actual nonce only after the first incomplete round.
    async function importedWithContext(context: TransferContext, mayCommit: () => boolean) {
      return importHandoffTranscript({ ...f.receiver.base(), context, destination: f.receiver.transcript,
        projectPath: f.receiver.project, mayCommit });
    }
    const a = attempts.begin('window:1', f.context.sessionId, 'claude', { model: 'fixture' });
    expect(await attempts.wait('window:1', a.id)).toMatchObject({ status: 'incomplete' });
    expect(admitted).toEqual([]);
    const actual = attempts.context('window:1', a.id);
    expect((await publishHandoffTranscript({ ...f.sender.base(), context: actual,
      writer: { provider: 'claude', sessionId: f.context.sessionId, transcriptPath: f.sender.transcript, projectCwd: f.sender.project },
      stopped: () => true, currentWriter: () => true })).status).toBe('published');
    expect((await f.push()).pushed).toBe(true);
    expect(await attempts.retry('window:1', a.id)).toMatchObject({ status: 'admitted', source: 'confirmed' });
    expect(admitted).toEqual([first + final]);
    expect(fs.readFileSync(f.receiver.transcript, 'utf8')).toBe(first + final);
    const competing = vi.fn(async () => ({ id: 'competing' }));
    expect(await admission.open(f.context.sessionId, competing)).toEqual(live);
    expect(competing).not.toHaveBeenCalled();
    attempts.ended(f.context.sessionId);
  });

  it('preserves runtime files on stale nonce, same-size change, divergence, longer history and conflicting receipt', async () => {
    const f = await fixture(); fs.writeFileSync(f.sender.transcript, 'first\nlast\n'); f.stop();
    expect((await f.publish()).status).toBe('published'); await f.push(); await f.pull();
    const receipt = fs.readFileSync(f.receiver.receipt);
    const cases = [
      { name: 'stale nonce', bytes: 'first\n', alter: () => fs.writeFileSync(f.receiver.receipt, JSON.stringify({ ...JSON.parse(receipt.toString()), transferNonce: randomUUID() })) },
      { name: 'same-size mirror mutation', bytes: 'first\n', alter: () => fs.writeFileSync(f.receiver.mirror, 'first\nLAST\n') },
      { name: 'shorter divergent local', bytes: 'wrong\n', alter: () => {} },
      { name: 'longer local history', bytes: 'first\nlast\nextra\n', alter: () => {} },
      { name: 'conflicting receipt', bytes: 'first\n', alter: () => fs.writeFileSync(path.join(path.dirname(f.receiver.receipt), path.basename(conflictCopyName(f.receiver.receipt, 'peer', new Date('2026-09-23')))), '{}') },
    ];
    for (const c of cases) {
      fs.writeFileSync(f.receiver.mirror, 'first\nlast\n');
      fs.rmSync(path.dirname(f.receiver.receipt), { recursive: true, force: true });
      fs.mkdirSync(path.dirname(f.receiver.receipt), { recursive: true }); fs.writeFileSync(f.receiver.receipt, receipt);
      fs.writeFileSync(f.receiver.transcript, c.bytes); c.alter();
      expect((await f.imported()).status, c.name).toBe('incomplete');
      expect(fs.readFileSync(f.receiver.transcript, 'utf8'), c.name).toBe(c.bytes);
    }
  });

  it('refuses a missing project and an over-cap source without publishing evidence', async () => {
    const f = await fixture(); fs.writeFileSync(f.sender.transcript, 'first\nlast\n'); f.stop();
    await f.publish(); await f.push(); await f.pull();
    fs.rmSync(f.receiver.project, { recursive: true });
    expect((await f.imported()).status).toBe('incomplete'); expect(fs.existsSync(f.receiver.transcript)).toBe(false);
    fs.writeFileSync(f.sender.transcript, 'x'); fs.truncateSync(f.sender.transcript, MAX_SYNC_FILE_BYTES + 1);
    fs.rmSync(f.sender.receipt);
    expect((await f.publish()).status).toBe('incomplete'); expect(fs.existsSync(f.sender.receipt)).toBe(false);
  });

  it('does not equate failed Git delivery with receipt confirmation; retries after sender stops', async () => {
    const f = await fixture(); fs.writeFileSync(f.sender.transcript, 'first\nlast\n'); f.stop();
    expect((await f.publish()).status).toBe('published');
    // No credentials/network: a missing bare remote makes the real Git invocation fail.
    await f.senderTransport.setRemote(f.sender.space, path.join(f.root, 'missing.git'));
    expect(await f.push()).toMatchObject({ pushed: false, contacted: false });
    expect(fs.existsSync(f.receiver.receipt)).toBe(false);
    expect((await f.imported()).status).toBe('incomplete');
    expect(fs.existsSync(f.receiver.transcript)).toBe(false);
    await f.senderTransport.setRemote(f.sender.space, f.bare);
    expect((await f.push()).pushed).toBe(true);
    await f.pull();
    expect((await f.imported()).status).toBe('confirmed');
    expect(fs.readFileSync(f.receiver.transcript, 'utf8')).toBe('first\nlast\n');
  });

  it('refuses a receipt conflict copy created by the actual Git merge', async () => {
    const f = await fixture(); fs.writeFileSync(f.sender.transcript, 'first\nlast\n'); f.stop();
    expect((await f.publish()).status).toBe('published');
    expect((await f.push()).pushed).toBe(true); await f.pull();
    const baseline = JSON.parse(fs.readFileSync(f.receiver.receipt, 'utf8'));
    // Both peers modify the same tracked receipt after their shared ancestor.
    // Git must produce the conflict copy; the test does not manufacture its name.
    fs.writeFileSync(f.receiver.receipt, JSON.stringify({ ...baseline, transferNonce: randomUUID() }));
    fs.writeFileSync(f.sender.receipt, JSON.stringify({ ...baseline, transferNonce: randomUUID() }));
    expect((await f.push()).pushed).toBe(true);
    const merged = await f.pull();
    expect(merged.conflictCopies.some((file) => file.includes('Handoffs'))).toBe(true);
    expect(fs.readdirSync(path.dirname(f.receiver.receipt)).some((name) => name.includes(' (from '))).toBe(true);
    fs.writeFileSync(f.receiver.transcript, 'first\n');
    expect((await f.imported()).status).toBe('incomplete');
    expect(fs.readFileSync(f.receiver.transcript, 'utf8')).toBe('first\n');
  });

  it('the actual conversation service sweep skips a pinned destination while materializing an unpinned peer', async () => {
    const f = await fixture();
    // The second conversation is a positive signal that the detached sweep ran,
    // not a timer-based assertion that nothing happened yet.
    const other = randomUUID(); const project = path.join(f.receiver.home, 'Projects', 'other');
    fs.mkdirSync(project, { recursive: true });
    const record = { ...f.receiver.record, id: other, projectName: 'other', originalPath: project,
      transcriptRef: `claude/transcripts/other/${other}.jsonl` };
    await f.receiver.store.upsert(record);
    const otherMirror = path.join(f.receiver.conversationsRoot, record.transcriptRef);
    const otherLocal = path.join(f.receiver.runtimeRoot, ccProjectSlug(project), `${other}.jsonl`);
    fs.mkdirSync(path.dirname(otherMirror), { recursive: true });
    fs.writeFileSync(otherMirror, 'other: synced\n');
    fs.mkdirSync(path.dirname(f.receiver.mirror), { recursive: true });
    fs.writeFileSync(f.receiver.mirror, 'first\nlast\n');
    fs.writeFileSync(f.receiver.transcript, 'first\n');
    await startConversationStore({ conversationsRoot: f.receiver.conversationsRoot,
      projectsDir: f.receiver.runtimeRoot, topicsDir: path.join(f.receiver.home, '.claude', 'topics'),
      nativeHomeRoot: f.receiver.home, pauseSweeps: true });
    const pin = pinHandoffDestination(f.context.sessionId);
    expect(pin).not.toBeNull();
    try {
      resumeSweeps();
      await vi.waitFor(() => expect(fs.readFileSync(otherLocal, 'utf8')).toBe('other: synced\n'));
      expect(fs.readFileSync(f.receiver.transcript, 'utf8')).toBe('first\n');
    } finally { pin?.release(); stopConversationStore(); }
  });

  it('a service sweep already staging an ordinary import rechecks the late pin before rename', async () => {
    const f = await fixture();
    fs.mkdirSync(path.dirname(f.receiver.mirror), { recursive: true });
    fs.writeFileSync(f.receiver.mirror, 'first\nlast\n');
    fs.writeFileSync(f.receiver.transcript, 'first\n');
    await startConversationStore({ conversationsRoot: f.receiver.conversationsRoot,
      projectsDir: f.receiver.runtimeRoot, topicsDir: path.join(f.receiver.home, '.claude', 'topics'),
      nativeHomeRoot: f.receiver.home, pauseSweeps: true });
    const entered = deferred<void>(); const proceed = deferred<void>();
    const copy = fs.promises.copyFile.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (src, dest, ...rest) => {
      if (String(src) === f.receiver.mirror && String(dest).startsWith(`${f.receiver.transcript}.`)) {
        entered.resolve(); await proceed.promise;
      }
      return copy(src, dest, ...rest);
    });
    let pin: ReturnType<typeof pinHandoffDestination> = null;
    try {
      resumeSweeps();
      await entered.promise; // actual materializeOut staging, not a guessed delay
      pin = pinHandoffDestination(f.context.sessionId);
      expect(pin).not.toBeNull();
      proceed.resolve();
      // Drain the destination chain after the stalled copy; this waits for the
      // production sweep's own shouldCommit check before asserting its outcome.
      await materializeOut({ spaceTranscriptPath: path.join(f.root, 'missing'), localJsonlPath: f.receiver.transcript });
      expect(fs.readFileSync(f.receiver.transcript, 'utf8')).toBe('first\n');
    } finally { proceed.resolve(); pin?.release(); spy.mockRestore(); stopConversationStore(); }
  });

  it('blocks a late ordinary materialization during pending import and cancels stalled transfer without startup', async () => {
    const f = await fixture(); fs.writeFileSync(f.sender.transcript, 'first\nlast\n'); f.stop(); await f.publish(); await f.push(); await f.pull();
    fs.writeFileSync(f.receiver.transcript, 'first\n');
    const late = deferred<void>(); const entered = deferred<void>();
    const pin = pinHandoffDestination(f.context.sessionId);
    expect(pin).not.toBeNull();
    const ordinary = materializeOut({ spaceTranscriptPath: f.receiver.mirror, localJsonlPath: f.receiver.transcript,
      shouldCommit: () => !pin!.active() });
    // The same destination chain and pin reject ordinary commits rather than relying on timing.
    expect((await ordinary).copied).toBe(false);
    const admission = createResumeAdmission<{ id: string }>({ acquire: async () => ({ ok: true }), release: async () => {}, getLive: () => undefined });
    const start = vi.fn(async () => ({ id: f.context.sessionId }));
    const attempts = createHandoffAttempts({ deviceId: 'receiver-install', admission,
      query: async () => ({ held: true, deviceId: 'sender-install', source: 'hub' as const }),
      takeover: async () => null, sync: async () => { entered.resolve(); await late.promise; return f.pull(); },
      confirm: async () => f.imported(), pin: () => pin,
      project: async () => f.receiver.project, start, dispose: async () => {}, delay: async () => {}, pollCount: 1 });
    const a = attempts.begin('window:2', f.context.sessionId, 'claude', { model: 'fixture' });
    await entered.promise;
    expect((await materializeOut({ spaceTranscriptPath: f.receiver.mirror, localJsonlPath: f.receiver.transcript,
      shouldCommit: () => !pin!.active() })).copied).toBe(false);
    expect(fs.readFileSync(f.receiver.transcript, 'utf8')).toBe('first\n');
    attempts.cancel('window:2', a.id); late.resolve();
    expect((await attempts.wait('window:2', a.id)).status).toBe('cancelled');
    expect(start).not.toHaveBeenCalled(); expect(fs.readFileSync(f.receiver.transcript, 'utf8')).toBe('first\n');
    await vi.waitFor(() => expect(pin!.active()).toBe(false));
  });
});
