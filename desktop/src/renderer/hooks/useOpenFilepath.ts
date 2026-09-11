// useOpenFilepath — the ONE resolve-and-open path for "a file mentioned in
// chat". Extracted from FilepathToken (2026-08-25) so the SendUserFile card
// opens files by exactly the same rules as a filepath pill: session list →
// the host's answer for that one path (artifacts:resolve-path) → artifactify;
// bridges without that channel keep the older session list → whole project →
// artifactify. Two copies of this logic would drift; the pill and the card
// must never disagree about whether a click opens something.
// `openFilepath` is the pure core so App.tsx's auto-open (deliverable-auto-open.ts)
// takes the same path without a hook.
//
// Contract: clicking a file in chat ALWAYS opens the artifact viewer, NEVER
// Project View (artifacts rule → UI invariants).
import { useCallback } from 'react';
import { useArtifactOptional } from '../state/ArtifactContext';
import type { ArtifactState } from '../state/artifact-tracker';
import type { ArtifactAction } from '../state/artifact-actions';
import type { ArtifactRecord } from '../../shared/artifacts/types';
import { findBestMatch, buildArtifactifyArgs } from '../components/filepath-match';
import { describeReadError } from '../components/artifact-views/read-error-copy';
import { isRemoteMode } from '../platform';

export interface OpenFilepathCtx {
  state: ArtifactState;
  dispatch: (action: ArtifactAction) => void;
}

export interface OpenFilepathOptions {
  // Default true = today's exact click behaviour: open the drawer up front so
  // a CLICK gets instant feedback while the lookup runs. Pass false for an
  // auto-open nobody clicked — opening early there buys nothing (nobody is
  // staring at the empty panel waiting) and guarantees a visible window where
  // the viewer is open with nothing selected (SessionDrawer force-opens the
  // file LIST when there's no active selection, so the user sees a list
  // instead of their file). In that mode the drawer opens only once a match
  // is found, right before it's shown; a total miss dispatches nothing at
  // all — the user didn't ask for this, so a silent no-op beats a panel
  // popping open onto an error about a file they never clicked.
  drawerOpensImmediately?: boolean;
}

// Stale-tap guard. WHY: the host lookup can take a noticeable moment over
// remote access, so a person can tap file A and then file B before A answers.
// Without this, A's late answer would land AFTER B and replace the file they
// actually asked for last. Each TAP takes a number; a lookup whose number is no
// longer its session's latest dispatches nothing and records nothing.
// Per session: a tap in one chat never cancels a lookup in another.
//
// Only taps take numbers (review 2026-09-11, finding 3). The deliverable
// auto-open (App.tsx) also runs through here; when it took a number it could
// cancel a tap the person was waiting on — the deliverable opened instead, or
// "Opening …" stuck. Now an auto-open never starts while a tap is looking up,
// and gives up if a tap starts before it finishes: it yields to taps, never the
// other way round.
const latestTapBySession = new Map<string, number>();
const tapInFlightBySession = new Map<string, number>();
let tapSerial = 0;

type HostAnswer = { ok: true; artifact: ArtifactRecord } | { ok: false; error: string };
type HostLookup =
  | { kind: 'answer'; answer: HostAnswer }
  | { kind: 'no-channel' }            // this bridge cannot answer: use the older lookup
  | { kind: 'failed'; detail: string }; // the question was asked and did not come back

/**
 * Ask the host which file this path names (artifacts:resolve-path).
 *
 * The older lookup is used ONLY when this bridge has no such channel: a host
 * without it (the remote shim rejects with `remote-unsupported: <channel>`), or
 * the Android app's bridge answering `not-implemented-on-mobile` — which the
 * shim RESOLVES as data, because only REJECT_ON_NOT_OK channels reject, and
 * this one must not be there (its other refusals are words for the person).
 *
 * Any other rejection — a timeout, a dropped connection — is reported as what
 * it is (review 2026-09-11, finding 5). Falling back there downloaded the
 * whole project list this channel exists to avoid, then said the file "wasn't
 * found", which nothing had shown.
 */
