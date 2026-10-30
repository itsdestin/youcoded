// How long models take to load on THIS machine (~/.youcoded/engine/load-times.json).
//
// WHY (2026-10-29): the loading bar measures real bytes only on Linux (/proc).
// On Windows and macOS it had nothing but a sweep and a seconds counter. Reading
// another process's I/O counters there needs native calls we cannot test from
// here, and a wrong native call can crash the app — so instead the app learns:
// every load is timed, and the next load of that model fills the bar by time
// and says "about N s left". A model never loaded here borrows the machine's
// speed from the others, scaled by file size.
//
// Per machine like the rest of the engine folder (never synced). Every read and
// write is async and best-effort: a lost file only means no estimate.

import * as fs from 'fs';

interface Entry { ms: number; sizeBytes: number | null }
interface FileShape { v: 1; models: Record<string, Entry> }

/** Ignore a "load" shorter than this — it was a model already in memory. */
const MIN_MS = 1_000;
const MAX_ENTRIES = 50;

export class LoadTimes {
  private models = new Map<string, Entry>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    void fs.promises.readFile(filePath, 'utf8').then((raw) => {
      const parsed = JSON.parse(raw) as Partial<FileShape>;
      for (const [id, e] of Object.entries(parsed.models ?? {})) {
        // Anything recorded while the file was being read wins over the old value.
        if (typeof e?.ms === 'number' && e.ms > 0 && !this.models.has(id)) {
          this.models.set(id, { ms: e.ms, sizeBytes: typeof e.sizeBytes === 'number' ? e.sizeBytes : null });
        }
      }
    }).catch(() => { /* no history yet, or unreadable — start fresh */ });
  }

  /** Milliseconds this model's load is expected to take, or null with no basis. */
  expected(modelId: string, sizeBytes: number | null): number | null {
    const own = this.models.get(modelId);
    if (own) return Math.round(own.ms);
    if (!sizeBytes) return null;
    // The machine's typical speed (median bytes per ms) across other models.
    const rates = [...this.models.values()]
      .filter((e) => e.sizeBytes && e.sizeBytes > 0)
      .map((e) => e.sizeBytes! / e.ms)
      .sort((a, b) => a - b);
    if (!rates.length) return null;
    return Math.round(sizeBytes / rates[Math.floor(rates.length / 2)]);
  }

  /** Remember one finished load. Averages with the last one, so a single slow
   *  load (a cold disk, a busy machine) moves the estimate only halfway. */
  record(modelId: string, sizeBytes: number | null, ms: number): void {
    if (!(ms >= MIN_MS)) return;
    const prev = this.models.get(modelId);
    this.models.delete(modelId); // re-insert last, so the oldest falls off first
    this.models.set(modelId, { ms: prev ? (prev.ms + ms) / 2 : ms, sizeBytes });
    while (this.models.size > MAX_ENTRIES) this.models.delete(this.models.keys().next().value!);
    const body: FileShape = { v: 1, models: Object.fromEntries(this.models) };
    // Serialized writes, each to a temp file then renamed in, so a crash
    // mid-write leaves the previous file whole.
    this.writing = this.writing.then(async () => {
      const tmp = `${this.filePath}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(body));
      await fs.promises.rename(tmp, this.filePath);
    }).catch(() => { /* best-effort */ });
  }
}
