// Records WHERE a download came from, so a leftover .partial can still be
// resumed after a crash or quit. Written BEFORE the first byte.
//
// WHY it is NOT deleted when the download finishes (2026-09-05): a finished
// model still needs the facts in here — the Hugging Face repo it came from,
// and whether that repo ships a vision projector. Completion stamps
// `completedAt` instead, so "a manifest exists" no longer means "this download
// is unfinished"; `completedAt` is the test. Three deletions are left, and
// only three: the model itself being deleted, an unreadable fragment being
// swept, and a manifest whose files have all vanished from under it
// (engine-manager's installedModels — a record of nothing).
//
// A sidecar beside the files rather than a central registry: it travels with
// the download, so it cannot drift out of sync with the cache dir, and it
// survives the user repointing engine.cacheDir.
//
// Spec: docs/active/specs/2026-08-26-model-download-resume-design.md §3.1
import * as fs from 'fs';
import * as path from 'path';
import type { DownloadManifest, ManifestVisionFile, QuantOption } from '../../shared/model-manager-types';

/** `<first-file-basename>.gguf.download.json`. Exported so cache-scan can
 *  recognise a manifest without knowing anything else about it. */
export const MANIFEST_SUFFIX = '.download.json';

/** The manifest path for a download, keyed to its FIRST file's basename — the
 *  same id models:delete addresses a split model by. `dir` is the download's
 *  own directory (downloadDirFor), which for a vision model is its folder. */
export function manifestPathFor(dir: string, firstFileBasename: string): string {
  return path.join(dir, `${firstFileBasename}${MANIFEST_SUFFIX}`);
}

/** WHERE a download's files and its manifest live (design §E2).
 *
 *  A model that ships a vision projector gets a folder of its own,
 *  `<cacheDir>/<id>/`, because llama-server only pairs a model with an
 *  `mmproj*.gguf` when the two sit together in ONE subdirectory of the models
 *  dir — and it then names that model by the FOLDER (both probed on b10665,
 *  2026-09-05). So the folder name has to be the id the flat layout would have
 *  given the model, or the app and the router would disagree about what this
 *  model is called. Text-only models stay flat, exactly as before. */
export function downloadDirFor(
  cacheDir: string, quant: { files: string[]; visionFile?: ManifestVisionFile }
): string {
  if (!quant.visionFile) return cacheDir;
  return path.join(cacheDir, path.basename(quant.files[0]).replace(/\.gguf$/i, ''));
}

/** The directory an ALREADY-INSTALLED model's files live in — its own folder
 *  when it has one, else the cache dir. Callers that only know a model id (the
 *  Resume path) cannot ask downloadDirFor, because the answer is on disk. */
export function installedDirFor(cacheDir: string, modelId: string): string {
  const folder = path.join(cacheDir, modelId);
  try { if (fs.statSync(folder).isDirectory()) return folder; } catch { /* flat */ }
  return cacheDir;
}

export function writeManifest(dir: string, repo: string, quant: QuantOption, startedAt: number): void {
  const firstFileBasename = path.basename(quant.files[0]);
  // WHY the prior manifest is read first: a manifest now survives completion, so
  // starting the SAME model again (a re-download, or fetching a part that was
  // deleted) would otherwise throw away the vision projector this repo was
  // already known to ship. Carry that one fact forward; everything else is
  // re-stated by the caller, and the fresh write deliberately drops
  // `completedAt` because this download is in flight again.
  const prior = readManifest(dir, firstFileBasename);
  const manifest: DownloadManifest = {
    v: 1,
    repo,
    quant: quant.quant,
    files: quant.files,
    totalSizeBytes: quant.totalSizeBytes,
    sha256ByFile: quant.sha256ByFile,
    startedAt,
    // The projector THIS download knows about wins. Nothing used to write one:
    // the line below only ever carried a projector FORWARD from an earlier
    // manifest, so a first-ever download of a vision repo produced a manifest
    // with no `visionFile` at all and the "Add vision" state was unreachable
    // (design §E2, T15 handoff 1).
    //
    // The fallback is same-publisher ONLY. Six-plus Hugging Face accounts
    // publish byte-identical GGUF filenames, so a same-named download from a
    // DIFFERENT account would otherwise inherit the previous account's
    // projector path — which §E4 would then fetch from the wrong repo, 404ing
    // or pairing a projector with weights it does not match.
    ...(quant.visionFile
      ? { visionFile: quant.visionFile }
      : prior?.visionFile && prior.repo === repo ? { visionFile: prior.visionFile } : {}),
  };
  writeAtomic(manifestPathFor(dir, firstFileBasename), manifest);
}

/** §E3's backfill writer: the record for a download that finished LONG AGO,
 *  before manifests existed. Everything about it is already decided by the
 *  caller (manifest-backfill.ts), which is the only thing that may write a
 *  `repo: null` manifest, so this is deliberately a plain write.
 *
 *  It overwrites EXACTLY ONE thing: an earlier backfill's "could not find it"
 *  record (`repo: null`, stamped complete), which §E3 re-asks after a while
 *  because a successful search can still have been wrong. Everything else on
 *  disk wins, and nothing else may be replaced.
 *
 *  WHY that matters: the lookup behind a backfill runs for as long as Hugging
 *  Face takes to answer, and the user can start a fresh download of the same
 *  filename in that time — which writes its own, unstamped manifest. That one
 *  was written by a real download and this one is an inference from a filename,
 *  so overwriting it would stamp a `completedAt` onto a download still in
 *  flight and take away its Resume. Returns whether anything was written.
 *
 *  The read and the write are two operations, so this narrows the window from
 *  minutes to microseconds rather than closing it. Widening that to a real
 *  exclusive create (`wx`) would also have to handle the pre-existing
 *  atomic-rename path; nothing has been seen to hit it. */
