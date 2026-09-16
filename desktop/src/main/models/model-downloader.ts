// GGUF downloader (spec §4.4): fetches quant file sets from HF resolve URLs
// into the llama.cpp cache dir. Contracts:
//   - files land FLAT under cacheDir with their BASENAME (subfolder paths in
//     the repo are collapsed) — that is what Plan B's cache-scan/router
//     discovery reads; probe-download.mjs pins the equivalence.
//   - EXCEPT a model that ships a vision projector, which lands in a folder of
//     its own, `<cacheDir>/<id>/`, with the projector beside it and the manifest
//     inside (design §E2). The engine only pairs the two when they share one
//     subdirectory. Both files are fetched by ONE job, under one downloadId,
//     with totalBytes summed over the pair, so the percentage covers both.
//   - in-flight bytes live in <name>.partial; publish is an atomic rename, so
//     a crash/cancel never leaves a half-file the router could try to load.
//   - resume: an existing .partial continues via a Range request.
//   - sha256 (from HF lfs.oid) verifies each part when available; a mismatch
//     deletes the bad bytes and errors — never publishes.
//   - cancel keeps .partial files (resume later); a later delete cleans up.
//   - the manifest sidecar SURVIVES completion, stamped with completedAt — see
//     download-manifest.ts for why a finished model still needs it.
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ulid } from 'ulid';
import { hfResolveUrl } from './hf-client';
import { writeManifest, readManifest, markManifestComplete, isManifestComplete, downloadDirFor } from './download-manifest';
import type { DownloadProgress, QuantOption } from '../../shared/model-manager-types';

const PROGRESS_INTERVAL_MS = 250;

interface ActiveDownload {
  key: string;                       // repo::quant — concurrency guard
  abort: AbortController;
  promise: Promise<void>;
  cancelled: boolean;
}

export class ModelDownloader {
  private active = new Map<string, ActiveDownload>(); // by downloadId

  constructor(private cacheDir: string, private fetchImpl: typeof fetch = fetch) {}

  /** Kick off a download; progress arrives via onProgress; await wait(id) for
   *  the outcome. Throws synchronously if this repo+quant is already running. */
  start(repo: string, quant: QuantOption, onProgress: (p: DownloadProgress) => void): string {
    const key = `${repo}::${quant.quant}`;
    for (const d of this.active.values()) {
      if (d.key === key) throw new Error('That model is already downloading.');
    }
    const firstFile = path.basename(quant.files[0]);
    // A vision model's files go in a folder of their own; everything else stays
    // flat. Resolved ONCE here and passed down, so the manifest, the .partial
    // files and the published files can never end up in different places.
    const dir = downloadDirFor(this.cacheDir, quant);
    // NEVER let `<cacheDir>/X.gguf` and `<cacheDir>/X/` both exist. They are one
    // model id to the engine, which serves exactly ONE of the two and silently
    // drops the other — and WHICH ONE IS NOT PREDICTABLE. Measured on b10665
    // (2026-09-05) on a single server: a dir holding `ACOLL-Q4_K_M.gguf` beside
    // `ACOLL-Q4_K_M/ACOLL-Q4_K_M.gguf` served the FLAT file, while `BCOLL` — the
    // same pair created in the opposite order — served the FOLDER. It follows
    // directory-entry order, which belongs to the filesystem, not to us.
    //
    // READ THIS BEFORE MOVING A MODEL INTO ITS FOLDER (T17): do not order that
    // move on an assumption that the half-populated folder is ignored while the
    // flat file is still there. It may shadow the working model instead, and
    // the user's model stops loading with nothing on screen to explain it.
    //
    // Both directions are refused, because the pair can be created from either
    // end. This one: a vision download whose model is already installed flat.
    if (dir !== this.cacheDir && fs.existsSync(path.join(this.cacheDir, firstFile))) {
      throw new Error(refuseCollision(firstFile, 'flat'));
    }
    // And this one: a TEXT-ONLY download of a filename that is already a vision
    // model's folder. Publisher A ships the filename with an mmproj (folder),
    // publisher B ships the same filename without one (flat) — and the flat path
    // cannot even see the folder's manifest, which lives inside the folder, so
    // the different-publisher guard below never fires for it.
    if (dir === this.cacheDir && isDirectory(path.join(this.cacheDir, firstFile.replace(/\.gguf$/i, '')))) {
      throw new Error(refuseCollision(firstFile, 'folder'));
    }
    // The manifest is what makes this download resumable after a crash — write
    // it BEFORE any bytes, so a crash one second from now still leaves a trail.
    // mkdir here (not only in run()) because the manifest lands in the same dir.
    fs.mkdirSync(dir, { recursive: true });
    const prior = readManifest(dir, firstFile);
    // WHY isManifestComplete: a manifest now stays behind after the download
    // finishes, and a FINISHED download is not "partly downloaded" — only an
    // unstamped manifest means there are half-fetched bytes on disk to protect.
    // prior.repo === null is an untraceable record (§E3's "not found" marker),
    // never a rival publisher — it must not block anything.
    if (prior && !isManifestComplete(prior) && prior.repo !== null && prior.repo !== repo) {
      // Same filename, different publisher: the .partial on disk holds ANOTHER
      // build's bytes, and Range-continuing it would fail the integrity check
      // only after the whole remainder was fetched. The prior download has a
      // row in Local Models (its manifest alone makes one), so the user can
      // delete it there.
      throw new Error(
        `${firstFile} is already partly downloaded from ${prior.repo}. `
        + `Delete that download in Local Models before downloading it from ${repo}.`
      );
    }
    writeManifest(dir, repo, quant, Date.now());

    const downloadId = ulid();
    const abort = new AbortController();
    const entry: ActiveDownload = {
      key, abort, cancelled: false, promise: Promise.resolve(),
    };
    entry.promise = this.run(downloadId, repo, quant, dir, entry, onProgress)
      .finally(() => { /* keep the entry until wait() consumers observe it */ });
    this.active.set(downloadId, entry);
    return downloadId;
  }

