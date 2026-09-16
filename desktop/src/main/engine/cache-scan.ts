// GGUF cache scan — the engine-off view of "what local models exist".
// Router-mode llama-server discovers the same directory (--models-dir, NOT
// LLAMA_CACHE — that one is vestigial), so the ids derived here MUST match what
// GET /models reports once the engine is running — with ONE known difference:
// the router lists one row per FILE, so a split set appears there as N rows
// while this scan collapses it to the first part. That is listing granularity,
// not a naming mismatch; EngineSupervisor.listModels drops the follower rows
// (shared/gguf-split.ts) and probe-models.mjs folds them before comparing.
// Measured on b10665, 2026-08-27, after four rows for one model reached the
// picker and three of them 500'd. It scans that dir at BOOT and
// never again on its own, so this scan can legitimately be AHEAD of the router
// for a file downloaded since — that gap is what EngineSupervisor.ensureServable
// closes, and reading a row from here as "usable" is the 2026-08-16 bug.
// ONE scan, TWO views: scanLocalDownloads reports every download on disk in
// whatever state it is in (the Settings list), and scanGgufCache is that
// filtered to complete sets (everything else, including the conversation model
// picker). Deriving one from the other is deliberate — two independent scans of
// the same directory can disagree, and a half-downloaded split model listed as
// installed was exactly that bug (2026-08-26).
// The id equivalence is an EMPIRICAL contract, pinned by
// test-engine/probe-models.mjs and recorded in docs/engine-dependencies.md —
// if a probe run shows the router naming models differently, fix
// ggufIdFromFileName (one function) and update the probe assertion together.
import * as fs from 'fs';
import * as path from 'path';
import type { EngineModel } from '../../shared/engine-types';
import { MANIFEST_SUFFIX } from '../models/download-manifest';
import { isVisionProjectorFile } from '../models/quant-parser';

// llama.cpp split-GGUF convention: <name>-00001-of-000NN.gguf. The model is
// addressed through its FIRST part; other parts are the same model's payload.
const PART_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;

export function ggufIdFromFileName(fileName: string): string {
  return fileName.replace(/\.gguf$/i, '');
}

/** One download's footprint on disk, in whatever state it is in. */
export interface LocalDownload {
  modelId: string;         // first-part id — what models:delete takes
  firstFileName: string;   // basename incl. .gguf — the manifest key
  partsDeclared: number;   // from the -of-000NN suffix; 1 for single-file
  partsPresent: number;    // published .gguf files found for this set
  bytesPublished: number;
  bytesPartial: number;
  hasPartial: boolean;
  // A manifest FILE exists (parsed by engine-manager, not here). Presence alone
  // says nothing about whether the download finished — the manifest survives
  // completion now, and its `completedAt` is what answers that.
  hasManifest: boolean;
  /** The one-level subdirectory of the cache dir this download lives in, or
   *  null when it sits flat. A model that ships a vision projector gets a
   *  folder of its own, because the engine only pairs the two when they sit
   *  together (design §E2); everything else stays flat, as before. */
  subdir: string | null;
  /** A published `mmproj*.gguf` sits beside the weights, so the engine will
   *  load this model with `--mmproj` and it can look at images. */
  hasProjector: boolean;
  /** Bytes of that published projector; 0 when there is none. Kept OUT of
   *  `bytesPublished`, which stays "the model's own weights" — the number the
   *  engine-off model list reports as a model's size. */
  visionBytes: number;
}

/** A download is usable only when every declared part is published. A stray
 *  .partial or manifest alongside a full set does NOT demote it — publication
 *  is an atomic rename, so the file count is the authority (spec §3.2). */
export function isComplete(d: LocalDownload): boolean {
  return d.partsPresent >= d.partsDeclared;
}

/** Every GGUF download in the cache dir, complete or not — the Settings view.
 *  Groups a split set under its first part and reports published vs in-flight
 *  bytes separately. A manifest with no bytes yet is a download too (it is
 *  written before the first fetch).
 *
 *  ONE LEVEL DEEP, and no further: the flat files, plus each immediate
 *  subdirectory. That is exactly what llama-server does with `--models-dir`
 *  (probed on b10665, 2026-09-05: `deep/inner/B-Q8_0.gguf` was not listed at
 *  all, while `weird-folder/C-Q8_0.gguf` was), and this scan must agree with
 *  the router about which models exist. */
export function scanLocalDownloads(cacheDir: string): LocalDownload[] {
  const out: LocalDownload[] = [];
  out.push(...scanOneDir(cacheDir, null));
  for (const ent of readDirents(cacheDir)) {
    if (!ent.isDirectory()) continue;
    out.push(...scanOneDir(path.join(cacheDir, ent.name), ent.name));
  }
  return out.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

function readDirents(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // cache dir not created yet — no downloads, not an error
  }
}

/** The scan of ONE directory: the cache dir itself (subdir null) or one model
 *  folder inside it. A folder holds exactly one model as far as the engine is
 *  concerned, so its rows are folded into one before they are returned. */
