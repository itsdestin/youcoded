// End-to-end name ownership through the composition root, against REAL stores
// on a temp directory — the naming sidecar and the conversation record both.
// This is the "a name you chose is never replaced" promise, proved at the layer
// that actually writes files, not at the layer that decides to.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({ managedRoots: null as any }));

// Sync-spaces is the only collaborator that must be faked: it decides where the
// Personal root is, and it would otherwise try to talk to a real git worktree.
vi.mock('../src/main/sync-spaces/service', () => ({
  onSyncSpacesEvent: () => () => {},
  syncSpacesSyncNow: async () => ({ ok: true }),
  syncSpacesSyncNowAwaited: async () => {},
  getManagedRoots: () => h.managedRoots,
}));
vi.mock('../src/main/conversations/reconciler', () => ({ reconcile: async () => 0 }));
vi.mock('../src/main/saved-folders', () => ({ readFolders: () => [] }));

let tmpRoot = '';
let svc: typeof import('../src/main/conversations/service');

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'naming-own-'));
  h.managedRoots = { personalRoot: path.join(tmpRoot, 'Personal'), listProjects: () => [] };
  process.env.YOUCODED_SLUG_REPAIR_STATE = path.join(tmpRoot, 'slug-repair-state.json');
  vi.resetModules();
  svc = await import('../src/main/conversations/service');
  await svc.startConversationStore({
    conversationsRoot: path.join(tmpRoot, 'Personal', 'Conversations'),
    namesRoot: path.join(tmpRoot, 'Personal', 'ConversationNames'),
    projectsDir: path.join(tmpRoot, 'projects'),
    topicsDir: path.join(tmpRoot, 'topics'),
    device: 'test-device',
  });
});
afterEach(() => {
  svc?.stopConversationStore();
  delete process.env.YOUCODED_SLUG_REPAIR_STATE;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const storedTitle = async (id: string) =>
  (await svc.getConversationStore()?.get('claude', id))?.title;

describe('name ownership, end to end', () => {
  it('an automatic title lands when nobody owns the name', async () => {
    await svc.noteAutomaticTitle('c1', 'Fix chat scroll', 'claude');
    expect(await storedTitle('c1')).toBe('Fix chat scroll');
    expect(await svc.isSessionNameOwned('claude', 'c1')).toBe(false);
    expect(await svc.resolveSessionName('claude', 'c1', 'Untitled'))
      .toEqual({ name: 'Fix chat scroll', manual: false });
  });

  it('a name the user saved survives every later automatic title', async () => {
    await svc.noteAutomaticTitle('c1', 'Fix chat scroll', 'claude');
    expect(await svc.setManualSessionName('claude', 'c1', 'Biology revision'))
      .toEqual({ ok: true, name: 'Biology revision' });

    await svc.noteAutomaticTitle('c1', 'Something else entirely', 'claude');
    await svc.noteAutomaticTitle('c1', 'And another', 'claude');

    expect(await svc.isSessionNameOwned('claude', 'c1')).toBe(true);
    // Both the ownership record AND the projection older clients read.
    expect(await svc.resolveSessionName('claude', 'c1', 'Untitled'))
      .toEqual({ name: 'Biology revision', manual: true });
    expect(await storedTitle('c1')).toBe('Biology revision');
  });

  it('saving the SAME text still takes ownership', async () => {
    await svc.noteAutomaticTitle('c1', 'Fix chat scroll', 'claude');
    await svc.setManualSessionName('claude', 'c1', 'Fix chat scroll');
    await svc.noteAutomaticTitle('c1', 'Renamed by the model', 'claude');
    expect(await storedTitle('c1')).toBe('Fix chat scroll');
  });

  it('refuses a blank name instead of quietly handing the session back', async () => {
    await svc.setManualSessionName('claude', 'c1', 'Mine');
    expect(await svc.setManualSessionName('claude', 'c1', '   ')).toEqual({ ok: false, error: 'Enter a name.' });
    expect(await svc.isSessionNameOwned('claude', 'c1')).toBe(true);
  });

  it('remembers the automatic name it displaced, for whatever offers it back later', async () => {
    // R11 took the reset action off the dialog, so nothing reaches this today.
    // The record still keeps the generated name, because a name that was shown
    // and then covered is not the same thing as a name that never existed —
    // and re-deriving it later would mean another model call.
    await svc.noteAutomaticTitle('c1', 'Fix chat scroll', 'claude');
    await svc.setManualSessionName('claude', 'c1', 'Biology revision');
    const rec = await svc.getNamingRecord('claude', 'c1');
    expect(rec).toMatchObject({ manual: 'Biology revision', auto: 'Fix chat scroll' });
  });

  it('a later automatic pass does not overwrite the remembered one while owned', async () => {
    await svc.noteAutomaticTitle('c1', 'Fix chat scroll', 'claude');
    await svc.setManualSessionName('claude', 'c1', 'Biology revision');
    await svc.noteAutomaticTitle('c1', 'Something else', 'claude');
    expect((await svc.getNamingRecord('claude', 'c1'))!.auto).toBe('Fix chat scroll');
  });

  it('ownership is per conversation and per lane', async () => {
    await svc.setManualSessionName('claude', 'c1', 'Mine');
    expect(await svc.isSessionNameOwned('claude', 'c2')).toBe(false);
    expect(await svc.isSessionNameOwned('native', 'c1')).toBe(false);
  });

  it('the ownership file lives beside Conversations, not inside it', async () => {
    // Older clients scan and rewrite Personal/Conversations through a fixed
    // field whitelist; anything they do not recognise there is dropped.
    await svc.setManualSessionName('claude', 'c1', 'Mine');
    expect(fs.existsSync(path.join(tmpRoot, 'Personal', 'ConversationNames', 'claude', 'c1.json'))).toBe(true);
    expect(fs.readdirSync(path.join(tmpRoot, 'Personal', 'Conversations', 'claude')))
      .toEqual(['c1.json']);
  });

  it('survives a restart', async () => {
    await svc.setManualSessionName('claude', 'c1', 'Biology revision');
    svc.stopConversationStore();
    vi.resetModules();
    const again = await import('../src/main/conversations/service');
    await again.startConversationStore({
      conversationsRoot: path.join(tmpRoot, 'Personal', 'Conversations'),
      namesRoot: path.join(tmpRoot, 'Personal', 'ConversationNames'),
      projectsDir: path.join(tmpRoot, 'projects'),
      topicsDir: path.join(tmpRoot, 'topics'),
      device: 'test-device',
    });
    expect(await again.isSessionNameOwned('claude', 'c1')).toBe(true);
    await again.noteAutomaticTitle('c1', 'Should not land', 'claude');
    expect((await again.getConversationStore()?.get('claude', 'c1'))?.title).toBe('Biology revision');
    again.stopConversationStore();
  });
});