async function askHost(
  resolvePath: (projectRoot: string, filePath: string) => Promise<any>,
  cwd: string,
  path: string,
): Promise<HostLookup> {
  let res: any;
  try {
    res = await resolvePath(cwd, path);
  } catch (err: any) {
    const detail = err?.message ? String(err.message) : String(err ?? '');
    return /^remote-unsupported\b/.test(detail) ? { kind: 'no-channel' } : { kind: 'failed', detail };
  }
  if (res?.ok === true && res.artifact && typeof res.artifact.id === 'string') {
    return { kind: 'answer', answer: { ok: true, artifact: res.artifact } };
  }
  if (res?.ok === false && res.error === 'not-implemented-on-mobile') return { kind: 'no-channel' };
  if (res?.ok === false && typeof res.error === 'string') return { kind: 'answer', answer: { ok: false, error: res.error } };
  // An answer of no recognisable shape: keep the pre-channel behaviour.
  return { kind: 'no-channel' };
}

/**
 * The drawer note for a host refusal. Each sentence states only what the code
 * proves (docs/error-message-standards.md); a code this client does not know
 * is shown as the host sent it, never replaced with a guess.
 */
function describeRefusal(error: string, name: string): string {
  switch (error) {
    case 'not-found':
      return `Couldn’t open ${name} — no file exists at that path.`;
    case 'not-a-file':
      return `Couldn’t open ${name} — that path isn’t a file (folders can’t be opened here).`;
    case 'protected-path':
      return `Couldn’t open ${name}. ${describeReadError('protected-path')}`;
    case 'not-allowed':
      // Remote host only: the folder is not a saved project, an indexed
      // project, or the folder of a chat running on the computer, so NOTHING
      // in it is handed out (remote-server.ts refuseUnknownRoot).
      return `Couldn’t open ${name} from this device — this chat’s folder isn’t available to remote devices (it isn’t a saved project or the folder of an open chat on the computer).`;
    case 'not-tracked':
      // Remote host only: a folder known only because a chat runs there hands
      // out just the files already on record for it (read-service.ts trackedOnly).
      return `Couldn’t open ${name} from this device. This chat’s folder isn’t saved as a project on the computer, so only files the assistant has already worked with in it can be opened.`;
    case 'outside-project':
      return `Couldn’t open ${name} from this device — it’s outside this chat’s project folder.`;
    default:
      return `Couldn’t open ${name}: ${error}`;
  }
}

