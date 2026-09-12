// Reading and writing a dot-path field of a plain JSON object, safely.
//
// WHY (2026-09-10 security review): the `settings:set` handler in remote-server.ts
// — reachable by a paired remote device — walked a client-supplied dot-path and
// assigned into it. A field of `__proto__.polluted` therefore wrote onto
// Object.prototype, changing every object in the main process. This helper is
// wired into that remote handler (and its settings:get reader).
//
// NOTE: the LOCAL settings:set/get in ipc-handlers.ts are NOT yet routed through
// this — that file is being changed concurrently by the remote batch-2/3 branch,
// so re-pointing it is deferred to a coordinated change (tracked in the security
// review STATUS). The local handler is only reachable by the app's own renderer,
// a much narrower surface than a paired remote device.
//
// A segment that is empty, `__proto__`, `constructor` or `prototype` is refused;
// arrays are traversed (not clobbered), so an array-typed setting like
// `permissions.allow` survives a walk through it.

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

function splitPath(field: string): string[] {
  const keys = field.split('.');
  if (keys.length === 0) throw new Error('empty field path');
  for (const k of keys) {
    if (k === '' || FORBIDDEN.has(k)) throw new Error(`unsafe field segment: ${JSON.stringify(k)}`);
  }
  return keys;
}

/** A non-null object — includes arrays, which are legitimate settings values
 *  (`permissions.allow`), so a walk through one must NOT replace it. Excludes
 *  primitives and null. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Read `field` (a dot-path) out of `root`, or undefined if any step is missing.
 *  Refuses the same segments as the setter, so a read of `__proto__` cannot leak
 *  the prototype object, and reads only OWN properties (never inherited ones). */
export function getJsonPath(root: unknown, field: string): unknown {
  let cursor: unknown = root;
  for (const key of splitPath(field)) {
    if (!isObject(cursor)) return undefined;
    cursor = Object.prototype.hasOwnProperty.call(cursor, key) ? (cursor as Record<string, unknown>)[key] : undefined;
  }
  return cursor;
}

/** Set `field` (a dot-path) in `root`, creating plain objects along the way (but
 *  never replacing an existing array/object it walks through). `undefined`
 *  deletes the leaf. Mutates and returns `root`. Throws on an unsafe segment
 *  BEFORE writing anything. */
export function setJsonPath(root: Record<string, unknown>, field: string, value: unknown): Record<string, unknown> {
  const keys = splitPath(field);
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const next = cursor[k];
    // Only replace a NON-object (primitive/null/undefined) with a fresh object;
    // an existing array or object is walked into, so a numeric-index write like
    // `permissions.allow.0` mutates the array instead of clobbering it to `{}`.
    if (!isObject(next)) cursor[k] = {};
    cursor = cursor[k] as Record<string, unknown>;
  }
  const leaf = keys[keys.length - 1];
  if (value === null || value === undefined) delete cursor[leaf];
  else cursor[leaf] = value;
  return root;
}
