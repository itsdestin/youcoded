import { describe, it, expect } from 'vitest';
import { serializedValues } from '../src/main/providers/chatgpt-request-diagnostics';

// WHY: the scanner was rewritten for speed (native string jumps, char-code whitespace).
// It must report exactly what the original character-by-character walk reported, so the
// original is kept here verbatim as the reference.
interface Scan { entries: Array<[string, string]>; complete: boolean }
function oldSerializedValues(text: string, array = false): Scan {
  const entries: Array<[string, string]> = [];
  let i = 1;
  const space = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const endValue = () => {
    let depth = 0;
    let quoted = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false; continue; }
      if (c === '"') quoted = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) break;
    }
  };
  while (i < text.length - 1) {
    space();
    if (text[i] === ']' || text[i] === '}') break;
    let key = String(entries.length);
    if (!array) {
      const start = i++;
      while (i < text.length) { if (text[i] === '\\') i += 2; else if (text[i++] === '"') break; }
      key = JSON.parse(text.slice(start, i));
      space(); i++; space();
    }
    const start = i;
    endValue();
    entries.push([key, text.slice(start, i).trimEnd()]);
    if (text[i] === ',') i++;
    else break;
  }
  space();
  // WHY: this scanner is the ONLY parser of the outgoing body, so it has to say when it
  // stopped early. A short walk yields a SHORT fingerprint, and two short fingerprints
  // of different requests compare equal — the caller must drop such an observation
  // rather than report it as a comparison.
  return { entries, complete: text[0] === (array ? '[' : '{') && i === text.length - 1 && text[i] === (array ? ']' : '}') };
}

describe('serializedValues fast scan', () => {
  const bodies = [
    '{"model":"m","input":[{"a":1},{"b":"x\\"y,]}"}],"n": 1.50 , "s":"é\\\\"}',
    '[ {"x" : [1,2,{"y":"\\u00e9"}] } ,\n\t "str,with]brackets" , 3 ]',
    '{"input":[{"type":"input_image","image_url":"data:image/png;base64,' + 'QUJD'.repeat(5000) + '"},{"t":"a b"}],"z":null}',
    '{"unterminated":"abc', '{"k":"v\\', '[1,2', '{ "a" :\u00a01 }', '{}', '[]',
  ];
  it.each(bodies.map((b, i) => [i, b] as const))('matches the original walk on body %i', (_i, b) => {
    // A body scanned in the wrong mode throws in the original; the fast walk must throw too.
    const run = (f: (t: string, a?: boolean) => Scan, a: boolean) => { try { return f(b, a); } catch (e) { return 'threw'; } };
    expect(run(serializedValues, false)).toEqual(run(oldSerializedValues, false));
    expect(run(serializedValues, true)).toEqual(run(oldSerializedValues, true));
  });
  it('matches on a real-shaped request, container and input array', () => {
    const input = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: [{ type: 'input_text', text: `m${i} "q" \\ `.repeat(3) }, { type: 'input_image', image_url: 'data:image/png;base64,' + Buffer.alloc(3000, i).toString('base64') }] })), null, 1);
    const top = `{"model":"gpt","input":${input},"stream":true}`;
    expect(serializedValues(top)).toEqual(oldSerializedValues(top));
    expect(serializedValues(input, true)).toEqual(oldSerializedValues(input, true));
  });
});
