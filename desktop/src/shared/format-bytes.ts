// The ONE place a file or download size becomes words (card #143, Destin 2026-11-12: "go ahead with 1000-based sizes").
//
// WHY 1000, not 1024: Hugging Face, macOS Finder, Linux file managers and every download page count 1 GB as 1,000,000,000
// bytes. The app counted 1 GB as 1,073,741,824, so the same model read 74.2 GB here and 79.7 GB on its download page.
// About twenty places each had their own copy of the divide-by-1024 arithmetic; they all call this now, and
// tests/format-bytes-guard.test.ts fails if a new copy appears.
//
// NOT covered, on purpose: memory arithmetic that decides whether a model fits (GiB constants in main/models) — those compare
// bytes with bytes and never show a unit — and fixed "limit" sentences written as round numbers ("25 MB").

const KB = 1_000;
export const MB = 1_000_000;
const GB = 1_000_000_000;

export interface FormatBytesOptions {
  /** Digits after the point for KB. Default 1 ("12.3 KB"); 0 gives "12 KB". */
  kbDecimals?: 0 | 1;
  /** "10 MB" instead of "10.0 MB" when the number is whole (a limit reads as a person's number). */
  trimZero?: boolean;
  /** No space before the unit ("4KB") — the session card's tight style. */
  compact?: boolean;
}

/** "812 B", "12.3 KB", "24.3 MB", "3.3 GB". Empty string for a bad number. */
export function formatBytes(bytes: number, opts: FormatBytesOptions = {}): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const { kbDecimals = 1, trimZero = false, compact = false } = opts;
  const sp = compact ? '' : ' ';
  const num = (v: number, d: number) => {
    const s = v.toFixed(d);
    return trimZero && Number(s) === Math.trunc(Number(s)) ? String(Math.trunc(Number(s))) : s;
  };
  if (bytes < KB) return `${Math.round(bytes)}${sp}B`;
  // A value that would round up to "1000.0 KB" belongs to the next unit.
  if (bytes < MB && Number((bytes / KB).toFixed(kbDecimals)) < 1000) return `${num(bytes / KB, kbDecimals)}${sp}KB`;
  if (bytes < GB && Number((bytes / MB).toFixed(1)) < 1000) return `${num(bytes / MB, 1)}${sp}MB`;
  return `${num(bytes / GB, 1)}${sp}GB`;
}

/** Always gigabytes with one decimal, even when small ("0.9 GB") — model cards and download lines. */
export function formatGb(bytes: number): string {
  return `${formatGbNumber(bytes)} GB`;
}

/** The number alone, for "74.2 of 113.0 GB" where one unit ends the phrase. */
export function formatGbNumber(bytes: number): string {
  return ((Number.isFinite(bytes) ? bytes : 0) / GB).toFixed(1);
}

/** Whole megabytes — a download progress line ("412 MB"). */
export function formatMbWhole(bytes: number): string {
  return `${Math.round((Number.isFinite(bytes) ? bytes : 0) / MB)} MB`;
}
