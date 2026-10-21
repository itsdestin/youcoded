import { describe, it, expect } from 'vitest';
import { collapseExcessImageParts, fitHistoryToImageLimits } from '../src/main/harness/image-history';
import { imageNote, parseImageNote } from '../src/main/harness/image-support';
import { pngHeader } from './helpers/image-fixtures';

const pic = (name: string) => ({ type: 'file', mediaType: 'image/png', data: { type: 'data', data: pngHeader(100, 100) }, filename: name });
/** One Read result per picture name, in order. */
const readTurns = (names: string[]) => names.flatMap((name, i) => [
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 'Read', input: { file_path: `/tmp/${name}` } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: `c${i}`, toolName: 'Read', output: { type: 'content', value: [{ type: 'text', text: 'Read image' }, pic(name)] } }] },
]) as any[];
const filesIn = (history: any[]) => history.flatMap((m) => Array.isArray(m.content) ? m.content : [])
  .flatMap((p: any) => p.type === 'tool-result' && p.output.type === 'content' ? p.output.value : p.type === 'file' ? [p] : [])
  .filter((v: any) => v.type === 'file').map((v: any) => v.filename ?? 'user');

describe('collapseExcessImageParts keeps a conversation under a per-request picture cap', () => {
  it('is a no-op (null, same objects) at or under the cap', () => {
    const history = readTurns(['a.png', 'b.png']);
    expect(collapseExcessImageParts(history, 2)).toBeNull();
    expect(collapseExcessImageParts(history, 5)).toBeNull();
  });

  it('over the cap, replaces the OLDEST pictures with the over-count note down to 80% of it, keeping the newest', () => {
    const history = readTurns(['a.png', 'b.png', 'c.png', 'd.png']);
    const next = collapseExcessImageParts(history, 3)!;   // 4 > 3 → keep floor(3 × 0.8) = 2
    expect(filesIn(next)).toEqual(['c.png', 'd.png']);
    const oldest = (next[1] as any).content[0].output;
    expect(oldest).toEqual({ type: 'text', value: 'Read image\n' + imageNote({ kind: 'unavailable', label: 'a.png', reason: 'over-count' }) });
    // Pairing and length untouched; untouched messages keep their identity.
    expect(next).toHaveLength(history.length);
    expect(next[0]).toBe(history[0]);
    expect(next[7]).toBe(history[7]);
  });

  it('counts pictures attached to user messages too, but never a PDF', () => {
    const pdf = { type: 'file', mediaType: 'application/pdf', data: Buffer.from('%PDF') };
    const history = [
      { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'file', mediaType: 'image/png', data: pngHeader(10, 10) }, pdf] },
      ...readTurns(['b.png']),
    ] as any[];
    const next = collapseExcessImageParts(history, 1)!;   // 2 pictures > 1 → keep floor(0.8) = 0
    expect((next[0] as any).content).toEqual([
      { type: 'text', text: 'see' }, pdf,
      { type: 'text', text: imageNote({ kind: 'unavailable', label: 'image', reason: 'over-count' }) },
    ]);
    // The PDF stays a file part and is never counted or noted as a picture.
    expect(filesIn(next)).toEqual(['user']);
  });

  it('a batch drop leaves room: the next few new pictures change nothing (the cached prefix stays put)', () => {
    const names = Array.from({ length: 11 }, (_, i) => `p${i}.png`);
    const once = collapseExcessImageParts(readTurns(names), 10)!;     // 11 > 10 → keep 8
    expect(filesIn(once)).toHaveLength(8);
    const later = [...once, ...readTurns(['n1.png', 'n2.png']).map((m: any, i: number) => JSON.parse(JSON.stringify(m), (k, v) => v?.type === 'Buffer' ? Buffer.from(v.data) : v))];
    expect(collapseExcessImageParts(later, 10)).toBeNull();           // 10 pictures: at the cap, untouched
  });

  it('the note round-trips through parseImageNote (the checkpoint store recomputes it)', () => {
    const note = imageNote({ kind: 'unavailable', label: 'contact.png', reason: 'over-count' });
    expect(parseImageNote(note)).toEqual({ kind: 'unavailable', label: 'contact.png', reason: 'over-count' });
  });
});

describe('fitHistoryToImageLimits shrinks before it drops', () => {
  const wide = () => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'Read', output: { type: 'content', value: [
    { type: 'text', text: 'Read image' }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: pngHeader(2160, 1350) }, filename: 'w.png' }] } }] }) as any;
  const cap = { maxEdgePx: 2000, maxPatches: 16_384 };
  const shrinker = { shrinkBytes: async () => ({ bytes: pngHeader(1800, 1125), mediaType: 'image/png' }) };

  it('keeps the picture, smaller, when it can be shrunk', async () => {
    const next = (await fitHistoryToImageLimits([wide()], cap, shrinker))! as any[];
    expect(next[0].content[0].output.value[0]).toEqual({ type: 'text', text: 'Read image' });
    expect(next[0].content[0].output.value[1].filename).toBe('w.png');
  });
  it('falls back to the note when it cannot, or after Stop', async () => {
    const note = 'Read image\n' + imageNote({ kind: 'oversized', label: 'w.png', width: 2160, height: 1350 });
    expect(((await fitHistoryToImageLimits([wide()], cap, { shrinkBytes: async () => null }))! as any[])[0].content[0].output.value).toBe(note);
    const stopped = new AbortController(); stopped.abort();
    expect(((await fitHistoryToImageLimits([wide()], cap, shrinker, stopped.signal))! as any[])[0].content[0].output.value).toBe(note);
  });
});
