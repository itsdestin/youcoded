// Joined-up shell commands (`cd app && npm test`) split into their parts, so "Always allow"
// can remember each part on its own and the engine can check each part on its own.
//
// WHY this is its own module in shared/: three readers must agree on what "a part" is — the
// engine (permission-engine / native-session-host decide each part), the grant derivation
// (bash-grant-shapes decides what to REMEMBER per part) and the card (lists the parts). One
// splitter, so what the card promised and what the engine honours cannot drift apart.
//
// WHAT it is: an ALLOWLIST splitter. It splits only text it fully understands — plain words,
// quoted runs, and the operators && || ; | — and returns null for ANYTHING else (variables,
// substitutions, redirects other than the three harmless ones, backslashes, comments,
// background `&`, new lines, subshell/brace groups). null means "treat the line as one opaque
// command", which is today's behaviour: only a word-for-word grant can cover it.
// Modelled on how Claude Code (each part must be allowed) and Codex (a line with
// substitutions or redirects is judged whole, never split) treat the same problem.

/** Most parts a chain may have before it is judged whole (a long chain is not an everyday command). */
const MAX_CHAIN_PARTS = 8;

// Harmless redirects removed from a part before it is judged: throw output away, or merge errors
// into the output. The same two shapes the built-in read-only list accepts.
const HARMLESS_REDIRECT = /^(?:2>&1|1>\/dev\/null|2>\/dev\/null|>\/dev\/null)(?=[\s;|&]|$)/;

/** Split a command line into its parts, or null when it is not a plain chain of at least two parts. */
export function splitChain(command: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let i = 0;
  const n = command.length;
  const push = (): boolean => {
    const text = current.replace(/\s+/g, ' ').trim();
    if (text === '') return false; // empty command around an operator: `; ls`, `ls &&`
    parts.push(text);
    current = '';
    return true;
  };
  while (i < n) {
    const c = command[i];
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return null;
      const body = command.slice(i, close + 1);
      if (/[\n\r]/.test(body)) return null;
      current += body; i = close + 1; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        // Inside double quotes the shell still expands $ ` and \ — text we cannot judge by eye.
        if (command[j] === '$' || command[j] === '`' || command[j] === '\\' || command[j] === '\n' || command[j] === '\r') return null;
        j++;
      }
      if (j >= n) return null;
      current += command.slice(i, j + 1); i = j + 1; continue;
    }
    // Operators.
    if (c === ';') { if (command[i + 1] === ';') return null; if (!push()) return null; i++; continue; }
    if (c === '|') {
      if (command[i + 1] === '&') return null; // `|&` also pipes errors: not one of ours
      if (!push()) return null;
      i += command[i + 1] === '|' ? 2 : 1;
      continue;
    }
    if (c === '&' && command[i + 1] === '&') { if (!push()) return null; i += 2; continue; }
    // Redirects: only the three harmless shapes, only after a space (so `a>b` is never one).
    if ((c === '2' || c === '1' || c === '>') && (i === 0 || command[i - 1] === ' ')) {
      const m = HARMLESS_REDIRECT.exec(command.slice(i));
      if (m) { i += m[0].length; continue; }
    }
    // Anything else the shell treats specially: refuse the whole line.
    if (c === '&' || c === '>' || c === '<' || c === '`' || c === '$' || c === '(' || c === ')'
      || c === '{' || c === '}' || c === '\\' || c === '\n' || c === '\r' || c === '\t') return null;
    // A `#` that starts a word begins a comment: everything after it would hide from us.
    if (c === '#' && (i === 0 || command[i - 1] === ' ')) return null;
    // Control characters / invisible formatting have no place in a command we are judging.
    const code = c.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff) return null;
    current += c; i++;
  }
  if (!push()) return null;
  if (parts.length < 2 || parts.length > MAX_CHAIN_PARTS) return null;
  return parts;
}

/** A `cd` that only steps down into a named folder below the current one: `cd app`, `cd src/ui`. Returns the folder
 *  ('' for a bare `cd`'s absence is not accepted), or null if this part is not such a step.
 *
 *  WHY so narrow: `cd /etc`, `cd ~`, `cd ..` and `cd -` leave the project, and the grants on the other parts were made
 *  for the project. Those parts are NOT waved through — they need their own word-for-word grant like any command. */
export function plainCdTarget(part: string): string | null {
  const m = /^cd ([A-Za-z0-9_][A-Za-z0-9_.@%+=,:-]*(?:\/[A-Za-z0-9_.@%+=,:-]+)*)\/?$/.exec(part);
  if (!m) return null;
  if (m[1].split('/').some((seg) => seg === '..' || seg === '.')) return null;
  return m[1];
}
