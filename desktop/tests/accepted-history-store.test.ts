import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AcceptedHistoryStore, type AcceptedHistoryProposal } from '../src/main/harness/accepted-history-store';
import { imageCollapsedToolResultText, prunedToolResultText } from '../src/main/harness/compaction';
import type { PersistedEventReference } from '../src/main/harness/session-store';

const sessionId = 'private-session';
const binding = 'chatgpt\u0000gpt-5\u0000account-hash\u00007';
const assemblyDigest = 'assembly-v1';

type Fixture = { type: string; sessionId: string; uuid: string; data: Record<string, any> };

const COALESCED = new Set(['assistant-text', 'assistant-thinking']);

/** Mirrors SessionStore.append's reference bookkeeping exactly: a coalesced
 *  delta anchors a [start,end) slice of the persisted part text, every other
 *  event anchors its whole persisted data blob. */
function refFor(event: Fixture): PersistedEventReference {
  return COALESCED.has(event.type) && event.data?.partId
    ? { eventUuid: event.uuid, anchorUuid: event.uuid, type: event.type as any, partId: String(event.data.partId), start: 0, end: String(event.data.text ?? '').length }
    : { eventUuid: event.uuid, anchorUuid: event.uuid, type: event.type as any, start: 0, end: JSON.stringify(event.data ?? {}).length };
}

