// "What the assistant was given" — the backend behind the line above every
// conversation and the panel behind it. Design:
// docs/active/specs/2026-09-10-session-context-backend-design.md (workspace).
//
// The three things these tests exist to hold:
//  1. EVERY chat gets the record, including one where nothing was left out
//     (contract R23/R28) — a missing line is indistinguishable from a broken app.
//  2. NO FILE BODIES ride in it. 47 installed skills are 619 KB on this machine;
//     that must never start travelling with every session.
//  3. The text the panel shows is what the MODEL would receive — same fitter,
//     same budget — never a second implementation's idea of it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

const NO_CONTEXT = async () => ({ contextLength: null, totalSlots: null });

const CHUNKS = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 'p1' },
  { type: 'text-delta', id: 'p1', delta: 'ok' },
  { type: 'text-end', id: 'p1' },
  { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: { total: 3 }, outputTokens: { total: 2 } } },
];
const factory = async () => new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: CHUNKS as any }) }) }) as any;

/** The record the host pushes when a session opens. */
function contextFor(host: NativeSessionHost, sessionId: string, cwd: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no session-context was pushed for this session')), 5000);
    host.on('session-context', (e: any) => {
      if (e.sessionId !== sessionId) return;
      clearTimeout(timer);
      resolve(e.context);
    });
    void host.create({ sessionId, cwd, binding: { providerId: 'openrouter', modelId: 'm' } });
  });
}

describe('what the assistant was given', () => {
  let root: string; let host: NativeSessionHost;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-ctx-'));
    // A .git marker stops the instruction-file walk escaping into the real
    // filesystem above the sandbox — without it this test reads whatever
    // CLAUDE.md happens to sit above /tmp.
    fs.mkdirSync(path.join(root, '.git'));
    host = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null);
  });
  afterEach(async () => { await host.destroyAll(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

  it('pushes a record for a chat where nothing was left out', async () => {
    // Contract R28: the line shows even when nothing extra was given. Its
    // absence would be ambiguous between "nothing was given" and "the app
    // failed to report".
    const ctx = await contextFor(host, 's-plain', root);
    expect(ctx.projectInstructions).toBeNull();
    expect(ctx.droppedMcpServers).toEqual([]);
    expect(ctx.tools.length).toBeGreaterThan(0);
    expect(ctx.modelLabel).toBe('m');
  });

  it('names the project instruction file and says it was NOT cut when it fits', async () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Rules\n\nBe careful.');
    const ctx = await contextFor(host, 's-fits', root);
    expect(ctx.projectInstructions.path).toBe(path.join(root, 'CLAUDE.md'));
    expect(ctx.projectInstructions.truncated).toBe(false);
    expect(ctx.projectInstructions.note).toBeNull();
  });

  it('carries NO file bodies — only the system prompt already in memory', async () => {
    // The guard that keeps 619 KB of skills out of every session's state and off
    // every phone's connection. A body sneaking back in is invisible in review
    // and expensive forever, so it fails here instead.
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), `# Rules\n\n${'detail '.repeat(500)}`);
    const ctx = await contextFor(host, 's-nobody', root);
    expect(Object.keys(ctx.projectInstructions).sort()).toEqual(['note', 'path', 'truncated']);
    for (const skill of ctx.skills) {
      expect(Object.keys(skill).sort()).toEqual(['description', 'id', 'label']);
    }
    // The prompt itself IS carried — it is assembled at session start and held in
    // memory either way, and it is the whole content of the System tab.
    expect(ctx.systemPrompt.length).toBeGreaterThan(0);
  });

  it('the System tab parts are the assembled prompt, minus the project file', async () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Rules\n\nPROJECT_MARKER');
    const ctx = await contextFor(host, 's-parts', root);
    const ids = ctx.systemPromptSections.map((s: any) => s.id);
    expect(ids).toContain('identity');
    expect(ids).toContain('preset');
    // The project file has its own tab; showing it under System too would say
    // the same thing twice.
    expect(ids).not.toContain('project');
    expect(ctx.systemPromptSections.some((s: any) => s.text.includes('PROJECT_MARKER'))).toBe(false);
    expect(ctx.systemPrompt).toContain('PROJECT_MARKER');
  });

  it('reads one file on demand, cut exactly as the model would receive it', async () => {
    const body = ['# Rules', '', '## One', 'first', '', '## Two', 'second', '', '## Three', 'third'].join('\n');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), body);
    await contextFor(host, 's-text', root);
    const res: any = host.sessionContextText('s-text', 'project');
    expect(res.path).toBe(path.join(root, 'CLAUDE.md'));
    expect(res.full).toBe(body);
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.truncated).toBe(false);
  });

  it('refuses honestly rather than inventing a file', async () => {
    await contextFor(host, 's-none', root);
    expect(host.sessionContextText('s-none', 'project')).toEqual({ error: 'not-found' });
    expect(host.sessionContextText('s-none', 'skill', 'no-such-skill')).toEqual({ error: 'unreadable' });
    expect(host.sessionContextText('never-opened', 'project')).toEqual({ error: 'not-live' });
  });

  it('a session still opens when the context cannot be described', async () => {
    // The record is an explanation; a chat that will not start is a broken app.
    // Proven by making the one thing that reads the disk throw.
    const dir = path.join(root, 'unreadable');
    fs.mkdirSync(dir);
    // A DIRECTORY named CLAUDE.md: existsSync says yes, readFileSync throws EISDIR.
    fs.mkdirSync(path.join(dir, 'CLAUDE.md'));
    fs.mkdirSync(path.join(dir, '.git'));
    await host.create({ sessionId: 's-broken', cwd: dir, binding: { providerId: 'openrouter', modelId: 'm' } });
    expect(host.getHistory('s-broken')).not.toBeNull();
  });
});
