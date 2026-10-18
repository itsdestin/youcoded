import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDiscoveryJob } from '../src/main/session-discovery-worker';
import { createSkillCatalog } from '../src/main/harness/skills/skill-catalog';
import { buildClaudeCodeContext } from '../src/main/claude-code-context';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSessionDiscovery, type DiscoveryJob } from '../src/main/session-discovery';

class FakeWorker extends EventEmitter {
  terminate = vi.fn(async () => 0);
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('keeps project precedence and Claude context identical to synchronous discovery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-discovery-'));
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  const project = path.join(root, 'project');
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  try {
    write(path.join(root, '.claude/skills/shared/SKILL.md'), '---\nname: Global\ndescription: global\n---\nGlobal body');
    write(path.join(project, '.claude/skills/shared/SKILL.md'), '---\nname: Project\ndescription: project\n---\nProject body');
    write(path.join(project, 'CLAUDE.md'), 'Project instructions');
    const expected = createSkillCatalog(undefined, project);
    const reply = runDiscoveryJob({ kind: 'skills', cwd: project });
    expect(reply.ok).toBe(true);
    if (!reply.ok || !Array.isArray(reply.value)) throw new Error('expected inventory');
    const actual = createSkillCatalog(reply.value);
    expect(actual.list()).toEqual(expected.list());
    expect(actual.load('shared').body).toBe('Project body');
    expect(runDiscoveryJob({ kind: 'claude-context', cwd: project, modelLabel: 'Model' })).toEqual({
      ok: true, value: buildClaudeCodeContext(project, 'Model'),
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe('session discovery', () => {
  it('waits for an off-thread result and shares concurrent requests for the same project', async () => {
    const worker = new FakeWorker();
    const spawn = vi.fn<(job: DiscoveryJob) => FakeWorker>(() => worker);
    const discovery = createSessionDiscovery({ spawn });
    const first = discovery.skills('/project');
    const second = discovery.skills('/project');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    let completed = false;
    void first.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    worker.emit('message', { ok: true, value: [] });
    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toEqual([]);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('serializes different projects and never lets a completed scan become a stale cache', async () => {
    const workers: FakeWorker[] = [];
    const spawn = vi.fn<(job: DiscoveryJob) => FakeWorker>(() => { const w = new FakeWorker(); workers.push(w); return w; });
    const discovery = createSessionDiscovery({ spawn });
    const a = discovery.skills('/a');
    const b = discovery.skills('/b');
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    workers[0].emit('message', { ok: true, value: [] });
    await a;
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    expect(spawn.mock.calls[1][0]).toMatchObject({ kind: 'skills', cwd: '/b' });
    workers[1].emit('message', { ok: true, value: [] });
    await b;
    const again = discovery.skills('/a');
    await vi.waitFor(() => expect(workers).toHaveLength(3));
    workers[2].emit('message', { ok: true, value: [] });
    await again;
  });

  it('terminates a stuck worker and lets the next request proceed', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const discovery = createSessionDiscovery({ spawn: () => { const w = new FakeWorker(); workers.push(w); return w; }, timeoutMs: 100 });
    const pending = discovery.skills('/stuck');
    const rejected = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    const next = discovery.skills('/next');
    await vi.advanceTimersByTimeAsync(0);
    workers[1].emit('message', { ok: true, value: [] });
    await expect(next).resolves.toEqual([]);
  });

  it('bounds shutdown waiting and rejects queued work while a worker cannot terminate', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    let releaseStop!: () => void;
    worker.terminate.mockImplementation(() => new Promise<number>((resolve) => { releaseStop = () => resolve(0); }));
    const spawn = vi.fn(() => worker);
    const discovery = createSessionDiscovery({ spawn, timeoutMs: 100, stopTimeoutMs: 100 });
    let failure: Error | undefined;
    const pending = discovery.skills('/stuck').catch((error: Error) => { failure = error; });
    try {
      await vi.advanceTimersByTimeAsync(250);
      expect(failure?.message).toContain('timed out');
      await expect(discovery.skills('/queued')).rejects.toThrow('still stopping');
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      releaseStop();
      await pending;
    }
    worker.terminate.mockResolvedValue(0);
    const recovered = discovery.skills('/recovered');
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(2);
    worker.emit('message', { ok: true, value: [] });
    await expect(recovered).resolves.toEqual([]);
  });

  it.each(['error', 'exit'] as const)('rejects a worker %s rather than silently removing skills', async (event) => {
    const worker = new FakeWorker();
    const discovery = createSessionDiscovery({ spawn: () => worker });
    const pending = discovery.skills('/project');
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(worker.listenerCount(event)).toBe(1));
    worker.emit(event, event === 'error' ? new Error('worker failed') : 1);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('preserves the Claude context request and result', async () => {
    const worker = new FakeWorker();
    const spawn = vi.fn<(job: DiscoveryJob) => FakeWorker>(() => worker);
    const discovery = createSessionDiscovery({ spawn });
    const pending = discovery.claudeContext('/project', 'Model');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    expect(spawn.mock.calls[0][0]).toEqual({ kind: 'claude-context', cwd: '/project', modelLabel: 'Model' });
    const context = { assembledBy: 'claude-code', skills: [] };
    worker.emit('message', { ok: true, value: context });
    await expect(pending).resolves.toEqual(context);
  });
});
