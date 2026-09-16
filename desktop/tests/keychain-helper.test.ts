import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import ts from 'typescript';

function load() {
  const calls: string[] = [];
  let ready!: () => void;
  const app = {
    setName: vi.fn((v: string) => calls.push(`name:${v}`)),
    setPath: vi.fn((k: string, v: string) => calls.push(`${k}:${v}`)),
    whenReady: vi.fn(() => new Promise<void>((r) => { ready = r; })),
    exit: vi.fn(),
  };
  const proc = Object.assign(new EventEmitter(), {
    env: { YOUCODED_KEYCHAIN_NAME: 'YouCoded Dev', YOUCODED_KEYCHAIN_SCRATCH: '/tmp/private' },
    send: vi.fn((_value: unknown, callback?: () => void) => callback?.()),
    connected: true,
  });
  const operation = vi.fn(() => ({ ok: true, value: true }));
  const source = fs.readFileSync(path.resolve(__dirname, '../src/main/providers/keychain-helper.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(compiled, { process: proc, exports: {}, Buffer, require: (name: string) => {
    if (name === 'electron') return { app, safeStorage: {} };
    if (name === './keychain-operation') return { keychainOperation: operation };
    throw new Error(`Unexpected helper dependency: ${name}`);
  } });
  return { app, proc, calls, operation, ready: () => ready() };
}

describe('minimal Electron keychain helper', () => {
  it('sets exact identity and isolated paths before waiting for ready', async () => {
    const h = load();
    expect(h.calls).toEqual(['name:YouCoded Dev', 'userData:/tmp/private', 'sessionData:/tmp/private']);
    h.proc.emit('message', { operation: 'available' });
    expect(h.operation).not.toHaveBeenCalled();
    h.ready();
    await vi.waitFor(() => expect(h.proc.send).toHaveBeenCalledWith({ ok: true, value: true }, expect.any(Function)));
  });
  it('exits on parent disconnect without importing normal services', () => {
    const h = load();
    h.proc.emit('disconnect');
    expect(h.app.exit).toHaveBeenCalledWith(0);
  });
  it('rejects malformed or oversized requests without touching the keychain', async () => {
    const h = load();
    h.ready();
    h.proc.emit('message', { operation: 'unknown' });
    h.proc.emit('message', { operation: 'encrypt', value: 'x'.repeat(16 * 1024 * 1024 + 1) });
    expect(h.operation).not.toHaveBeenCalled();
    expect(h.app.exit).toHaveBeenCalledWith(1);
  });
});
