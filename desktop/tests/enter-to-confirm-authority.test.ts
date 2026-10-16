// desktop/tests/enter-to-confirm-authority.test.ts
//
// Enter confirms a popup through ONE path: `<Dialog onEnter>` (hooks/use-enter-to-confirm.ts).
// A window/document `keydown` listener that reacts to Enter anywhere else is refused unless
// listed below with its reason.
//
// WHY (close-session-friction proposal 2, approved 2026-10-12): the close prompt's hand-made
// window listener closed the session from a focused tag, fired twice from its own button,
// skipped "Don't show again" and answered under a stacked popup — four bugs a shared rule now
// prevents. WHY a source scan and not an ast-grep rule: the listener is usually a named
// function defined lines away from the addEventListener call; finding its body needs the
// name resolved, which a pattern rule cannot do.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../src/renderer');

/** Files allowed their own window-level Enter, and why. A ratchet: an entry that no longer
 *  matches must be removed. */
const ALLOWED: Record<string, string> = {
  'components/ToolCard.tsx': 'chat cards (permission, question): Enter presses the card\'s highlighted button; outside the guide ("Not covered yet") and gated to the chat on screen (card-keys-context)',
  'components/PromptCard.tsx': 'Claude Code prompt cards: same roving-button rule as ToolCard',
  'components/InputBar.tsx': 'the message box: Enter sends a message, not a popup confirm',
};

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'dev' ? [] : files(p);
    return /\.(ts|tsx)$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [p] : [];
  });
}

/** The text from the first `{` at or after `from` to its matching `}`. */
function block(src: string, from: number): string {
  const start = src.indexOf('{', from);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** Bodies of every window/document keydown listener in a file. */
function keydownBodies(src: string): string[] {
  const out: string[] = [];
  const re = /\b(?:window|document)\.addEventListener\(\s*['"]keydown['"]\s*,\s*([A-Za-z_$][\w$]*|\()/g;
  for (let m: RegExpExecArray | null; (m = re.exec(src)); ) {
    if (m[1] === '(') { out.push(block(src, m.index + m[0].length)); continue; }
    const def = new RegExp(`(?:const|let|function)\\s+${m[1]}\\b`).exec(src);
    if (def) out.push(block(src, def.index));
  }
  return out;
}

const hits = files(ROOT)
  .filter((f) => keydownBodies(fs.readFileSync(f, 'utf8')).some((b) => /['"]Enter['"]/.test(b)))
  .map((f) => path.relative(ROOT, f).split(path.sep).join('/'));

describe('Enter to confirm has one owner', () => {
  it('no window or document keydown listener handles Enter outside the allowed files', () => {
    const extra = hits.filter((f) => !(f in ALLOWED));
    expect(extra, `These files handle Enter in a window/document keydown listener:\n  ${extra.join('\n  ')}\n\n`
      + 'A popup\'s Enter goes through <Dialog onEnter={…}> (hooks/use-enter-to-confirm.ts): it ignores a '
      + 'focused control, typing and a popup stacked on top. If this is not a popup confirm, add the file to '
      + 'ALLOWED with the reason.').toEqual([]);
  });

  it('the allowed list only shrinks: every entry still matches', () => {
    expect(Object.keys(ALLOWED).filter((f) => !hits.includes(f))).toEqual([]);
  });
});
