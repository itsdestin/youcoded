// The engine's output kept on disk, bounded, and never able to hurt the engine.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openEngineLog } from '../src/main/engine/engine-log';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-log-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

describe('engine log', () => {
  it('keeps what the engine prints, with a line marking each start', async () => {
    const file = path.join(dir, 'engine.log');
    const log = openEngineLog(file);
    log.begin(['llama-server', '--port', '9920']);
    log.write(Buffer.from('srv load_model: loading model\n'));
    await vi.waitFor(() => expect(read(file)).toContain('loading model'));
    expect(read(file)).toMatch(/===== .* engine start: llama-server --port 9920/);
  });

  it('past the size cap the file moves to engine.log.1 and a fresh one starts', async () => {
    const file = path.join(dir, 'engine.log');
    const log = openEngineLog(file, 100);
    log.write('a'.repeat(150) + '\n');
    await vi.waitFor(() => expect(read(`${file}.1`)).toContain('a'.repeat(150)));
    log.write('after the roll\n');
    await vi.waitFor(() => expect(read(file)).toContain('after the roll'));
    expect(read(file)).not.toContain('a'.repeat(150));
  });

  it('a folder that cannot be written means no log, never an error', async () => {
    const log = openEngineLog(path.join(dir, 'missing', 'engine.log'));
    expect(() => { log.write('x\n'); log.write('y\n'); }).not.toThrow();
  });

  it('close() resolves only once the file is on disk, so nothing lands after it', async () => {
    // WHY (CI flake, engine-manager-router T23): the open and the writes are async, so
    // a stopped engine used to create/append engine.log after stop() returned and a
    // temp-folder cleanup raced it (ENOTEMPTY). Nothing here waits or sleeps: close()
    // itself is the thing awaited, and the file must be complete the instant it resolves.
    const file = path.join(dir, 'engine.log');
    const log = openEngineLog(file);
    log.begin(['llama-server']);
    log.write('last words\n');
    await log.close();
    expect(read(file)).toContain('last words');
    const before = fs.readdirSync(dir);
    // A plain removal (no retries) is what a clean teardown looks like.
    expect(() => fs.rmSync(dir, { recursive: true })).not.toThrow();
    expect(before).toEqual(['engine.log']);
    fs.mkdirSync(dir); // afterEach removes it again
  });

  it('close() on a log that never wrote, or twice, is harmless; a later write reopens', async () => {
    const file = path.join(dir, 'engine.log');
    const log = openEngineLog(file);
    await log.close();
    log.write('one\n');
    await log.close();
    await log.close();
    log.write('two\n');
    await log.close();
    expect(read(file)).toBe('one\ntwo\n');
  });
});
