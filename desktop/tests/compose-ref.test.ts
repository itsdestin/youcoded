// compose-ref.ts's wire format (doc-comments build, T7): what an "Ask about
// this" chip / the "Ask Your Assistant" summary chip actually sends to the
// model. This used to be `${OPEN}${encodeURIComponent(JSON.stringify(ref))}${CLOSE}`
// — unreadable percent-encoded JSON in the model's own turn. These tests pin
// the replacement grammar: readable text, PTY-safe (no literal space in the
// syntax this file invents), and still round-trips through the SAME
// draft-token layer the composer uses (`makeDraftToken`/`expandDraftTokens`),
// not just the encode/decode functions in isolation.
import { describe, it, expect } from 'vitest';
import {
  splitComposeRefs,
  makeDraftToken,
  expandDraftTokens,
  genRefId,
  truncateQuote,
  type ComposeRef,
} from '../src/renderer/components/context-menu/compose-ref';
import { buildOutgoingMessage } from '../src/renderer/components/outgoing-message';
import { loadWorker, drain } from './helpers/pty-worker-harness';

/** Every round-trip test goes through the REAL send-time path a chip actually
 *  takes — `makeDraftToken` (what the composer holds while typing) then
 *  `expandDraftTokens` (what `InputBar.tsx` calls at send) — rather than a
 *  private encode function, so these tests also double as F11's "typed
 *  through as a draft token" pin for every case, not just one dedicated test. */
function marker(ref: ComposeRef): string {
  return expandDraftTokens(makeDraftToken(ref));
}

function decodeOne(text: string): ComposeRef {
  const segs = splitComposeRefs(text);
  const refs = segs.filter((s) => s.type === 'ref');
  expect(refs).toHaveLength(1);
  return (refs[0] as { type: 'ref'; ref: ComposeRef }).ref;
}

describe('doc quote reference (ephemeral "Ask about this", no comment)', () => {
  it('round-trips quote and path', () => {
    const ref: ComposeRef = {
      id: genRefId(), kind: 'doc', path: 'docs/notes.md', fileName: 'notes.md',
      quote: 'the quick brown fox', label: '“the quick brown fox”',
    };
    const wire = marker(ref);
    expect(wire).toBe('⦃"the quick brown fox"_docs/notes.md⦄');
    const decoded = decodeOne(wire);
    expect(decoded).toMatchObject({ kind: 'doc', path: 'docs/notes.md', fileName: 'notes.md', quote: 'the quick brown fox' });
  });

  it('round-trips a line-range anchor', () => {
    const ref: ComposeRef = {
      id: genRefId(), kind: 'doc', path: 'src/app.ts', fileName: 'app.ts',
      quote: 'const x = 1;', lineRange: [12, 18], label: 'lines 12-18 · app.ts',
    };
    const wire = marker(ref);
    expect(wire).toBe('⦃"const x = 1;"_src/app.ts_L12-18⦄');
    const decoded = decodeOne(wire);
    expect(decoded.lineRange).toEqual([12, 18]);
    expect(decoded.label).toBe('lines 12-18 · app.ts');
  });

  it('a single-line range reads as "line N", not "lines N-N"', () => {
    const ref: ComposeRef = {
      id: genRefId(), kind: 'doc', path: 'src/app.ts', fileName: 'app.ts',
      quote: 'x', lineRange: [5, 5], label: 'line 5 · app.ts',
    };
    const decoded = decodeOne(marker(ref));
    expect(decoded.label).toBe('line 5 · app.ts');
  });

  it('round-trips a spreadsheet cell with a sheet name', () => {
    const ref: ComposeRef = {
      id: genRefId(), kind: 'doc', path: 'budget.xlsx', fileName: 'budget.xlsx',
      cell: 'C4', sheet: 'Q3', quote: '42', label: 'Q3 · C4 · budget.xlsx',
    };
    const wire = marker(ref);
    expect(wire).toBe('⦃"42"_budget.xlsx_cell_C4_Q3⦄');
    const decoded = decodeOne(wire);
    expect(decoded).toMatchObject({ cell: 'C4', sheet: 'Q3', path: 'budget.xlsx' });
  });

  it('round-trips a spreadsheet cell with no sheet (single-sheet workbook)', () => {
    const ref: ComposeRef = {
      id: genRefId(), kind: 'doc', path: 'notes.xlsx', fileName: 'notes.xlsx',
      cell: 'B2', quote: 'x', label: 'B2 · notes.xlsx',
    };
    const wire = marker(ref);
    expect(wire).toBe('⦃"x"_notes.xlsx_cell_B2⦄');
    const decoded = decodeOne(wire);
    expect(decoded.cell).toBe('B2');
    expect(decoded.sheet).toBeUndefined();
  });
});

