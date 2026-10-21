import path from 'node:path';

// SECURITY: synced/remote record refs must stay inside the conversation store.
// WHY a standalone module: background index workers must not load the live
// conversation service (and its Electron/session lifecycle dependency graph).
export function containedTranscriptPath(root: string, ref: string): string | null {
  if (!ref || path.isAbsolute(ref)) return null;
  const resolvedRoot = path.resolve(root);
  const joined = path.resolve(resolvedRoot, ref);
  return joined.startsWith(resolvedRoot + path.sep) ? joined : null;
}
