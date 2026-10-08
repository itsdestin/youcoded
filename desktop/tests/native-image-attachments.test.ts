// M4 Task 2 — images reach the model through the USER MESSAGE.
//
// The July plan (§5 item 6) described two separate gaps: "InputBar builds text
// parts only" and "Read refuses images". Both were wrong. An attachment has
// always been a file PATH prepended to the message text — for Claude Code
// sessions too — so nothing was missing in the composer, and the model was
// simply told to go Read a file the native Read tool refuses.
//
// The fix mirrors what every other harness does for a pasted image: put it in the
// user message. That path works on EVERY provider we ship (verified against
// @ai-sdk/openai-compatible@3.0.14, which converts file parts to `image_url`).
// Image-in-TOOL-RESULT is deliberately NOT implemented: it is Anthropic-only
// across the ecosystem, and openai-compatible JSON.stringifies it — three of our
// four provider paths would hand the model a wall of base64.
//
// UPDATE (2026-08-11 spec, Task 4): the paragraph above is no longer the whole
// story. Read now ALSO delivers images for MODEL-INITIATED reads (a vision
// model asking to see a path it was told about) via ToolResultPayload.images —
// see tools/read.ts and the "Read: image delivery" suite in
// harness-tools-core.test.ts. Images live canonically in the tool-result
// message as the AI SDK v7 'content' output shape; the wire-level
// "Anthropic-only" problem this comment used to describe is solved per-provider
// by adaptForWire (src/main/harness/wire-adapter.ts, see wire-adapter.test.ts),
// which rewrites that shape at request-build time — native on Anthropic, split
// into a synthetic user message elsewhere, stripped (with a text note) for a
// non-vision model. That driver has landed. This file's suite is about the
// USER-attachment path (imagePartsFor) specifically, which it does not touch —
// except for the three ReadTool refusal-wording assertions below, updated to
// match the new honest refusal text.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveProfile, CLOUD_DEFAULT, type CapabilityProfile } from '../src/main/harness/capability-profile';
import { ReadTool } from '../src/main/harness/tools/read';
import type { ToolServices } from '../src/main/harness/tools/types';
import { pngHeader, providerFileBytes } from './helpers/image-fixtures';
import { imageNote } from '../src/main/harness/image-support';
import type { ModelAttachment } from '../src/main/harness/busy-message-boundary';

// 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-img-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('supportsVision resolution', () => {
  it('is true for providers reached through their own SDK', () => {
    for (const providerType of ['anthropic', 'openai', 'google'] as const) {
      expect(resolveProfile({ providerType, modelId: 'whatever', contextLength: null }).supportsVision).toBe(true);
    }
  });

  it('is false for an unknown model behind a transport provider', () => {
    // openrouter / openai-compatible / local-engine serve vision AND text-only
    // models from one endpoint, so the transport cannot answer this. A wrong
    // `true` fails the whole turn with a provider error; a wrong `false` only
    // means the model is told it cannot see the image.
    for (const providerType of ['openrouter', 'openai-compatible', 'local-engine'] as const) {
      expect(resolveProfile({ providerType, modelId: 'some-unknown-model', contextLength: 8_000 }).supportsVision).toBe(false);
    }
  });

  it('lets the registry override a transport provider in BOTH directions', () => {
    const registry = [
      { match: 'seeing-model', label: 'Seeing', supportsVision: true },
      { match: 'blind-model', label: 'Blind', supportsVision: false },
    ];
    expect(resolveProfile({ providerType: 'openrouter', modelId: 'vendor/seeing-model', contextLength: null }, registry).supportsVision).toBe(true);
    // Override DOWN matters too: a text-only model served by a direct provider
    // must not inherit that provider's optimistic default.
    expect(resolveProfile({ providerType: 'anthropic', modelId: 'blind-model', contextLength: null }, registry).supportsVision).toBe(false);
  });

  it('CLOUD_DEFAULT itself claims no vision', () => {
    // resolveProfile always spreads the real value over it; the literal stays
    // false so a direct use cannot accidentally claim the capability.
    expect(CLOUD_DEFAULT.supportsVision).toBe(false);
  });
});

