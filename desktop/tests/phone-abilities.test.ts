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

describe('the theme marketplace from a phone: browse, install, remove, update and publish', () => {
  const themes = () => ({
    listThemes: vi.fn(async () => [{ slug: 'golden' }]), getThemeDetail: vi.fn(async () => ({ slug: 'golden' })),
    installTheme: vi.fn(async () => ({ status: 'installed' })), uninstallTheme: vi.fn(async () => ({ status: 'uninstalled' })),
    updateTheme: vi.fn(async () => ({ ok: true, newVersion: '2.0.0' })), publishTheme: vi.fn(async () => ({ prUrl: 'https://x/pr/1', prNumber: 1 })),
    resolvePublishStateForSlug: vi.fn(async () => ({ kind: 'draft' })), invalidateRegistryCache: vi.fn(),
  });
  it('list and detail answer a phone', async () => {
    bindThemeMarketplace(themes() as any);
    expect(await phone('theme-marketplace:list', undefined)).toEqual({ reply: true, payload: [{ slug: 'golden' }] });
    expect(await phone('theme-marketplace:detail', { slug: 'golden' })).toEqual({ reply: true, payload: { slug: 'golden' } });
  });
  it('install, uninstall and update run for a phone with only the slug (the old refusal is gone)', async () => {
    const t = themes();
    bindThemeMarketplace(t as any);
    expect(await phone('theme-marketplace:install', { slug: 'golden' })).toEqual({ reply: true, payload: { status: 'installed' } });
    expect(await phone('theme-marketplace:uninstall', { slug: 'golden' })).toEqual({ reply: true, payload: { status: 'uninstalled' } });
    expect(await phone('theme-marketplace:update', { slug: 'golden' })).toEqual({ reply: true, payload: { ok: true, newVersion: '2.0.0' } });
    expect(t.installTheme).toHaveBeenCalledWith('golden');
    expect(t.uninstallTheme).toHaveBeenCalledWith('golden');
    expect(t.updateTheme).toHaveBeenCalledWith('golden');
  });
  it('publish runs for a phone with ONLY the slug: a path, a folder or a registry entry sent along is never passed on', async () => {
    const t = themes();
    bindThemeMarketplace(t as any);
    const out: any = await phone('theme-marketplace:publish', { slug: 'golden', path: '/etc', themeDir: '/home/x/.ssh', existingEntry: { slug: 'evil' } });
    expect(out.payload).toEqual({ prUrl: 'https://x/pr/1', prNumber: 1 });
    expect(t.publishTheme).toHaveBeenCalledTimes(1);
    expect(t.publishTheme.mock.calls[0]).toEqual(['golden']);
    // The state read the Publish sheet needs (already open for review, published, ready) answers too, so the phone shows what the computer shows.
    expect(await phone('theme-marketplace:resolve-publish-state', { slug: 'golden' })).toEqual({ reply: true, payload: { kind: 'draft' } });
  });
  it('the real provider refuses every slug that is not a plain name, and a theme that is not already on the computer, for a publish from a phone', async () => {
    const { ThemeMarketplaceProvider } = await import('../src/main/theme-marketplace-provider');
    const real = new ThemeMarketplaceProvider();
    bindThemeMarketplace(real);
    for (const slug of ['../../etc', '/etc/passwd', 'a/b', 'A_B', '', '..', 'x'.repeat(5) + '/../y']) {
      const out: any = await phone('theme-marketplace:publish', { slug });
      expect(out.payload?.error ?? out.payload?.message ?? JSON.stringify(out), slug).toMatch(/Invalid theme slug|error/i);
      expect(await phone('theme-marketplace:uninstall', { slug }), slug).toEqual({ reply: true, payload: { status: 'failed', error: 'Invalid theme slug' } });
    }
    const missing: any = await phone('theme-marketplace:publish', { slug: 'no-such-theme-r63' });
    expect(JSON.stringify(missing)).toContain('Theme not found on disk');
  });
  it('the neighbours stay refused and never run: refresh-registry and generate-preview', async () => {
    const t = themes();
    bindThemeMarketplace(t as any);
    for (const name of ['theme-marketplace:refresh-registry', 'theme-marketplace:generate-preview']) {
      expect(await phone(name, { slug: 'golden' }), name).toEqual(refusalOf(name));
    }
    expect(t.invalidateRegistryCache).not.toHaveBeenCalled();
  });
});

