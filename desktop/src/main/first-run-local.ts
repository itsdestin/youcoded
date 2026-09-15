// First-run local models (design youcoded-dev docs/archive/design/2026-09-14-first-run-local-models).
//
// The pure decisions behind "Use a local model" on the setup card, kept apart
// from FirstRunManager and ipc-handlers so a test can pin them without a
// machine, a download or an engine:
//   - which curated model setup suggests for this computer (Q-3);
//   - the record of the download setup finished on, and what the band above
//     the message box says about it (Q-4/Q-7, round 3 review B-5/B-6).
import fs from 'fs';
import path from 'path';
import type { CuratedModel, DownloadProgress, InstalledLocalModel } from '../shared/model-manager-types';

const GiB = 1024 ** 3;

/**
 * The curated model setup suggests. WHY never a 'large' one: those are tens of
 * gigabytes, the wrong first download for someone who has not tried a local
 * model yet — the full list is one button away for anyone who wants one.
 * Below 16 GB the small tier (the smallest of it under 12 GB, whose memory an
 * 8 GB laptop's OS already half-fills); otherwise the first everyday model.
 */
export function pickSuggestedModel(curated: CuratedModel[], totalMemoryBytes: number): CuratedModel | null {
  if (curated.length === 0) return null;
  const small = curated.filter((m) => m.tier === 'small');
  const everyday = curated.filter((m) => m.tier === 'everyday');
  if (totalMemoryBytes < 16 * GiB) {
    if (small.length === 0) return everyday[0] ?? curated[0];
    return totalMemoryBytes < 12 * GiB ? small[0] : small[small.length - 1];
  }
  return everyday[0] ?? small[small.length - 1] ?? curated[0];
}

/** The download setup finished on — the only download the band ever announces. */
export interface SetupDownloadRecord {
  repo: string;
  quant: string;
  label: string;
  startedAt: number;
}

const RECORD_FILE = 'first-run-local-download.json';

export function readSetupDownload(dir: string): SetupDownloadRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, RECORD_FILE), 'utf8'));
    return parsed && typeof parsed.repo === 'string' && typeof parsed.quant === 'string' ? parsed : null;
  } catch { return null; }
}

export function writeSetupDownload(dir: string, record: SetupDownloadRecord): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, RECORD_FILE), JSON.stringify(record, null, 2));
}

export function clearSetupDownload(dir: string): void {
  try { fs.rmSync(path.join(dir, RECORD_FILE), { force: true }); } catch { /* nothing to clear */ }
}

/** What the band above the message box shows — shape shared with the renderer's strip. */
export interface SetupDownloadStatus {
  state: 'downloading' | 'stopped' | 'done';
  modelLabel: string;
  percent: number;
  minutesLeft: number | null;
}

const pct = (received: number, total: number | null | undefined) =>
  total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;

/**
 * The band's answer. Null means "show nothing", and it is null whenever anything
 * else can already answer (round 3 review B-5: only the first download, when the
 * app would otherwise be unusable — never an ordinary download from Settings).
 */
export function computeSetupDownloadStatus(input: {
  record: SetupDownloadRecord | null;
  otherUsable: boolean;
  /** The newest progress event for the record's repo + quant this launch, and the first one seen. */
  live: { latest: DownloadProgress; first: { at: number; bytes: number } } | null;
  installed: InstalledLocalModel[];
  now: number;
}): SetupDownloadStatus | null {
  const { record, otherUsable, live, installed, now } = input;
  if (!record || otherUsable) return null;
  const base = { modelLabel: record.label };

  const row = installed.find((m) => m.repo === record.repo && m.quant === record.quant);
  if (row?.status === 'complete' || live?.latest.state === 'done') return { ...base, state: 'done', percent: 100, minutesLeft: null };

  if (live && (live.latest.state === 'downloading' || live.latest.state === 'verifying')) {
    const { receivedBytes, totalBytes } = live.latest;
    const elapsed = now - live.first.at;
    const rate = elapsed > 0 ? (receivedBytes - live.first.bytes) / elapsed : 0; // bytes per ms
    // WHY a 5-second floor: the first seconds of a download are a burst that
    // would promise a time the rest of it cannot keep.
    const minutesLeft = elapsed >= 5000 && rate > 0 && totalBytes > receivedBytes
      ? Math.max(1, Math.ceil((totalBytes - receivedBytes) / rate / 60000))
      : null;
    return { ...base, state: 'downloading', percent: pct(receivedBytes, totalBytes), minutesLeft };
  }

  if (row?.status === 'unfinished' || live) {
    return { ...base, state: 'stopped', percent: row ? pct(row.sizeBytes, row.totalSizeBytes) : 0, minutesLeft: null };
  }
  // Recorded, but nothing on disk and nothing moving yet: the download is starting.
  return { ...base, state: 'downloading', percent: 0, minutesLeft: null };
}
