// Saves quit had to stop are written down at quit and handed over once at the next launch
// (final review, finding 4) — so the person hears that a document couldn't be saved even though
// the app was gone when it happened.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/logger', () => ({ log: vi.fn() }));
import { recordAbandonedSaves, takeAbandonedSaves } from '../../src/main/office/abandoned-saves';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'office-abandoned-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('saves stopped at quit', () => {
  it('are handed over once, then forgotten', async () => {
    await recordAbandonedSaves(['/home/you/plan.docx'], dir);
    expect(await takeAbandonedSaves(dir)).toEqual(['/home/you/plan.docx']);
    expect(await takeAbandonedSaves(dir)).toEqual([]);
  });

  it('keep files from an earlier quit that no launch has reported yet, each once', async () => {
    await recordAbandonedSaves(['/home/you/plan.docx'], dir);
    await recordAbandonedSaves(['/home/you/plan.docx', '/home/you/budget.xlsx'], dir);
    expect(await takeAbandonedSaves(dir)).toEqual(['/home/you/plan.docx', '/home/you/budget.xlsx']);
  });

  it('ignore a damaged list, and remove it so it is not read again', async () => {
    await writeFile(path.join(dir, 'office-abandoned-saves.json'), '{not json');
    expect(await takeAbandonedSaves(dir)).toEqual([]);
    await expect(readFile(path.join(dir, 'office-abandoned-saves.json'))).rejects.toThrow();
  });

  it('never hold up quit when the folder cannot be written', async () => {
    await expect(recordAbandonedSaves(['/home/you/plan.docx'], path.join(dir, 'missing', 'deeper'))).resolves.toBeUndefined();
  });

  it('write nothing when nothing was stopped', async () => {
    await recordAbandonedSaves([], dir);
    await expect(readFile(path.join(dir, 'office-abandoned-saves.json'))).rejects.toThrow();
  });
});
