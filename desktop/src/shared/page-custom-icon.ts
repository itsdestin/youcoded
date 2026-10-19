/** A page-authored outline, never SVG markup or presentation attributes. */
export interface PageCustomIcon { version: 1; paths: string[] }

const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const SPACE = /[\t\n\r ]/;

function validPath(path: string): boolean {
  let pos = 0;
  const whitespace = () => { while (pos < path.length && SPACE.test(path[pos])) pos++; };
  whitespace();
  if (path[pos] !== 'M' && path[pos] !== 'm') return false;
  let command = '';
  let firstArgument = true;
  while (pos < path.length) {
    whitespace();
    if (pos === path.length) return true;
    const next = path[pos].toUpperCase();
    if (Object.hasOwn(ARITY, next)) {
      command = next;
      pos++;
      firstArgument = true;
      if (command === 'Z') { command = ''; continue; }
    } else if (!command) return false;

    // WHY: tokenize by argument position, not a loose character allowlist. Arc
    // flags are single digits (including compact "01"), and every command must
    // supply complete groups; otherwise browsers silently draw a partial icon.
    for (let arg = 0; arg < ARITY[command]; arg++) {
      whitespace();
      if (!firstArgument && path[pos] === ',') { pos++; whitespace(); }
      const flag = command === 'A' && (arg === 3 || arg === 4);
      let token: string;
      if (flag) {
        token = path[pos];
        if (token !== '0' && token !== '1') return false;
      } else {
        NUMBER.lastIndex = pos;
        const match = NUMBER.exec(path);
        if (!match) return false;
        token = match[0];
      }
      const number = Number(token);
      if (!Number.isFinite(number) || Math.abs(number) > 1024) return false;
      if (command === 'A' && arg < 2 && number < 0) return false;
      pos += token.length;
      firstArgument = false;
    }
  }
  return true;
}

/** Invalid or future metadata must not prevent a page from opening. */
export function parsePageCustomIcon(value: unknown): PageCustomIcon | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const { version, paths } = value as Record<string, unknown>;
    if (version !== 1 || !Array.isArray(paths)) return undefined;
    const count = paths.length;
    if (!Number.isInteger(count) || count < 1 || count > 12) return undefined;
    // WHY: bound all input before grammar scanning, including whitespace-heavy
    // paths, so untrusted page metadata cannot cause unbounded renderer work.
    let total = 0;
    const normalized: string[] = [];
    for (let index = 0; index < count; index++) {
      const path: unknown = paths[index];
      if (typeof path !== 'string' || path.length > 2048) return undefined;
      total += path.length;
      if (total > 8192) return undefined;
      normalized.push(path);
    }
    if (!normalized.every(validPath)) return undefined;
    return { version: 1, paths: normalized };
  } catch {
    return undefined;
  }
}
