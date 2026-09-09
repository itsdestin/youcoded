import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AcceptedHistoryStore, type AcceptedHistoryProposal } from '../src/main/harness/accepted-history-store';

const sessionId = 'private-session';
const binding = 'chatgpt\u0000gpt-5\u0000account-hash\u00007';

describe('AcceptedHistoryStore', () => {
  let root: string;
  let transcript: string;
  let store: AcceptedHistoryStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-accepted-history-'));
    transcript = path.join(root, 'native', 'session.jsonl');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, [
      JSON.stringify({ v: 1, sessionId }),
      JSON.stringify({ type: 'user-message', sessionId, uuid: 'u1', data: { text: 'hello' } }),
      JSON.stringify({ type: 'assistant-thinking', sessionId, uuid: 'r1', data: { partId: 'reasoning-0', text: 'summary' } }),
      JSON.stringify({ type: 'assistant-text', sessionId, uuid: 'a1', data: { partId: 'text-0', text: 'answer' } }),
      JSON.stringify({ type: 'turn-complete', sessionId, uuid: 'done', data: {} }),
      '',
    ].join('\n'));
    store = new AcceptedHistoryStore(path.join(root, 'electron-user-data'));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

  function proposal(overrides: Partial<AcceptedHistoryProposal> = {}): AcceptedHistoryProposal {
    return {
      sessionId,
      transcriptPath: transcript,
      binding,
      assemblyDigest: 'assembly-v1',
      revision: store.currentRevision(sessionId),
      acceptedEventUuids: ['u1', 'r1', 'a1'],
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [
          { type: 'reasoning', text: 'summary', providerOptions: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'PRIVATE_SENTINEL' } } },
          { type: 'text', text: 'answer', providerOptions: { openai: { itemId: 'msg_1', phase: 'final_answer' } } },
        ] },
      ] as any,
      ...overrides,
    };
  }

  it('publishes references to exact transcript content and restores private metadata without duplicating transcript text', async () => {
    const revision = await store.invalidate(sessionId, 'history-mutation');
    await expect(store.publish({ ...proposal(), revision })).resolves.toEqual({ ok: true });

    const sidecar = fs.readFileSync(store.manifestPathForTest(sessionId), 'utf8');
    expect(sidecar).toContain('PRIVATE_SENTINEL');
    expect(sidecar).not.toContain('"text":"hello"');
    expect(sidecar).not.toContain('"text":"answer"');
    expect((fs.statSync(path.dirname(store.manifestPathForTest(sessionId))).mode & 0o077)).toBe(0);
    expect((fs.statSync(store.manifestPathForTest(sessionId)).mode & 0o077)).toBe(0);

    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest: 'assembly-v1' }))
      .toEqual({ ok: true, messages: proposal().messages });
  });

  it('rejects flushed abandoned retries because only accepted UUID ranges may be referenced', async () => {
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'assistant-text', sessionId, uuid: 'abandoned', data: { partId: 'text-0', text: 'abandoned' } })}\n`);
    const revision = await store.invalidate(sessionId, 'history-mutation');
    const bad = proposal({ revision, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'abandoned' }] }] as any });
    await expect(store.publish(bad)).resolves.toEqual({ ok: false, reason: 'unreferenced-history' });
    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest: 'assembly-v1' })).toEqual({ ok: false, reason: 'ineligible' });
  });

  it('fences late publication, binding mismatch, transcript advance, malformed and oversized state', async () => {
    const first = await store.invalidate(sessionId, 'history-mutation');
    await store.publish({ ...proposal(), revision: first });
    await store.invalidate(sessionId, 'context-clear');
    await expect(store.publish({ ...proposal(), revision: first })).resolves.toEqual({ ok: false, reason: 'stale-generation' });
    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest: 'assembly-v1' })).toEqual({ ok: false, reason: 'ineligible' });

    const next = await store.invalidate(sessionId, 'history-mutation');
    await store.publish({ ...proposal(), revision: next });
    expect(store.restore({ sessionId, transcriptPath: transcript, binding: `${binding}-other`, assemblyDigest: 'assembly-v1' })).toEqual({ ok: false, reason: 'binding-mismatch' });
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'user-message', sessionId, uuid: 'u2', data: { text: 'later' } })}\n`);
    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest: 'assembly-v1' })).toEqual({ ok: false, reason: 'transcript-advanced' });

    fs.writeFileSync(store.manifestPathForTest(sessionId), '{bad');
    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest: 'assembly-v1' })).toEqual({ ok: false, reason: 'malformed' });
    fs.writeFileSync(store.manifestPathForTest(sessionId), Buffer.alloc(16 * 1024 * 1024 + 1));
    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest: 'assembly-v1' })).toEqual({ ok: false, reason: 'oversized' });
  });

  it('invalidates an older checkpoint before oversized/failed replacement and survives failed unlink', async () => {
    const first = await store.invalidate(sessionId, 'history-mutation');
    await store.publish({ ...proposal(), revision: first });
    const second = await store.invalidate(sessionId, 'history-mutation');
    const huge = 'x'.repeat(16 * 1024 * 1024);
    await expect(store.publish(proposal({ revision: second, messages: [{ role: 'user', content: huge }] as any })))
      .resolves.toEqual({ ok: false, reason: 'oversized' });
    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest: 'assembly-v1' })).toEqual({ ok: false, reason: 'ineligible' });

    let writes = 0;
    const failing = new AcceptedHistoryStore(path.join(root, 'electron-user-data'), { beforeRename: () => { if (++writes > 1) throw new Error('disk'); } });
    const third = await failing.invalidate(sessionId, 'history-mutation');
    await expect(failing.publish({ ...proposal(), revision: third })).resolves.toEqual({ ok: false, reason: 'write-failed' });
    expect(failing.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest: 'assembly-v1' })).toEqual({ ok: false, reason: 'ineligible' });

    const unlinkFailing = new AcceptedHistoryStore(path.join(root, 'electron-user-data'), { unlink: () => { throw new Error('busy'); } });
    await expect(unlinkFailing.remove(sessionId)).resolves.toEqual({ ok: false, reason: 'unlink-failed' });
    expect(unlinkFailing.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest: 'assembly-v1' })).toEqual({ ok: false, reason: 'ineligible' });
  });

  it('validates image bytes and removes orphan sidecars when the real transcript disappears', async () => {
    const image = path.join(root, 'image.png');
    fs.writeFileSync(image, Buffer.from('pixels-v1'));
    fs.writeFileSync(transcript, [
      JSON.stringify({ v: 1, sessionId }),
      JSON.stringify({ type: 'user-message', sessionId, uuid: 'u-img', data: { text: 'look', attachments: [image] } }),
      '',
    ].join('\n'));
    const revision = await store.invalidate(sessionId, 'history-mutation');
    const withImage = proposal({
      revision,
      acceptedEventUuids: ['u-img'],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'file', mediaType: 'image/png', data: fs.readFileSync(image) }] }] as any,
    });
    await expect(store.publish(withImage)).resolves.toEqual({ ok: true });
    fs.writeFileSync(image, Buffer.from('pixels-v2'));
    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest: 'assembly-v1' })).toEqual({ ok: false, reason: 'image-mismatch' });

    fs.rmSync(transcript);
    await store.cleanupOrphans();
    expect(fs.existsSync(store.manifestPathForTest(sessionId))).toBe(false);
  });
});
