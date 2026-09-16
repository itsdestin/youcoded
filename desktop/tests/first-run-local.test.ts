import { describe, expect, it } from 'vitest';
import { computeSetupDownloadStatus, pickSuggestedModel, type SetupDownloadRecord } from '../src/main/first-run-local';
import type { CuratedModel, DownloadProgress, InstalledLocalModel } from '../src/shared/model-manager-types';

const GiB = 1024 ** 3;
const curated: CuratedModel[] = [
  { id: 'qwen35-2b', label: 'Qwen3.5 2B', hfRepo: 'a/2b', quantDefault: 'Q4', tier: 'small' },
  { id: 'qwen35-4b', label: 'Qwen3.5 4B', hfRepo: 'a/4b', quantDefault: 'Q4', tier: 'small' },
  { id: 'qwen35-9b', label: 'Qwen3.5 9B', hfRepo: 'a/9b', quantDefault: 'Q4', tier: 'everyday' },
  { id: 'big', label: 'Big', hfRepo: 'a/big', quantDefault: 'Q4', tier: 'large' },
];

describe('pickSuggestedModel', () => {
  it('suggests the smallest model on an 8 GB computer', () => {
    expect(pickSuggestedModel(curated, 8 * GiB)?.id).toBe('qwen35-2b');
  });
  it('suggests the largest small model between 12 and 16 GB', () => {
    expect(pickSuggestedModel(curated, 14 * GiB)?.id).toBe('qwen35-4b');
  });
  it('suggests an everyday model at 16 GB and above, and never a large one', () => {
    expect(pickSuggestedModel(curated, 16 * GiB)?.id).toBe('qwen35-9b');
    expect(pickSuggestedModel(curated, 256 * GiB)?.id).toBe('qwen35-9b');
  });
  it('answers null for an empty list', () => {
    expect(pickSuggestedModel([], 32 * GiB)).toBeNull();
  });
});

describe('computeSetupDownloadStatus', () => {
  const record: SetupDownloadRecord = { repo: 'a/9b', quant: 'Q4', label: 'Qwen3.5 9B', startedAt: 0 };
  const progress = (over: Partial<DownloadProgress>): DownloadProgress => ({
    downloadId: 'd1', repo: 'a/9b', quant: 'Q4', state: 'downloading',
    receivedBytes: 0, totalBytes: 10 * GiB, currentPart: 1, parts: 1, ...over,
  });
  const row = (over: Partial<InstalledLocalModel>): InstalledLocalModel => ({
    id: 'm', sizeBytes: 4 * GiB, quant: 'Q4', quantDescription: '', parts: 1, status: 'unfinished',
    partsPresent: 1, totalSizeBytes: 10 * GiB, repo: 'a/9b', ...over,
  } as InstalledLocalModel);

  it('shows nothing without a setup download', () => {
    expect(computeSetupDownloadStatus({ record: null, otherUsable: false, live: null, installed: [], now: 0 })).toBeNull();
  });

  it('shows nothing when anything else can already answer (B-5)', () => {
    expect(computeSetupDownloadStatus({
      record, otherUsable: true, live: { latest: progress({ receivedBytes: GiB }), first: { at: 0, bytes: 0 } }, installed: [], now: 1,
    })).toBeNull();
  });

  it('reports progress and a time left once the rate has settled', () => {
    const s = computeSetupDownloadStatus({
      record, otherUsable: false, installed: [], now: 60_000,
      live: { latest: progress({ receivedBytes: 5 * GiB }), first: { at: 0, bytes: 4 * GiB } },
    });
    expect(s).toEqual({ state: 'downloading', modelLabel: 'Qwen3.5 9B', percent: 50, minutesLeft: 5 });
  });

  it('promises no time in the first five seconds', () => {
    const s = computeSetupDownloadStatus({
      record, otherUsable: false, installed: [], now: 2_000,
      live: { latest: progress({ receivedBytes: GiB }), first: { at: 0, bytes: 0 } },
    });
    expect(s?.minutesLeft).toBeNull();
  });

  it('says stopped for a half-downloaded model after a restart (Q-7)', () => {
    const s = computeSetupDownloadStatus({ record, otherUsable: false, live: null, installed: [row({})], now: 0 });
    expect(s).toEqual({ state: 'stopped', modelLabel: 'Qwen3.5 9B', percent: 40, minutesLeft: null });
  });

  it('says done once the model is complete', () => {
    const s = computeSetupDownloadStatus({ record, otherUsable: false, live: null, installed: [row({ status: 'complete' })], now: 0 });
    expect(s?.state).toBe('done');
  });

  it('ignores another model downloading', () => {
    const s = computeSetupDownloadStatus({ record, otherUsable: false, live: null, installed: [row({ repo: 'other/repo' })], now: 0 });
    expect(s).toEqual({ state: 'downloading', modelLabel: 'Qwen3.5 9B', percent: 0, minutesLeft: null });
  });
});
