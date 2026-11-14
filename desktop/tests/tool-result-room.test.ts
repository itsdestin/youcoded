// The cut that sizes a tool result to the room left in the chat (review deck 2 Q-1, 2026-11-12).
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import { capResultToRoom, capResultAndSave } from '../src/main/harness/tool-result-room';
import { spillDirFor } from '../src/main/harness/tools/spill-paths';

const SESSION = 'tool-result-room-test';
afterEach(() => { fs.rmSync(spillDirFor(SESSION), { recursive: true, force: true }); });

const big = (n: number) => `START-${'x'.repeat(n)}-END exit code 1`;

describe('capResultToRoom', () => {
  it('returns a result that fits untouched', () => {
    expect(capResultToRoom('short', 10)).toBe('short');
  });
  it('keeps both ends by default, so a command error on the last lines survives', () => {
    const out = capResultToRoom(big(20_000), 1_000);
    expect(out.startsWith('START-')).toBe(true);
    expect(out.endsWith('-END exit code 1')).toBe(true);
    expect(out).toMatch(/characters from the middle were dropped/);
    expect(out.length).toBeLessThan(3_000 + 400);
  });
  it('keeps only the beginning of a file, where the next offset continues', () => {
    const out = capResultToRoom(big(20_000), 1_000, { headOnly: true, hint: 'Re-run with a narrower offset/limit window' });
    expect(out.startsWith('START-')).toBe(true);
    expect(out).not.toContain('-END exit code 1');
    expect(out).toMatch(/narrower offset\/limit window\.\]$/);
  });
  it('never gives less than the floor, however little room is left', () => {
    expect(capResultToRoom(big(20_000), -500).length).toBeGreaterThan(2_000);
  });
});

describe('capResultAndSave', () => {
  it('saves the whole result and names the file when it cuts', async () => {
    const text = big(20_000);
    const out = await capResultAndSave(SESSION, 'Grep', text, 1_000, 'Re-run with a narrower pattern');
    const m = out.match(/saved at (\S+\.txt)/);
    expect(m).not.toBeNull();
    expect(m![1].startsWith(spillDirFor(SESSION))).toBe(true);
    expect(fs.readFileSync(m![1], 'utf8')).toBe(text);
  });
  it('writes nothing when the result fits', async () => {
    expect(await capResultAndSave(SESSION, 'Grep', 'short', 1_000)).toBe('short');
    expect(fs.existsSync(spillDirFor(SESSION))).toBe(false);
  });
  it('does not save a file read or a command preview: both already exist on disk', async () => {
    for (const tool of ['Read', 'Bash']) {
      const out = await capResultAndSave(SESSION, tool, big(20_000), 1_000);
      expect(out).not.toMatch(/saved at/);
    }
    expect(fs.existsSync(spillDirFor(SESSION))).toBe(false);
  });
});
