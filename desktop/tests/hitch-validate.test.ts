// The trust boundary of the hitch recorder: whatever a renderer sends is rebuilt field by field.
import { describe, it, expect } from 'vitest';
import { validateBatch, cleanString, MAX_ENTRIES_PER_BATCH } from '../src/main/hitch-validate';

const NOW = 1_800_000_000_000;
const frame = (over: Record<string, unknown> = {}) => ({
  k: 'frame', t: NOW - 5, d: 250, b: 200, sl: 30, rd: 10, inp: true,
  sc: [{ it: 'event-listener', iv: 'BUTTON#.onclick', fn: 'renderThing', src: 'index-abc.js', pos: 1234, d: 180, fl: 20 }],
  ctx: { vis: 'visible', foc: true, vm: 'chat', dlg: false, scr: false, dpr: 2, els: 4000 }, ...over,
});
const batch = (over: Record<string, unknown> = {}) => ({ v: 1, mode: 'loaf', kind: null, entries: [frame()], tally: { f: 3, fms: 210, over: 0 }, dropped: 0, ...over });

describe('validateBatch', () => {
  it('passes a well-formed batch through with every known field', () => {
    const b = validateBatch(batch(), NOW)!;
    expect(b.mode).toBe('loaf');
    expect(b.kind).toBe('main');
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0]).toMatchObject({ k: 'frame', d: 250, b: 200, inp: true });
    expect((b.entries[0] as any).sc[0]).toMatchObject({ fn: 'renderThing', src: 'index-abc.js', pos: 1234 });
    expect(b.tally).toEqual({ f: 3, fms: 210, over: 0, oms: 0 });
  });

  it.each([null, undefined, 5, 'x', [], { v: 2 }, { mode: 'loaf' }])('rejects a non-batch (%j)', (raw) => {
    expect(validateBatch(raw, NOW)).toBeNull();
  });

  it('caps the entries array and counts what it ignored', () => {
    const b = validateBatch(batch({ entries: Array.from({ length: 5000 }, () => frame()) }), NOW)!;
    expect(b.entries).toHaveLength(MAX_ENTRIES_PER_BATCH);
    expect(b.rejected).toBe(5000 - MAX_ENTRIES_PER_BATCH);
  });

  it('drops malformed entries instead of copying them', () => {
    const b = validateBatch(batch({ entries: [null, 7, { k: 'frame' }, { k: 'frame', d: 'NaN' }, { k: 'weird', d: 5 }, { k: 'frame', d: -1 }, { k: 'event', d: 500, type: 'mouseover' }, frame()] }), NOW)!;
    expect(b.entries).toHaveLength(1);
    expect(b.rejected).toBe(7);
  });

  it('rejects numbers out of range, NaN and Infinity', () => {
    const b = validateBatch(batch({ entries: [frame({ d: Infinity }), frame({ d: 1e12 }), frame({ d: NaN }), frame({ d: 120 })] }), NOW)!;
    expect(b.entries.map((e) => e.d)).toEqual([120]);
  });

  it('cuts strings to 120 printable-ASCII characters and strips control/non-ASCII text', () => {
    const evil = 'secret message\n\u0000‮' + 'x'.repeat(500) + ' é中';
    const b = validateBatch(batch({ entries: [frame({ sc: [{ it: evil, iv: evil, fn: evil, src: evil, pos: 1, d: 5, fl: 0 }] })] }), NOW)!;
    const s = (b.entries[0] as any).sc[0];
    for (const f of ['iv', 'fn']) { expect(s[f].length).toBeLessThanOrEqual(120); expect(s[f]).toMatch(/^[\x20-\x7e]*$/); }
    expect(s.src.length).toBeLessThanOrEqual(80);
    expect(s.it.length).toBeLessThanOrEqual(40);
  });

  it('keeps at most 3 scripts and drops unknown keys everywhere', () => {
    const scripts = Array.from({ length: 9 }, (_, i) => ({ it: 'a', iv: 'b', fn: 'f' + i, src: 's.js', pos: i, d: 10, fl: 0, extra: 'LEAK' }));
    const b = validateBatch({ ...batch({ entries: [frame({ sc: scripts, text: 'LEAK', value: 'LEAK' })] }), secret: 'LEAK' }, NOW)!;
    expect((b.entries[0] as any).sc).toHaveLength(3);
    expect(JSON.stringify(b)).not.toContain('LEAK');
  });

  it('only accepts interaction event types and a known coarse target kind', () => {
    const ev = (over: Record<string, unknown>) => ({ k: 'event', t: NOW, type: 'keydown', d: 200, delay: 10, proc: 150, pres: 40, tgt: 'terminal', ...over });
    const b = validateBatch(batch({ entries: [ev({}), ev({ type: 'keyup' }), ev({ tgt: 'my secret textarea text' }), ev({ key: 'a', text: 'hello' })] }), NOW)!;
    expect(b.entries).toHaveLength(3);
    expect((b.entries[0] as any).tgt).toBe('terminal');
    expect((b.entries[1] as any).tgt).toBe('other');
    expect(JSON.stringify(b)).not.toContain('hello');
  });

  it('replaces a lying timestamp with the receive time', () => {
    const b = validateBatch(batch({ entries: [frame({ t: 1 }), frame({ t: NOW + 3_600_000 }), frame({ t: NOW - 1000 })] }), NOW)!;
    expect(b.entries.map((e) => e.t)).toEqual([NOW, NOW, NOW - 1000]);
  });

  it('validates context fields strictly', () => {
    const b = validateBatch(batch({ entries: [frame({ ctx: { vis: 'hax', foc: 'yes', vm: 'Not Allowed!', dlg: 1, dpr: 99999, els: -4, evil: 1 } })] }), NOW)!;
    expect((b.entries[0] as any).ctx).toEqual({});
  });

  it('accepts startup marks only as yc:* names with numeric times', () => {
    const marks: Record<string, unknown> = { 'yc:app-mounted': 1500.4, 'evil': 5, 'yc:bad name': 3, 'yc:x': 'a' };
    for (let i = 0; i < 100; i++) marks['yc:m' + i] = i;
    const b = validateBatch(batch({ entries: [], startup: { marks, fcp: 321 } }), NOW)!;
    expect(b.startup!.fcp).toBe(321);
    expect(b.startup!.marks['yc:app-mounted']).toBe(1500);
    expect(Object.keys(b.startup!.marks).length).toBe(40);
    expect(Object.keys(b.startup!.marks)).not.toContain('evil');
  });

  it('knows the three buddy window kinds and nothing else', () => {
    expect(validateBatch(batch({ kind: 'buddy-chat' }), NOW)!.kind).toBe('buddy-chat');
    expect(validateBatch(batch({ kind: '../../etc' }), NOW)!.kind).toBe('main');
  });
});

describe('cleanString', () => {
  it('handles non-strings', () => { expect(cleanString(5)).toBe(''); expect(cleanString(undefined)).toBe(''); });
});