describe('an existing comment thread reference', () => {
  it('round-trips the comment id, quote and path', () => {
    const ref: ComposeRef = {
      id: genRefId(), kind: 'doc', commentId: 'c-1234-abcd', path: 'docs/plan.md', fileName: 'plan.md',
      quote: 'ship it', label: '“ship it” · plan.md',
    };
    const wire = marker(ref);
    expect(wire).toBe('⦃comment_c-1234-abcd_"ship it"_docs/plan.md⦄');
    const decoded = decodeOne(wire);
    expect(decoded).toMatchObject({ kind: 'doc', commentId: 'c-1234-abcd', path: 'docs/plan.md', quote: 'ship it' });
  });
});

describe('a chat message / code block reference (pathless — review 2, F2)', () => {
  it('round-trips quote and entryKey with no path', () => {
    const ref: ComposeRef = {
      id: genRefId(), kind: 'chat', entryKey: 'entry-42', quote: 'do the thing', label: '“do the thing”',
    };
    const wire = marker(ref);
    expect(wire).toBe('⦃chat_entry-42_"do the thing"⦄');
    const decoded = decodeOne(wire);
    expect(decoded).toMatchObject({ kind: 'chat', entryKey: 'entry-42', quote: 'do the thing' });
    expect(decoded.path).toBeUndefined();
  });

  // Before F2, only three path-requiring forms shipped — every live
  // chat-message/code-block "Ask about this" (a shipped, R15-covered
  // feature) would have silently broken without this fourth form.
  it('is the ONLY form with no path — regressing to the pre-F2 three forms would drop this entirely', () => {
    const ref: ComposeRef = { id: genRefId(), kind: 'chat', entryKey: 'e1', quote: 'q', label: 'q' };
    expect(marker(ref)).not.toContain('_undefined');
  });
});

describe('Ask Your Assistant\'s summary chip (commentIds set)', () => {
  it('encodes count and path as a pointer, never the ids or comment bodies', () => {
    const ref: ComposeRef = {
      id: genRefId(), kind: 'doc', commentId: 'c-1', commentIds: ['c-1', 'c-2', 'c-3'],
      path: 'docs/plan.md', fileName: 'plan.md', label: '3 comments · plan.md',
    };
    const wire = marker(ref);
    expect(wire).toBe('⦃3_open_comments_docs/plan.md_use_ReadFileComments_to_read_them⦄');
    const decoded = decodeOne(wire);
    expect(decoded).toMatchObject({ kind: 'doc', path: 'docs/plan.md', label: '3 comments · plan.md' });
    // Deliberate: the wire form is a POINTER (§6.2 — "the comments themselves
    // reach the assistant through its comment tools, not the chip"). A
    // decoded chip cannot recover WHICH comments they were, only the count —
    // hover-highlight-all/click-to-thread on this one chip kind is a known,
    // accepted trade-off of the frozen grammar once the message has been
    // sent, not a bug in this parser.
    expect(decoded.commentIds).toBeUndefined();
  });

  it('uses singular "comment" for exactly one', () => {
    const ref: ComposeRef = {
      id: genRefId(), kind: 'doc', commentId: 'c-1', commentIds: ['c-1'],
      path: 'notes.md', fileName: 'notes.md', label: '1 comment · notes.md',
    };
    const decoded = decodeOne(marker(ref));
    expect(decoded.label).toBe('1 comment · notes.md');
  });
});