  async wait(downloadId: string): Promise<void> {
    const entry = this.active.get(downloadId);
    if (!entry) return;
    try { await entry.promise; } finally { this.active.delete(downloadId); }
  }

  cancel(downloadId: string): void {
    const entry = this.active.get(downloadId);
    if (!entry) return;
    entry.cancelled = true;
    entry.abort.abort();
  }


  private async run(
    downloadId: string, repo: string, quant: QuantOption, dir: string,
    entry: ActiveDownload, onProgress: (p: DownloadProgress) => void
  ): Promise<void> {
    const vision = quant.visionFile ?? null;
    // The projector is its own LEG of this job, never a member of `quant.files`
    // — that list means "the split parts of this quant, complete 1..N", and
    // several readers judge a download finished from it alone. Counting it as
    // one more part here is only about what the user is shown: the bar and the
    // "part 2 of 2" line have to cover the bytes actually being fetched.
    const parts = quant.files.length + (vision ? 1 : 0);
    const base: Omit<DownloadProgress, 'state' | 'receivedBytes' | 'currentPart'> = {
      downloadId, repo, quant: quant.quant, parts,
      totalBytes: quant.totalSizeBytes + (vision?.size ?? 0),
    };
    let doneBytes = 0; // completed parts
    // Set the moment every WEIGHT file is published: from here on the model
    // itself works, so a failure in the projector leg is reported as that and
    // nothing else (design §E2 — "a failed projector leg leaves the model
    // complete, in the 'available' state").
    let weightsPublished = false;
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < quant.files.length; i++) {
        const filePath = quant.files[i];
        const fileName = path.basename(filePath);
        const finalPath = path.join(dir, fileName);
        const partialPath = `${finalPath}.partial`;
        if (fs.existsSync(finalPath)) { // already installed (re-download after partial delete)
          doneBytes += fs.statSync(finalPath).size;
          continue;
        }
        const emit = (received: number, state: DownloadProgress['state'] = 'downloading') =>
          onProgress({ ...base, state, receivedBytes: doneBytes + received, currentPart: i + 1 });

        const received = await this.downloadFile(
          hfResolveUrl(repo, filePath), partialPath, entry.abort.signal, emit
        );

        const expected = quant.sha256ByFile[filePath];
        if (expected) {
          emit(received, 'verifying');
          const actual = await sha256File(partialPath);
          if (actual !== expected) {
            fs.rmSync(partialPath, { force: true });
            throw new Error(`${fileName} failed its integrity check — the download was corrupted. Please try again.`);
          }
        }
        // Publish atomically — the router only ever sees whole files.
        fs.renameSync(partialPath, finalPath);
        doneBytes += received;
      }
      weightsPublished = true;
      // Clean completion of the WHOLE set. The manifest is STAMPED, not deleted:
      // the finished model still needs its repo and its vision projector, and
      // `completedAt` is what tells every reader this is a record rather than an
      // interrupted download. Deliberately NOT in a finally: cancel and error
      // must leave it unstamped, because that is exactly when the user will
      // want to resume.
      //
      // Stamped BEFORE the projector leg, on purpose: the weights are on disk
      // and the model is usable now, and a projector that never arrives is not
      // an interrupted download to resume — it is the `vision: 'available'`
      // state, whose recovery is "Add vision" (design §E2/§E4).
      markManifestComplete(dir, path.basename(quant.files[0]), Date.now());
      if (vision) {
        const fileName = path.basename(vision.path);
        const finalPath = path.join(dir, fileName);
        if (fs.existsSync(finalPath)) {
          doneBytes += fs.statSync(finalPath).size;
        } else {
          const partialPath = `${finalPath}.partial`;
          const emit = (received: number, state: DownloadProgress['state'] = 'downloading') =>
            onProgress({ ...base, state, receivedBytes: doneBytes + received, currentPart: parts });
          const received = await this.downloadFile(
            hfResolveUrl(repo, vision.path), partialPath, entry.abort.signal, emit
          );
          if (vision.sha256) {
            emit(received, 'verifying');
            const actual = await sha256File(partialPath);
            if (actual !== vision.sha256) {
              fs.rmSync(partialPath, { force: true });
              throw new Error(`${fileName} failed its integrity check — the download was corrupted. Please try again.`);
            }
          }
          fs.renameSync(partialPath, finalPath);
          doneBytes += received;
        }
      }
      onProgress({ ...base, state: 'done', receivedBytes: doneBytes, currentPart: parts });
    } catch (e: any) {
      if (entry.cancelled) {
        onProgress({ ...base, state: 'cancelled', receivedBytes: doneBytes, currentPart: parts });
        throw new Error('Download cancelled.');
      }
      const detail = e?.message ?? String(e);
      // The real failure, forwarded — never a guessed cause. The only thing
      // added is the fact this code KNOWS and the user cannot see: the weights
      // are already on disk, so the model works and only its eye is missing.
      // The forwarded detail is another system's sentence and may end without
      // punctuation ("socket hang up"), which would run straight into the next
      // sentence. Close it rather than reword it — the real cause must survive
      // verbatim.
      const closed = /[.!?]$/.test(detail.trim()) ? detail.trim() : `${detail.trim()}.`;
      const message = weightsPublished
        ? `The model downloaded, but its vision file did not: ${closed} `
          + `You can add it later from the model's row in Local Models.`
        : detail;
      onProgress({ ...base, state: 'error', receivedBytes: doneBytes, currentPart: parts, message });
      throw e;
    }
  }

  /** One file → .partial with Range resume. Returns total bytes of the file. */
  private async downloadFile(
    url: string, partialPath: string, signal: AbortSignal,
    emit: (receivedInFile: number) => void
  ): Promise<number> {
    let start = 0;
    try { start = fs.statSync(partialPath).size; } catch { /* fresh */ }
    const res = await this.fetchImpl(url, {
      signal,
      headers: start > 0 ? { Range: `bytes=${start}-` } : undefined,
    });
    if (res.status === 416) { fs.rmSync(partialPath, { force: true }); return this.downloadFile(url, partialPath, signal, emit); }
    if (!res.ok && res.status !== 206) throw new Error(`Hugging Face responded with HTTP ${res.status}.`);
    if (start > 0 && res.status !== 206) { fs.rmSync(partialPath, { force: true }); start = 0; } // Range ignored → restart
    if (!res.body) throw new Error('Empty download response.');
    const ws = fs.createWriteStream(partialPath, { flags: start > 0 ? 'a' : 'w' });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let received = start;
    let lastEmit = 0;
    try {
      for (;;) {
        // K3: don't rely SOLELY on fetch honoring the signal — check each turn
        // so a cancel always breaks the loop (and reject the in-flight read).
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        await new Promise<void>((resolve, reject) => ws.write(value, (err) => (err ? reject(err) : resolve())));
        const now = Date.now();
        if (now - lastEmit >= PROGRESS_INTERVAL_MS) { lastEmit = now; emit(received); }
      }
      emit(received);
      return received;
    } finally {
      await new Promise<void>((resolve) => ws.end(() => resolve()));
    }
  }
}

/** Is this path a directory? False for "absent" and for "a file". */
function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** The refusal for a flat/folder name collision, in both directions.
 *
 *  It leads with DELETE, not with "Add vision": the Add-vision link only appears
 *  on a row whose manifest names a projector, and every download made before
 *  this feature has no manifest at all — Destin's own `gemma-4-E2B-it-Q8_0` is
 *  exactly that case, and unsloth's repo for it does ship an mmproj. Telling him
 *  to click a link that is not on the row would be a misleading instruction, and
 *  §E3's backfill can permanently record `repo: null` for a model it cannot
 *  identify, which would leave the link missing forever. So the action that
 *  always works comes first, and the better one is offered conditionally. */
function refuseCollision(firstFile: string, existing: 'flat' | 'folder'): string {
  const what = existing === 'flat'
    ? `${firstFile} is already downloaded without its vision file.`
    : `${firstFile} is already downloaded as a model that can see images.`;
  return `${what} Delete it in Local Models and download it again. `
    + `If its row offers "Add vision", that adds the vision file on its own and keeps the model you have.`;
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}
