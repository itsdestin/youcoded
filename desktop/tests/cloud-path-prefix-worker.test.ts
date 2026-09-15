import { beforeEach, expect, it, vi } from 'vitest';
const disk = vi.hoisted(() => ({ size: 100, readLengths: [] as number[], closes: 0 }));
vi.mock('../src/main/cloud-files/windows-metadata', () => ({ createWindowsMetadataProbe: () => ({ probe: () => ({ kind: 'observed', residency: 'local' }) }) }));
vi.mock('node:fs/promises', () => ({ default: {
  stat: async () => ({ size: disk.size, mtimeMs: 7, isFile: () => true }),
  open: async () => ({
    stat: async () => ({ size: disk.size, mtimeMs: 7, isFile: () => true }),
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      disk.readLengths.push(length);
      const bytesRead = Math.min(length, Math.max(0, disk.size - position));
      buffer.fill(65, offset, offset + bytesRead); return { bytesRead };
    },
    close: async () => { disk.closes++; },
  }),
} }));
import { runCloudWorker } from '../src/main/cloud-files/io-worker';
import { encodeCloudRequest } from '../src/main/cloud-files/worker-protocol';
async function read(prefix: boolean, maxBytes: number) {
  return new Promise<any>(resolve => {
    let receive!: (event: { data: unknown }) => void;
    runCloudWorker({ on: (_event, listener) => { receive = listener; }, postMessage: wire => resolve(JSON.parse(wire).result) });
    receive({ data: encodeCloudRequest({ id: 1, generation: 1, command: { kind: 'path-read', path: '/large.md', maxBytes, prefix, allowDownload: false } }) });
  });
}
beforeEach(() => { disk.size = 100; disk.readLengths = []; disk.closes = 0; });
it('production worker reads only the prefix and reports full metadata size', async () => {
  const result = await read(true, 10);
  expect(result).toMatchObject({ kind: 'path-ready', sizeBytes: 100 });
  expect(Buffer.from(result.base64, 'base64')).toHaveLength(10);
  expect(disk.readLengths).toEqual([10]); expect(disk.closes).toBe(1);
});
it('full reads still refuse over cap without opening content', async () => {
  expect(await read(false, 10)).toMatchObject({ kind: 'too-large' });
  expect(disk.readLengths).toEqual([]);
});
it('a full-read window consumes the entire file below its cap', async () => {
  const result = await read(false, 120);
  expect(Buffer.from(result.base64, 'base64')).toHaveLength(100);
  expect(disk.closes).toBe(1);
});