function scanOneDir(dirAbs: string, subdir: string | null): LocalDownload[] {
  const sets = new Map<string, LocalDownload>();
  // The projector is tracked apart from the sets on purpose — see hasProjector.
  let projectorBytes = 0;
  let projectorPartialBytes = 0;
  let hasProjector = false;
  for (const ent of readDirents(dirAbs)) {
    if (!ent.isFile()) continue;
    const published = /\.gguf$/i.test(ent.name);
    const partial = /\.gguf\.partial$/i.test(ent.name);
    const manifest = ent.name.endsWith(`.gguf${MANIFEST_SUFFIX}`);
    if (!published && !partial && !manifest) continue;   // notes, .tmp, anything else
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(path.join(dirAbs, ent.name)).size; } catch { continue; } // raced delete
    // The final filename this entry belongs to ('X.gguf.partial' -> 'X.gguf',
    // 'X.gguf.download.json' -> 'X.gguf').
    const finalName = partial ? ent.name.replace(/\.partial$/i, '')
      : manifest ? ent.name.slice(0, -MANIFEST_SUFFIX.length)
      : ent.name;
    // A vision projector is NOT a model and NOT one of the weight set's parts.
    // The router never lists it (it pairs it onto the model beside it), so
    // letting it through here would invent a model row nothing can serve, and —
    // worse — a `mmproj-…-00001-of-00002`-shaped name could be counted as a
    // published part of the set it sits next to.
    if (isVisionProjectorFile(finalName)) {
      if (published) { hasProjector = true; projectorBytes += sizeBytes; }
      else if (partial) { projectorPartialBytes += sizeBytes; }
      continue;
    }
    const part = PART_RE.exec(finalName);
    const firstFileName = part ? finalName.replace(PART_RE, `-00001-of-${part[2]}.gguf`) : finalName;
    let set = sets.get(firstFileName);
    if (!set) {
      set = {
        modelId: ggufIdFromFileName(firstFileName),
        firstFileName,
        partsDeclared: part ? Number(part[2]) : 1,
        partsPresent: 0,
        bytesPublished: 0,
        bytesPartial: 0,
        hasPartial: false,
        hasManifest: false,
        subdir,
        hasProjector: false,
        visionBytes: 0,
      };
      sets.set(firstFileName, set);
    }
    if (published) { set.partsPresent += 1; set.bytesPublished += sizeBytes; }
    else if (partial) { set.hasPartial = true; set.bytesPartial += sizeBytes; }
    else { set.hasManifest = true; }
  }
  const rows = [...sets.values()].sort((a, b) => a.firstFileName.localeCompare(b.firstFileName));
  if (subdir === null) return rows;
  if (rows.length === 0) {
    // A folder with NO weights at all. Empty, or holding nothing we recognise:
    // return nothing, there is no model here. The one exception is a folder
    // holding ONLY a projector — the leftover of a download whose weights were
    // deleted, or of a move that got half way — because a row that is never
    // listed is also a row the user can never delete, and this one can be
    // gigabytes. It is reported as an incomplete download, which is what it is.
    if (projectorBytes === 0 && projectorPartialBytes === 0) return [];
    return [{
      modelId: subdir,
      firstFileName: `${subdir}.gguf`,   // where its manifest would be, if it had one
      partsDeclared: 1,
      partsPresent: 0,                    // no weights → never complete, never offered
      bytesPublished: 0,
      bytesPartial: projectorPartialBytes,
      hasPartial: projectorPartialBytes > 0,
      hasManifest: false,
      subdir,
      hasProjector: projectorBytes > 0,
      visionBytes: projectorBytes,
    }];
  }
  // A folder is ONE model to the engine, and the engine names it by the FOLDER,
  // not by the file inside it (probed on b10665, 2026-09-05:
  // `weird-folder/C-Q8_0.gguf` was served as the model `weird-folder`). Using
  // the filename here instead would give the app an id the router does not
  // answer to — the 2026-08-16 class of bug. Anything else that happens to be
  // in the folder is part of the same footprint: it is what `deleteModel`
  // removes and what the row's size has to admit to.
  //
  // COST of that folding, for a folder our downloader did not create: the row
  // keeps only the FIRST filename, and `installedModels` reads the manifest
  // under that name — so a second weight set's own manifest, and the repo in it,
  // are silently lost. Harmless today (the downloader puts exactly one set in a
  // folder), but it is why "one folder, one model" is a rule and not a habit.
  const primary = rows[0];
  for (const extra of rows.slice(1)) {
    primary.bytesPublished += extra.bytesPublished;
    primary.bytesPartial += extra.bytesPartial;
    primary.hasPartial = primary.hasPartial || extra.hasPartial;
    primary.hasManifest = primary.hasManifest || extra.hasManifest;
  }
  primary.modelId = subdir;
  primary.hasProjector = hasProjector;
  primary.visionBytes = projectorBytes;
  // A projector still arriving is in-flight bytes of THIS download — the
  // second leg of the one job that fetched the weights (design §E2).
  primary.bytesPartial += projectorPartialBytes;
  if (projectorPartialBytes > 0) primary.hasPartial = true;
  return [primary];
}

/** The engine-off view — complete downloads only.
 *
 *  INCOMPLETE SETS ARE OMITTED BY CONSTRUCTION. Everything downstream of this
 *  function — listModels, liveModels, engine:models, the conversation model
 *  picker — inherits that, so there is no second place to remember the rule.
 *  A half-downloaded split model listed as installed was the 2026-08-26 bug. */
export function scanGgufCache(cacheDir: string): EngineModel[] {
  return scanLocalDownloads(cacheDir)
    .filter(isComplete)
    .map((d) => ({
      id: d.modelId,
      sizeBytes: d.bytesPublished,
      loaded: false,
      state: 'unloaded' as const, // cache scan = engine-off view; nothing is resident
    }));
}