describe('skills:update from a phone', () => {
  it('get-featured and get-packages answer a phone, and skills:update now runs (and running chats reload their plugins)', async () => {
    const reload = vi.fn();
    const skillProvider: any = {
      getFeatured: vi.fn(async () => ({ hero: [{ id: 'a' }], rails: [] })), update: vi.fn(async () => ({ ok: true, newVersion: '2.0.0' })),
      configStore: { getPackages: () => ({ 'some-plugin': { version: '1.0.0' } }) },
    };
    bindSkillsDeps({ skillProvider, sessionManager: { broadcastReloadPlugins: reload } } as any);
    expect(await phone('skills:get-featured', undefined)).toEqual({ reply: true, payload: { hero: [{ id: 'a' }], rails: [] } });
    expect(await phone('marketplace:get-packages', undefined)).toEqual({ reply: true, payload: { 'some-plugin': { version: '1.0.0' } } });
    expect(await phone('skills:update', { id: 'some-plugin', path: '/etc' })).toEqual({ reply: true, payload: { ok: true, newVersion: '2.0.0' } });
    expect(skillProvider.update).toHaveBeenCalledWith('some-plugin');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('rate, vote, comment, report and the install count from a phone, as the owner', () => {
  it('the write channels reach the owner\'s signed-in client; config, cache and the file viewer stay refused', async () => {
    const client: any = {
      postRating: vi.fn(async () => ({ ok: true })), deleteRating: vi.fn(async () => ({ ok: true })),
      setThumb: vi.fn(async () => ({ vote: 1, thumbs_up: 3, thumbs_down: 0, extra: 'dropped' })), getThumb: vi.fn(async () => ({ vote: 0, thumbs_up: 3, thumbs_down: 0 })),
      postComment: vi.fn(async () => ({ id: 'c1', hidden: false, leak: 'x' })), toggleThemeLike: vi.fn(async () => ({ liked: true })),
      postReport: vi.fn(async () => ({ ok: true })), postInstall: vi.fn(async () => ({ ok: true })),
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
    // R6-3: the Report button and the install count (the old refusals are gone)
    expect(await phone('marketplace:report', { rating_user_id: 'u', rating_plugin_id: 'p', reason: 'spam' })).toMatchObject({ reply: true });
    expect(client.postReport).toHaveBeenCalledWith({ rating_user_id: 'u', rating_plugin_id: 'p', reason: 'spam' });
    expect(await phone('marketplace:install', { pluginId: 'p' })).toMatchObject({ reply: true });
    expect(client.postInstall).toHaveBeenCalledWith('p');
    for (const name of ['marketplace:get-config', 'marketplace:set-config', 'marketplace:invalidate-cache', 'marketplace:read-component']) {
      expect(await phone(name, {}), name).toEqual(refusalOf(name));
    }
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

  describe('a skill\'s own file (kind "skill")', () => {
    const mkSkill = (dir: string, name = 'mine', body = 'SKILL BODY') => {
      const sd = path.join(dir, '.claude', 'skills', name);
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(path.join(sd, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n${body}`);
      return sd;
    };
    it('is read for a phone: the skill is found from the computer\'s own skill scan by its id (the old refusal is gone)', async () => {
      const dir = tmp();
      const sd = mkSkill(dir);
      const out: any = await ask('skill', ctxFor({ s1: dir }), 's1', 'mine');
      expect(out.payload.text).toContain('SKILL BODY');
      expect(out.payload.path).toBe(path.join(sd, 'SKILL.md'));
    });
    it('the phone cannot choose the folder: a cwd or path it sends is ignored, and an unknown id or session finds nothing', async () => {
      const mine = tmp(); mkSkill(mine, 'mine', 'MINE');
      const other = tmp(); mkSkill(other, 'theirs', 'OTHER FOLDER');
      const ctx = ctxFor({ s1: mine });
      const sent: any = await phone('native:session-context-text', { sessionId: 's1', kind: 'skill', id: 'theirs', cwd: other, path: path.join(other, '.claude/skills/theirs/SKILL.md') }, ctx);
      expect(JSON.stringify(sent)).not.toContain('OTHER FOLDER');
      expect(sent.payload).toEqual({ error: 'not-found' });
      expect(((await ask('skill', ctx, 's1', '../../etc/passwd')) as any).payload).toEqual({ error: 'not-found' });
      expect(JSON.stringify(await ask('skill', ctxFor({}), 'nope', 'mine'))).not.toContain('MINE');
    });
    it('a SKILL.md that is really a link to a private key is refused as "kept on the computer", never opened', async () => {
      const dir = tmp();
      const sd = mkSkill(dir);
      const key = path.join(tmp(), 'id_rsa');
      fs.writeFileSync(key, '-----BEGIN PRIVATE KEY-----');
      fs.rmSync(path.join(sd, 'SKILL.md'));
      fs.symlinkSync(key, path.join(sd, 'SKILL.md'));
      const out: any = await ask('skill', ctxFor({ s1: dir }), 's1', 'mine');
      expect(out.payload).toEqual({ error: 'kept-on-computer' });
      expect(JSON.stringify(out)).not.toContain('PRIVATE KEY');
    });
    it('a skill folder inside a .ssh folder is refused too (the deny list is judged on the real path)', async () => {
      const root = tmp();
      const dir = path.join(root, '.ssh');
      fs.mkdirSync(dir);
      mkSkill(dir);
      expect(((await ask('skill', ctxFor({ s1: dir }), 's1', 'mine')) as any).payload).toEqual({ error: 'kept-on-computer' });
    });
    it('only a regular file up to 1 MB: a named pipe and an oversize file are refused', async () => {
      const big = tmp(); mkSkill(big, 'mine', 'x'.repeat(1024 * 1024 + 1));
      expect(((await ask('skill', ctxFor({ s1: big }), 's1', 'mine')) as any).payload).toEqual({ error: 'too-large' });
      // A named pipe: the computer's skill scan no longer opens it (it used to hang here), and the phone's own read refuses it.
      if (process.platform !== 'win32') {
        const pdir = tmp(); const psd = mkSkill(pdir);
        fs.rmSync(path.join(psd, 'SKILL.md'));
        spawnSync('mkfifo', [path.join(psd, 'SKILL.md')]);
        expect(((await ask('skill', ctxFor({ s1: pdir }), 's1', 'mine')) as any).payload).toEqual({ error: 'unreadable' });
      }
      // A SKILL.md that is a folder is not a regular file either: no text comes back.
      const dir = tmp(); const sd = mkSkill(dir);
      fs.rmSync(path.join(sd, 'SKILL.md'));
      fs.mkdirSync(path.join(sd, 'SKILL.md'));
      expect(JSON.stringify(await ask('skill', ctxFor({ s1: dir }), 's1', 'mine'))).not.toContain('text');
    });
    it('the text of the file is read once, after it was judged', async () => {
      const dir = tmp(); mkSkill(dir);
      // (The computer's skill scan reads each SKILL.md's heading while finding the skill; that is the lookup. The phone's own read is the async one.)
      const spyAsync = vi.spyOn(fs.promises, 'readFile');
      await ask('skill', ctxFor({ s1: dir }), 's1', 'mine');
      expect(spyAsync.mock.calls.filter((c) => String(c[0]).endsWith('SKILL.md'))).toHaveLength(1);
      spyAsync.mockRestore();
    });
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