describe('AcceptedHistoryStore', () => {
  let root: string;
  let transcript: string;
  let store: AcceptedHistoryStore;

  const base: Fixture[] = [
    { type: 'user-message', sessionId, uuid: 'u1', data: { text: 'hello' } },
    { type: 'assistant-thinking', sessionId, uuid: 'r1', data: { partId: 'reasoning-0', text: 'summary' } },
    { type: 'assistant-text', sessionId, uuid: 'a1', data: { partId: 'text-0', text: 'answer' } },
    { type: 'turn-complete', sessionId, uuid: 'done', data: {} },
  ];

  function writeTranscript(events: Fixture[]): void {
    fs.writeFileSync(transcript, [JSON.stringify({ v: 1, sessionId }), ...events.map(e => JSON.stringify(e)), ''].join('\n'));
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-accepted-history-'));
    transcript = path.join(root, 'native', 'session.jsonl');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    writeTranscript(base);
    store = new AcceptedHistoryStore(path.join(root, 'electron-user-data'));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

  function proposal(overrides: Partial<AcceptedHistoryProposal> = {}): AcceptedHistoryProposal {
    return {
      sessionId,
      transcriptPath: transcript,
      binding,
      assemblyDigest,
      revision: store.currentRevision(sessionId),
      references: base.slice(0, 3).map(refFor),
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

  /** Publish `input` at a fresh revision and return what a later restore sees. */
  async function roundTrip(input: Partial<AcceptedHistoryProposal>): Promise<any> {
    const revision = await store.invalidate(sessionId, 'history-mutation');
    const published = await store.publish(proposal({ ...input, revision }));
    if (!published.ok) return published;
    return store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest });
  }

  function sidecar(): string {
    return fs.readFileSync(store.manifestPath(sessionId), 'utf8');
  }

  /** Every JSON key path in the manifest whose string value contains `marker`, so a
   *  privacy test can assert WHERE a kept string lives, not just that it appears. */
  function markerPaths(value: unknown, marker: string, trail: string[] = []): string[][] {
    if (typeof value === 'string') return value.includes(marker) ? [trail] : [];
    if (Array.isArray(value)) return value.flatMap((item, index) => markerPaths(item, marker, [...trail, String(index)]));
    if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => markerPaths(item, marker, [...trail, key]));
    return [];
  }

  it('publishes references to exact transcript content and restores private metadata without duplicating transcript text', async () => {
    const revision = await store.invalidate(sessionId, 'history-mutation');
    await expect(store.publish({ ...proposal(), revision })).resolves.toEqual({ ok: true });

    expect(sidecar()).toContain('PRIVATE_SENTINEL');
    expect(sidecar()).not.toContain('"text":"hello"');
    expect(sidecar()).not.toContain('"text":"answer"');
    expect((fs.statSync(path.dirname(store.manifestPath(sessionId))).mode & 0o077)).toBe(0);
    expect((fs.statSync(store.manifestPath(sessionId)).mode & 0o077)).toBe(0);

    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest }))
      .toEqual({ ok: true, messages: proposal().messages, eventUuids: ['u1', 'r1', 'a1'], revision });
  });

  it('returns the recorded transformation so a restored session keeps its summary anchor', async () => {
    const events: Fixture[] = [
      { type: 'compact-summary', sessionId, uuid: 'c1', data: { summary: 'SUMMARY_BODY' } },
      { type: 'skill-invoked', sessionId, uuid: 's1', data: { body: 'SKILL_BODY', args: 'SKILL_ARGS' } },
    ];
    writeTranscript(events);
    const restored = await roundTrip({
      references: events.map(refFor),
      messages: [
        { role: 'user', content: '[Earlier conversation summary]\nSUMMARY_BODY' },
        { role: 'user', content: 'SKILL_BODY\n\nSKILL_ARGS' },
      ] as any,
      transformation: { kind: 'summary', summaryEventUuid: 'c1' },
    });
    expect(sidecar()).not.toContain('SUMMARY_BODY');
    expect(sidecar()).not.toContain('SKILL_BODY');
    expect(restored).toEqual({
      ok: true,
      eventUuids: ['c1', 's1'],
      revision: store.currentRevision(sessionId),
      transformation: { kind: 'summary', summaryEventUuid: 'c1' },
      messages: [
        { role: 'user', content: '[Earlier conversation summary]\nSUMMARY_BODY' },
        { role: 'user', content: 'SKILL_BODY\n\nSKILL_ARGS' },
      ],
    });
  });

  it('rebuilds merged assistant text and an interrupted partial string from consecutive anchors', async () => {
    const events: Fixture[] = [
      { type: 'assistant-text', sessionId, uuid: 'a1', data: { partId: 'text-0', text: 'ans' } },
      { type: 'assistant-text', sessionId, uuid: 'a2', data: { partId: 'text-1', text: 'wer' } },
      { type: 'assistant-text', sessionId, uuid: 'a3', data: { partId: 'text-2', text: 'more' } },
      { type: 'assistant-text', sessionId, uuid: 'a4', data: { partId: 'text-3', text: 'text' } },
    ];
    writeTranscript(events);
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { role: 'assistant', content: 'moretext' },
    ];
    const restored = await roundTrip({ references: events.map(refFor), messages: messages as any });
    expect(sidecar()).toContain('"kind":"concat"');
    expect(sidecar()).not.toContain('answer');
    expect(sidecar()).not.toContain('moretext');
    expect(restored).toEqual({ ok: true, messages, eventUuids: ['a1', 'a2', 'a3', 'a4'], revision: store.currentRevision(sessionId) });
  });

  it('rejects a reference set that covers only part of a persisted assistant part', async () => {
    const partial = base.slice(0, 3).map(refFor);
    partial[2] = { ...partial[2], end: 3 };
    const revision = await store.invalidate(sessionId, 'history-mutation');
    await expect(store.publish(proposal({ revision, references: partial })))
      .resolves.toEqual({ ok: false, reason: 'unreferenced-history' });
  });

  it('rejects flushed abandoned retries because only accepted UUID ranges may be referenced', async () => {
    writeTranscript([...base, { type: 'assistant-text', sessionId, uuid: 'abandoned', data: { partId: 'text-9', text: 'abandoned' } }]);
    const revision = await store.invalidate(sessionId, 'history-mutation');
    const bad = proposal({ revision, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'abandoned' }] }] as any });
    await expect(store.publish(bad)).resolves.toEqual({ ok: false, reason: 'unreferenced-history' });
    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest })).toEqual({ ok: false, reason: 'ineligible' });
  });

  it('keeps the parallel-call wrapper argument string and nothing else: no per-call input, no tool output', async () => {
    const events: Fixture[] = [
      { type: 'tool-use', sessionId, uuid: 't1', data: { toolUseId: 'call_1', toolName: 'Bash', toolInput: { command: 'SECRET_TOOL_INPUT' } } },
      { type: 'tool-result', sessionId, uuid: 't2', data: { toolUseId: 'call_1', toolName: 'Bash', toolResult: 'SECRET_TOOL_OUTPUT' } },
    ];
    writeTranscript(events);
    const wrapper = {
      itemId: 'fc_parallel', toolCallId: 'call_1', toolName: 'Bash',
      input: '{"calls":[{"name":"Bash","arguments":"{\\"command\\":\\"WRAPPER_ARGUMENT_MARKER\\"}"}]}',
      index: 0, count: 1,
    };
    const messages = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'Bash', input: { command: 'SECRET_TOOL_INPUT' }, providerOptions: { openai: { itemId: 'fc_1', parallelToolCall: wrapper } } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'Bash', output: { type: 'text', value: 'SECRET_TOOL_OUTPUT' }, providerOptions: { openai: { parallelToolCall: wrapper } } }] },
    ];
    const restored = await roundTrip({ references: events.map(refFor), messages: messages as any });

    // The real per-call input and the tool output stay in the transcript only.
    expect(sidecar()).not.toContain('SECRET_TOOL_INPUT');
    expect(sidecar()).not.toContain('SECRET_TOOL_OUTPUT');
    // The one documented exemption: the wrapper's raw argument string is kept, and it
    // may live ONLY under providerOptions.openai.parallelToolCall.input.
    const marked = markerPaths(JSON.parse(sidecar()), 'WRAPPER_ARGUMENT_MARKER');
    expect(marked.length).toBe(2);
    expect(marked.map(p => p.slice(-3).join('.'))).toEqual(['openai.parallelToolCall.input', 'openai.parallelToolCall.input']);
    expect(restored).toEqual({ ok: true, messages, eventUuids: ['t1', 't2'], revision: store.currentRevision(sessionId) });
  });

  it('publishes an empty-summary reasoning part with no transcript reference and restores it byte-for-byte', async () => {
    // WHY: @ai-sdk/openai emits reasoning-start for an encrypted reasoning item that never
    // produces summary text, so `ai` builds a reasoning part whose text is ''. No anchor can
    // ever reproduce an empty target, so before this every such turn published
    // `unreferenced-history` forever and the session could never become durable.
    const events: Fixture[] = [
      { type: 'user-message', sessionId, uuid: 'u1', data: { text: 'hello' } },
      { type: 'assistant-text', sessionId, uuid: 'a1', data: { partId: 'text-0', text: 'answer' } },
    ];
    writeTranscript(events);
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [
        { type: 'reasoning', text: '', providerOptions: { openai: { itemId: 'rs_empty', reasoningEncryptedContent: 'EMPTY_SUMMARY_SENTINEL' } } },
        { type: 'text', text: 'answer', providerOptions: { openai: { itemId: 'msg_1', phase: 'final_answer' } } },
      ] },
    ];
    const restored = await roundTrip({ references: events.map(refFor), messages: messages as any });
    expect(JSON.parse(sidecar()).messages[1].content.parts[0]).toEqual({
      kind: 'empty', field: 'reasoning-text',
      providerOptions: { openai: { itemId: 'rs_empty', reasoningEncryptedContent: 'EMPTY_SUMMARY_SENTINEL' } },
    });
    expect(restored).toEqual({ ok: true, messages, eventUuids: ['u1', 'a1'], revision: store.currentRevision(sessionId) });
  });

  it('lets ONLY reasoning be empty, and only with allowlisted metadata', async () => {
    const events: Fixture[] = [{ type: 'assistant-text', sessionId, uuid: 'a1', data: { partId: 'text-0', text: 'answer' } }];
    writeTranscript(events);
    for (const part of [
      { type: 'text', text: '', providerOptions: { openai: { itemId: 'msg_1', phase: 'final_answer' } } },   // empty visible text is never anchorless
      { type: 'reasoning', text: '', providerOptions: { openai: { reasoningEncryptedContent: 'x', providerExecuted: true } } },  // outside the allowlist
    ]) {
      await expect(roundTrip({ references: events.map(refFor), messages: [{ role: 'assistant', content: [part] }] as any }))
        .resolves.toEqual({ ok: false, reason: 'unreferenced-history' });
    }
  });

  it('leaves no eligibility file behind and finishes the sweep past an undecodable name', async () => {
    const revision = await store.invalidate(sessionId, 'history-mutation');
    await expect(store.publish(proposal({ revision }))).resolves.toEqual({ ok: true });
    const dir = path.dirname(store.manifestPath(sessionId));
    // A name `encodeURIComponent` could never have produced: decodeURIComponent THROWS
    // on it, and that used to abandon the whole sweep at whatever readdir order it hit.
    fs.writeFileSync(path.join(dir, '%E0%A4%A.manifest.json'), '{}');
    // A fence whose manifest never landed — the crash window leaves exactly this.
    fs.writeFileSync(path.join(dir, 'gone.eligibility.json'), JSON.stringify({ v: 1, sessionId: 'gone', revision: 1, eligible: false, reason: 'x' }));

    fs.rmSync(transcript);
    await store.cleanupOrphans();

    // Both orphan pairs are gone; only the entry no session id can name is skipped.
    expect(fs.readdirSync(dir).sort()).toEqual(['%E0%A4%A.manifest.json']);
  });

  it('remove() takes the eligibility fence with the manifest', async () => {
    const revision = await store.invalidate(sessionId, 'history-mutation');
    await expect(store.publish(proposal({ revision }))).resolves.toEqual({ ok: true });
    const dir = path.dirname(store.manifestPath(sessionId));
    expect(fs.readdirSync(dir).sort()).toEqual([`${sessionId}.eligibility.json`, `${sessionId}.manifest.json`]);

    await expect(store.remove(sessionId)).resolves.toEqual({ ok: true });
    expect(fs.readdirSync(dir)).toEqual([]);
    // And the in-memory fence still wins, so a stale in-flight publish cannot land.
    expect(store.currentRevision(sessionId)).toBe(revision + 1);
  });

  it('refuses provider metadata outside the per-kind allowlist instead of copying it', async () => {
    const events: Fixture[] = [{ type: 'tool-use', sessionId, uuid: 't1', data: { toolUseId: 'call_1', toolName: 'Bash', toolInput: {} } }];
    writeTranscript(events);
    const toolCall = (providerOptions: any) => [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'Bash', input: {}, providerOptions }] }];
    for (const providerOptions of [
      { openai: { itemId: 'fc_1', providerExecuted: true } },                                  // unknown key under openai
      { openai: { parallelToolCall: { itemId: 'fc_1', arguments: 'SMUGGLED' } } },             // unknown key under the wrapper
      { anthropic: { cacheControl: 'ephemeral' } },                                            // unknown provider entirely
    ]) {
      await expect(roundTrip({ references: events.map(refFor), messages: toolCall(providerOptions) as any }))
        .resolves.toEqual({ ok: false, reason: 'unreferenced-history' });
    }

    // Reasoning-only metadata on a plain text part is not that part's allowlist either.
    writeTranscript(base);
    const leaky = proposal().messages as any[];
    await expect(roundTrip({ messages: [leaky[0], { role: 'assistant', content: [{ type: 'text', text: 'answer', providerOptions: { openai: { reasoningEncryptedContent: 'LEAK' } } }] }] as any }))
      .resolves.toEqual({ ok: false, reason: 'unreferenced-history' });
  });

  it('cites the real anchor for a user message preceded by an empty accepted one, never a literal', async () => {
    const events: Fixture[] = [
      { type: 'user-message', sessionId, uuid: 'u-empty', data: { text: '' } },
      { type: 'user-message', sessionId, uuid: 'u-real', data: { text: 'REAL_USER_TEXT' } },
      { type: 'user-message', sessionId, uuid: 'u-next', data: { text: 'SECOND_USER_TEXT' } },
    ];
    writeTranscript(events);
    const messages = [{ role: 'user', content: 'REAL_USER_TEXT' }, { role: 'user', content: 'SECOND_USER_TEXT' }];
    const restored = await roundTrip({ references: events.map(refFor), messages: messages as any });
    // The empty anchor must not be spent as the head of a two-anchor run: that would
    // both copy real user text into the sidecar and burn the anchor the next message needs.
    expect(JSON.parse(sidecar()).messages.map((m: any) => m.content)).toEqual([
      { kind: 'event', uuid: 'u-real', field: 'user-text' },
      { kind: 'event', uuid: 'u-next', field: 'user-text' },
    ]);
    expect(sidecar()).not.toContain('REAL_USER_TEXT');
    expect(restored).toEqual({ ok: true, messages, eventUuids: ['u-empty', 'u-real', 'u-next'], revision: store.currentRevision(sessionId) });
  });

  it('accepts references that tile one persisted part and rejects a gap or an overlap', async () => {
    const events: Fixture[] = [{ type: 'assistant-text', sessionId, uuid: 'a1', data: { partId: 'text-0', text: 'hello' } }];
    writeTranscript(events);
    const messages = [{ role: 'assistant', content: 'hello' }];
    const ref = (start: number, end: number): PersistedEventReference =>
      ({ eventUuid: `delta-${start}-${end}`, anchorUuid: 'a1', type: 'assistant-text' as any, partId: 'text-0', start, end });

    await expect(roundTrip({ references: [ref(0, 3), ref(3, 5)], messages: messages as any }))
      .resolves.toEqual({ ok: true, messages, eventUuids: ['a1'], revision: store.currentRevision(sessionId) });
    await expect(roundTrip({ references: [ref(0, 2), ref(3, 5)], messages: messages as any }))
      .resolves.toEqual({ ok: false, reason: 'unreferenced-history' });
    await expect(roundTrip({ references: [ref(0, 3), ref(2, 5)], messages: messages as any }))
      .resolves.toEqual({ ok: false, reason: 'unreferenced-history' });
  });

  it('never rejects: an unexpected failure while describing publishes as unreferenced-history', async () => {
    const revision = await store.invalidate(sessionId, 'history-mutation');
    const exploding = [{ role: 'user', get content(): string { throw new Error('boom'); } }];
    await expect(store.publish(proposal({ revision, messages: exploding as any })))
      .resolves.toEqual({ ok: false, reason: 'unreferenced-history' });
  });

  it('refuses a tampered manifest: bad role, bad transformation shape, or a non-text field', async () => {
    const revision = await store.invalidate(sessionId, 'history-mutation');
    await store.publish(proposal({ revision }));
    const original = sidecar();
    const tamper = (mutate: (manifest: any) => void) => {
      const manifest = JSON.parse(original);
      mutate(manifest);
      fs.writeFileSync(store.manifestPath(sessionId), JSON.stringify(manifest));
      return store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest });
    };
    expect(tamper(m => { m.messages[0].role = 'root'; })).toEqual({ ok: false, reason: 'malformed' });
    expect(tamper(m => { m.transformation = { kind: 'summary' }; })).toEqual({ ok: false, reason: 'malformed' });
    expect(tamper(m => { m.transformation = { kind: 'rewritten' }; })).toEqual({ ok: false, reason: 'malformed' });
    expect(tamper(m => { m.messages[0].content = { kind: 'event', uuid: 'u1', field: 'tool-call' }; })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('re-reads a tool-delivered image by path and refuses a changed one', async () => {
    const image = path.join(root, 'shot.png');
    fs.writeFileSync(image, Buffer.from('pixels-v1'));
    const events: Fixture[] = [
      { type: 'tool-result', sessionId, uuid: 't2', data: { toolUseId: 'call_1', toolName: 'Read', toolResult: 'here it is', images: [image] } },
    ];
    writeTranscript(events);
    const messages = [{ role: 'tool', content: [{
      type: 'tool-result', toolCallId: 'call_1', toolName: 'Read',
      output: { type: 'content', value: [
        { type: 'text', text: 'here it is' },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: fs.readFileSync(image) }, filename: 'shot.png' },
      ] },
    }] }];
    const restored = await roundTrip({ references: events.map(refFor), messages: messages as any });
    expect(restored).toEqual({ ok: true, messages, eventUuids: ['t2'], revision: store.currentRevision(sessionId) });

    fs.writeFileSync(image, Buffer.from('pixels-v2'));
    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest })).toEqual({ ok: false, reason: 'image-mismatch' });
  });

  it('recomputes pruned and image-collapsed tool results from the untouched event text', async () => {
    const image = path.join(root, 'shot.png');
    fs.writeFileSync(image, Buffer.from('pixels-v1'));
    const long = 'LONG_TOOL_OUTPUT'.repeat(40);
    const events: Fixture[] = [
      { type: 'tool-result', sessionId, uuid: 't1', data: { toolUseId: 'call_1', toolName: 'Bash', toolResult: long } },
      { type: 'tool-result', sessionId, uuid: 't2', data: { toolUseId: 'call_2', toolName: 'Read', toolResult: 'see this', images: [image] } },
    ];
    writeTranscript(events);
    const messages = [{ role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'call_1', toolName: 'Bash', output: { type: 'text', value: prunedToolResultText(long, 100) } },
      { type: 'tool-result', toolCallId: 'call_2', toolName: 'Read', output: { type: 'text', value: imageCollapsedToolResultText('see this', 'Read') } },
    ] }];
    const restored = await roundTrip({ references: events.map(refFor), messages: messages as any, transformation: { kind: 'pruned' } });
    expect(sidecar()).toContain('"keepChars":100');
    expect(sidecar()).toContain('"imageCollapsed":true');
    expect(sidecar()).not.toContain('LONG_TOOL_OUTPUT');
    expect(sidecar()).not.toContain('see this');
    expect(restored).toEqual({ ok: true, messages, eventUuids: ['t1', 't2'], revision: store.currentRevision(sessionId), transformation: { kind: 'pruned' } });

    // A keep-length the event text cannot support is a corrupt manifest, not a shorter result.
    const manifest = JSON.parse(sidecar());
    manifest.messages[0].content.parts[0].pruned.keepChars = long.length + 1;
    fs.writeFileSync(store.manifestPath(sessionId), JSON.stringify(manifest));
    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('keeps injected user strings as bounded literals and refuses an oversized one', async () => {
    const steer = '<steer>\nhurry up\n</steer>';
    const restored = await roundTrip({ messages: [...proposal().messages, { role: 'user', content: steer }] as any });
    expect(restored).toEqual({ ok: true, messages: [...proposal().messages, { role: 'user', content: steer }], eventUuids: ['u1', 'r1', 'a1'], revision: store.currentRevision(sessionId) });

    const oversized = 'x'.repeat(64 * 1024 + 1);
    await expect(roundTrip({ messages: [{ role: 'user', content: oversized }] as any }))
      .resolves.toEqual({ ok: false, reason: 'unreferenced-history' });
  });

  it('fences late publication, binding mismatch, transcript advance, malformed and oversized state', async () => {
    const first = await store.invalidate(sessionId, 'history-mutation');
    await store.publish({ ...proposal(), revision: first });
    await store.invalidate(sessionId, 'context-clear');
    await expect(store.publish({ ...proposal(), revision: first })).resolves.toEqual({ ok: false, reason: 'stale-generation' });
    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest })).toEqual({ ok: false, reason: 'ineligible' });

    const next = await store.invalidate(sessionId, 'history-mutation');
    await store.publish({ ...proposal(), revision: next });
    expect(store.restore({ sessionId, transcriptPath: transcript, binding: `${binding}-other`, assemblyDigest })).toEqual({ ok: false, reason: 'binding-mismatch' });
    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest: 'assembly-v2' })).toEqual({ ok: false, reason: 'assembly-mismatch' });
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'user-message', sessionId, uuid: 'u2', data: { text: 'later' } })}\n`);
    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest })).toEqual({ ok: false, reason: 'transcript-advanced' });

    fs.writeFileSync(store.manifestPath(sessionId), '{bad');
    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest })).toEqual({ ok: false, reason: 'malformed' });
    fs.writeFileSync(store.manifestPath(sessionId), Buffer.alloc(16 * 1024 * 1024 + 1));
    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest })).toEqual({ ok: false, reason: 'oversized' });
  });

  it('invalidates an older checkpoint before oversized/failed replacement and survives failed unlink', async () => {
    const first = await store.invalidate(sessionId, 'history-mutation');
    await store.publish({ ...proposal(), revision: first });
    const second = await store.invalidate(sessionId, 'history-mutation');
    // WHY: the sidecar only ever copies bounded injected literals, so the 16 MiB
    // bound is reached by their COUNT — a single giant message would be rejected
    // as unreferenced-history long before size ever mattered.
    const flood = Array.from({ length: 300 }, () => ({ role: 'user', content: 'x'.repeat(60_000) }));
    await expect(store.publish(proposal({ revision: second, messages: flood as any })))
      .resolves.toEqual({ ok: false, reason: 'oversized' });
    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest })).toEqual({ ok: false, reason: 'ineligible' });

    let writes = 0;
    const failing = new AcceptedHistoryStore(path.join(root, 'electron-user-data'), { beforeRename: () => { if (++writes > 1) throw new Error('disk'); } });
    const third = await failing.invalidate(sessionId, 'history-mutation');
    await expect(failing.publish({ ...proposal(), revision: third })).resolves.toEqual({ ok: false, reason: 'write-failed' });
    expect(failing.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest })).toEqual({ ok: false, reason: 'ineligible' });

    const unlinkFailing = new AcceptedHistoryStore(path.join(root, 'electron-user-data'), { unlink: () => { throw new Error('busy'); } });
    await expect(unlinkFailing.remove(sessionId)).resolves.toEqual({ ok: false, reason: 'unlink-failed' });
    expect(unlinkFailing.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest })).toEqual({ ok: false, reason: 'ineligible' });
  });

  it('validates user attachment bytes and removes orphan sidecars when the real transcript disappears', async () => {
    const image = path.join(root, 'image.png');
    fs.writeFileSync(image, Buffer.from('pixels-v1'));
    const events: Fixture[] = [{ type: 'user-message', sessionId, uuid: 'u-img', data: { text: 'look', attachments: [image] } }];
    writeTranscript(events);
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'file', mediaType: 'image/png', data: fs.readFileSync(image) }] }];
    const restored = await roundTrip({ references: events.map(refFor), messages: messages as any });
    expect(restored).toEqual({ ok: true, messages, eventUuids: ['u-img'], revision: store.currentRevision(sessionId) });

    fs.writeFileSync(image, Buffer.from('pixels-v2'));
    expect(store.restore({ sessionId, transcriptPath: transcript, binding, assemblyDigest })).toEqual({ ok: false, reason: 'image-mismatch' });

    fs.rmSync(transcript);
    await store.cleanupOrphans();
    expect(fs.existsSync(store.manifestPath(sessionId))).toBe(false);
  });
});
