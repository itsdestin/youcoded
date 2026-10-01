// phone-abilities.test.ts — the phone abilities Destin approved on 2026-09-30 / 2026-09-11 (one-core R6-1).
// Each one was a refusal; each test shows the refusal is GONE (the handler runs for a phone). tests/phone-open-set.test.ts pins that
// nothing ELSE opened. The instruction-file read gets the most care: it reads a file off the computer, so the phone deny list applies.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { findChannel, serveRemoteChannel } from '../src/main/ipc/channel-table';
import { bindThemeMarketplace } from '../src/main/ipc/theme-marketplace';
import { bindSkillsDeps } from '../src/main/ipc/skills';
import { bindAccountDeps } from '../src/main/ipc/account';
import { spawnSync } from 'child_process';
import { locateContextFile } from '../src/main/claude-code-context';
import { authOkMessage } from '../src/main/remote-server';

const phoneCtx = (extra: any = {}): any => ({ door: 'remote', runtime: null, broadcast: vi.fn(), ...extra });
const phone = (name: string, payload: unknown, ctx: any = phoneCtx()) => serveRemoteChannel(findChannel(name)!, payload, ctx);
const refusalOf = (name: string) => ({ reply: true, payload: { ok: false, error: `This feature isn't available over remote access yet (${name}).`, unsupported: true } });

afterEach(() => { vi.unstubAllEnvs(); });

describe('browsing the theme marketplace from a phone (answer 1)', () => {
  it('list and detail answer a phone; install, uninstall, update, publish and the rest stay refused and never run', async () => {
    const themes = {
      listThemes: vi.fn(async () => [{ slug: 'golden' }]), getThemeDetail: vi.fn(async () => ({ slug: 'golden' })),
      installTheme: vi.fn(), uninstallTheme: vi.fn(), updateTheme: vi.fn(), publishTheme: vi.fn(), resolvePublishStateForSlug: vi.fn(),
      invalidateRegistryCache: vi.fn(),
    };
    bindThemeMarketplace(themes as any);
    expect(await phone('theme-marketplace:list', undefined)).toEqual({ reply: true, payload: [{ slug: 'golden' }] });
    expect(await phone('theme-marketplace:detail', { slug: 'golden' })).toEqual({ reply: true, payload: { slug: 'golden' } });
    for (const name of ['theme-marketplace:install', 'theme-marketplace:uninstall', 'theme-marketplace:update', 'theme-marketplace:publish', 'theme-marketplace:resolve-publish-state', 'theme-marketplace:refresh-registry', 'theme-marketplace:generate-preview']) {
      expect(await phone(name, { slug: 'golden' }), name).toEqual(refusalOf(name));
    }
    expect(themes.installTheme).not.toHaveBeenCalled();
    expect(themes.publishTheme).not.toHaveBeenCalled();
    expect(themes.invalidateRegistryCache).not.toHaveBeenCalled();
  });
});

describe('featured skills and update-available from a phone (answer 2)', () => {
  it('get-featured and get-packages answer a phone; skills:update (applying an update) stays refused', async () => {
    const skillProvider: any = {
      getFeatured: vi.fn(async () => ({ hero: [{ id: 'a' }], rails: [] })), update: vi.fn(),
      configStore: { getPackages: () => ({ 'some-plugin': { version: '1.0.0' } }) },
    };
    bindSkillsDeps({ skillProvider, sessionManager: { broadcastReloadPlugins: vi.fn() } } as any);
    expect(await phone('skills:get-featured', undefined)).toEqual({ reply: true, payload: { hero: [{ id: 'a' }], rails: [] } });
    expect(await phone('marketplace:get-packages', undefined)).toEqual({ reply: true, payload: { 'some-plugin': { version: '1.0.0' } } });
    expect(await phone('skills:update', { id: 'some-plugin' })).toEqual(refusalOf('skills:update'));
    expect(skillProvider.update).not.toHaveBeenCalled();
  });
});

