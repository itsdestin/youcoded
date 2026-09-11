// Reading and writing a dot-path field of a plain JSON object, safely.
//
// WHY (2026-09-10 security review): the `settings:set` handlers — one in
// ipc-handlers.ts, one in remote-server.ts (reachable by a paired remote device)
// — walked a client-supplied dot-path and assigned into it. A field of
// `__proto__.polluted` therefore wrote onto Object.prototype, changing every
// object in the main process. The two handlers had copied the same walk, so the
// fix lives in one place both call.
//
// A segment that is empty, `__proto__`, `constructor` or `prototype` is refused;
// every step must land on a plain own object, never an inherited one.

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

function splitPath(field: string): string[] {
  const keys = field.split('.');
  if (keys.length === 0) throw new Error('empty field path');
  for (const k of keys) {
    if (k === '' || FORBIDDEN.has(k)) throw new Error(`unsafe field segment: ${JSON.stringify(k)}`);
  }
  return keys;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read `field` (a dot-path) out of `root`, or undefined if any step is missing.
 *  Refuses the same segments as the setter, so a read of `__proto__` cannot leak
 *  the prototype object. */
export function getJsonPath(root: unknown, field: string): unknown {
  let cursor: unknown = root;
  for (const key of splitPath(field)) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = Object.prototype.hasOwnProperty.call(cursor, key) ? cursor[key] : undefined;
  }
  return cursor;
}

/** Set `field` (a dot-path) in `root`, creating plain objects along the way.
 *  `undefined` deletes the leaf. Mutates and returns `root`. Throws on an unsafe
 *  segment BEFORE writing anything. */
export function setJsonPath(root: Record<string, unknown>, field: string, value: unknown): Record<string, unknown> {
  const keys = splitPath(field);
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const next = cursor[k];
    if (!isPlainObject(next)) cursor[k] = {};
    cursor = cursor[k] as Record<string, unknown>;
  }
  const leaf = keys[keys.length - 1];
  if (value === null || value === undefined) delete cursor[leaf];
  else cursor[leaf] = value;
  return root;
}