export async function openFilepath(
  ctx: OpenFilepathCtx,
  sessionId: string,
  path: string,
  options?: OpenFilepathOptions
): Promise<void> {
  const { state } = ctx;
  const drawerOpensImmediately = options?.drawerOpensImmediately ?? true;
  const name = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path;

  let token: number;
  if (drawerOpensImmediately) {
    token = ++tapSerial;
    latestTapBySession.set(sessionId, token);
    tapInFlightBySession.set(sessionId, token);
  } else {
    // An auto-open yields to a tap in progress (see the guard's comment above).
    if (tapInFlightBySession.has(sessionId)) return;
    token = latestTapBySession.get(sessionId) ?? 0;
  }
  const isCurrent = () => (latestTapBySession.get(sessionId) ?? 0) === token;
  // Every dispatch below goes through this, so a superseded lookup cannot touch
  // the drawer even on a path someone adds later without an isCurrent check.
  const dispatch = (action: ArtifactAction) => { if (isCurrent()) ctx.dispatch(action); };

  try {
    // Open the drawer first so there's an immediate response regardless of how
    // the lookup below resolves. If resolution fails, set a pill-error note —
    // otherwise the drawer's generic "no files yet" empty state would directly
    // contradict the file the user just clicked. PILL_RESOLVE_STARTED puts
    // "Opening <name>…" in that same place while the lookup runs (it used to show
    // "Nothing here yet" for as long as the lookup took). Skipped entirely in
    // deferred mode — see OpenFilepathOptions above.
    if (drawerOpensImmediately) {
      dispatch({ type: 'DRAWER_OPENED', sessionId });
      dispatch({ type: 'PILL_ERROR_CLEARED', sessionId });
      dispatch({ type: 'PILL_RESOLVE_STARTED', sessionId, name });
    }
    const failWith = (message: string) => {
      if (!drawerOpensImmediately) return; // deferred mode: silent no-op, nothing was ever shown
      dispatch({ type: 'PILL_RESOLVE_FAILED', sessionId, message });
    };
    const failed = () => failWith(`Couldn’t open ${name} — the file wasn’t found in this project.`);
    // Show a record that is not (necessarily) in the session's list yet.
    const show = (artifact: ArtifactRecord) => {
      if (!drawerOpensImmediately) dispatch({ type: 'DRAWER_OPENED', sessionId });
      dispatch({ type: 'SESSION_ARTIFACT_UPSERTED', sessionId, artifact });
      dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId, artifactId: artifact.id });
    };

    // 1. Already in this session's live list? Select it. findBestMatch prefers
    //    an exact path match over the suffix-tolerant fallback so a same-named
    //    file elsewhere can't shadow it.
    //    WHY cwd is passed to every findBestMatch below: with the session's
    //    folder known, a tapped path is compared against each record's FULL
    //    path, so a same-named file in another folder can never be opened in
    //    its place (the wrong-CLAUDE.md bug, 2026-09-11).
    const cwd = state.sessionCwd?.[sessionId];
    const sessMatch = findBestMatch(state.sessionArtifacts[sessionId] ?? [], path, cwd);
    if (sessMatch) {
      if (!drawerOpensImmediately) dispatch({ type: 'DRAWER_OPENED', sessionId });
      dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId, artifactId: sessMatch.id });
      return;
    }

    if (!cwd) { failed(); return; } // nothing to resolve without a root — say so
    const folder: string = cwd;

    // ARTIFACTIFY the path: a file visible in chat must open no matter how it
    // was created or where it lives. appendVersion records it (author 'user',
    // type 'read'); this is the only path that PERSISTS a brand-new artifact.
    // A WRITE — not bridged over remote access, which is why the host lookup
    // below never reaches here in remote mode. `unrecordable` is the note for a
    // path buildArtifactifyArgs can't record (a `~/` path); without it the
    // older lookup's "wasn't found" wording is kept.
    const artifactify = async (unrecordable?: string): Promise<void> => {
      const args = buildArtifactifyArgs(path, folder);
      if (!args) { if (unrecordable) failWith(unrecordable); else failed(); return; }
      await (window.claude as any).artifacts.appendVersion(folder, sessionId, args);
      if (!isCurrent()) return;
      const refreshed = await (window.claude as any).artifacts.listSession(sessionId, folder);
      if (!isCurrent()) return;
      let selected = false;
      if (refreshed?.ok && Array.isArray(refreshed.artifacts)) {
        const added = findBestMatch(refreshed.artifacts as ArtifactRecord[], path, folder);
        if (added) {
          // Deferred mode: hold SESSION_ARTIFACTS_LOADED back too — dispatching
          // it without a match still reveals the panel via the drawer's list
          // state, the exact half-open window this option exists to avoid.
          if (!drawerOpensImmediately) dispatch({ type: 'DRAWER_OPENED', sessionId });
          dispatch({ type: 'SESSION_ARTIFACTS_LOADED', sessionId, artifacts: refreshed.artifacts });
          dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId, artifactId: added.id });
          selected = true;
        } else if (drawerOpensImmediately) {
          dispatch({ type: 'SESSION_ARTIFACTS_LOADED', sessionId, artifacts: refreshed.artifacts });
        }
      }
      if (!selected) failed();
    };

    try {
      // 2. Ask the host about THIS path (artifacts:resolve-path). WHY: the older
      //    step below downloads the whole project list to find one file — 3,090
      //    records, ~1 MB, to a phone for one tap (2026-09-11) — and a file
      //    discovery never lists (inside a nested git repo) then falls through to
      //    artifactify, a write a phone cannot make. The host answers with the
      //    tracked record, or the on-disk file's discovered record, or a reason.
      //    No `await` when the bridge lacks the method, so the older lookup
      //    starts in the same tick it always did.
      const resolvePath = (window.claude as any)?.artifacts?.resolvePath;
      const lookup: HostLookup = typeof resolvePath === 'function'
        ? await askHost(resolvePath, folder, path)
        : { kind: 'no-channel' };
      if (!isCurrent()) return;
      if (lookup.kind === 'failed') {
        failWith(lookup.detail ? `Couldn’t open ${name}: ${lookup.detail}` : `Couldn’t open ${name}.`);
        return;
      }
      if (lookup.kind === 'answer') {
        const answer = lookup.answer;
        if (answer.ok) {
          // Deferred mode never SELECTS a discovered (ephemeral) record — see the
          // long WHY in step 3 below. A tracked record is safe to show.
          if (drawerOpensImmediately || !answer.artifact.discovered) { show(answer.artifact); return; }
          // Deferred + discovered: record it first (desktop), as before. Over
          // remote access there is no write to do it with — silent, like any miss.
          if (isRemoteMode()) return;
          await artifactify();
          return;
        }
        // Outside the folder, the desktop still records and opens the file (a temp
        // xlsx the assistant made, say) exactly as before. A remote device cannot
        // write, so it is told instead of getting a request that can only fail.
        if (answer.error === 'outside-project' && !isRemoteMode()) {
          // A `~/` path cannot be recorded (the renderer can't expand it): say
          // what the host established — outside the folder — not "not found"
          // (review 2026-09-11, finding 6).
          await artifactify(`Couldn’t open ${name} — it’s outside this chat’s project folder, and a path starting with ~ can’t be opened from outside the folder.`);
          return;
        }
        failWith(describeRefusal(answer.error, name));
        return;
      }

      // 3. A bridge without the host lookup: resolve against the WHOLE project —
      //    every tracked artifact (any session, including deleted) plus on-disk
      //    files — and inject the match into the session list so the drawer can
      //    show it.
      // Ask the cheap question first: listProject reads the sidecar (already in
      // memory / a fast IPC round trip) and is checked BEFORE the expensive
      // listAllFiles disk walk. findBestMatch always PREFERS the tracked match
      // over the on-disk one, so firing both in parallel (the old code) paid
      // for a full-project scan on every open even when the sidecar already had
      // the answer — measured at ~4s on a large workspace. Sequential costs one
      // extra round trip only on a miss, which is the uncommon case.
      const projRes = await (window.claude as any).artifacts.listProject(folder);
      if (!isCurrent()) return;
      const trackedList: ArtifactRecord[] = projRes?.ok ? (projRes.artifacts ?? []) : [];
      let projMatch: ArtifactRecord | undefined = findBestMatch(trackedList, path, folder);
      // WHY (deferred mode only): an auto-open must never select an EPHEMERAL
      // record. listAllFiles (project-file-discovery.ts) returns a DISCOVERED
      // record whose `id` is a relative path, not a persisted sidecar ULID. In
      // deferred/auto-open mode, LIST_PROJECT racing a queued APPEND_VERSION
      // means the file can be real but not yet in the sidecar — so a discovered
      // match here is exactly the case where a concurrent whole-session refresh
      // (artifact-tool-use-tracker's debounced listSession -> replaces the
      // session artifact list wholesale) wipes that id out from under the
      // selection a moment later, leaving nothing for ACTIVE_ARTIFACT_SET to
      // find and force-opening the file list instead of the file
      // (SessionDrawer.tsx: `showList = !active`). A synchronous click never
      // races that refresh, so only click mode may still fall back to the disk
      // scan; deferred mode instead falls through to artifactify below, which
      // PERSISTS a real sidecar record before selecting it.
      // This narrows what deferred mode can open: a path buildArtifactifyArgs
      // can't turn into artifactify args — notably a `~/` path, which it
      // returns null for (see the `!args` check in artifactify) — used to be
      // resolvable via the listAllFiles suffix match this branch now skips, and
      // silently opens nothing instead. That's the right trade (a silent no-op is
      // deferred mode's documented contract above; restoring the disk-scan
      // fallback here reintroduces the force-open-list race this comment
      // exists to prevent) but it is a real behavior loss, not a free one —
      // don't "restore" the fallback without re-solving the race it reopens.
      if (!projMatch && drawerOpensImmediately) {
        const filesRes = await (window.claude as any).artifacts.listAllFiles(folder);
        if (!isCurrent()) return;
        const filesList: ArtifactRecord[] = filesRes?.ok ? (filesRes.files ?? []) : [];
        projMatch = findBestMatch(filesList, path, folder);
      }
      if (projMatch) { show(projMatch); return; }

      // 4. Nothing matched anywhere — artifactify (above).
      await artifactify();
    } catch { failed(); }
  } finally {
    // This tap is no longer looking anything up, so auto-opens may run again —
    // unless a newer tap has taken its place.
    if (drawerOpensImmediately && tapInFlightBySession.get(sessionId) === token) {
      tapInFlightBySession.delete(sessionId);
    }
  }
}

export function useOpenFilepath(sessionId: string): (path: string) => Promise<void> {
  // Optional: the buddy window / sandbox render without ArtifactProvider. The
  // caller still renders its pill/card; the click is a no-op there.
  const artifactCtx = useArtifactOptional();
  return useCallback(async (path: string) => {
    if (!artifactCtx) return;
    await openFilepath(artifactCtx, sessionId, path);
  }, [artifactCtx, sessionId]);
}