describe('rate, vote and comment from a phone, as the owner (answer 3)', () => {
  it('the six write channels reach the owner\'s signed-in client; report, install report and config stay refused', async () => {
    const client: any = {
      postRating: vi.fn(async () => ({ ok: true })), deleteRating: vi.fn(async () => ({ ok: true })),
      setThumb: vi.fn(async () => ({ vote: 1, thumbs_up: 3, thumbs_down: 0, extra: 'dropped' })), getThumb: vi.fn(async () => ({ vote: 0, thumbs_up: 3, thumbs_down: 0 })),
      postComment: vi.fn(async () => ({ id: 'c1', hidden: false, leak: 'x' })), toggleThemeLike: vi.fn(async () => ({ liked: true })),
      postReport: vi.fn(), install: vi.fn(),
    };
    bindAccountDeps({ store: {} as any, client, installedSkillSource: null });
    expect(await phone('marketplace:rate', { pluginId: 'p', rating: 5 })).toMatchObject({ reply: true });
    expect(client.postRating).toHaveBeenCalledWith({ pluginId: 'p', rating: 5 });
    await phone('marketplace:rate:delete', { pluginId: 'p' });
    expect(client.deleteRating).toHaveBeenCalledWith('p');
    expect(await phone('marketplace:thumb', { plugin_id: 'p', value: 1 })).toMatchObject({ reply: true });
    expect(await phone('marketplace:thumb:get', { plugin_id: 'p' })).toMatchObject({ reply: true });
    expect(await phone('marketplace:comment', { plugin_id: 'p', body: 'nice' })).toMatchObject({ reply: true });
    expect(client.postComment).toHaveBeenCalled();
    await phone('marketplace:theme:like', { themeId: 't' });
    expect(client.toggleThemeLike).toHaveBeenCalledWith('t');
    for (const name of ['marketplace:report', 'marketplace:install', 'marketplace:get-config', 'marketplace:set-config', 'marketplace:invalidate-cache', 'marketplace:read-component']) {
      expect(await phone(name, {}), name).toEqual(refusalOf(name));
    }
    expect(client.postReport).not.toHaveBeenCalled();
    expect(client.install).not.toHaveBeenCalled();
  });
});

