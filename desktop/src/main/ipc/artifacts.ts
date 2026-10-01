// artifacts.ts — the artifact viewer / Project Files channels (artifacts:*), one table entry each,
// served to the computer's windows and (for the reads) to a phone.
//
// WHY (2026-09-30 one-core R3-7): these were written twice. The reads were ipcMain handlers in
// ipc-handlers.ts AND a lookup table inside remote-server.ts (the phone's folder gate and size ceilings);
// the watch and download channels were separate phone `case`s. Now each channel is ONE entry: the same
// handler for both doors, and what only a phone is held to (the folder gate, the smaller size ceiling,
// the watch cap) declared on the entry as policy, so a phone cannot reach a read the computer's own
// windows would answer without those checks.
//
// WHAT A PHONE MAY DO, unchanged from before this move (batch 3, 2026-09-11):
//   - READ: list-session, list-project, list-all-files, list-folder, resolve-path, list-projects-index,
//     get, read-binary, search-content, check-existence, and watch / unwatch a folder, and ask for a
//     download link. Each behind the same gates as before (see the per-entry notes).
//   - NOT WRITE: save, append-version, rename, remove-record, import-file, include-external, exclude
//     and delete-project are `remoteAllowed: false`. The phone door refuses them without running the
//     handler, with the same "isn't available over remote access yet" answer it always gave.
//
// SECURITY: artifacts:get / save / read-binary enforce the write boundary and the read roots INSIDE the
// functions they call (read-service.ts, write-authorization.ts); this file adds no second copy of that
// logic and weakens none of it. The save body below is the computer's own, moved unchanged.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IPC } from '../../shared/backend-contract';
import { REMOTE_TEXT_PREVIEW_MAX_BYTES, REMOTE_BINARY_PREVIEW_MAX_BYTES } from '../../shared/remote-file-limits';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import {
  appendVersion, readSidecar, readSidecarShared, writeSidecar, renameArtifact, removeArtifactRecord,
} from '../artifacts/artifact-store';
import { listProjects, removeProject } from '../artifacts/central-index';
import { listProjectsIndex } from '../artifacts/projects-index';
import { invalidateDiscoveryCache } from '../artifacts/project-file-discovery';
import { ensureProject, ensureProjectCoalesced, applyGitTreatmentCoalesced } from '../artifacts/project-manager';
import { sweepStaleTmp } from '../artifacts/cas-write';
import { watchProject, unwatchProject, dropSubscriber, noteOwnWrite, invalidateSidecarIdCache } from '../artifacts/project-watcher';
import { authorizeArtifactWrite } from '../artifacts/write-authorization';
import { importFile } from '../artifacts/import-file';
import {
  listSessionFiles, listProjectFiles, listAllFiles, listFolder, readArtifactText, readArtifactBytes,
  searchArtifactContent, checkArtifactExistence, resolveArtifactPath, judgeRecordLocation, isKnownRoot,
} from '../artifacts/read-service';
import { defineChannel, type MainChannelCtx, type MainChannelDef } from './channel-def';
import { refuseUnknownRoot, refuseUnknownProject, refuseUnlessRecorded } from './file-gates';

// Root of ~/.claude — where the central index lives.
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// A phone shows one project's Files and one conversation's drawer at a time; four leaves room for a
// switch mid-grace without letting a socket pin a watcher per directory on the computer.
const MAX_WATCHED_ROOTS_PER_SOCKET = 4;

const ARTIFACT_CHANGED = IPC.ARTIFACTS_CHANGED;
const sendChanged = (ctx: MainChannelCtx, payload: unknown) => ctx.desktop?.sendToWindows(ARTIFACT_CHANGED, payload);
/** The answer a phone has always been given when a read throws (not the table's generic failure marker). */
const readFailure = (e: unknown) => ({ ok: false, error: String((e as Error)?.message ?? e) });
/** The refusal a phone gets for a malformed request. */
const badRequest = { ok: false, error: 'bad-request' };