describe('escaping (review 2, F7)', () => {
  it('escapes an embedded quote mark and recovers it exactly on decode', () => {
    const quote = 'He said "stop it" and left';
    const ref: ComposeRef = { id: genRefId(), kind: 'doc', path: 'docs/x.md', fileName: 'x.md', quote, label: `“${quote}”` };
    const wire = marker(ref);
    expect(wire).toBe('⦃"He said \\"stop it\\" and left"_docs/x.md⦄');
    const decoded = decodeOne(wire);
    expect(decoded.quote).toBe(quote);
    expect(decoded.path).toBe('docs/x.md');
  });

  it('an underscore inside a real path or quote is never mistaken for a structural separator', () => {
    const path = '2026_09_24_plan.md';
    const quote = 'the_next_step is ready';
    const ref: ComposeRef = { id: genRefId(), kind: 'doc', path, fileName: path, quote, label: `“${quote}”` };
    const decoded = decodeOne(marker(ref));
    expect(decoded.path).toBe(path);
    expect(decoded.quote).toBe(quote);
  });

  it('a quote spanning a newline round-trips through encode/decode itself (send-time PTY sanitization is a separate, later step — see the outgoing-message test below)', () => {
    const quote = 'first line\nsecond line';
    const ref: ComposeRef = { id: genRefId(), kind: 'doc', path: 'notes.md', fileName: 'notes.md', quote, label: `“${truncateQuote(quote)}”` };
    const decoded = decodeOne(marker(ref));
    expect(decoded.quote).toBe(quote);
  });

  it('a raw ⦃/⦄ inside quoted text never crashes the render — it degrades to plain text', () => {
    // compose-ref.ts's own header comment: the delimiters are chosen because
    // they don't appear in ordinary text, so this grammar (unlike the old
    // JSON+percent-encoding scheme) has no escape for them if one somehow
    // shows up. The policy is the same one the old JSON parser's `catch` had:
    // never throw over a mangled marker.
    const text = 'before ⦃"a⦄weird"_x.md⦄ after';
    expect(() => splitComposeRefs(text)).not.toThrow();
  });

  it('a payload matching none of the four forms degrades to plain text, not a crash', () => {
    const text = 'before ⦃not a real reference at all⦄ after';
    const segs = splitComposeRefs(text);
    expect(segs.map((s) => s.type)).toEqual(['text', 'text', 'text']);
    expect(segs.map((s) => (s as { value?: string }).value).join('')).toBe(text);
  });
});

describe('wire-safety: readable text, no JSON, no PTY-hostile whitespace (review 1, F11/F12)', () => {
  it('contains no percent-encoding or JSON braces', () => {
    const ref: ComposeRef = { id: genRefId(), kind: 'doc', path: 'a/b.md', fileName: 'b.md', quote: 'hello', label: '“hello”' };
    const wire = marker(ref);
    expect(wire).not.toMatch(/%[0-9A-Fa-f]{2}/);
    expect(wire).not.toContain('{');
    expect(wire).not.toContain('}');
  });

  it('never places a literal space in the structural syntax it invents', () => {
    // Quote/path here carry no spaces of their own, so ANY space in the wire
    // text would have to come from this grammar's own separators — which
    // must never happen (F12: a PTY chunk boundary can drop/shift a literal
    // space byte; underscore is inert single-byte ASCII).
    const ref: ComposeRef = {
      id: genRefId(), kind: 'doc', commentId: 'c-1', commentIds: ['c-1', 'c-2'],
      path: 'a/b.md', fileName: 'b.md', label: '2 comments · b.md',
    };
    expect(marker(ref)).not.toContain(' ');
  });
});

