// The trust boundary of the hitch recorder: whatever a renderer sends is rebuilt field by field.
import { describe, it, expect } from 'vitest';
import { validateBatch, appName, MAX_ENTRIES_PER_BATCH } from '../src/main/hitch-validate';

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

  it('keeps no free text from any string slot (control, non-ASCII and over-long input all become the safe default)', () => {
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

describe('appName', () => {
  it('passes app constants, masks ids, and replaces everything else with ?', () => {
    expect(appName('session:create')).toBe('session:create');
    expect(appName('out:12345678-aaaa-bbbb-cccc-1234567890ab')).toBe('out:*');
    for (const bad of ['/home/u/x', 'two words', 'a\nb', '', 5, undefined, 'x'.repeat(200)]) expect(appName(bad)).toBe('?');
  });
});

describe('fuzz: nothing free-form reaches the written line', () => {
  const TEXT = ['MY SECRET DRAFT', '/home/u/Clients/Acme/report.js', 'https://host/x?token=abc', 'C:\\Users\\me\\f.js', '\u4e2d\u6587\u00e9', 'line1\nline2', '\u0000\u202e', 'file:///etc/passwd', 'user@example.com'];
  const junk = (): any[] => [...TEXT, ...TEXT.map((t) => t.repeat(30)), 5, null, {}, [], true];
  it('a batch with free text in EVERY string slot writes none of it', () => {
    const entries: any[] = [];
    for (const t of junk()) {
      entries.push(
        { k: 'frame', t: NOW, d: 200, b: 1, sl: 1, rd: 1, inp: t, sc: [{ it: t, iv: t, fn: t, src: t, pos: 1, d: 5, fl: 0 }, { it: 'event-listener', iv: t, fn: t, src: 'index-1.js', pos: 1, d: 5, fl: 0 }], ctx: { vis: t, foc: t, vm: t, dlg: t, scr: t, dpr: t, els: t }, extra: t },
        { k: 'event', t: NOW, type: t, d: 200, delay: 1, proc: 1, pres: 1, tgt: t, ctx: {} },
        { k: t, t: NOW, d: 200 },
      );
    }
    const marks: Record<string, unknown> = {};
    for (const [i, t] of junk().entries()) marks[typeof t === 'string' ? t : 'k' + i] = t;
    const out = JSON.stringify(validateBatch({ v: 1, mode: TEXT[0], kind: TEXT[1], entries, tally: { f: TEXT[2] }, dropped: TEXT[3], startup: { marks, fcp: TEXT[4] } }, NOW));
    for (const t of TEXT) {
      expect(out, t).not.toContain(t.slice(0, 10).replace(/\\/g, '\\\\'));
    }
    expect(out).not.toMatch(/secret|Acme|token|passwd|example\.com|\\u202e|\\\\n|[\u4e2d\u00e9]/i);
  });
  it('legitimate shapes survive', () => {
    const b = validateBatch(batch({ entries: [frame({ sc: [{ it: 'event-listener', iv: 'BUTTON.onclick', fn: 'renderThing', src: 'index-abc.js', pos: 5, d: 9, fl: 0 }] })] }), NOW)!;
    expect((b.entries[0] as any).sc[0]).toMatchObject({ it: 'event-listener', iv: 'BUTTON.onclick', fn: 'renderThing', src: 'index-abc.js' });
  });
});

// WHY (integration re-check 2026-10-05): the invoker used to be accepted on main when it merely used a safe character set, so a
// charset-clean string (a token, a draft pasted as one word, an id with dashes) would have been written. The reduction the
// preload does (TAG.onevent / "url" / "other" / a short dotted API name) is now enforced on main too.
describe('invoker (iv) is a shape, not just a character set', () => {
  const iv = (v: unknown, it = 'event-listener') => (validateBatch(batch({ entries: [frame({ sc: [{ it, iv: v, fn: '', src: 'index-a.js', pos: 1, d: 9, fl: 0 }] })] }), NOW)!.entries[0] as any).sc[0].iv;
  it.each(['BUTTON.onclick', 'H1.onkeydown', 'my-element.onclick', 'Window.requestAnimationFrame', 'TimerHandler:setTimeout', 'url', 'other', 'FrameRequestCallback'])('keeps the legitimate shape %s', (v) => {
    expect(iv(v)).toBe(v);
  });
  it.each(['my-secret-draft-about-acme', 'sk-ant-api03-AbC123xyz', 'a.b.c.d.e', 'b8e1c2d4-1111-2222-3333-444455556666', 'BUTTON.my-secret-class.onclick', 'user_name_alice', 'Window.hunter2'])('turns the charset-clean free string %s into "other"', (v) => {
    expect(iv(v)).toBe('other');
  });
  it('a script start never carries an invoker, whatever it sends', () => {
    expect(iv('https://x/y.js', 'classic-script')).toBe('');
    expect(iv('anything-at-all', 'module-script')).toBe('');
  });
});

describe('script source names', () => {
  it('a function name is dropped whenever the source is "other", and a non-.js source becomes "other"', () => {
    const one = (src: unknown, fn: unknown) => (validateBatch(batch({ entries: [frame({ sc: [{ it: 'event-listener', iv: 'url', fn, src, pos: 1, d: 9, fl: 0 }] })] }), NOW)!.entries[0] as any).sc[0];
    expect(one('other', 'secretFn')).toMatchObject({ src: 'other', fn: '' });
    expect(one('notes-about-acme.txt', 'secretFn')).toMatchObject({ src: 'other', fn: '' });
    expect(one('index-abc.js', 'has space')).toMatchObject({ src: 'index-abc.js', fn: '' });
  });
});

// ── Switch marks (2026-10-05): the `sw` array of a batch ─────────────────────────────────────────────────────────────
const sw = (over: Record<string, unknown> = {}) => ({
  t: NOW - 5, cause: 'pill', vm: 'chat', dk: 'claude', str: false, cold: true, open: 6, ff: 40, st: 190, end: 'settled',
  e1: 120, e2: 140, mut: 33, ls: 1, lsv: 0.0123456, loaf: 2, loafMs: 180, ind: 130, gap: 2500, drain: null, ...over,
});
const swBatch = (list: unknown[], over: Record<string, unknown> = {}) => ({ v: 1, mode: 'loaf', kind: null, entries: [], sw: list, swOver: 3, tally: {}, dropped: 0, ...over });

describe('switch lines (batch.sw)', () => {
  it('passes a well-formed switch through, rounding the shift sum', () => {
    const b = validateBatch(swBatch([sw()]), NOW)!;
    expect(b.sw).toHaveLength(1);
    expect(b.sw[0]).toMatchObject({ cause: 'pill', vm: 'chat', dk: 'claude', str: false, cold: true, open: 6, ff: 40, st: 190, end: 'settled', e1: 120, e2: 140, mut: 33, ls: 1, lsv: 0.012, loaf: 2, loafMs: 180, ind: 130, gap: 2500, drain: null });
    expect(b.swOver).toBe(3);
  });

  it('a batch with no sw array has none (older windows keep working)', () => {
    const b = validateBatch({ v: 1, mode: 'loaf', kind: null, entries: [], tally: {}, dropped: 0 }, NOW)!;
    expect(b.sw).toEqual([]);
    expect(b.swOver).toBe(0);
  });

  it('rejects a line whose view, kind or ending is not one of the fixed values; an unknown cause is honestly "other"', () => {
    const b = validateBatch(swBatch([sw({ vm: 'x' }), sw({ dk: 'cloud' }), sw({ end: 'weird' }), sw({ cause: 'bribe' }), null, 5, 'x']), NOW)!;
    expect(b.sw).toHaveLength(1);
    expect(b.sw[0].cause).toBe('other');
    expect(b.rejected).toBe(6);
  });

  it('keeps a missing measurement null (never 0) and settled only when the switch really settled', () => {
    const [a, c] = validateBatch(swBatch([sw({ ff: null, st: null, e1: null, ind: null, gap: null, end: 'interrupted' }), sw({ end: 'cap', st: 99 })]), NOW)!.sw;
    expect([a.ff, a.st, a.e1, a.ind, a.gap]).toEqual([null, null, null, null, null]);
    expect(c.st).toBeNull();
  });

  it('settled can never precede the first frame', () => {
    expect(validateBatch(swBatch([sw({ ff: 80, st: 20 })]), NOW)!.sw[0].st).toBe(80);
  });

  it('range-checks every number and replaces a lying timestamp', () => {
    const [l] = validateBatch(swBatch([sw({ t: 5, ff: -1, st: Infinity, e1: NaN, mut: 1e12, ls: -4, loaf: 'x', gap: 1e12, open: 1e9, lsv: 5000 })]), NOW)!.sw;
    expect(l.t).toBe(NOW);
    expect([l.ff, l.st, l.e1, l.gap]).toEqual([null, null, null, null]);
    expect([l.mut, l.ls, l.loaf, l.open, l.lsv]).toEqual([0, 0, 0, 0, 0]);
  });

  it('caps the array and counts what it ignored', () => {
    const b = validateBatch(swBatch(Array.from({ length: 400 }, () => sw())), NOW)!;
    expect(b.sw).toHaveLength(100);
    expect(b.rejected).toBe(300);
  });

  it('fuzz: free text in EVERY slot of a switch reaches the line nowhere (the line has no string slot except fixed enums)', () => {
    const TEXT = ['MY SECRET DRAFT', '/home/u/Clients/Acme/report.js', 'https://host/x?token=abc', 'C:\\Users\\me\\f.js', '\u4e2d\u6587\u00e9', 'line1\nline2', 'user@example.com', 'sess-1234-abcd', 'My Project Name'];
    const out: any[] = [];
    for (const t of [...TEXT, ...TEXT.map((x) => x.repeat(30)), 5, null, {}, [], true]) {
      out.push(sw({ cause: t, vm: t, dk: t, end: t, str: t, cold: t, id: t, name: t, path: t, sid: t, sessionId: t, label: t, why: t, open: t, ff: t, st: t, e1: t, e2: t, mut: t, ls: t, lsv: t, loaf: t, loafMs: t, ind: t, gap: t, drain: t }));
      // the same text in every slot, but with valid enums, so the line IS accepted and every free slot is exercised
      out.push(sw({ id: t, name: t, path: t, sid: t, sessionId: t, label: t, why: t, text: t, title: t, extra: { deep: t } }));
    }
    const text = JSON.stringify(validateBatch(swBatch(out), NOW));
    expect(text).not.toMatch(/SECRET|Acme|token|host|passwd|example\.com|sess-1234|Project Name|Users|[\u4e2d\u00e9]|line1/);
    // And the accepted lines carry exactly the known keys.
    for (const l of validateBatch(swBatch(out), NOW)!.sw) {
      expect(Object.keys(l).sort()).toEqual(['cause', 'cold', 'dk', 'drain', 'e1', 'e2', 'end', 'ff', 'gap', 'ind', 'loaf', 'loafMs', 'ls', 'lsv', 'mut', 'open', 'st', 'str', 't', 'vm']);
      for (const v of Object.values(l)) if (typeof v === 'string') expect(v).toMatch(/^(pill|menu|key|drawer|auto|other|chat|terminal|claude|native|shell|settled|streaming|cap|interrupted|hidden|closed)$/);
    }
  });
});
