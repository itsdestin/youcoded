/**
 * A file link that could not be opened says why — never "the file wasn't found".
 *
 * Error inventory 2026-09-10, false message 8. openFilepath's `failed()` always said
 * "Couldn't open X — the file wasn't found in this project." It fired in four places,
 * and NONE of them checks whether the file exists:
 *   · the conversation's folder is unknown (nothing to search),
 *   · the path starts with ~ (buildArtifactifyArgs returns null for exactly that),
 *   · the file was recorded but the refreshed list did not show it,
 *   · a bridge call threw — no search result at all.
 * Each now gets the sentence that is true for it. open-filepath.test.ts pins the action
 * ORDER for the same branches; this pins the words.
 */
import { describe, it, expect, vi } from 'vitest';
import { openFilepath } from '../src/renderer/hooks/useOpenFilepath';
import type { ArtifactState } from '../src/renderer/state/artifact-tracker';
import type { ArtifactAction } from '../src/renderer/state/artifact-actions';

function makeCtx(state: Partial<ArtifactState>) {
  const dispatched: ArtifactAction[] = [];
  return {
    ctx: { state: { sessionArtifacts: {}, sessionCwd: {}, ...state } as ArtifactState, dispatch: (a: ArtifactAction) => dispatched.push(a) },
    dispatched,
  };
}

function installArtifacts(stubs: Partial<Record<'listProject' | 'listAllFiles' | 'listSession' | 'appendVersion', (...a: any[]) => Promise<any>>>) {
  (globalThis as any).window = {
    ...(globalThis as any).window,
    claude: {
      artifacts: {
        listProject: vi.fn(stubs.listProject ?? (async () => ({ ok: true, artifacts: [] }))),
        listAllFiles: vi.fn(stubs.listAllFiles ?? (async () => ({ ok: true, files: [] }))),
        listSession: vi.fn(stubs.listSession ?? (async () => ({ ok: true, artifacts: [] }))),
        appendVersion: vi.fn(stubs.appendVersion ?? (async () => ({ ok: true }))),
      },
    },
  };
}

const failure = (dispatched: ArtifactAction[]) =>
  (dispatched.find((a) => a.type === 'PILL_RESOLVE_FAILED') as { message?: string } | undefined)?.message ?? '';

describe('openFilepath — the failure sentence matches what actually happened', () => {
  it('a conversation whose folder is unknown says that, not "wasn\'t found"', async () => {
    installArtifacts({});
    const { ctx, dispatched } = makeCtx({ sessionCwd: {} });
    await openFilepath(ctx, 's1', 'notes.md');

    expect(failure(dispatched)).toMatch(/couldn.t open notes\.md/i);
    expect(failure(dispatched)).toMatch(/which folder/i);
    expect(failure(dispatched)).not.toMatch(/wasn.t found/i);
  });

  it('a path starting with ~ says that, not "wasn\'t found"', async () => {
    installArtifacts({});
    const { ctx, dispatched } = makeCtx({ sessionCwd: { s1: '/proj' } });
    await openFilepath(ctx, 's1', '~/notes.md');

    expect(failure(dispatched)).toMatch(/couldn.t open notes\.md/i);
    expect(failure(dispatched)).toMatch(/~/);
    expect(failure(dispatched)).not.toMatch(/wasn.t found/i);
  });

  it('a lookup that threw names the reason, without the transport wrapper', async () => {
    installArtifacts({
      listProject: async () => { throw new Error("Error invoking remote method 'artifacts:list-project': Error: EACCES: permission denied, open '/proj/.youcoded/artifacts.json'"); },
    });
    const { ctx, dispatched } = makeCtx({ sessionCwd: { s1: '/proj' } });
    await openFilepath(ctx, 's1', '/proj/notes.md');

    expect(failure(dispatched)).toMatch(/couldn.t open notes\.md/i);
    expect(failure(dispatched)).toContain('EACCES: permission denied');
    expect(failure(dispatched)).not.toMatch(/Error invoking remote method/);
    expect(failure(dispatched)).not.toMatch(/wasn.t found/i);
  });

  it('a file recorded but not listed back claims nothing beyond "couldn\'t open"', async () => {
    installArtifacts({ listSession: async () => ({ ok: true, artifacts: [] }) });
    const { ctx, dispatched } = makeCtx({ sessionCwd: { s1: '/proj' } });
    await openFilepath(ctx, 's1', '/proj/orphan.md');

    expect(failure(dispatched)).toMatch(/couldn.t open orphan\.md/i);
    expect(failure(dispatched)).not.toMatch(/wasn.t found/i);
  });
});