describe('the draft-token layer keeps working against the new wire format (review 1, F11)', () => {
  it('a typed draft token expands to the new grammar at send time, in place among ordinary prose', () => {
    const ref: ComposeRef = { id: genRefId(), kind: 'doc', path: 'docs/x.md', fileName: 'x.md', quote: 'ship it', label: '“ship it”' };
    const draftText = `please review ${makeDraftToken(ref)} today`;
    // The draft token is a short, mostly zero-width placeholder — nothing
    // like the eventual marker text is visible in the raw string yet.
    expect(draftText).not.toContain('⦃"ship it"');
    const expanded = expandDraftTokens(draftText);
    expect(expanded).toBe('please review ⦃"ship it"_docs/x.md⦄ today');
  });
});

describe('the sent bubble is confirmed by an exact content match (chat-reducer/outgoing-message.ts)', () => {
  it('a message containing a reference marker keeps content and ptyText identical', () => {
    // WHY this matters here: the optimistic bubble is confirmed against the
    // transcript by an EXACT string match (outgoing-message.ts). If the
    // marker's own text were altered by the newline/tab sanitization that
    // runs on the way to the PTY, content and ptyText would diverge and the
    // bubble would stay "pending" forever (docs/PITFALLS.md → PTY Writes).
    const ref: ComposeRef = { id: genRefId(), kind: 'doc', path: 'docs/x.md', fileName: 'x.md', quote: 'ship it', label: '“ship it”' };
    const expanded = expandDraftTokens(`please review ${makeDraftToken(ref)} today`);
    const outgoing = buildOutgoingMessage(expanded, [])!;
    expect(outgoing).not.toBeNull();
    expect(outgoing.content).toBe(outgoing.ptyText);
    expect(outgoing.content).toContain('⦃"ship it"_docs/x.md⦄');
  });

  it('a newline inside a quote survives full send-time sanitization as a space, and the result still parses', () => {
    const quote = 'first line\nsecond line';
    const ref: ComposeRef = { id: genRefId(), kind: 'doc', path: 'notes.md', fileName: 'notes.md', quote, label: `“${truncateQuote(quote)}”` };
    const expanded = expandDraftTokens(makeDraftToken(ref));
    const outgoing = buildOutgoingMessage(expanded, [])!;
    expect(outgoing.content).toBe(outgoing.ptyText);
    const decoded = decodeOne(outgoing.content);
    expect(decoded.quote).toBe('first line second line');
  });
});

describe('the marker reaches the PTY byte-identical through the real submit chunking (review 1, F12)', () => {
  it('survives pty-worker.js\'s echo-driven chunking with no bytes lost or reordered', async () => {
    const ref: ComposeRef = {
      id: genRefId(), kind: 'doc', path: 'docs/active/plans/2026-09-24-onboarding-redesign.md',
      fileName: '2026-09-24-onboarding-redesign.md',
      quote: "Today's first-run flow shows five screens before the composer is reachable",
      label: '“Today’s first-run flow…”',
    };
    const expanded = expandDraftTokens(`Can we get a screenshot of these five screens? ${makeDraftToken(ref)}`);
    const outgoing = buildOutgoingMessage(expanded, [])!;
    expect(Buffer.byteLength(outgoing.ptyText, 'utf8')).toBeGreaterThan(56); // must actually exercise chunking, not the atomic path

    const { deliver, writes } = loadWorker();
    deliver({ type: 'input', data: outgoing.ptyText + '\r' });
    await drain(400);

    // The `\r` is held for CC's echo, which never arrives against this fake
    // PTY (no onData) — same accepted shape as the existing over-56-byte case
    // in pty-worker-writes.test.ts. The BODY must still have arrived whole.
    expect(writes.join('')).toBe(outgoing.ptyText);
    for (const w of writes) expect(Buffer.byteLength(w, 'utf8')).toBeLessThanOrEqual(56);

    // And the reassembled bytes still parse back into the same reference —
    // proving no chunk boundary landed inside the marker in a way that
    // corrupted its structural `_` separators or its quote/path text.
    const decoded = decodeOne(writes.join(''));
    expect(decoded).toMatchObject({
      kind: 'doc',
      path: 'docs/active/plans/2026-09-24-onboarding-redesign.md',
      quote: "Today's first-run flow shows five screens before the composer is reachable",
    });
  });
});
