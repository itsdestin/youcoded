import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { publishHandoffTranscript, importHandoffTranscript } from '../src/main/conversations/handoff-transcript';
import type { TransferContext } from '../src/main/conversations/handoff-receipt';
import type { ConversationRecord } from '../src/main/conversations/store-core';
import { MAX_SYNC_FILE_BYTES, conflictCopyName } from '../src/main/sync-spaces/guards';
import { ccProjectSlug } from '../src/main/slug-encoding';
import { materializeOut } from '../src/main/conversations/transcript-mirror';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-transcript-')); roots.push(root);
  const personalRoot = path.join(root, 'Personal');
  const conversationsRoot = path.join(personalRoot, 'Conversations');
  const runtimeRoot = path.join(root, 'runtime');
  const senderRuntimeRoot = path.join(root, 'sender-runtime');
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const context: TransferContext = { transferNonce: randomUUID(), sessionId: randomUUID(), provider: 'claude', senderDeviceId: 'sender', requesterDeviceId: 'requester' };
  const record = { id: context.sessionId, provider: context.provider, projectName: 'project', originalPath: project,
    transcriptRef: `claude/transcripts/project/${context.sessionId}.jsonl` } as ConversationRecord;
  const mirror = path.join(conversationsRoot, record.transcriptRef);
  const source = path.join(senderRuntimeRoot, ccProjectSlug(project), `${context.sessionId}.jsonl`);
  const destination = path.join(runtimeRoot, ccProjectSlug(project), `${context.sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  fs.writeFileSync(source, 'first\nlast\n'); fs.writeFileSync(mirror, 'first\nlast\n');
  const resolveRecord = async () => record;
  const guard = () => true;
  const sender = () => ({ context, record, conversationsRoot, personalRoot, runtimeRoot: senderRuntimeRoot, writer: { provider: 'claude' as const, sessionId: context.sessionId, transcriptPath: source, projectCwd: project }, stopped: guard, currentWriter: guard, resolveRecord });
  const receiver = () => ({ context, record, conversationsRoot, personalRoot, runtimeRoot, destination, projectPath: project, mayCommit: guard, resolveRecord });
  return { root, project, personalRoot, conversationsRoot, context, record, mirror, source, destination, sender, receiver };
}

describe('handoff transcript evidence', () => {
  it('publishes only stopped matching bytes and confirms the actual runtime file', async () => {
    const f = fixture();
    expect((await publishHandoffTranscript(f.sender())).status).toBe('published');
    expect((await importHandoffTranscript(f.receiver())).status).toBe('confirmed');
    expect(fs.readFileSync(f.destination, 'utf8')).toBe('first\nlast\n');
    expect(fs.existsSync(path.join(f.personalRoot, 'Handoffs', 'claude', `${f.context.sessionId}.json`))).toBe(true);
  });
  it('refuses same-id source from a different project and a stale record cwd before mirroring', async () => {
    const f = fixture();
    const other = path.join(f.root, 'other', 'project'); fs.mkdirSync(other, { recursive: true });
    const otherSource = path.join(f.sender().runtimeRoot, ccProjectSlug(other), `${f.context.sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(otherSource), { recursive: true }); fs.writeFileSync(otherSource, 'wrong project\n');
    fs.writeFileSync(f.mirror, 'first\n');
    const wrongSource = { ...f.sender(), writer: { ...f.sender().writer, projectCwd: other, transcriptPath: otherSource } };
    expect((await publishHandoffTranscript(wrongSource)).status).toBe('incomplete');
    const staleRecord = { ...f.record, originalPath: other };
    expect((await publishHandoffTranscript({ ...f.sender(), record: staleRecord,
      resolveRecord: async () => staleRecord })).status).toBe('incomplete');
    const unboundPath = { ...f.sender(), writer: { ...f.sender().writer, transcriptPath: otherSource } };
    expect((await publishHandoffTranscript(unboundPath)).status).toBe('incomplete');
    expect(fs.readFileSync(f.mirror, 'utf8')).toBe('first\n');
    expect(fs.existsSync(path.join(f.personalRoot, 'Handoffs', 'claude', `${f.context.sessionId}.json`))).toBe(false);
  });
  it('accepts post-realpath CC source and a record using a symlink alias to the same project', async () => {
    const f = fixture();
    const aliasDir = path.join(f.root, 'alias'); fs.mkdirSync(aliasDir);
    const alias = path.join(aliasDir, 'project'); fs.symlinkSync(f.project, alias, 'dir');
    const record = { ...f.record, originalPath: alias };
    expect((await publishHandoffTranscript({ ...f.sender(), writer: { ...f.sender().writer, projectCwd: f.project },
      record, resolveRecord: async () => record })).status).toBe('published');
  });
  it('copies only absent or byte-prefix mirrors from the captured watcher path', async () => {
    const f = fixture();
    fs.writeFileSync(f.mirror, 'first\n');
    expect((await publishHandoffTranscript(f.sender())).status).toBe('published');
    expect(fs.readFileSync(f.mirror, 'utf8')).toBe('first\nlast\n');
    fs.writeFileSync(f.mirror, 'other');
    expect((await publishHandoffTranscript(f.sender())).status).toBe('incomplete');
    expect(fs.readFileSync(f.mirror, 'utf8')).toBe('other');
    fs.writeFileSync(f.mirror, 'first\nlast\nplus');
    expect((await publishHandoffTranscript(f.sender())).status).toBe('incomplete');
    expect(fs.readFileSync(f.mirror, 'utf8')).toBe('first\nlast\nplus');
  });
  it('does not publish when the final mirror stage fails or is still in progress', async () => {
    const f = fixture(); fs.writeFileSync(f.mirror, 'first\n');
    const original = fs.promises.open.bind(fs.promises);
    let begin!: () => void, finish!: () => void;
    const begun = new Promise<void>((resolve) => { begin = resolve; });
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(`${f.mirror}.`) && args[1] === 'wx') {
        begin(); await pending; throw new Error('mirror disk unavailable');
      }
      return original(...args);
    });
    try {
      const task = publishHandoffTranscript(f.sender());
      await begun;
      expect(fs.readFileSync(f.mirror, 'utf8')).toBe('first\n');
      expect(fs.existsSync(path.join(f.personalRoot, 'Handoffs', 'claude', `${f.context.sessionId}.json`))).toBe(false);
      finish(); expect((await task).status).toBe('incomplete');
      expect(fs.readFileSync(f.mirror, 'utf8')).toBe('first\n');
    } finally { finish(); spy.mockRestore(); }
  });

  it('rejects absent, wrong nonce, sender, requester and malformed or competing receipts', async () => {
    const f = fixture();
    expect((await importHandoffTranscript(f.receiver())).status).toBe('incomplete');
    await publishHandoffTranscript(f.sender());
    for (const field of ['transferNonce', 'senderDeviceId', 'requesterDeviceId'] as const) {
      const context = { ...f.context, [field]: field === 'transferNonce' ? randomUUID() : 'other' };
      expect((await importHandoffTranscript({ ...f.receiver(), context })).status).toBe('incomplete');
    }
    const receipt = path.join(f.personalRoot, 'Handoffs', 'claude', `${f.context.sessionId}.json`);
    fs.writeFileSync(path.join(path.dirname(receipt), path.basename(conflictCopyName(receipt, 'peer 2', new Date('2026-09-23')))), '{}');
    expect((await importHandoffTranscript(f.receiver())).status).toBe('incomplete');
    expect(fs.existsSync(f.destination)).toBe(false);
  });
  it('treats case variants as ambiguous, but not arbitrary id-prefix files', async () => {
    const f = fixture(); await publishHandoffTranscript(f.sender());
    const dir = path.join(f.personalRoot, 'Handoffs', 'claude');
    const similar = path.join(dir, `${f.context.sessionId} (unrelated).json`);
    fs.writeFileSync(similar, '{}');
    expect((await importHandoffTranscript(f.receiver())).status).toBe('confirmed');
    const variant = path.join(dir, `${f.context.sessionId.toUpperCase()}.json`);
    fs.writeFileSync(variant, '{}');
    expect((await importHandoffTranscript(f.receiver())).status).toBe('incomplete');
  });
  it('preserves equal-size and shorter divergent targets, and longer targets', async () => {
    const f = fixture(); await publishHandoffTranscript(f.sender());
    for (const content of ['other\nlast\n', 'xxxxx', 'first\nlast\nMORE']) {
      fs.writeFileSync(f.destination, content);
      expect((await importHandoffTranscript(f.receiver())).status).toBe('incomplete');
      expect(fs.readFileSync(f.destination, 'utf8')).toBe(content);
    }
    fs.writeFileSync(f.destination, 'first\n');
    expect((await importHandoffTranscript(f.receiver())).status).toBe('confirmed');
  });
  it('refuses changed mirrors, missing project, held fork, lane mismatch and absent stop', async () => {
    const f = fixture();
    fs.writeFileSync(f.mirror, 'other\nlast\n');
    expect((await publishHandoffTranscript(f.sender())).status).toBe('incomplete');
    fs.writeFileSync(f.mirror, 'first\nlast\n');
    for (const sender of [ { ...f.sender(), stopped: () => false }, { ...f.sender(), currentWriter: () => false },
      { ...f.sender(), record: { ...f.record, transcriptRef: `native/transcripts/project/${f.context.sessionId}.jsonl` } } ]) {
      expect((await publishHandoffTranscript(sender)).status).toBe('incomplete');
    }
    await publishHandoffTranscript(f.sender());
    expect((await importHandoffTranscript({ ...f.receiver(), mayCommit: () => false })).status).toBe('incomplete');
    expect((await importHandoffTranscript({ ...f.receiver(), projectPath: null })).status).toBe('incomplete');
    expect(fs.existsSync(f.destination)).toBe(false);
  });
  it('refuses a same-size divergence introduced during the final awaited prefix comparison', async () => {
    const f = fixture(); await publishHandoffTranscript(f.sender());
    fs.writeFileSync(f.destination, 'first\n');
    const original = fs.promises.open.bind(fs.promises);
    let mutated = false; let tmpOpens = 0;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (String(args[0]).endsWith('.tmp') && ++tmpOpens === 2) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close();
          if (!mutated) { mutated = true; fs.writeFileSync(f.destination, 'other\n'); }
        });
      }
      return handle;
    });
    try {
      expect((await importHandoffTranscript(f.receiver())).status).toBe('incomplete');
      expect(mutated).toBe(true);
      expect(fs.readFileSync(f.destination, 'utf8')).toBe('other\n');
    } finally { spy.mockRestore(); }
  });
  it('preserves a valid predecessor when staged bytes change after fingerprint', async () => {
    const f = fixture(); await publishHandoffTranscript(f.sender());
    const predecessor = 'first\n';
    fs.writeFileSync(f.destination, predecessor);
    const original = fs.promises.open.bind(fs.promises);
    let tmpOpens = 0; let mutatedTmp: string | undefined;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (String(args[0]).endsWith('.tmp') && ++tmpOpens === 3) {
        // The third tmp open is the awaited final prefix comparison. Mutate
        // only after it read the valid prefix, as its handle closes.
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close();
          mutatedTmp = String(args[0]);
          fs.writeFileSync(mutatedTmp, 'other\nlast\n'); // same size
        });
      }
      return handle;
    });
    try {
      const result = await importHandoffTranscript(f.receiver());
      expect(tmpOpens).toBeGreaterThanOrEqual(3);
      expect(mutatedTmp).toBeDefined();
      expect(result.status).toBe('incomplete');
      expect(fs.readFileSync(f.destination, 'utf8')).toBe(predecessor);
      expect(fs.existsSync(mutatedTmp!)).toBe(false);
    } finally { spy.mockRestore(); }
  });
  it('refuses an already-matching target if cancellation arrives during final fingerprint', async () => {
    const f = fixture(); await publishHandoffTranscript(f.sender());
    fs.writeFileSync(f.destination, 'first\nlast\n');
    const original = fs.promises.open.bind(fs.promises);
    let opens = 0; let allowed = true;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (args[0] === f.destination && ++opens === 2) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); allowed = false; });
      }
      return handle;
    });
    try {
      expect((await importHandoffTranscript({ ...f.receiver(), mayCommit: () => allowed })).status).toBe('incomplete');
      expect(opens).toBe(2);
      expect(fs.readFileSync(f.destination, 'utf8')).toBe('first\nlast\n');
    } finally { spy.mockRestore(); }
  });
  it('refuses publication if the stop becomes unproven during final receipt checks', async () => {
    const f = fixture(); let stopped = true;
    const original = fs.promises.readdir.bind(fs.promises);
    let checks = 0;
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (String(args[0]).includes('Handoffs') && ++checks === 2) stopped = false;
      return result;
    });
    try {
      expect((await publishHandoffTranscript({ ...f.sender(), stopped: () => stopped })).status).toBe('incomplete');
      expect(checks).toBe(2);
      expect(fs.existsSync(path.join(f.personalRoot, 'Handoffs', 'claude', `${f.context.sessionId}.json`))).toBe(false);
    } finally { spy.mockRestore(); }
  });
  it('does not commit a canceled copy and serializes ordinary materialization behind the same destination', async () => {
    const f = fixture(); await publishHandoffTranscript(f.sender());
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
    const original = fs.promises.open.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.tmp') && args[1] === 'wx') { entered(); await blocked; }
      return original(...args);
    });
    let allowed = true;
    try {
      const importing = importHandoffTranscript({ ...f.receiver(), mayCommit: () => allowed });
      await started;
      const ordinary = materializeOut({ spaceTranscriptPath: f.mirror, localJsonlPath: f.destination, shouldCommit: () => allowed });
      allowed = false; release();
      expect((await importing).status).toBe('incomplete');
      expect((await ordinary).copied).toBe(false);
      expect(fs.existsSync(f.destination)).toBe(false);
    } finally { release(); spy.mockRestore(); }
  });
  it('bounds staged reads when a verified mirror grows and preserves the destination', async () => {
    const f = fixture(); await publishHandoffTranscript(f.sender());
    fs.writeFileSync(f.destination, 'first\n');
    const original = fs.promises.open.bind(fs.promises);
    let opened = 0; let grew = false;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (args[0] === f.mirror && opened++ === 1) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation((async (...args: unknown[]) => {
          if (!grew) { grew = true; fs.truncateSync(f.mirror, MAX_SYNC_FILE_BYTES + 1); }
          return read(...(args as [Buffer, number, number, number]));
        }) as typeof handle.read);
      }
      return handle;
    });
    try {
      expect((await importHandoffTranscript(f.receiver())).status).toBe('incomplete');
      expect(grew).toBe(true);
      expect(fs.readFileSync(f.destination, 'utf8')).toBe('first\n');
    } finally { spy.mockRestore(); }
  });
  it('refuses a mirror replaced after verification even when replacement bytes match', async () => {
    const f = fixture(); await publishHandoffTranscript(f.sender());
    const original = fs.promises.open.bind(fs.promises);
    let opened = 0; let replaced = false;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (args[0] === f.mirror && opened++ === 1) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation((async (...args: unknown[]) => {
          if (!replaced) {
            replaced = true;
            fs.renameSync(f.mirror, `${f.mirror}.old`);
            fs.writeFileSync(f.mirror, 'first\nlast\n');
          }
          return read(...(args as [Buffer, number, number, number]));
        }) as typeof handle.read);
      }
      return handle;
    });
    try {
      expect((await importHandoffTranscript(f.receiver())).status).toBe('incomplete');
      expect(replaced).toBe(true);
      expect(fs.existsSync(f.destination)).toBe(false);
    } finally { spy.mockRestore(); }
  });
  it('rejects a failed staged copy without modifying the runtime target', async () => {
    const f = fixture(); await publishHandoffTranscript(f.sender());
    const original = fs.promises.open.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.tmp') && args[1] === 'wx') throw new Error('staging disk failure');
      return original(...args);
    });
    try {
      expect((await importHandoffTranscript(f.receiver())).status).toBe('incomplete');
      expect(fs.existsSync(f.destination)).toBe(false);
    } finally { spy.mockRestore(); }
  });
  it('rejects swapped writer identity and symlinked receipt directory', async () => {
    const f = fixture();
    expect((await publishHandoffTranscript({ ...f.sender(), writer: { ...f.sender().writer, sessionId: 'rotated' } })).status).toBe('incomplete');
    fs.unlinkSync(f.mirror);
    expect((await publishHandoffTranscript(f.sender())).status).toBe('published');
    expect(fs.readFileSync(f.mirror, 'utf8')).toBe('first\nlast\n');
    fs.rmSync(path.join(f.personalRoot, 'Handoffs', 'claude'), { recursive: true, force: true });
    fs.symlinkSync(path.join(f.personalRoot, 'Conversations', 'claude'), path.join(f.personalRoot, 'Handoffs', 'claude'));
    expect((await publishHandoffTranscript(f.sender())).status).toBe('incomplete');
  });
  it('refuses symlinked paths and oversized inputs before publishing or importing', async () => {
    const f = fixture();
    fs.truncateSync(f.source, MAX_SYNC_FILE_BYTES + 1);
    expect((await publishHandoffTranscript(f.sender())).status).toBe('incomplete');
    fs.writeFileSync(f.source, 'first\nlast\n');
    expect((await publishHandoffTranscript(f.sender())).status).toBe('published');
    fs.truncateSync(f.mirror, MAX_SYNC_FILE_BYTES + 1);
    expect((await importHandoffTranscript(f.receiver())).status).toBe('incomplete');
    expect(fs.existsSync(f.destination)).toBe(false);
    fs.writeFileSync(f.mirror, 'first\nlast\n');
    fs.unlinkSync(f.mirror); fs.symlinkSync(f.source, f.mirror);
    expect((await publishHandoffTranscript(f.sender())).status).toBe('incomplete');
  });
});
