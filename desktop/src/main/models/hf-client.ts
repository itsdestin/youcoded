// Hugging Face Hub client (spec §4.2). Every consumed field is recorded in
// docs/provider-dependencies.md; parse DEFENSIVELY — rows missing required
// fields are skipped, absent optional fields become null (never guessed).
import type { HFSearchHit, QuantOption } from '../../shared/model-manager-types';
import { groupQuantOptions } from './quant-parser';

const API = 'https://huggingface.co/api';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status?: number; json: () => Promise<any> }>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Transient HTTP statuses worth retrying: 429 (rate limit) and 5xx
// (server/gateway). A 404 (repo/file absent) is permanent — don't waste retries.
function isRetryableStatus(status?: number): boolean {
  return status === 429 || (status ?? 0) >= 500;
}

export function hfResolveUrl(repo: string, filePath: string): string {
  // repo is 'owner/name' — the slash is a real URL separator; file path
  // segments are encoded individually (subfolders stay subfolders).
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${repo}/resolve/main/${encodedPath}`;
}

export class HfClient {
  private maxAttempts: number;
  private retryDelayMs: number;

  constructor(
    private fetchImpl: FetchLike = fetch as any,
    // Test seam: shrink the backoff to 0 so the retry path runs instantly.
    opts: { maxAttempts?: number; retryDelayMs?: number } = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
    this.retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
  }

  // Fetch with backoff + jitter. The Local Models panel resolves many repos'
  // quant lists at once, and that burst regularly trips transient
  // huggingface.co failures (ECONNRESET, timeouts, 429s). Retrying a couple
  // times in the background clears almost all of them — so a card only shows
  // "unavailable" after real, repeated failure, not a first-attempt flake. The
  // jitter de-syncs the parallel cards' retries so they don't re-burst in
  // lockstep. A FRESH timeout signal per attempt is required (one
  // AbortSignal.timeout would already be aborted by the time we retry).
  private async fetchWithRetry(url: string): Promise<{ ok: boolean; status?: number; json: () => Promise<any> }> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok && isRetryableStatus(res.status) && attempt < this.maxAttempts) {
          await sleep(this.retryDelayMs * attempt * (1 + Math.random()));
          continue;
        }
        return res; // ok, or a permanent failure the caller maps to a message
      } catch (e) {
        lastErr = e; // network flake / timeout — back off and retry
        if (attempt < this.maxAttempts) {
          await sleep(this.retryDelayMs * attempt * (1 + Math.random()));
          continue;
        }
      }
    }
    throw lastErr ?? new Error('Hugging Face is not reachable right now — try again in a moment.');
  }

  async search(query: string): Promise<HFSearchHit[]> {
    const url = `${API}/models?search=${encodeURIComponent(query)}&filter=gguf&sort=downloads&limit=30`;
    const res = await this.fetchWithRetry(url);
    if (!res.ok) throw new Error('Hugging Face search is not reachable right now — try again in a moment.');
    const rows = await res.json();
    const out: HFSearchHit[] = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row?.id !== 'string') continue; // skip malformed
      out.push({
        repo: row.id,
        downloads: typeof row.downloads === 'number' ? row.downloads : 0,
        likes: typeof row.likes === 'number' ? row.likes : 0,
      });
    }
    return out;
  }

  /** List a repo's downloadable quant variants. recursive=true is REQUIRED:
   *  unsloth keeps dynamic quants in subfolders.
   *
   *  NOT PAGINATED, and that is now a known gap: this reads the first page and
   *  ignores the `Link: rel="next"` header the API sends when a tree is longer.
   *  No real GGUF repo has come close (the largest measured on 2026-09-05 was 88
   *  entries), but §E3's backfill turns a listing into a PERMANENT record — a
   *  short read there costs a model its vision until the record expires, rather
   *  than one stale panel. Follow the header if a repo is ever seen truncated. */
  async quantOptions(repo: string): Promise<QuantOption[]> {
    const url = `${API}/models/${repo}/tree/main?recursive=true`;
    const res = await this.fetchWithRetry(url);
    if (!res.ok) throw new Error("Could not list this model's files on Hugging Face — try again in a moment.");
    const rows = await res.json();
    const files = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row?.type !== 'file' || typeof row?.path !== 'string' || typeof row?.size !== 'number') continue;
      files.push({
        path: row.path,
        size: row.size,
        // lfs.oid is the blob's sha256 for LFS files (all real GGUFs); absent
        // for small non-LFS files — downloader skips verification then.
        sha256: typeof row?.lfs?.oid === 'string' && /^[0-9a-f]{64}$/.test(row.lfs.oid) ? row.lfs.oid : null,
      });
    }
    return groupQuantOptions(files);
  }
}
