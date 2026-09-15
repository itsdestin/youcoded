import { afterEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('../src/main/cloud-files/path-access', () => ({ pathAvailability: io.probe }));
import fs from 'fs';
import { discoverProjectFiles, invalidateDiscoveryCache } from '../src/main/artifacts/project-file-discovery';
const platform = process.platform;
afterEach(() => { Object.defineProperty(process, 'platform', { value: platform }); vi.restoreAllMocks(); vi.useRealTimers(); });
it('flat Windows directories stop probing at the scan deadline and report incomplete', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.useFakeTimers(); vi.setSystemTime(0);
  invalidateDiscoveryCache('/budget-flat');
  vi.spyOn(fs.promises, 'readdir').mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ name: `${i}.md`, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false })) as any);
  vi.spyOn(fs.promises, 'stat').mockResolvedValue({ mtime: new Date(0) } as any);
  io.probe.mockImplementation(async (target: string) => {
    if (target.endsWith('.md')) vi.setSystemTime(Date.now() + 600);
    return { residency: 'local', mtimeMs: 0, sizeBytes: 4 };
  });
  const result = await discoverProjectFiles('/budget-flat');
  expect(result.truncated).toBe(true);
  expect(result.files.length).toBeLessThan(4);
  expect(io.probe.mock.calls.length).toBeLessThan(5);
});
it('a pending metadata probe cannot hold the listing past its remaining budget', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.useFakeTimers(); vi.setSystemTime(0);
  invalidateDiscoveryCache('/budget-pending');
  io.probe.mockImplementation(() => new Promise(() => {}));
  let result: any;
  void discoverProjectFiles('/budget-pending').then(value => { result = value; });
  await vi.advanceTimersByTimeAsync(1501);
  expect(result).toMatchObject({ truncated: true });
});