describe('the instruction-file read for a phone (answer 9), under the R3-SEC phone protections', () => {
  const made: string[] = [];
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r61-')); made.push(d); return d; };
  afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const host = { sessionContextText: vi.fn(() => ({ error: 'not-live' })) };
  const ctxFor = (cwdBySession: Record<string, string>, runtime: any = { nativeHost: host }) => phoneCtx({ runtime, remote: { sessionCwd: (id: string) => cwdBySession[id] } });
  const ask = (kind: string, ctx: any, sessionId = 's1', id?: string) => phone('native:session-context-text', { sessionId, kind, id }, ctx);

  it('a Claude Code session\'s project file (CLAUDE.md in its folder) is read for the phone, as on the computer', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'be kind');
    const out: any = await ask('project', ctxFor({ s1: dir }));
    expect(out.payload).toEqual({ path: path.join(dir, 'CLAUDE.md'), text: 'be kind', full: 'be kind', truncated: false });
    // The computer's door gives the same answer for the same session (parity).
    const desk: any = await findChannel('native:session-context-text')!.handler({ sessionId: 's1', kind: 'project' }, { door: 'desktop', runtime: { nativeHost: host }, broadcast: vi.fn(), desktop: { sessionManager: { getSession: () => ({ cwd: dir }) } } } as any);
    expect(desk).toEqual(out.payload);
  });

  it('the user-level file (~/.claude/CLAUDE.md) is read for the phone', async () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'global rules');
    vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
    const out: any = await ask('user', ctxFor({}));
    expect(out.payload.text).toBe('global rules');
  });

  it('a session that is not open gets not-live, and a folder the phone supplies is ignored for one that is', async () => {
    const real = tmp(), other = tmp();
    fs.writeFileSync(path.join(real, 'CLAUDE.md'), 'the session folder');
    fs.writeFileSync(path.join(other, 'CLAUDE.md'), 'a folder the phone named');
    const ctx = ctxFor({ s1: real });
    const known: any = await phone('native:session-context-text', { sessionId: 's1', kind: 'project', cwd: other, projectRoot: other, path: path.join(other, 'CLAUDE.md') }, ctx);
    expect(known.payload.text).toBe('the session folder');
    const unknown: any = await phone('native:session-context-text', { sessionId: 'nope', kind: 'project', cwd: other }, ctx);
    expect(unknown.payload).toEqual({ error: 'not-live' });
  });

  it('an invented kind never reaches a skill file: the phone gets the host\'s answer and the locator finds nothing', async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, '.claude', 'skills', 'mine'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: d\n---\nSECRET SKILL BODY');
    for (const kind of ['bogus', '', 'Skill', 'skills']) {
      const out: any = await ask(kind, ctxFor({ s1: dir }), 's1', 'mine');
      expect(JSON.stringify(out), kind).not.toContain('SECRET SKILL BODY');
      expect(out.payload, kind).toEqual({ error: 'not-live' });
    }
    expect(locateContextFile({ getSession: () => ({ cwd: dir }) }, 's1', 'bogus' as any, 'mine')).toEqual({ error: 'not-found' });
  });

  it('a project file that is a named pipe is refused without hanging, and an oversize one is refused', async () => {
    const dir = tmp();
    if (process.platform !== 'win32') {
      spawnSync('mkfifo', [path.join(dir, 'CLAUDE.md')]);
      expect(((await ask('project', ctxFor({ s1: dir }))) as any).payload).toEqual({ error: 'unreadable' });
    }
    const big = tmp();
    fs.writeFileSync(path.join(big, 'CLAUDE.md'), 'x'.repeat(1024 * 1024 + 1));
    expect(((await ask('project', ctxFor({ s1: big }))) as any).payload).toEqual({ error: 'too-large' });
  });

  it('a CLAUDE.md that is really a link to a private key is refused as "kept on the computer", never opened', async () => {
    const dir = tmp();
    const key = path.join(tmp(), 'id_rsa');
    fs.writeFileSync(key, '-----BEGIN PRIVATE KEY-----');
    fs.symlinkSync(key, path.join(dir, 'CLAUDE.md'));
    const out: any = await ask('project', ctxFor({ s1: dir }));
    expect(out.payload).toEqual({ error: 'kept-on-computer' });
    expect(JSON.stringify(out)).not.toContain('PRIVATE KEY');
    // The computer's own window is unchanged: it reads the file it was asked for.
  });

  it('a project file inside a .git or .ssh folder is refused too (the deny list is judged on the real path)', async () => {
    const root = tmp();
    const dir = path.join(root, '.ssh');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'x');
    expect(((await ask('project', ctxFor({ s1: dir }))) as any).payload).toEqual({ error: 'kept-on-computer' });
  });

  it('a skill\'s file is NOT read for a phone (only the instruction files were approved): it gets the host\'s answer', async () => {
    const out: any = await ask('skill', ctxFor({ s1: tmp() }), 's1', 'anything');
    expect(out.payload).toEqual({ error: 'not-live' });
  });

  it('an assistant (native) session still answers from its host, which knows how much was cut', async () => {
    const answered = { path: '/p/CLAUDE.md', text: 'cut', full: 'full text', truncated: true };
    const liveHost = { sessionContextText: vi.fn(() => answered) };
    const out: any = await ask('project', ctxFor({ s1: tmp() }, { nativeHost: liveHost }));
    expect(out.payload).toEqual(answered);
  });
});

describe('native sessions from a phone: remote access is identical to the desktop', () => {
  it('the host\'s handshake says the phone may run native sessions, unless the computer has the engine switched off', () => {
    expect(authOkMessage({ deviceId: 'd' }).capabilities.nativeSessions).toBe(true);
    vi.stubEnv('YOUCODED_NATIVE', '0');
    expect(authOkMessage({ deviceId: 'd' }).capabilities.nativeSessions).toBe(false);
  });
  it('only that one capability changed in the handshake', () => {
    const c: any = authOkMessage({ deviceId: 'd' }).capabilities;
    expect(c).toMatchObject({ nativeWindows: false, openInOs: false, openExternal: false, git: false, themePictures: false, themeRigs: false, terminalScreenRead: false, buddy: false, projectWrites: false, contentSearch: false, sessionRecord: true, nativeSessions: true });
  });
});
