// startup-dialog-shape.mjs — describe the Claude Code dialog on a terminal
// screen in plain structural terms: its heading, its option labels, and HOW an
// option is picked (a printed digit, the ❯ cursor moved with arrows, or
// checkboxes toggled with Space).
//
// WHY a separate reader from the app's parser (src/renderer/parser/
// ink-select-parser.ts): this one describes what Claude Code SHOWS, so the
// drift check can say "the trust dialog's options lost their numbers" in words
// even when the app's parser has stopped recognising the dialog at all — which
// is exactly the failure it exists to catch. The app's own understanding is
// checked separately, by replaying the same captures through the real parser
// (tests/startup-dialogs.test.ts).
//
// Input is screen text as rows (a headless xterm's buffer, trailing spaces
// trimmed). Empty rows may or may not be present — the app's serializer drops
// them, a raw buffer keeps them — and both must read the same.

const FOOTER = /(enter to confirm|esc to (cancel|exit|reject)|space to select)/i;
const RULE = /^[─━═]{8,}$/;
const CURSOR = /^(\s*)([❯>])(\s+)(\S.*)$/;
const CHECKBOX = /^\[[ ✔✓x×]\]\s/;
const NUMBERED = /^(\d{1,2})[.:]\s+/;

/**
 * @param {string[]} rows
 * @returns {{present: false} | {present: true, kind: 'select'|'multi-select'|'unknown', heading: string,
 *   body: string[], options: {label: string, number: number|null}[], cursorIndex: number,
 *   selection: 'numbered-digits'|'cursor-arrows'|'checkbox-space'|'unknown', footer: string, extraRows: string[]}}
 */
export function readDialogShape(rows) {
  const lines = rows.map((r) => r.replace(/\s+$/, ''));
  // The footer is the dialog's own chrome ("Enter to confirm · Esc to cancel"),
  // drawn at the bottom — only look near the end, never at scrollback.
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
    if (FOOTER.test(lines[i]) && lines[i].trim().length < 100) { footerIdx = i; break; }
  }
  if (footerIdx < 0) return { present: false };
  const footer = lines[footerIdx].trim();

  let cursorIdx = -1;
  for (let i = footerIdx - 1; i >= Math.max(0, footerIdx - 30); i--) {
    if (CURSOR.test(lines[i])) { cursorIdx = i; break; }
  }
  const unknown = (heading = '') => ({
    present: true, kind: 'unknown', heading, body: [], options: [], cursorIndex: -1,
    selection: 'unknown', footer, extraRows: [],
  });
  if (cursorIdx < 0) return unknown();

  const m = CURSOR.exec(lines[cursorIdx]);
  const labelCol = m[1].length + m[2].length + m[3].length;
  const colOf = (l) => (/^(\s*)/.exec(l) ?? ['', ''])[1].length;

  // Options: rows whose text starts at exactly the cursor row's label column.
  let first = cursorIdx;
  for (let i = cursorIdx - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.trim() || colOf(l) !== labelCol || CURSOR.test(l)) break;
    first = i;
  }
  // The dialog's width = its top rule's length (Claude Code draws it edge to
  // edge). Needed to tell a wrapped label from the next option — see wrapsInto.
  let width = 0;
  for (let i = first - 1; i >= Math.max(0, first - 30); i--) {
    if (RULE.test(lines[i].trim())) { width = lines[i].trim().length; break; }
  }
  const optionRows = [];
  const extraRows = [];
  let ambiguousWrap = false;
  for (let i = first; i < footerIdx; i++) {
    const l = lines[i];
    if (!l.trim()) { if (optionRows.length) break; continue; }
    if (i === cursorIdx) { optionRows.push({ i, text: m[4] }); continue; }
    if (colOf(l) === labelCol) {
      // An unnumbered label that did not fit wraps onto the next row at the SAME
      // column (40 columns: "Use this and all future MCP servers" / "in this
      // project"), so the column alone cannot say "new option".
      const prev = optionRows[optionRows.length - 1];
      const wrap = prev && !NUMBERED.test(l.trim()) ? wrapsInto(lines[prev.last ?? prev.i], l, width) : 'no';
      if (wrap === 'ambiguous') ambiguousWrap = true;
      if (wrap === 'yes') { prev.text += ' ' + l.trim(); prev.last = i; continue; }
      optionRows.push({ i, text: l.trim() });
      continue;
    }
    // Deeper rows: a wrapped numbered label, or (multi-select) the "Enable selected" row.
    extraRows.push(l.trim());
  }
  const options = optionRows.map((r) => {
    const n = NUMBERED.exec(r.text);
    return { label: n ? r.text.slice(n[0].length) : r.text, number: n ? Number(n[1]) : null };
  });
  const cursorIndex = optionRows.findIndex((r) => r.i === cursorIdx);

  // Heading: the first line of the dialog's own box (after the nearest rule).
  let top = Math.max(0, first - 30);
  for (let i = first - 1; i >= Math.max(0, first - 30); i--) {
    if (RULE.test(lines[i].trim())) { top = i + 1; break; }
  }
  const bodyAll = lines.slice(top, first).map((l) => l.trim()).filter(Boolean);
  const heading = bodyAll[0] ?? '';
  const body = bodyAll.slice(1);

  const multi = options.length > 0 && options.every((o) => CHECKBOX.test(o.label));
  const numbered = options.length > 0 && options.every((o) => o.number !== null);
  return {
    present: true,
    kind: multi ? 'multi-select' : options.length >= 2 ? 'select' : 'unknown',
    heading,
    body,
    options,
    cursorIndex,
    selection: multi ? 'checkbox-space' : numbered ? 'numbered-digits' : options.length >= 2 ? 'cursor-arrows' : 'unknown',
    footer,
    extraRows,
    ambiguousWrap,
  };
}

