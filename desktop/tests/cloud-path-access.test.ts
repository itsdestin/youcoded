import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const worker = vi.hoisted(() => ({ commands: [] as any[], size: 4, residency: 'partial' }));
vi.mock('../src/main/cloud-files/utility-worker', () => ({ spawnCloudIoWorker: (events: any) => ({
  send(wire: string) {
    const request = JSON.parse(wire); const c = request.command; worker.commands.push(c);
    const result = c.kind === 'path-probe'
      ? { kind: 'path-probe', path: c.path, residency: worker.residency, sizeBytes: worker.size, mtimeMs: 7 }
      : { kind: 'path-ready', path: c.path, base64: Buffer.from('file').toString('base64'), sizeBytes: 4, mtimeMs: 7 };
    events.message(JSON.stringify({ id: request.id, generation: request.generation, result }));
  }, kill() {},
}) }));
import { readPath } from '../src/main/cloud-files/path-access';
const platform = process.platform;
beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'win32' }); worker.commands = []; worker.size = 4; worker.residency = 'partial'; });
afterEach(() => { Object.defineProperty(process, 'platform', { value: platform }); });
const reads = () => worker.commands.filter(c => c.kind === 'path-read');
it('actual service never submits content for a preview, even with a consent token', async () => {
  const ask: any = await readPath('/project/a', { intent: 'explicit', owner: 'one' });
  expect(ask.error).toBe('needs-download');
  const preview: any = await readPath('/project/a', { intent: 'preview', owner: 'one', operationToken: ask.operationToken });
  expect(preview.error).toBe('needs-download'); expect(preview.operationToken).toBeUndefined();
  expect(reads()).toEqual([]);
});
it('binds one-use consent to exact owner/path/size/cap and never treats approved boolean as authority', async () => {
  const ask: any = await readPath('/project/a', { intent: 'explicit', owner: 'one' });
  for (const options of [
    { intent: 'explicit', owner: 'two', operationToken: ask.operationToken },
    { intent: 'explicit', owner: 'one', approved: true },
    { intent: 'explicit', owner: 'one', operationToken: ask.operationToken, maxBytes: 100 },
  ]) expect((await readPath('/project/a', options as any) as any).error).toBe('needs-download');
  expect((await readPath('/project/b', { intent: 'explicit', owner: 'one', operationToken: ask.operationToken }) as any).error).toBe('needs-download');
  worker.size = 5;
  expect((await readPath('/project/a', { intent: 'explicit', owner: 'one', operationToken: ask.operationToken }) as any).error).toBe('needs-download');
  expect(reads()).toEqual([]);
  worker.size = 4;
  const approved: any = await readPath('/project/a', { intent: 'explicit', owner: 'one', operationToken: ask.operationToken });
  expect(approved.bytes.toString()).toBe('file'); expect(reads()).toHaveLength(1);
  expect(reads()[0]).toMatchObject({ allowDownload: true, expectedSize: 4, expectedMtime: 7 });
  expect((await readPath('/project/a', { intent: 'explicit', owner: 'one', operationToken: ask.operationToken }) as any).error).toBe('needs-download');
  expect(reads()).toHaveLength(1);
});
it('selects preview/full windows by observed size and retains remote absolute size ceilings', async () => {
  worker.residency = 'local'; worker.size = 100;
  await readPath('/large', { prefix: { bytes: 10 } });
  expect(reads().at(-1)).toMatchObject({ prefix: true, maxBytes: 10 });
  await readPath('/large', { prefix: { bytes: 10, fullUpTo: 120 } });
  expect(reads().at(-1)).toMatchObject({ prefix: false, maxBytes: 120 });
  worker.size = 200;
  await readPath('/large', { prefix: { bytes: 10, fullUpTo: 120 } });
  expect(reads().at(-1)).toMatchObject({ prefix: true, maxBytes: 10 });
  const count = reads().length;
  expect(await readPath('/large', { prefix: { bytes: 10 }, maxBytes: 50 })).toMatchObject({ error: 'too-large', limitBytes: 50 });
  expect(reads()).toHaveLength(count);
});
it('local observation only submits a non-download read', async () => {
  worker.residency = 'local';
  expect((await readPath('/project/local') as any).ok).toBe(true);
  expect(reads()[0].allowDownload).toBe(false);
});