export function writeBackfillManifest(
  dir: string, firstFileBasename: string, manifest: DownloadManifest
): boolean {
  const target = manifestPathFor(dir, firstFileBasename);
  if (fs.existsSync(target)) {
    const prior = readManifest(dir, firstFileBasename);
    // An UNREADABLE file is not a known miss, so it is left alone: installedModels
    // sweeps those, and guessing here could destroy a download's only record.
    if (!prior || prior.repo !== null || prior.completedAt == null) return false;
  }
  writeAtomic(target, manifest);
  return true;
}

/** Stamp a manifest as finished — the download's LAST step, in place of the
 *  delete it used to do (see the header). A missing or unreadable manifest is a
 *  no-op: there is nothing to stamp, and completion must not fail over it.
 *  Idempotent — an already-stamped manifest keeps its original `completedAt`.
 *
 *  KNOWN, not a blocker: this is a read-modify-write, where the file previously
 *  only ever saw a whole-file write or a delete. Two app instances sharing one
 *  cache dir (the dev instance and the built app do) can therefore lose an
 *  update here — the loser's fields are overwritten by the winner's snapshot.
 *  The window is one file read wide and both writers are writing the same
 *  facts, so nothing has been seen to go wrong; widen the fix if a future field
 *  is written by one instance and read by the other. */
export function markManifestComplete(
  cacheDir: string, firstFileBasename: string, completedAt: number
): void {
  const manifest = readManifest(cacheDir, firstFileBasename);
  if (!manifest || manifest.completedAt != null) return;
  writeAtomic(manifestPathFor(cacheDir, firstFileBasename), { ...manifest, completedAt });
}

/** The question every caller used to answer with "does the file exist?".
 *  A manifest with no `completedAt` is an unfinished download — resumable, and
 *  shown as interrupted in Local Models. A stamped one is only a record. */
export function isManifestComplete(manifest: DownloadManifest | null): boolean {
  return manifest != null && manifest.completedAt != null;
}

function writeAtomic(target: string, manifest: DownloadManifest): void {
  // Write-then-rename: a crash mid-write must leave NO manifest rather than half
  // of one. readManifest would reject the fragment, but "absent" is the honest
  // state and "present but unreadable" invites someone to try to repair it.
  // PER-PROCESS temp name, never a fixed `<file>.tmp`: a dev instance and the
  // built app share the cache dir, so two writers on one temp path make the
  // loser's rename throw ENOENT (scripts/ast-grep/atomic-tmp-name-per-process).
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, target);
}

/** The manifest for a download, or null. Absent, unreadable, malformed, and
 *  from-a-future-version all answer null — each of those is a record nothing
 *  can be trusted from. Whether the download it describes has FINISHED is a
 *  separate question, answered by `completedAt` / isManifestComplete. */
export function readManifest(cacheDir: string, firstFileBasename: string): DownloadManifest | null {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPathFor(cacheDir, firstFileBasename), 'utf8'));
  } catch {
    return null;
  }
  if (raw?.v !== 1) return null;
  // null is a REAL, wanted value: §E3's backfill records "I looked this model's
  // repo up on Hugging Face and found nothing" as `repo: null`, so the lookup
  // costs one search per model ever rather than one per Local Models render.
  // Rejecting it here would make that record unreadable — and an unreadable
  // manifest gets swept, which is exactly the loop it exists to stop.
  if (raw.repo !== null && (typeof raw.repo !== 'string' || !raw.repo)) return null;
  if (typeof raw.quant !== 'string' || !raw.quant) return null;
  if (!Array.isArray(raw.files) || raw.files.length === 0) return null;
  if (!raw.files.every((f: unknown) => typeof f === 'string')) return null;
  if (typeof raw.totalSizeBytes !== 'number' || !Number.isFinite(raw.totalSizeBytes)) return null;
  if (typeof raw.sha256ByFile !== 'object' || raw.sha256ByFile === null) return null;
  if (typeof raw.startedAt !== 'number') return null;
  // The two fields a completed manifest carries. Both optional, so an unfinished
  // manifest — and every manifest written before 2026-09-05 — still reads fine.
  // A value of the WRONG SHAPE is corruption rather than an old file, so the
  // rule above (a record nothing can be trusted from answers null) applies.
  if (raw.completedAt !== undefined && typeof raw.completedAt !== 'number') return null;
  if (raw.repoCheckedAt !== undefined && typeof raw.repoCheckedAt !== 'number') return null;
  if (raw.visionFile !== undefined) {
    const v = raw.visionFile;
    if (typeof v !== 'object' || v === null) return null;
    if (typeof v.path !== 'string' || !v.path) return null;
    if (typeof v.size !== 'number' || !Number.isFinite(v.size)) return null;
    if (v.sha256 !== null && typeof v.sha256 !== 'string') return null;
  }
  return raw as DownloadManifest;
}

export function removeManifest(cacheDir: string, firstFileBasename: string): void {
  fs.rmSync(manifestPathFor(cacheDir, firstFileBasename), { force: true });
  // Sweep any half-written temp too. The name carries the writing process's
  // pid, so it can't be reconstructed — match the prefix instead. A crashed
  // write from ANOTHER process is exactly the litter this is here to clear.
  const prefix = `${firstFileBasename}${MANIFEST_SUFFIX}.`;
  let names: string[] = [];
  try { names = fs.readdirSync(cacheDir); } catch { return; } // dir gone — nothing to sweep
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith('.tmp')) {
      fs.rmSync(path.join(cacheDir, name), { force: true });
    }
  }
}
