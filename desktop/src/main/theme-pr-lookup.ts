// theme-pr-lookup.ts
// Thin wrapper around `gh pr list` to check whether a theme submission has an
// open or recently-merged PR in the destinclaude-themes repo.
//
// Used by publish-state-resolver to bridge the post-merge / pre-registry-CI
// window: after a PR merges, the registry hasn't rebuilt yet, so the theme
// would otherwise flash back to "draft" for ~1 minute. findRecentlyMergedPR
// covers that gap.
//
// Both methods cache per (slug, author) pair for ttlMs (default 60s) so rapid
// navigation between theme details doesn't thrash the gh CLI. On any failure
// (gh missing, not authed, network down) they return null — callers treat that
// as "no PR found" and decide separately whether to surface a degraded-mode
// warning.

import { execFile as _execFile } from 'child_process';
import { promisify } from 'util';

const REPO = 'itsdestin/destinclaude-themes';
const DEFAULT_TTL_MS = 60_000;
// How far back to look when searching for recently-merged PRs.
const MERGED_WINDOW_MIN = 5;

export interface PRRef {
  number: number;
  url: string;
}

interface CacheEntry {
  value: PRRef | null;
  expires: number;
}

export interface ThemePRLookupOpts {
  /** Injectable execFile for testing — defaults to promisified child_process.execFile */
  execFile?: (bin: string, args: string[]) => Promise<{ stdout: string }>;
  /** Cache TTL in milliseconds — defaults to 60 000 */
  ttlMs?: number;
  /** Monotonic clock injectable for tests — defaults to Date.now */
  now?: () => number;
  /** Path to the gh binary — defaults to 'gh' (resolved via PATH) */
  ghPath?: string;
}

export class ThemePRLookup {
  private openCache = new Map<string, CacheEntry>();
  private mergedCache = new Map<string, CacheEntry>();
  private execFile: (bin: string, args: string[]) => Promise<{ stdout: string }>;
  private ttlMs: number;
  private now: () => number;
  private ghPath: string;

  constructor(opts: ThemePRLookupOpts = {}) {
    this.execFile = opts.execFile ?? (promisify(_execFile) as any);
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.ghPath = opts.ghPath ?? 'gh';
  }

  /** Bust the cache for a specific (slug, author) pair — call after submitting or merging. */
  invalidate(slug: string, author: string): void {
    const key = `${author}/${slug}`;
    this.openCache.delete(key);
    this.mergedCache.delete(key);
  }

  /** Returns the first open PR matching (slug, author), or null if none / on error. */
  async findOpenPR(slug: string, author: string): Promise<PRRef | null> {
    return this.cached(this.openCache, `${author}/${slug}`, async () => {
      const args = [
        'pr', 'list',
        '--repo', REPO,
        '--author', author,
        '--state', 'open',
        '--search', slug,
        '--json', 'number,url',
      ];
      return this.runAndParseFirst(args);
    });
  }

  /**
   * Returns the first PR merged within the last MERGED_WINDOW_MIN minutes that
   * matches (slug, author), or null if none / on error.
   *
   * This bridges the post-merge / pre-registry-CI window so the UI doesn't
   * briefly revert to "draft" state while the registry rebuild is in flight.
   */
  async findRecentlyMergedPR(slug: string, author: string): Promise<PRRef | null> {
    return this.cached(this.mergedCache, `${author}/${slug}`, async () => {
      // ISO timestamp for "5 minutes ago" — gh supports merged:>=<ISO8601> in --search
      const cutoff = new Date(this.now() - MERGED_WINDOW_MIN * 60_000).toISOString();
      const args = [
        'pr', 'list',
        '--repo', REPO,
        '--author', author,
        '--state', 'merged',
        '--search', `${slug} merged:>=${cutoff}`,
        '--json', 'number,url',
      ];
      return this.runAndParseFirst(args);
    });
  }

  // --- private helpers ---

  private async cached(
    cache: Map<string, CacheEntry>,
    key: string,
    fetcher: () => Promise<PRRef | null>,
  ): Promise<PRRef | null> {
    const hit = cache.get(key);
    if (hit && hit.expires > this.now()) return hit.value;
    const value = await fetcher();
    cache.set(key, { value, expires: this.now() + this.ttlMs });
    return value;
  }

  private async runAndParseFirst(args: string[]): Promise<PRRef | null> {
    try {
      const { stdout } = await this.execFile(this.ghPath, args);
      const arr: unknown = JSON.parse(stdout || '[]');
      if (
        Array.isArray(arr) &&
        arr.length > 0 &&
        typeof (arr[0] as any)?.number === 'number'
      ) {
        const first = arr[0] as { number: number; url: unknown };
        return { number: first.number, url: String(first.url) };
      }
      return null;
    } catch {
      // gh not installed, not authed, network error, or unexpected JSON — degrade gracefully
      return null;
    }
  }
}
