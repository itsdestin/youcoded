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
});
