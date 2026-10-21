import { diffLines } from 'diff';

export type DiffRow =
  | { kind: 'ctx'; oldN: number; newN: number; text: string }
  | { kind: 'del'; oldN: number; text: string }
  | { kind: 'add'; newN: number; text: string };

/** Only bounded work may run in render. Check UTF-16 text length AND lines:
 * a giant single line and many short unrelated lines are different slow cases. */
export function canDiffInline(oldStr: string, newStr: string): boolean {
  if (oldStr.length + newStr.length > 32_768) return false;
  let lines = 0;
  for (const text of [oldStr, newStr]) {
    // EOF after a newline adds no token to jsdiff; an unterminated last line does.
    if (text.length > 0 && !text.endsWith('\n') && ++lines > 200) return false;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && ++lines > 200) return false;
  }
  return true;
}

/** Shared by the small render fast path and the worker: identical exact rows. */
export function diffRowsFromStrings(oldStr: string, newStr: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldN = 1;
  let newN = 1;
  // WHY normalize EOF: the previous viewer treats a missing final newline as
  // noise, rather than marking an otherwise identical last line as changed.
  const oldNorm = oldStr.length > 0 && !oldStr.endsWith('\n') ? oldStr + '\n' : oldStr;
  const newNorm = newStr.length > 0 && !newStr.endsWith('\n') ? newStr + '\n' : newStr;
  for (const change of diffLines(oldNorm, newNorm)) {
    const lines = change.value.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const text of lines) {
      if (change.added) rows.push({ kind: 'add', newN: newN++, text });
      else if (change.removed) rows.push({ kind: 'del', oldN: oldN++, text });
      else rows.push({ kind: 'ctx', oldN: oldN++, newN: newN++, text });
    }
  }
  return rows;
}
