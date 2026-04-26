import { describe, it, expect } from 'vitest';
import { isPreviewFresh } from '../src/main/theme-marketplace-provider';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('isPreviewFresh', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-fresh-'));
  const manifestPath = path.join(tmp, 'manifest.json');
  const previewPath = path.join(tmp, 'preview.png');

  it('returns false when preview.png does not exist', () => {
    fs.writeFileSync(manifestPath, '{}');
    expect(isPreviewFresh(tmp)).toBe(false);
  });

  it('returns true when preview.png mtime is newer than manifest.json', () => {
    fs.writeFileSync(manifestPath, '{}');
    // ensure manifest is older
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(manifestPath, past, past);
    fs.writeFileSync(previewPath, 'png');
    expect(isPreviewFresh(tmp)).toBe(true);
  });

  it('returns false when preview.png mtime is older than manifest.json', () => {
    fs.writeFileSync(previewPath, 'png');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(previewPath, past, past);
    fs.writeFileSync(manifestPath, '{}');
    expect(isPreviewFresh(tmp)).toBe(false);
  });

  it('returns true when preview.png mtime equals manifest.json mtime', () => {
    fs.writeFileSync(manifestPath, '{}');
    fs.writeFileSync(previewPath, 'png');
    const t = new Date(Date.now() - 60_000);
    fs.utimesSync(manifestPath, t, t);
    fs.utimesSync(previewPath, t, t);
    expect(isPreviewFresh(tmp)).toBe(true);
  });
});
