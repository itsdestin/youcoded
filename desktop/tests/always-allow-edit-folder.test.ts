// Q-2 / Q-3 (review deck 2026-11-01): edits get "for this conversation" and "files in this folder".
import { describe, it, expect } from 'vitest';
import { editGrantChoices, folderRulesFor, projectRelativeFolder, projectRelativePath } from '../src/shared/edit-grants';
import { ruleMatches } from '../src/shared/subject-glob';
import { decidePermission } from '../src/main/harness/permission-engine';
import { rulesForMode, DESTRUCTIVE_DENY_LIST } from '../src/shared/permission-types';
import { rememberedRulesFor } from '../src/main/harness/harness-session';
import { PermissionBroker } from '../src/main/harness/permission-broker';

const CWD = '/home/u/proj';
const rules = (file: string, tool = 'Edit') => folderRulesFor(file, CWD)!.find((r) => r.tool === tool)!;

describe('folder rules', () => {
  it('store the project-relative folder for Edit and Write', () => {
    expect(folderRulesFor('src/ui/a.ts', CWD)!.map((r) => [r.tool, r.pattern, r.match, r.action])).toEqual([
      ['Edit', 'src/ui', 'folder', 'allow'], ['Write', 'src/ui', 'folder', 'allow'],
    ]);
    expect(rules('README.md').pattern).toBe('.');
    expect(rules(`${CWD}/src/ui/a.ts`).pattern).toBe('src/ui'); // an absolute spelling of the same file
    expect(rules('src\\ui\\a.ts').pattern).toBe('src/ui');
  });
  it('cover files directly in the folder, however the path is spelled', () => {
    const r = rules('src/ui/a.ts');
    for (const f of ['src/ui/b.ts', `${CWD}/src/ui/new-file.tsx`, './src/ui/c.ts', 'src//ui/d.ts', 'src\\ui\\e.ts']) expect(ruleMatches(r, f, { cwd: CWD }), f).toBe(true);
    expect(ruleMatches(rules('x.ts', 'Write'), 'y.ts', { cwd: CWD })).toBe(true);
  });
  it('do not cover sub-folders, parents, siblings, look-alikes, or ".." tricks', () => {
    const r = rules('src/ui/a.ts');
    for (const f of [
      'src/ui/deep/a.ts', 'src/a.ts', 'src/ui2/a.ts', 'src/uix/a.ts', 'other/src/ui/a.ts', 'src/ui/../../.git/config', 'src/ui/../a.ts', '../proj/src/ui/a.ts',
      '/home/u/other/src/ui/a.ts', '/home/u/proj-evil/src/ui/a.ts', '/etc/passwd', 'src/ui/', 'src/ui', '', '~/src/ui/a.ts', 'SRC/UI/a.ts',
    ]) expect(ruleMatches(r, f, { cwd: CWD }), f).toBe(false);
    // an absolute path is refused when the project folder is unknown
    expect(ruleMatches(r, `${CWD}/src/ui/a.ts`)).toBe(false);
  });
  it('belong to their own tool, and only as an allow', () => {
    const r = rules('src/ui/a.ts');
    expect(ruleMatches({ ...r, tool: 'Read' }, 'src/ui/a.ts', { cwd: CWD })).toBe(false);
    expect(ruleMatches({ ...r, tool: 'Bash' }, 'src/ui/a.ts', { cwd: CWD })).toBe(false);
    expect(ruleMatches({ ...r, action: 'ask' }, 'src/ui/a.ts', { cwd: CWD })).toBe(false);
  });
  it('are not derived for paths that are not plain project files', () => {
    for (const f of ['../x.ts', 'a/../../x.ts', '/home/u/other/x.ts', '', 'src/']) expect(folderRulesFor(f, CWD), f).toBeNull();
    expect(projectRelativePath('a/./b.ts', CWD)).toBe('a/b.ts');
    expect(projectRelativeFolder('b.ts', CWD)).toBe('.');
  });
  it('are honoured by the engine in Ask first, for editing and for creating', () => {
    const layers = { presetRules: [], modeRules: rulesForMode('ask'), denyList: DESTRUCTIVE_DENY_LIST, rememberedRules: folderRulesFor('src/ui/a.ts', CWD)! };
    expect(decidePermission('Edit', 'src/ui/b.ts', layers, { cwd: CWD }).action).toBe('allow');
    expect(decidePermission('Write', 'src/ui/new.ts', layers, { cwd: CWD }).action).toBe('allow');
    expect(decidePermission('Edit', 'src/other/b.ts', layers, { cwd: CWD }).action).toBe('ask');
  });
});