describe('Read tool — images are refused with the RIGHT reason', () => {
  // ctx here carries no `supportsVision` (undefined = false, the conservative
  // default — see ToolContext), so a deliverable image still hits the vision
  // gate. Updated 2026-08-11 (Task 4): the refusal now names the REAL reason
  // (model has no vision) instead of steering back to the attach-a-message
  // flow, which is a fact about a DIFFERENT model, not this file.
  it('names the image, and the real reason it is refused', async () => {
    const p = path.join(dir, 'shot.png');
    fs.writeFileSync(p, PNG);
    const r = await ReadTool.execute({ file_path: p }, { cwd: dir } as any);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('is an image');
    expect(r.text).toMatch(/cannot view images/i);
    // The old text blamed the file's encoding, which is a different fact and
    // sends the model looking for a text workaround that does not exist.
    expect(r.text).not.toContain('it is a binary file');
  });

  it('gives a no-vision model the VISION reason for an undeliverable format too, not convert-and-retry advice', async () => {
    // An all-ASCII .svg has no NUL bytes, so the binary sniff would have let it
    // through as text. It is still an image, and unlike png/jpg/gif/webp it is
    // never deliverable regardless of vision support (see
    // UNDELIVERABLE_IMAGE_EXTENSIONS) — but ctx here ALSO has no vision, so the
    // real blocker is "this model cannot see images at all", not "this format
    // needs converting". Fix 1 (2026-08-11 review): telling a no-vision model
    // to convert to PNG and Read the copy is a dead end — the copy comes back
    // to the SAME vision gate — and costs it a wasted Bash round-trip first.
    const p = path.join(dir, 'icon.svg');
    fs.writeFileSync(p, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const r = await ReadTool.execute({ file_path: p }, { cwd: dir } as any);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/cannot view images/i);
    expect(r.text).not.toMatch(/convert it to png/i);
  });

  it('still gives a VISION-capable model the convert-to-PNG advice for an undeliverable format', async () => {
    // For a model that CAN see images, "cannot be delivered, convert it" is the
    // correct and only useful advice — svg itself is never deliverable, vision
    // support or not. This is the case Fix 1 must not break while fixing the
    // no-vision dead end above.
    const p = path.join(dir, 'icon.svg');
    fs.writeFileSync(p, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const r = await ReadTool.execute({ file_path: p }, { cwd: dir, supportsVision: true } as any);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('svg');
    expect(r.text).toMatch(/cannot be delivered/i);
    expect(r.text).toMatch(/convert it to png/i);
  });

  it('still refuses a non-image binary with the binary message', async () => {
    const p = path.join(dir, 'blob.bin');
    fs.writeFileSync(p, Buffer.from([0, 1, 2, 0, 3]));
    const r = await ReadTool.execute({ file_path: p }, { cwd: dir } as any);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('binary file');
    expect(r.text).not.toContain('is an image');
  });

  it('still reads ordinary text files', async () => {
    const p = path.join(dir, 'notes.txt');
    fs.writeFileSync(p, 'hello\nworld\n');
    // The text path records the read in readRegistry (read-before-edit), so this
    // case needs a fuller context than the refusals, which return before that.
    const ctx = { cwd: dir, signal: new AbortController().signal, readRegistry: new Map(), sessionId: 's', todos: [] };
    const r = await ReadTool.execute({ file_path: p }, ctx as any);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('hello');
  });

  it('advertises text-only in its base description; vision models get a different one', async () => {
    // The base `description` (what a text-only model sees) still says only
    // "TEXT file" and refuses images — it no longer tells the model to go
    // attach the image elsewhere, because for a VISION model that advice is
    // now false (see descriptionFor, exercised in harness-tools-core.test.ts's
    // "Read: image delivery" suite).
    expect(ReadTool.description).toMatch(/TEXT file/);
    expect(ReadTool.description).toMatch(/refused/i);
  });
});

// The core of the fix: an attachment must actually reach the model as an image
// part. These assert on what the PROVIDER receives, not on our own plumbing —
// the whole bug class here was plumbing that looked right and delivered nothing.
describe('HarnessSession.send — attachments become image parts', () => {
  async function capturePrompt(supportsVision: boolean, attachments: string[], profile?: CapabilityProfile,
                               toolServices?: ToolServices, modelAttachments?: ModelAttachment[]) {
    const { HarnessSession } = await import('../src/main/harness/harness-session');
    const { ASSISTANT_PRESET } = await import('../src/shared/harness-manifest');
    const { EMPTY_SKILL_CATALOG } = await import('./helpers/harness-fakes');
    const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
    const { CLOUD_DEFAULT } = await import('../src/main/harness/capability-profile');

    let seen: any;
    const model = new MockLanguageModelV4({
      doStream: async (o: any) => {
        seen = o.prompt;
        return { stream: simulateReadableStream({ chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
        ] }) };
      },
    });
    const session = new HarnessSession({
      sessionId: 's-img', cwd: dir, harness: ASSISTANT_PRESET,
      binding: { providerId: 'openrouter', modelId: 'm' },
      skillCatalog: EMPTY_SKILL_CATALOG,
      profile: profile ?? { ...CLOUD_DEFAULT, supportsVision },
      ...(toolServices ? { toolServices } : {}),
    } as any, async () => model as any);
    await session.send('look at this', attachments, modelAttachments);
    return seen.find((m: any) => m.role === 'user');
  }

  it.each([true, false])('keeps a busy image message as a real human event (vision %s)', async (supportsVision) => {
    const { HarnessSession } = await import('../src/main/harness/harness-session');
    const { ASSISTANT_PRESET } = await import('../src/shared/harness-manifest');
    const { EMPTY_SKILL_CATALOG } = await import('./helpers/harness-fakes');
    const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
    const p = path.join(dir, 'shot.png');
    fs.writeFileSync(p, PNG);
    const prompts: any[] = [];
    const model = new MockLanguageModelV4({ doStream: async (req: any) => {
      prompts.push(req.prompt);
      return { stream: simulateReadableStream({ chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: 'ok' }, { type: 'text-end', id: 'reply' },
        { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
      ] }) };
    } });
    const events: any[] = [];
    let queued = true;
    const session = new HarnessSession({ sessionId: 'busy-img', cwd: dir, harness: ASSISTANT_PRESET,
      binding: { providerId: 'openrouter', modelId: 'm' }, skillCatalog: EMPTY_SKILL_CATALOG,
      profile: { ...CLOUD_DEFAULT, supportsVision },
      takeReadyBusyMessage: () => {
        if (!queued) return;
        queued = false;
        return { id: 'image', text: '', attachments: [p] };
      },
    }, async () => model as any);
    session.on('transcript-event', event => events.push(event));
    await session.send('first');
    expect(prompts).toHaveLength(2);
    const input = prompts[1].filter((m: any) => m.role === 'user').at(-1);
    expect(input.content.some((part: any) => part.type === 'file')).toBe(supportsVision);
    const event = events.find(e => e.type === 'user-message' && e.data.attachments?.[0] === p);
    expect(event.data.text).toBe('');
    // The model read the picker path itself, so nothing differs to persist.
    expect(event.data.modelAttachments).toBeUndefined();
    expect(session.acceptedHistory().eventUuids).toContain(event.uuid);
  });

  it('a busy message carrying a prepared copy persists it as modelAttachments and the model gets the copy', async () => {
    const { HarnessSession } = await import('../src/main/harness/harness-session');
    const { ASSISTANT_PRESET } = await import('../src/shared/harness-manifest');
    const { EMPTY_SKILL_CATALOG } = await import('./helpers/harness-fakes');
    const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
    const huge = path.join(dir, 'huge.png'); fs.writeFileSync(huge, pngHeader(2904, 17528));
    const small = path.join(dir, 'small.png'); fs.writeFileSync(small, pngHeader(610, 3686));
    const prompts: any[] = [];
    const model = new MockLanguageModelV4({ doStream: async (req: any) => {
      prompts.push(req.prompt);
      return { stream: simulateReadableStream({ chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: 'ok' }, { type: 'text-end', id: 'reply' },
        { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
      ] }) };
    } });
    const events: any[] = [];
    let queued = true;
    const session = new HarnessSession({ sessionId: 'busy-prepared', cwd: dir, harness: ASSISTANT_PRESET,
      binding: { providerId: 'chatgpt', modelId: 'gpt-x' }, skillCatalog: EMPTY_SKILL_CATALOG,
      profile: resolveProfile({ providerType: 'chatgpt', modelId: 'gpt-x', contextLength: null }),
      takeReadyBusyMessage: () => {
        if (!queued) return;
        queued = false;
        return { id: 'image', text: 'picture', attachments: [huge], modelAttachments: [small] };
      },
    }, async () => model as any);
    session.on('transcript-event', event => events.push(event));
    await session.send('first');
    const event = events.find(e => e.type === 'user-message' && e.data.attachments?.[0] === huge);
    expect(event.data.modelAttachments).toEqual([small]);
    const input = prompts[1].filter((m: any) => m.role === 'user').at(-1);
    expect(providerFileBytes(input.content.find((p: any) => p.type === 'file'))).toEqual(pngHeader(610, 3686));
  });

  it('attaches the pixels for a vision-capable model', async () => {
    const p = path.join(dir, 'shot.png');
    fs.writeFileSync(p, PNG);
    const user = await capturePrompt(true, [p]);
    expect(Array.isArray(user.content)).toBe(true);
    const file = user.content.find((c: any) => c.type === 'file');
    expect(file).toBeDefined();
    expect(file.mediaType).toBe('image/png');
    // The TEXT must survive alongside the image — it is the dedup key the
    // optimistic bubble is confirmed against (see native-send.ts).
    expect(user.content.find((c: any) => c.type === 'text').text).toBe('look at this');
  });

  // NOTE on the assertions below: the AI SDK normalizes a string `content` into
  // [{type:'text'}] before the provider sees it, so "no image" cannot be asserted
  // as a raw string HERE — it is asserted as the absence of a file part, which is
  // the fact that actually matters. The plain-string shape inside our own history
  // is separately pinned by harness-history-rebuild.test.ts's deep-equal.
  const noFileParts = (user: any) =>
    expect((user.content as any[]).filter((c) => c.type === 'file')).toHaveLength(0);

  it('sends NO image part when the model cannot see images', async () => {
    // A text-only model handed an image part fails the whole turn with a provider
    // error — strictly worse than being told it cannot see the picture.
    const p = path.join(dir, 'shot.png');
    fs.writeFileSync(p, PNG);
    noFileParts(await capturePrompt(false, [p]));
  });

  it('sends a plain string when nothing was attached', async () => {
    noFileParts(await capturePrompt(true, []));
  });

  it('skips a non-image attachment rather than corrupting the message', async () => {
    const p = path.join(dir, 'notes.txt');
    fs.writeFileSync(p, 'hello');
    noFileParts(await capturePrompt(true, [p]));
  });

  it('survives an attachment that vanished between compose and send', async () => {
    // The turn must not die because a temp file was cleaned up; the path is
    // still in the message text either way.
    noFileParts(await capturePrompt(true, [path.join(dir, 'gone.png')]));
  });

  it('an attachment over the provider limit is NOT delivered, and the model is told so by basename', async () => {
    const huge = path.join(dir, 'huge.png'); fs.writeFileSync(huge, pngHeader(2904, 17528));
    const user = await capturePrompt(true, [huge], resolveProfile({ providerType: 'chatgpt', modelId: 'gpt-x', contextLength: null }));
    expect(user.content.some((p: any) => p.type === 'file')).toBe(false);
    expect(user.content.at(-1)).toMatchObject({ type: 'text', text: imageNote({ kind: 'oversized', label: 'huge.png', width: 2904, height: 17528 }) });
  });
  it('modelAttachments is read in place of attachments', async () => {
    const huge = path.join(dir, 'huge.png'); fs.writeFileSync(huge, pngHeader(2904, 17528));
    const small = path.join(dir, 'small.png'); fs.writeFileSync(small, pngHeader(610, 3686));
    const user = await capturePrompt(true, [huge], resolveProfile({ providerType: 'chatgpt', modelId: 'gpt-x', contextLength: null }), undefined, [small]);
    expect(providerFileBytes(user.content.find((p: any) => p.type === 'file'))).toEqual(pngHeader(610, 3686));
  });
  it('a message whose only attachments are non-images keeps today’s plain-string shape — no note, no parts', async () => {
    const notes = path.join(dir, 'notes.txt'); fs.writeFileSync(notes, 'hello');
    const user = await capturePrompt(true, [notes], resolveProfile({ providerType: 'chatgpt', modelId: 'gpt-x', contextLength: null }));
    // The AI SDK normalizes a plain-string user message to ONE text part before
    // the provider sees it (see the NOTE above), so "plain string" is asserted as
    // exactly that single part: no file, no note.
    expect(user.content).toEqual([{ type: 'text', text: 'look at this' }]);
  });
  it('a preparation failure is told to the model as such, with the preparer’s reason — never as "above size limit"', async () => {
    const huge = path.join(dir, 'huge.png'); fs.writeFileSync(huge, pngHeader(2904, 17528));
    const user = await capturePrompt(true, [huge], resolveProfile({ providerType: 'chatgpt', modelId: 'gpt-x', contextLength: null }), undefined,
      [{ path: huge, prepareFailed: 'is 2904×17528 px and could not be downscaled for the model (shrinking it took longer than 15 s on this computer)' }]);
    expect(user.content.some((p: any) => p.type === 'file')).toBe(false);
    expect(user.content.at(-1)).toEqual({ type: 'text', text: imageNote({ kind: 'unavailable', label: 'huge.png', reason: 'prepare-failed', detail: 'is 2904×17528 px and could not be downscaled for the model (shrinking it took longer than 15 s on this computer)' }) });
  });
});