/** A Claude Code session's conversation id when it differs from its desktop id (VersionEvent.conversationId).
 *  WHY (2026-09-30 one-core R3-7): the computer read this from its own closure and the phone from a separate
 *  wiring; both are the runtime's one id map now. */
const conversationIdFor = (ctx: MainChannelCtx, id: string): string | undefined => {
  const mapped = ctx.runtime?.sessionState.sessionIdMap.get(id);
  return mapped && mapped !== id ? mapped : undefined;
};

/** Normalize an include/exclude entry to a canonical ABSOLUTE path. FilesTab passes a relative path for
 *  internal artifacts and an absolute one for externals; storing one uniform shape keeps
 *  trackedArtifacts' comparisons trivial. */
const toCanonicalAbs = (projectRoot: string, p: string): string => {
  const fwd = p.replace(/\\/g, '/');
  const isAbs = /^[a-zA-Z]:\//.test(fwd) || fwd.startsWith('/');
  return canonicalize(isAbs ? fwd : `${projectRoot.replace(/\\/g, '/')}/${fwd}`, null);
};

// A crashed/closed renderer never sends unwatch — drop its refs on destroy so it cannot pin a watcher
// forever. One listener per webContents, attached on its first subscribe.
const watchedSenders = new Set<number>();

export const artifactsChannels: MainChannelDef[] = [
  // ── Reads ────────────────────────────────────────────────────────────────────

  defineChannel({
    name: IPC.ARTIFACTS_LIST_SESSION, kind: 'handle',
    remoteOnError: readFailure,
    // A session's own folder counts here (records: true) — the drawer lists what THAT session recorded.
    remoteGuard: async (p, ctx) => {
      if (typeof p?.sessionId !== 'string') return badRequest;
      return (await refuseUnknownRoot(p.projectRoot, ctx, { records: true })) ?? undefined;
    },
    handler: ({ sessionId, projectRoot }, ctx) => listSessionFiles(sessionId, projectRoot, conversationIdFor(ctx, sessionId)),
  }),

  // LIST_PROJECT → TRACKED SIDECAR ARTIFACTS ONLY. No on-disk discovery is merged in — that is
  // LIST_ALL_FILES's job. What comes back is whatever trackedArtifacts() admits (visible-artifacts.ts owns
  // the rules). Deleted records (tombstones) ARE returned; callers that don't want them must filter.
  defineChannel({
    name: IPC.ARTIFACTS_LIST_PROJECT, kind: 'handle',
    remoteOnError: readFailure,
    remoteGuard: async (p, ctx) => (await refuseUnknownProject(p?.projectId, ctx, { records: true })) ?? undefined,
    handler: ({ projectId, opts }) => listProjectFiles(projectId, opts),
  }),

  // LIST_ALL_FILES → the Project Files section: the folder as it exists on disk, unioned with tracked
  // internals discovery missed (read-service.ts). A phone gets it only for a folder the computer shows.
  defineChannel({
    name: IPC.ARTIFACTS_LIST_ALL_FILES, kind: 'handle',
    remoteOnError: readFailure,
    remoteGuard: async (p, ctx) => (await refuseUnknownProject(p?.projectId, ctx)) ?? undefined,
    handler: ({ projectId, opts }) => listAllFiles(projectId, opts),
  }),

  // LIST_FOLDER → one folder of Project Files, a page at a time, straight from disk (folder-listing.ts).
  // The same folder gate as list-all-files first; inside the project, folder-listing's own in-folder and
  // protected-path checks apply exactly as they do on the computer.
  defineChannel({
    name: IPC.ARTIFACTS_LIST_FOLDER, kind: 'handle',
    remoteOnError: readFailure,
    remoteGuard: async (p, ctx) => {
      if (typeof p?.relDir !== 'string') return badRequest;
      return (await refuseUnknownProject(p.projectId, ctx)) ?? undefined;
    },
    handler: ({ projectId, relDir, opts }, ctx) => listFolder(projectId, relDir, ctx.door === 'remote' ? { ...opts, refusePrivate: true } : opts),
  }),

  // RESOLVE_PATH → ONE file path tapped in chat, answered with the record the drawer opens. A phone can name
  // ANY path here, so: the folder gate runs first and nothing is looked up for a folder the computer never
  // showed; and a folder known only because a chat runs there (a phone can start one anywhere, "No folder"
  // lands in home) answers only files that chat recorded — the rule artifacts:get applies — with the same
  // not-tracked whether or not any other path exists (trackedOnly). The computer's own renderer only names
  // the folder of the chat it is showing, so it has no gate and no trackedOnly.
  defineChannel({
    name: IPC.ARTIFACTS_RESOLVE_PATH, kind: 'handle',
    remoteOnError: readFailure,
    remoteGuard: async (p, ctx) => {
      if (typeof p?.path !== 'string' || p.path.length === 0) return badRequest;
      return (await refuseUnknownRoot(p.projectRoot, ctx, { records: true })) ?? undefined;
    },
    // Forced by the door, whatever the phone sent: a folder the computer does not itself show is tracked-only.
    remotePayload: async (p) => ({ ...p, trackedOnly: !(await isKnownRoot(p.projectRoot)) }),
    // WHY (2026-10-01 one-core R3-8, R3-7 review): the old desktop handler ignored `trackedOnly` (it never took one),
    // so the computer's door ignores it too: only the phone's door sets it, and a window that sent one gets no change.
    handler: ({ projectRoot, path: filePath, trackedOnly }, ctx) =>
      resolveArtifactPath(projectRoot, filePath, ctx.door === 'remote'
        // WHY refusePrivate (2026-10-01 one-core R3-SEC): only the phone's door; the computer's answer is unchanged.
        ? { ...(trackedOnly !== undefined ? { trackedOnly } : {}), refusePrivate: true }
        : undefined),
  }),

  // The Project View project list — saved folders reconciled with the central index (projects-index.ts).
  defineChannel({
    name: IPC.ARTIFACTS_LIST_PROJECTS_INDEX, kind: 'handle',
    remoteOnError: readFailure,
    handler: (opts) => listProjectsIndex(opts),
  }),

  // `full`: the user clicked "Load the whole file" on the partial-view bar. Still refused above
  // FULL_READ_MAX_BYTES — the flag opts into a BIGGER read, not an unbounded one. A phone carries its own
  // smaller preview ceiling (answers too-large from stat, never a prefix), forced by the door.
  defineChannel({
    name: IPC.ARTIFACTS_GET, kind: 'handle',
    remoteOnError: readFailure,
    remoteGuard: async (p, ctx) => {
      if (typeof p?.artifactId !== 'string') return badRequest;
      // By path inside a folder the computer shows; inside a session-only folder, only a file that session
      // recorded, named by its record id.
      if (await refuseUnknownRoot(p.projectRoot, ctx)) {
        return (await refuseUnknownRoot(p.projectRoot, ctx, { records: true }))
          ?? (await refuseUnlessRecorded(p.projectRoot, p.artifactId))
          ?? undefined;
      }
      return undefined;
    },
    remotePayload: (p) => ({ ...p, maxBytes: REMOTE_TEXT_PREVIEW_MAX_BYTES }),
    // WHY maxBytes only for a phone (2026-10-01 one-core R3-8, R3-7 review): the old desktop handler took no ceiling.
    handler: ({ projectRoot, artifactId, full, maxBytes }, ctx) => readArtifactText(projectRoot, artifactId, { full: full === true, maxBytes: ctx.door === 'remote' ? maxBytes : undefined, refusePrivate: ctx.door === 'remote' }),
  }),

  // Read a file as base64 for the binary viewers. SECURITY: this RETURNS file contents and a phone can reach
  // it. read-service.ts resolves symlinks FIRST, then restricts reads to the user's project roots and tracked
  // artifacts, refusing well-known secret locations even inside those roots — a check on the file itself, so
  // no folder gate here. The phone's smaller ceiling is forced by the door.
  defineChannel({
    name: IPC.ARTIFACTS_READ_BINARY, kind: 'handle',
    remoteOnError: readFailure,
    remotePayload: (p) => ({ ...p, maxBytes: REMOTE_BINARY_PREVIEW_MAX_BYTES }),
    // WHY maxBytes only for a phone (2026-10-01 one-core R3-8, R3-7 review): the old desktop handler took no ceiling.
    handler: ({ absolutePath, maxBytes }, ctx) => readArtifactBytes(absolutePath, { maxBytes: ctx.door === 'remote' ? maxBytes : undefined, refusePrivate: ctx.door === 'remote' }),
  }),

  defineChannel({
    name: IPC.ARTIFACTS_SEARCH_CONTENT, kind: 'handle',
    remoteOnError: readFailure,
    remoteGuard: async (p, ctx) => (await refuseUnknownRoot(p?.projectRoot, ctx)) ?? undefined,
    handler: ({ projectRoot, query }, ctx) => searchArtifactContent(projectRoot, query, { refusePrivate: ctx.door === 'remote' }),
  }),

  // Batch-check whether each requested artifact's resolved path still exists on disk, so "file not on disk"
  // folds into the deleted UI state without mutating the sidecar.
  defineChannel({
    name: IPC.ARTIFACTS_CHECK_EXISTENCE, kind: 'handle',
    remoteOnError: readFailure,
    remoteGuard: async (p, ctx) => (await refuseUnknownRoot(p?.projectRoot, ctx, { records: true })) ?? undefined,
    handler: ({ projectRoot, artifactIds }) => checkArtifactExistence(projectRoot, artifactIds),
  }),

  // ── Watching a folder for changes made outside the app (spec §8) ─────────────
  // Watchers live in main, refcounted per subscriber (project-watcher.ts owns the lifecycle). The events
  // themselves are pushed by ipc-handlers.ts (to the subscribed windows, and to every phone), unchanged.
  defineChannel({
    name: IPC.ARTIFACTS_WATCH_PROJECT, kind: 'handle',
    remoteOnError: readFailure,
    // A watcher is a full tree walk on the main thread (project-watcher.ts measures 310-372 ms on a large
    // folder) and holds OS watch handles, so a phone naming `/usr` or a hundred different roots is refused
    // (T6 review, finding 3).
    remoteGuard: async (p, ctx) => {
      const refused = await refuseUnknownRoot(p?.projectRoot, ctx);
      if (refused) return { ok: false, error: refused.error };
      const watched = ctx.remote?.watchedRoots;
      if (watched && !watched.has(p.projectRoot) && watched.size >= MAX_WATCHED_ROOTS_PER_SOCKET) return { ok: false, error: 'too-many' };
      return undefined;
    },
    handler: async ({ projectRoot }, ctx) => {
      if (typeof projectRoot !== 'string' || projectRoot.length === 0) return { ok: false };
      // A phone gets its own id — negative, so it can never collide with a window id — and loses it when its
      // socket closes, the way a destroyed renderer loses its refs. A reconnect is a NEW socket, so the
      // phone re-subscribes (useProjectWatch).
      if (ctx.remote) {
        ctx.remote.watchedRoots.add(projectRoot);
        return watchProject(projectRoot, ctx.remote.watchSubscriberId());
      }
      const sender = ctx.sender;
      if (!sender) return { ok: false };
      if (!watchedSenders.has(sender.id)) {
        watchedSenders.add(sender.id);
        sender.once?.('destroyed', () => {
          watchedSenders.delete(sender.id);
          dropSubscriber(sender.id);
        });
      }
      return watchProject(projectRoot, sender.id);
    },
  }),

  defineChannel({
    name: IPC.ARTIFACTS_UNWATCH_PROJECT, kind: 'handle',
    handler: async ({ projectRoot }, ctx) => {
      if (typeof projectRoot !== 'string' || projectRoot.length === 0) return { ok: false };
      if (ctx.remote) {
        const watchId = ctx.remote.currentWatchId();
        if (watchId !== undefined) {
          unwatchProject(projectRoot, watchId);
          ctx.remote.watchedRoots.delete(projectRoot);
        }
        return { ok: true };
      }
      if (ctx.sender) unwatchProject(projectRoot, ctx.sender.id);
      return { ok: true };
    },
  }),

  // artifacts:download is a REMOTE channel (batch 3): a phone asks the host for a short-lived link and the
  // host's HTTP route streams the file. On the computer's own windows there is nothing to download to, so it
  // refuses with a code the renderer never shows (Download is only offered in remote mode).
  // Refusals (`sensitive`, `outside-roots`, `busy`…) are data the card shows, so this channel must never join
  // the shim's REJECT_ON_NOT_OK.
  defineChannel({
    name: IPC.ARTIFACTS_DOWNLOAD, kind: 'handle',
    remoteOnError: readFailure,
    handler: async (payload, ctx) => {
      if (!ctx.remote) return { ok: false, code: 'not-remote' };
      // The record route (projectRoot + artifactId) is offered only for a folder the computer shows or a live
      // session runs in; for any other folder the record is IGNORED and the path alone decides (T7 review,
      // finding 4; re-review, finding 6). A session-only folder therefore reaches only files that session
      // recorded (re-review, finding 1).
      const recordRoot = typeof payload?.projectRoot === 'string' && typeof payload?.artifactId === 'string'
        && await isKnownRoot(payload.projectRoot, ctx.remote.sessionRoots());
      const request = recordRoot
        ? { absolutePath: payload.absolutePath, projectRoot: payload.projectRoot, artifactId: payload.artifactId }
        : { absolutePath: payload?.absolutePath };
      return ctx.remote.mintDownload(request);
    },
  }),

  // ── Writes: the computer's windows only. A phone is refused before the handler runs. ──

  // The renderer Tracker calls this when it observes a Write/Edit/MultiEdit transcript event so the central
  // index is populated and artifacts appear in the Session Drawer even before the user opens it.
  // Burst-safe by construction (2026-08-15): opening a long conversation replays ~1,000 of these at once; the
  // coalesced helpers answer the burst with one index write and one .gitignore read; appendVersion queues
  // per project. Never call appendVersionsDirect from a handler.
  defineChannel({
    name: IPC.ARTIFACTS_APPEND_VERSION, kind: 'handle', remoteAllowed: false,
    handler: async ({ projectRoot, sessionId, args }, ctx) => {
      const { project } = await ensureProjectCoalesced(CLAUDE_DIR, projectRoot, sessionId);
      await applyGitTreatmentCoalesced(projectRoot);
      const result = await appendVersion(projectRoot, project.id, project.name, {
        path: args.path,
        kind: args.kind,
        absolutePath: args.absolutePath,
        sessionId,
        type: args.type,
        author: args.author,
        toolUseId: typeof args.toolUseId === 'string' && args.toolUseId ? args.toolUseId : undefined,
        // WHY: a Claude Code resume gets a fresh desktop id, so a files list keyed on it alone lost everything
        // before the resume; the conversation's own id lets LIST_SESSION find these again.
        conversationId: conversationIdFor(ctx, sessionId),
      });
      // AFTER the append resolves, not before it (2026-08-15 review): appendVersion is queued, so an
      // invalidate issued before the call could be followed by a watcher rebuild that read the OLD sidecar.
      invalidateSidecarIdCache(projectRoot); // watcher path-to-id map is stale
      // A newly created/edited file may also be a discovered doc — drop the cached disk scan.
      invalidateDiscoveryCache(projectRoot);
      // Broadcast the REAL artifact id so listeners can match it. A deduped append changed nothing on disk (a
      // replayed tool call recorded the first time round), so it must not announce an edit.
      if (!result.deduped) {
        sendChanged(ctx, { projectRoot, artifactId: result.artifactId, kind: args.type, by: args.author });
      }
      return { ok: result.committed, project };
    },
  }),

  defineChannel({
    name: IPC.ARTIFACTS_RENAME, kind: 'handle', remoteAllowed: false,
    handler: async ({ projectRoot, artifactId, newName }, ctx) => {
      const result = await renameArtifact(projectRoot, artifactId, newName);
      invalidateSidecarIdCache(projectRoot); // watcher path-to-id map is stale
      // Every open window's artifact UI re-lists with the new name.
      if (result.ok) sendChanged(ctx, { projectRoot, artifactId, kind: 'rename', by: 'user' });
      return result;
    },
  }),

  // Remove a tracking RECORD (never the file). See removeArtifactRecord — Session Drawer per-row remove.
  defineChannel({
    name: IPC.ARTIFACTS_REMOVE_RECORD, kind: 'handle', remoteAllowed: false,
    handler: async ({ projectRoot, artifactId }, ctx) => {
      const result = await removeArtifactRecord(projectRoot, artifactId);
      invalidateSidecarIdCache(projectRoot); // watcher path-to-id map is stale
      if (result.ok) sendChanged(ctx, { projectRoot, artifactId, kind: 'remove', by: 'user' });
      return result;
    },
  }),

  // baseMtimeMs: optimistic-concurrency token from artifacts:get — the save is rejected ('conflict') when the
  // file changed underneath (spec §12.9). confirmed: the user clicked through the confirm-tier dialog; main
  // REQUIRES it for needs-confirm paths so the policy decision cannot be skipped by a caller that never
  // showed the dialog (D5 — mistake-prevention tier).
  // THIS BODY IS THE COMPUTER'S, MOVED UNCHANGED: its path checks are the feature's security boundary.
  defineChannel({
    name: IPC.ARTIFACTS_SAVE, kind: 'handle', remoteAllowed: false,
    handler: async ({ projectRoot, projectId, projectName, artifactId, content: newContent, sessionId, ...opts }, ctx) => {
      const sidecar = await readSidecarShared(projectRoot);
      const artifact = (sidecar && !('corrupted' in sidecar))
        ? sidecar.artifacts.find((a) => a.id === artifactId)
        : undefined;

      let fullPath: string;
      // A `../` record is judged as artifacts:get judges it (F3), so the tier below sees its REAL location.
      const judged = artifact ? await judgeRecordLocation(projectRoot, artifact) : null;
      if (judged && !judged.ok) return judged.error === 'missing' ? { ok: false as const, error: 'artifact-not-found' } : judged;
      if (judged?.ok) {
        fullPath = judged.realPath;
      } else if (artifact) {
        // NOTE the tracked branch historically wrote artifact.absolutePath! with NO check at all — the
        // sidecar-escalation hole (spec §12.1). Everything below now runs on the RESOLVED path for both branches.
        fullPath = artifact.kind === 'internal'
          ? path.join(projectRoot, artifact.path)
          : artifact.absolutePath!;
      } else {
        // Discovered (on-disk) file: the id IS a canonical relative path. Fast string-level traversal reject
        // before touching the filesystem.
        const resolved = path.resolve(projectRoot, artifactId);
        const root = path.resolve(projectRoot);
        if (resolved !== root && !resolved.startsWith(root + path.sep)) {
          return { ok: false as const, error: 'artifact-not-found' };
        }
        fullPath = resolved;
      }

      // Symlink resolution → in-root enforcement → D5 tier policy → concurrency token, all on the RESOLVED
      // path (write-authorization.ts owns the logic + its tests — this is the feature's security boundary,
      // keep it pinned).
      const auth = await authorizeArtifactWrite({
        projectRoot,
        fullPath,
        mustStayInRoot: !artifact || artifact.kind === 'internal',
        baseMtimeMs: opts?.baseMtimeMs,
        confirmed: opts?.confirmed,
      });
      if (!auth.ok) return auth;
      const realPath = auth.realPath;

      // Suppress the watcher echo of our own write (spec §8.4), then atomic write: .tmp + rename so the
      // original is never half-written. pid+time-suffixed temp name: two processes (dev + built app) writing
      // the same file must not race the same .tmp — the loser's rename would ENOENT. These tmp files land in
      // the USER'S project tree, so sweep crash orphans for this file first and unlink our own tmp on
      // failure — a pid+time name is never overwritten by the next write, so a strand would linger forever
      // (git status noise, visible in the Files UI).
      noteOwnWrite(realPath);
      await sweepStaleTmp(path.dirname(realPath), path.basename(realPath));
      const tmpPath = `${realPath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.promises.writeFile(tmpPath, newContent, 'utf8');
        await fs.promises.rename(tmpPath, realPath);
      } catch (e) {
        try { await fs.promises.unlink(tmpPath); } catch { /* already gone */ }
        throw e;
      }
      const st = await fs.promises.stat(realPath).catch(() => null);

      if (artifact) {
        invalidateSidecarIdCache(projectRoot);
        await appendVersion(projectRoot, projectId, projectName, {
          path: artifact.path,
          kind: artifact.kind,
          absolutePath: artifact.absolutePath,
          sessionId,
          type: 'edit',
          author: 'user',
        });
      } else {
        // NO sidecar mutation for discovered files, so editing a doc never silently creates a .youcoded/
        // tracking dir.
        invalidateDiscoveryCache(projectRoot); // refresh the cached mtime next scan
      }
      // Broadcast the change to every renderer so all open windows update their artifact UI.
      sendChanged(ctx, { projectRoot, artifactId, kind: 'edit', by: 'user' });
      // Fresh token so the editor can keep saving without a refetch round-trip.
      return { ok: true as const, mtimeMs: st?.mtimeMs };
    },
  }),

  // IMPORT_FILE → copy/move a picked file into the project. All policy lives in artifacts/import-file.ts
  // (traversal, self-import, collisions, temp+rename, verify-before-unlink). disclosedCollisions is the list of
  // colliding basenames the renderer's dialog actually NAMED to the user — forwarded so 'replace' can only
  // overwrite files the user was shown.
  defineChannel({
    name: IPC.ARTIFACTS_IMPORT_FILE, kind: 'handle', remoteAllowed: false,
    handler: ({ projectRoot, sourcePath, destDir, opts }) => importFile({
      projectRoot, sourcePath, destDir,
      mode: opts.mode,
      onCollision: opts.onCollision,
      disclosedCollisions: opts.disclosedCollisions,
    }),
  }),

  // INCLUDE_EXTERNAL = PIN a file into the tracked set. NOTHING IN THE APP CALLS THIS TODAY (it used to be
  // "+ Add file", which became a real Move/Copy import on 2026-07-23). The handler and the manualIncludes rule
  // stay because existing sidecars still carry pins written by the old flow. Three steps: ensure a record
  // exists (a pin with no record would show nothing), add to manualIncludes (idempotent), remove from
  // manualExcludes (CAS-retried).
  defineChannel({
    name: IPC.ARTIFACTS_INCLUDE_EXTERNAL, kind: 'handle', remoteAllowed: false,
    handler: async ({ projectRoot, absolutePath }, ctx) => {
      const canonical = toCanonicalAbs(projectRoot, absolutePath);
      const rootCanon = canonicalize(projectRoot, null);
      const isInternal = canonical === rootCanon || canonical.startsWith(rootCanon + '/');

      // 1. Ensure a record exists (author 'user', type 'read' — a pin, not an edit).
      const { project } = await ensureProject(CLAUDE_DIR, projectRoot, 'manual-include');
      invalidateSidecarIdCache(projectRoot); // watcher path-to-id map is stale
      const appendResult = await appendVersion(projectRoot, project.id, project.name, {
        path: isInternal ? canonical.slice(rootCanon.length + 1) : (canonical.split('/').pop() ?? canonical),
        kind: isInternal ? 'internal' : 'external',
        absolutePath: isInternal ? null : canonical,
        sessionId: 'manual-include',
        type: 'read',
        author: 'user',
      });

      // 2 + 3. Pin it and clear any standing exclude (CAS-retried).
      for (let attempt = 0; attempt < 5; attempt++) {
        const sidecar = await readSidecar(projectRoot);
        if (!sidecar || 'corrupted' in sidecar) return { ok: false as const, error: 'sidecar-missing' };
        const originalUpdatedAt = sidecar.updatedAt;
        const alreadyIncluded = sidecar.manualIncludes.some((i) => i.path === canonical);
        const hadExclude = sidecar.manualExcludes.includes(canonical);
        if (alreadyIncluded && !hadExclude) break; // nothing to change
        if (!alreadyIncluded) {
          sidecar.manualIncludes.push({ path: canonical, addedAt: new Date().toISOString(), addedBy: 'user' });
        }
        sidecar.manualExcludes = sidecar.manualExcludes.filter((p) => p !== canonical);
        sidecar.updatedAt = new Date().toISOString();
        const w = await writeSidecar(projectRoot, originalUpdatedAt, sidecar);
        if (w.committed) break;
      }
      sendChanged(ctx, { projectRoot, artifactId: appendResult.artifactId, kind: 'include', by: 'user' });
      return { ok: true as const };
    },
  }),

  // Exclude = un-pin an external artifact (remove from manualIncludes) AND add a sticky manualExcludes entry so
  // trackedArtifacts() keeps hiding it even if Claude re-edits the file. Never touches the file on disk or the
  // session drawer's activity log. NO RENDERER CALLER as of 2026-07-23; the handler stays because legacy
  // sidecars carry manualExcludes entries that must keep round-tripping and manualExcludes is still
  // load-bearing in trackedArtifacts() rule 2.
  defineChannel({
    name: IPC.ARTIFACTS_EXCLUDE, kind: 'handle', remoteAllowed: false,
    handler: async ({ projectRoot, canonicalPath }, ctx) => {
      const canonical = toCanonicalAbs(projectRoot, canonicalPath);
      for (let attempt = 0; attempt < 5; attempt++) {
        const sidecar = await readSidecar(projectRoot);
        if (!sidecar || 'corrupted' in sidecar) return { ok: false as const, error: 'sidecar-missing' };
        const originalUpdatedAt = sidecar.updatedAt;
        sidecar.manualIncludes = sidecar.manualIncludes.filter((i) => i.path !== canonical);
        if (!sidecar.manualExcludes.includes(canonical)) sidecar.manualExcludes.push(canonical);
        sidecar.updatedAt = new Date().toISOString();
        const w = await writeSidecar(projectRoot, originalUpdatedAt, sidecar);
        if (w.committed) break;
      }
      sendChanged(ctx, { projectRoot, artifactId: null, kind: 'exclude', by: 'user' });
      return { ok: true as const };
    },
  }),

  // Remove a project from the central index. The project folder and its files are NOT deleted — only the
  // YouCoded tracking record is removed. When deleteSidecar is true, also removes .youcoded/artifacts.json
  // from the project folder so artifact history starts fresh on next session.
  defineChannel({
    name: IPC.ARTIFACTS_DELETE_PROJECT, kind: 'handle', remoteAllowed: false,
    handler: async ({ projectId, deleteSidecar }) => {
      const projects = await listProjects(CLAUDE_DIR);
      const p = projects.find((x) => x.id === projectId);
      if (!p) return { ok: false as const, error: 'project-not-found' };
      await removeProject(CLAUDE_DIR, projectId);
      if (deleteSidecar) {
        const sidecarPath = path.join(p.path, '.youcoded', 'artifacts.json');
        try {
          await fs.promises.unlink(sidecarPath);
        } catch {
          // Ignore ENOENT — sidecar may already be absent
        }
      }
      return { ok: true as const };
    },
  }),
];