/**
 * Is `row` the wrapped remainder of `prevRow`'s label? Claude Code (Ink)
 * word-wraps greedily: a word moves to the next row only when it does not fit.
 * So if the row's first word would have fit after `prevRow`, it cannot be a
 * wrap — it is a new option. 'ambiguous' covers the 2-column band where the
 * dialog's right padding is not known.
 */
export function wrapsInto(prevRow, row, width) {
  if (!width) return 'ambiguous';
  const word = row.trim().split(/\s+/)[0] ?? '';
  const need = prevRow.replace(/\s+$/, '').length + 1 + word.length;
  if (need > width) return 'yes';
  if (need <= width - 2) return 'no';
  return 'ambiguous';
}

/** Temp paths change every run; the drift check compares everything else. */
export function normalizeVolatile(text) {
  return String(text)
    .replace(/\/(?:tmp|var\/folders)\/[^\s]*/g, '<tmp-path>')
    .replace(/[A-Z]:\\[^\s]*\\Temp\\[^\s]*/gi, '<tmp-path>');
}

/** The comparable summary saved into every fixture as `dialogs[n]`. */
export function shapeSummary(shape) {
  if (!shape.present) return { present: false };
  return {
    present: true,
    kind: shape.kind,
    heading: normalizeVolatile(shape.heading),
    options: shape.options.map((o) => o.label),
    numbers: shape.options.map((o) => o.number),
    defaultCursor: shape.cursorIndex,
    selection: shape.selection,
    footer: shape.footer,
    body: shape.body.map(normalizeVolatile),
  };
}

/**
 * What changed between a saved dialog summary and a fresh one, in words.
 * `breaking` changes are the ones the app depends on (heading, options, how an
 * option is picked, the footer, where the cursor starts); body wording is
 * reported as a note — it can move a title anchor, which the parser replay
 * test (not this diff) is what proves.
 */
export function diffSummaries(name, saved, fresh) {
  const breaking = [];
  const notes = [];
  if (!saved.present && !fresh.present) return { breaking, notes };
  if (saved.present !== fresh.present) {
    breaking.push(`${name}: dialog ${saved.present ? 'no longer appears' : 'now appears where there was none'}`
      + (fresh.present ? ` ("${fresh.heading}")` : ''));
    return { breaking, notes };
  }
  if (saved.kind !== fresh.kind) breaking.push(`${name}: kind changed ${saved.kind} → ${fresh.kind}`);
  if (saved.heading !== fresh.heading) breaking.push(`${name}: heading changed "${saved.heading}" → "${fresh.heading}"`);
  if (JSON.stringify(saved.options) !== JSON.stringify(fresh.options)) {
    breaking.push(`${name}: options changed [${saved.options.join(' | ')}] → [${fresh.options.join(' | ')}]`);
  }
  if (saved.selection !== fresh.selection) {
    breaking.push(`${name}: how an option is picked changed: ${saved.selection} → ${fresh.selection}`);
  }
  if (saved.defaultCursor !== fresh.defaultCursor) {
    breaking.push(`${name}: the option highlighted at first changed: "${saved.options[saved.defaultCursor]}" → "${fresh.options[fresh.defaultCursor]}"`);
  }
  if (saved.footer !== fresh.footer) breaking.push(`${name}: footer changed "${saved.footer}" → "${fresh.footer}"`);
  if (JSON.stringify(saved.body) !== JSON.stringify(fresh.body)) {
    notes.push(`${name}: body wording changed\n      was: ${saved.body.join(' / ')}\n      now: ${fresh.body.join(' / ')}`);
  }
  return { breaking, notes };
}
