// How long loads take on this machine — the loading bar's estimate where the
// engine's bytes cannot be measured (Windows, macOS).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LoadTimes } from '../src/main/engine/load-times';

let dir: string;
let file: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-times-')); file = path.join(dir, 'load-times.json'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const GB = 1e9;

describe('LoadTimes', () => {
  it('has no estimate before any load was timed', () => {
    expect(new LoadTimes(file).expected('m', 10 * GB)).toBeNull();
  });

  it("a model's own past load is its estimate, and a second load moves it only halfway", () => {
    const t = new LoadTimes(file);
    t.record('m', 30 * GB, 12_000);
    expect(t.expected('m', 30 * GB)).toBe(12_000);
    t.record('m', 30 * GB, 40_000); // one slow load (busy machine)
    expect(t.expected('m', 30 * GB)).toBe(26_000);
  });

  it('a model never loaded here borrows the machine speed, scaled by size', () => {
    const t = new LoadTimes(file);
    t.record('big', 30 * GB, 12_000);
    expect(t.expected('new', 15 * GB)).toBe(6_000);
    expect(t.expected('new', null)).toBeNull();
  });

  it('ignores a "load" too short to be one (the model was already in memory)', () => {
    const t = new LoadTimes(file);
    t.record('m', GB, 300);
    expect(t.expected('m', GB)).toBeNull();
  });

  it('survives a restart of the app', async () => {
    new LoadTimes(file).record('m', 30 * GB, 12_000);
    await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true));
    const again = new LoadTimes(file);
    await vi.waitFor(() => expect(again.expected('m', 30 * GB)).toBe(12_000));
  });

  it('an unreadable history file just means no estimate', () => {
    fs.writeFileSync(file, '{not json');
    expect(() => new LoadTimes(file).expected('m', GB)).not.toThrow();
  });
});
