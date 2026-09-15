import { describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { readStripped } from './helpers/guard-scope';
import { createWindowsMetadataProbe } from '../src/main/cloud-files/windows-metadata';

const path = 'C:\\Users\\Example\\OneDrive\\report.txt';
function fixture(attributes = 0x80, error = 0) {
  const query = vi.fn((_path: string) => attributes);
  const lastError = vi.fn(() => error);
  const func = vi.fn((signature: string) => signature.includes('GetFileAttributesW') ? query : lastError);
  const load = vi.fn(() => ({ func }));
  const loadKoffi = vi.fn(() => ({ load }));
  const isOwnedWorker = vi.fn(() => true);
  const probe = createWindowsMetadataProbe({ platform: 'win32', isOwnedWorker, loadKoffi });
  return { probe, query, lastError, func, load, loadKoffi, isOwnedWorker };
}

describe('Windows display metadata only', () => {
  it('has no data-open, enumeration, or Node filesystem fallback in the display probe', () => {
    const source = readStripped(join(__dirname, '../src/main/cloud-files/windows-metadata.ts'));
    expect(source).toContain('GetFileAttributesW');
    expect(source).not.toMatch(/\b(?:CfOpen\w*|CreateFile\w*|ReadFile\w*|FindFirst\w*|FindNext\w*|readFile\w*|statSync|lstatSync|readdir\w*)\b/);
    expect([...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(match => match[1])).toEqual(['koffi']);
    expect(source).not.toMatch(/\bimport\s/);
  });
  it.each([
    [0x80, 'local', 'file', 'ordinary-attributes'],
    [0x400000, 'partial', 'file', 'recall-on-data-access'],
    [0x1000, 'partial', 'file', 'offline'],
    [0x10, 'local', 'directory', 'ordinary-attributes'],
    [0x400010, 'partial', 'directory', 'directory-recall-on-data-access'],
    [0x1010, 'partial', 'directory', 'offline'],
    [0x400, 'unknown', 'file', 'unrecognized-reparse-point'],
    [0x410, 'unknown', 'directory', 'unrecognized-reparse-point'],
    [0x40000, 'local', 'file', 'ordinary-attributes'], // EA, NOT enumeration RECALL_ON_OPEN
    [0x480400, 'partial', 'file', 'recall-on-data-access'], // pinned is not hydrated
    [0x1800, 'partial', 'file', 'offline'],
    [0x100000, 'local', 'file', 'ordinary-attributes'], // unpinned is not proof either
  ])('classifies attributes %i conservatively', (attributes, residency, entryType, reason) => {
    const f = fixture(attributes as number);
    expect(f.probe.probe(path)).toEqual({ kind: 'observed', residency, entryType, attributes, reason, identityCapability: 'unavailable' });
    expect(f.query).toHaveBeenCalledExactlyOnceWith(path);
    expect(f.lastError).not.toHaveBeenCalled();
  });

  it('loads lazily and binds only the two documented Win32 signatures', () => {
    const f = fixture();
    expect(f.loadKoffi).not.toHaveBeenCalled();
    f.probe.probe(path);
    f.probe.probe(path);
    expect(f.loadKoffi).toHaveBeenCalledTimes(1);
    expect(f.load).toHaveBeenCalledExactlyOnceWith('kernel32.dll');
    expect(f.func.mock.calls).toEqual([
      ['uint32_t __stdcall GetFileAttributesW(const char16_t *lpFileName)'],
      ['uint32_t __stdcall GetLastError(void)'],
    ]);
    expect(f.probe.probe(path)).not.toHaveProperty('provider');
    expect(f.probe.probe(path)).not.toHaveProperty('identity');
    expect(f.probe.probe(path)).not.toHaveProperty('noRecall');
  });

  it.each([[2, 'not-found', 'not-found'], [3, 'not-found', 'not-found'], [5, 'error', 'access-denied'], [1234, 'error', 'native-query-failed']])('keeps native error %i distinct', (code, kind, reason) => {
    const f = fixture(0xffffffff, code as number);
    expect(f.probe.probe(path)).toMatchObject({ kind, reason, residency: 'unknown', attributes: null, entryType: 'unknown' });
    expect(f.lastError).toHaveBeenCalledTimes(1);
    expect(f.query.mock.invocationCallOrder[0]).toBeLessThan(f.lastError.mock.invocationCallOrder[0]);
  });

  it('sanitizes query exceptions without falling back to another operation', () => {
    const f = fixture();
    f.query.mockImplementation(() => { throw new Error(path); });
    const result = f.probe.probe(path);
    expect(result).toMatchObject({ kind: 'error', residency: 'unknown', reason: 'native-query-failed' });
    expect(JSON.stringify(result)).not.toContain(path);
    expect(f.lastError).not.toHaveBeenCalled();
    expect(f.func).toHaveBeenCalledTimes(2);
  });

  it('reports missing DLL as unsupported and never exposes its exception', () => {
    const f = fixture();
    f.load.mockImplementation(() => { throw new Error(path); });
    expect(f.probe.probe(path)).toMatchObject({ kind: 'unsupported', reason: 'native-unavailable', residency: 'unknown' });
    expect(JSON.stringify(f.probe.probe(path))).not.toContain(path);
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.query).not.toHaveBeenCalled();
  });

  it.each(['linux', 'darwin'])('does not load koffi on %s', platform => {
    const loadKoffi = vi.fn(() => { throw new Error('must not load'); });
    const probe = createWindowsMetadataProbe({ platform, isOwnedWorker: () => true, loadKoffi });
    expect(probe.probe(path)).toMatchObject({ kind: 'unsupported', reason: 'platform-unsupported' });
    expect(loadKoffi).not.toHaveBeenCalled();
  });

  it('requires the host-owned worker guard before loading and before every native call', () => {
    const f = fixture();
    f.isOwnedWorker.mockReturnValue(false);
    expect(f.probe.probe(path)).toMatchObject({ kind: 'unsupported', reason: 'owned-worker-required' });
    expect(f.loadKoffi).not.toHaveBeenCalled();
    f.isOwnedWorker.mockReturnValue(true);
    f.probe.probe(path);
    f.isOwnedWorker.mockReturnValue(false);
    f.probe.probe(path);
    expect(f.query).toHaveBeenCalledTimes(1);
  });

  it.each([null, undefined, 1, {}, '', 'relative.txt', 'C:relative', 'C:\\a\0b', 'C:\\*.txt', 'C:\\a?.txt', 'C:\\' + 'a'.repeat(32764)])('rejects malformed paths without native calls: %j', input => {
    const f = fixture();
    expect(f.probe.probe(input)).toMatchObject({ kind: 'error', reason: 'invalid-path', residency: 'unknown' });
    expect(f.loadKoffi).not.toHaveBeenCalled();
  });

  it.each(['\\\\server\\share\\file', '\\\\?\\C:\\folder\\file', '\\\\?\\UNC\\server\\share\\file', 'C:\\emoji-😀.txt'])('passes exact Unicode/UNC paths unchanged: %s', input => {
    const f = fixture();
    f.probe.probe(input);
    expect(f.query).toHaveBeenCalledExactlyOnceWith(input);
  });

  it.each(['C:\\NUL', 'C:\\folder\\CON.txt', 'C:\\COM1', 'C:\\aux.log', 'C:\\LPT9', 'C:\\COM¹.txt', 'C:\\NUL:stream', 'C:\\con .txt', '\\\\?\\C:\\NUL', '\\\\server\\share\\PRN.txt'])('rejects reserved device components: %s', input => {
    const f = fixture();
    expect(f.probe.probe(input)).toMatchObject({ kind: 'error', reason: 'invalid-path' });
    expect(f.loadKoffi).not.toHaveBeenCalled();
  });

  it.each(['C:\\console.txt', 'C:\\COM10.txt', 'C:\\null.txt'])('keeps non-device names valid: %s', input => {
    const f = fixture();
    expect(f.probe.probe(input).kind).toBe('observed');
  });

  it('bounds batches before doing any work, including aggregate path length', () => {
    const f = fixture();
    for (const input of [null, {}, Array(65).fill(path), Array(5).fill('C:\\' + 'a'.repeat(30000)), [path, null]]) {
      expect(f.probe.probeBatch(input)).toMatchObject({ kind: 'error', reason: 'invalid-batch' });
    }
    expect(f.loadKoffi).not.toHaveBeenCalled();
    expect(f.probe.probeBatch([path, 'C:\\second'])).toMatchObject({ kind: 'batch', observations: [{ kind: 'observed' }, { kind: 'observed' }] });
    expect(f.query.mock.calls).toEqual([[path], ['C:\\second']]);
  });
});