describe('what the card offers and what main stores', () => {
  it('offers this file or the folder, in plain words', () => {
    expect(editGrantChoices('src/ui/a.ts').map((c) => [c.scope, c.label])).toEqual([['exact', 'Only this file'], ['folder', 'Files in src/ui']]);
    expect(editGrantChoices('a.ts')[1].label).toBe('Files in the project folder');
    expect(editGrantChoices('src/ui/a.ts')[1].limits).toMatch(/password and key files/);
    expect(editGrantChoices(undefined)).toEqual([]);
  });
  it('stores the folder only when asked, and falls back to the one file otherwise', () => {
    expect(rememberedRulesFor('Edit', 'src/ui/a.ts', 'folder', CWD).map((r) => r.match)).toEqual(['folder', 'folder']);
    expect(rememberedRulesFor('Edit', 'src/ui/a.ts', 'exact', CWD)).toEqual([{ tool: 'Edit', pattern: 'src/ui/a.ts', action: 'allow', match: 'exact' }]);
    expect(rememberedRulesFor('Edit', 'src/ui/a.ts', undefined, CWD)).toHaveLength(1);
    // the folder cannot be derived: the narrowest grant, never a wider guess
    expect(rememberedRulesFor('Edit', '../x/a.ts', 'folder', CWD)).toEqual([{ tool: 'Edit', pattern: '../x/a.ts', action: 'allow', match: 'exact' }]);
    // other tools never get a folder rule
    expect(rememberedRulesFor('Read', 'src/ui/a.ts', 'folder', CWD)[0].match).toBe('exact');
  });
});

describe('the broker only passes the choices that make sense', () => {
  function ask(extra: Record<string, unknown>, decision: Record<string, unknown>) {
    const broker = new PermissionBroker();
    let id = '';
    broker.on('hook-event', (e: any) => { id = e.payload._requestId; });
    const p = broker.ask({ sessionId: 's', toolName: 'Edit', toolInput: { file_path: 'a.ts' }, denyListed: false, ...extra } as any);
    broker.respond(id, { decision: { behavior: 'allow' }, ...decision });
    return p;
  }
  it('"this conversation" is honoured on an ordinary edit ask', async () => {
    expect((await ask({}, { allowEditsForChat: true })).allowEditsForChat).toBe(true);
  });
  it('and never on an outside-folder ask, a floor-forced ask, a helper, or another tool', async () => {
    expect((await ask({ external: true }, { allowEditsForChat: true })).allowEditsForChat).toBeUndefined();
    expect((await ask({ floorStop: 'secret-path' }, { allowEditsForChat: true })).allowEditsForChat).toBeUndefined();
    expect((await ask({ raisedBy: 'child-1' }, { allowEditsForChat: true })).allowEditsForChat).toBeUndefined();
    expect((await ask({ toolName: 'Bash', toolInput: { command: 'ls' } }, { allowEditsForChat: true })).allowEditsForChat).toBeUndefined();
  });
  it('the folder width is passed through; anything else narrows to exact', async () => {
    expect((await ask({}, { updatedPermissions: ['native:always-allow'], grantScope: 'folder' })).grantScope).toBe('folder');
    expect((await ask({}, { updatedPermissions: ['native:always-allow'], grantScope: '../..' })).grantScope).toBe('exact');
  });
});
