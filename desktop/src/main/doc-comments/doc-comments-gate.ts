// Shared `projectRoot` gate for every docComments:* entry point — desktop IPC
// (doc-comments/ipc-handlers.ts) and remote (remote-server.ts) today, and the
// ONE place a future native tool (T8) or a main-process-hosted assistant path
// should import from rather than re-deriving its own allowlist.
//
// WHY this exists (post-T3 build review, finding F1 — blocker): doc-comments-
// store.ts's own containment check (design §1.5) only proves a `path` resolves
// INSIDE whatever `projectRoot` it is given — nothing ever proved `projectRoot`
// ITSELF is a folder the app actually recognizes. A caller naming
// `projectRoot: '/'` (or `$HOME`) made that containment check a no-op, since
// `path.resolve('/', anything)` always lands "inside" `/`: every docComments:*
// channel could then create/mutate a sidecar anywhere on disk, and — for a
// `.docx`/`.xlsx` target — made the main process read and parse ANY such file
// on the machine, bypassing the exact guard (`read-binary-access.ts` /
// `authorizeBytesRead`) the artifacts binary viewers already enforce for the
// same class of read.
//
// The fix reuses the SAME "is this root one the app shows" authority this
// design's own §1.5 already cites as a precedent for two OTHER subsystems:
// git's `knownGitRoot`/`gitGate` (`ipc-handlers.ts` ~5235) and
// `remote-server.ts`'s `isKnownRoot`/`refuseUnknownRoot` (used by
// `artifacts:watch-project` ~3895) — both ultimately call `isKnownRoot()`
// (`artifacts/read-service.ts`). This module is a THIRD consumer of that one
// allowlist, not a fourth independently-invented one.
import { isKnownRoot } from '../artifacts/read-service';

export type UnknownProjectRootRefusal = { ok: false; error: 'unknown-project-root' };

/**
 * Refuses when `projectRoot` is present but is not a root the app itself
 * shows — a saved folder, an indexed project, or one of `extraSessionRoots`.
 * Returns `null` (proceed) when `projectRoot` is `undefined`: the caller then
 * takes the fallback (loose-file) path, which never claims a project at all
 * and is gated separately, at the point it would read a file's actual bytes
 * (see `doc-comments-dispatch.ts`'s `listNativeComments`) — not here.
 *
 * `extraSessionRoots` mirrors `remote-server.ts`'s own `sessionRoots()` /
 * "records" mode: design §1.4 is explicit that doc comments follow
 * `useActiveProject.ts`'s own fallback shape — a session's file drawer hands
 * the comments service the session's raw cwd even when that folder was never
 * added as a saved folder or indexed project (`{id:'', name:'project', path:
 * cwd}`), so refusing every unregistered-but-currently-open session directory
 * here would break real, already-open sessions instead of only closing a
 * hole. The caller supplies its OWN live roots; this module never discovers
 * them independently.
 */
export async function refuseUnknownProjectRoot(
  projectRoot: string | undefined,
  extraSessionRoots: readonly string[] = []
): Promise<UnknownProjectRootRefusal | null> {
  if (projectRoot === undefined) return null;
  return (await isKnownRoot(projectRoot, extraSessionRoots)) ? null : { ok: false, error: 'unknown-project-root' };
}

// ---------------------------------------------------------------------------
// docComments:add's `selector` shape — Android/desktop parity (code review
// 2026-09-27, Android F1).
//
// WHY: Android's `DocCommentsBridge.kt` already does
// `CommentSelector.fromJson(payload.optJSONObject("selector")) ?:
// return missingField("selector")` before ever calling `addComment` — a
// request with a missing or malformed `selector` is refused with
// `{ok:false, error:"missing-field", field:"selector"}`. Desktop's own
// `ipc-handlers.ts`/`remote-server.ts` ADD handlers used to cast
// `payload?.selector as CommentSelector` straight through with NO check at
// all — a compile-time-only TS assertion that does nothing at runtime — so a
// caller that omitted `selector` got a silent success on desktop (a
// persisted comment with no `selector` field) and a refusal on Android for
// the IDENTICAL request shape on the IDENTICAL channel. `ipc-bridge.md`'s
// parity rule says every channel must agree; this is the shared check both
// desktop surfaces now run before dispatching, so they can't drift apart
// again.
//
// This mirrors Android's OWN leniency, not a stricter desktop-only check:
// `CommentSelector.fromJson` only validates the OUTER shape (`kind` is
// literally 'text' or 'cell', and a `selector` sub-object is present) —
// `TextQuoteSelector.fromJson`/`CellSelector.fromJson` default every MISSING
// inner field (`exact`, `cell`, ...) to an empty string rather than refuse.
// Validating inner fields here would make desktop STRICTER than Android for
// the same channel, which is its own parity gap in the other direction.
export function isValidCommentSelectorShape(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const rec = v as Record<string, unknown>;
  if (rec.kind !== 'text' && rec.kind !== 'cell') return false;
  const inner = rec.selector;
  return typeof inner === 'object' && inner !== null && !Array.isArray(inner);
}

export type MissingSelectorFieldRefusal = { ok: false; error: 'missing-field'; field: 'selector' };

/** Same refusal shape Android's `missingField("selector")` and desktop's own
 *  `ipc-handlers.ts`-local `missingField()` both produce — exported here too
 *  so `remote-server.ts` (which has no local `missingField` helper of its
 *  own) doesn't need to hand-roll a second copy of the literal object shape. */
export function missingSelectorField(): MissingSelectorFieldRefusal {
  return { ok: false, error: 'missing-field', field: 'selector' };
}
