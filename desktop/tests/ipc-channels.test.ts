import { describe, test, it, expect } from 'vitest';
import path from 'path';
// readSourceFile is guard-scope's CRLF-normalising reader (Windows checkouts match the same regexes).
import { readSource as readSourceFile } from './helpers/guard-scope';
import { PAGE_SOCKET_CHANNELS, PAGE_VIDEO_CHANNELS } from '../src/shared/pages-types';

// preload.ts cannot import shared/backend-contract.ts (Electron sandbox), so the channel map is written out
// twice and this file keeps the copies identical. It then pins, per channel family, that every surface
// (preload, remote-shim, the channel table in main/ipc/*.ts, remote-server) carries the same strings.
// WHY it fails instead of warning: a channel added to one map and forgotten in the other must be red.
const read = (...parts: string[]) => readSourceFile(path.join(__dirname, '..', ...parts));
const readSource = read;

function ipcConstants(source: string, decl: RegExp): Map<string, string> {
  // Anchored to the `} as const;` terminator: a `[^}]+` body stopped at a `}` inside a comment and
  // silently truncated the map to a third of its keys.
  const block = source.match(decl);
  const out = new Map<string, string>();
  if (!block) return out;
  const entry = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*'([^']+)'/gm; // CONSTANT-shaped names only: comment words ("Task 1:") once polluted this
  let m: RegExpExecArray | null;
  while ((m = entry.exec(block[1])) !== null) out.set(m[1], m[2]);
  return out;
}

// A channel-table entry is the only place a channel is served: the entry exists, ipc-handlers.ts keeps no
// hand-written ipcMain.handle for it, and remote-server.ts keeps no leftover `case` (the table answers first,
// so a leftover would be dead code).
function expectTableEntry(file: string, konst: string, channel: string): void {
  expect(read('src', 'main', 'ipc', `${file}.ts`), `${channel}: no entry in ipc/${file}.ts`).toContain(`name: IPC.${konst},`);
  expect(read('src', 'main', 'ipc-handlers.ts'), `${channel}: still hand-registered in ipc-handlers.ts`).not.toContain(`ipcMain.handle(IPC.${konst}`);
  expect(read('src', 'main', 'remote-server.ts'), `${channel}: leftover case in remote-server.ts`).not.toContain(`case '${channel}'`);
}
const konstOf = (channel: string) => channel.toUpperCase().replace(/[:-]/g, '_');

const CONTRACT_RE = /export const IPC\s*=\s*\{([\s\S]*?)\n\} as const;/;
const contractIpc = ipcConstants(read('src', 'shared', 'backend-contract.ts'), CONTRACT_RE);

describe('IPC channel consistency', () => {
  const preloadSource = read('src', 'main', 'preload.ts');
  const preloadIpc = ipcConstants(preloadSource, /const IPC\s*=\s*\{([\s\S]*?)\n\} as const;/);
  const typesIpc = contractIpc;

  test('handoff channels are served by both desktop transports through the table', () => {
    const host = read('src', 'main', 'remote-server.ts');
    const entries = read('src', 'main', 'ipc', 'handoff.ts');
    const shim = read('src', 'renderer', 'remote-shim.ts');
    for (const [name, action] of Object.entries({ HANDOFF_BEGIN: 'begin', HANDOFF_STATUS: 'status',
      HANDOFF_WAIT: 'wait', HANDOFF_RETRY: 'retry', HANDOFF_SAVED_COPY: 'saved-copy', HANDOFF_FORCE: 'force',
      HANDOFF_CANCEL: 'cancel', HANDOFF_CREATE_PARAMS: 'create-params' })) {
      const channel = `handoff:${action}`;
      expect(preloadIpc.get(name)).toBe(channel);
      expect(typesIpc.get(name)).toBe(channel);
      expect(entries).toContain(`IPC.${name}`);
      expect(host).not.toContain(`case '${channel}':`);
      expect(shim).toContain(`invoke('${channel}'`);
    }
  });

  // Without this every comparison below passes vacuously when an extraction stops matching.
  test('both IPC maps were actually parsed', () => {
    expect(preloadIpc.size).toBeGreaterThan(250);
    expect(typesIpc.size).toBeGreaterThan(250);
    expect(preloadIpc.get('BUDDY_SHOW')).toBe('buddy:show');
    expect(typesIpc.get('BUDDY_SHOW')).toBe('buddy:show');
  });

  test('a constant in both maps has the same channel string in both', () => {
    const mismatched = [...preloadIpc]
      .filter(([name, value]) => typesIpc.has(name) && typesIpc.get(name) !== value)
      .map(([name, value]) => `${name}: preload '${value}' vs types '${typesIpc.get(name)}'`);
    expect(mismatched).toEqual([]);
  });

  test('no constant is added to one map and forgotten in the other', () => {
    const preloadOnly = [...preloadIpc.keys()].filter((n) => !typesIpc.has(n)).sort();
    const typesOnly = [...typesIpc.keys()].filter((n) => !preloadIpc.has(n)).sort();
    expect(preloadOnly, 'preload-only constant(s): add them to shared/backend-contract.ts and regenerate').toEqual([]);
    expect(typesOnly, 'contract-only constant(s): run node scripts/generate-preload-channels.mjs').toEqual([]);
  });

  // Report only: 59 legitimate inline channel strings exist (artifacts:*, git:*, project:*, sync:*).
  test('inline ipcRenderer channel strings are reported, not asserted', () => {
    const inline = new Set<string>();
    const pattern = /ipcRenderer\.\w+\('([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(preloadSource)) !== null) inline.add(m[1]);
    const known = new Set([...typesIpc.values(), ...preloadIpc.values()]);
    const unlisted = [...inline].filter((ch) => !known.has(ch) && !ch.includes(':output:'));
    if (unlisted.length > 0) console.warn('preload.ts calls these channels without a map entry:', unlisted);
    expect(inline.size).toBeGreaterThan(0);
  });
});

// ── Channel families ─────────────────────────────────────────────────────────
// Every row: each `req` and `push` string is in preload.ts and remote-shim.ts; `contract` also demands
// shared/backend-contract.ts; `table` names the main/ipc/<file>.ts that serves each `req` (strict: exact
// `name: IPC.X,` entry, no hand-registered copy, no leftover remote-server case). `konst` maps a channel to
// its constant when it is not konstOf(channel). A phone-only/desktop-only difference is a separate test below.
type Family = { req: string[]; push?: string[]; contract?: boolean; table?: string; konst?: (ch: string) => string };

const artifactChannels = [...new Set([...read('src', 'main', 'artifacts', 'ipc-channels.ts').matchAll(/'([^']+)'/g)].map((m) => m[1]))];
const DESKTOP_ONLY_DEV = new Set(['dev:setup-workspace', 'dev:setup-status', 'dev:setup-clear']);
const OFFICE = ['office:status', 'office:create', 'office:pick', 'office:open', 'office:invoke', 'office:close', 'office:versions', 'office:restore', 'office:save-copy'];
const NATIVE_CHANNELS = [
  'native:send', 'native:queue-remove', 'native:interrupt', 'native:compact', 'native:clear', 'native:invoke-skill',
  'native:set-binding', 'native:switch-model', 'native:set-permission-mode', 'native:get-permission-mode',
  'native:sessions-list', 'native:kill-shell', 'native:submit-admin-password', 'native:session-context-text',
];
const DOC_COMMENTS = ['list', 'add', 'reply', 'resolve', 'reopen', 'move', 'edit', 'edit-reply', 'delete', 'delete-reply', 'watch', 'unwatch'].map((a) => `docComments:${a}`);

const FAMILIES: Record<string, Family> = {
  // WHY derived: a hand-listed array let two new dev:* channels escape every check once.
  'dev:*': { req: [...contractIpc.values()].filter((v) => v.startsWith('dev:') && !DESKTOP_ONLY_DEV.has(v)) },
  'account:*': { req: ['account:start', 'account:poll', 'account:signed-in', 'account:user', 'account:refresh', 'account:sign-out',
    'account:sign-out-all', 'account:update-profile', 'account:set-handle', 'account:delete', 'account:export'] },
  'social:*': { req: ['social:lookup-handle', 'social:send-request', 'social:list-requests', 'social:accept-request', 'social:decline-request',
    'social:cancel-request', 'social:list-friends', 'social:unfriend', 'social:block', 'social:unblock', 'social:list-blocks',
    'social:presence-connect', 'social:presence-disconnect', 'social:presence-send'], push: ['social:presence-event'], table: 'social' },
  'terminal:get-screen-text': { req: ['terminal:get-screen-text'], table: 'ui' },
  'native:retry': { req: ['native:retry'], contract: true, table: 'native' },
  'native:continue-turn': { req: ['native:continue-turn'], contract: true, table: 'native' },
  'pty:raw-bytes': { req: ['pty:raw-bytes'] },
  'update:changelog': { req: ['update:changelog'] },
  'analytics:*': { req: ['analytics:get-opt-in', 'analytics:set-opt-in'] },
  'performance:* and app:restart': { req: ['performance:get-config', 'performance:set-config', 'app:restart'] },
  'artifacts:*': { req: artifactChannels.filter((c) => c !== 'artifacts:changed'), push: ['artifacts:changed'], table: 'artifacts' },
  'project:*': { req: ['project:list-conversations', 'project:repo-info', 'project:list-context', 'project:read-context-file', 'project:write-context-file'], table: 'project' },
  'chatsearch:*': { req: ['chatsearch:resolve', 'chatsearch:read'], table: 'chatsearch' },
  'syncspaces:*': { req: ['status', 'enable', 'sync-now', 'create-project', 'import-project', 'rename-project', 'set-project-description',
    'stop-project', 'remove-project', 'lease-query', 'lease-takeover', 'lease-force', 'list-devices', 'rename-device', 'remove-device'].map((a) => `syncspaces:${a}`),
    push: ['syncspaces:event', 'session:moved'], table: 'sync-spaces', konst: (ch) => `SYNC_SPACES_${ch.slice(11).toUpperCase().replace(/-/g, '_')}` },
  'folders:set-description': { req: ['folders:set-description'], table: 'folders' },
  'github:*': { req: ['github:status', 'github:connect-start', 'github:connect-cancel', 'github:install-gh', 'github:disconnect'], push: ['github:connect-done'], table: 'github' },
  'search:*': { req: ['search:list', 'search:set-key', 'search:remove-key', 'search:test'], table: 'search' },
  'tags and notes': { req: ['session:set-tag', 'session:set-note', 'session:get-meta', 'tags:list', 'tags:create', 'tags:update', 'tags:delete'] },
  'engine:*': { req: ['engine:status', 'engine:install', 'engine:restart'], push: ['engine:install-progress', 'engine:status-changed'], table: 'engine' },
  'git:*': { req: ['git:file-status', 'git:file-review', 'git:commit-file-diff', 'git:stage', 'git:unstage', 'git:commit', 'git:discard', 'git:watch', 'git:unwatch'], push: ['git:changed'], table: 'git' },
  'office:*': { req: OFFICE, push: ['office:changed'] },
  'docComments:*': { req: DOC_COMMENTS, push: ['docComments:changed'] },
  'native:*': { req: NATIVE_CHANNELS },
  'permissions:*': { req: ['permissions:list', 'permissions:remove', 'permissions:remove-project'], table: 'permissions' },
  'specialists:*': { req: ['specialists:list', 'specialists:delegated-get', 'specialists:delegated-set', 'specialists:steer', 'specialists:interrupt'], push: ['specialists:event'], table: 'specialists' },
  'fs:read-head': { req: ['fs:read-head'], table: 'files' },
  'marketplace feedback': { req: ['marketplace:thumb', 'marketplace:thumb:get', 'marketplace:comment'], table: 'marketplace' },
  'arcade:*': { req: ['arcade:status', 'arcade:leaderboard', 'arcade:submit-score', 'arcade:records'], table: 'game' },
  'buddy helper': { req: ['buddy:helper-status', 'buddy:install-helper', 'buddy:remove-helper'], contract: true },
  'pages phase 2': { req: ['pages:approve', 'pages:remove-connection', 'pages:refresh', 'pages:saved-keys', 'pages:delete-saved-key', 'pages:fetch'], contract: true, table: 'pages' },
};

describe('channel families are carried by every surface', () => {
  it.each(Object.entries(FAMILIES))('%s', (name, fam) => {
    expect(fam.req.length, `${name}: no channels found (vacuous)`).toBeGreaterThan(0);
    const preload = read('src', 'main', 'preload.ts');
    const shim = read('src', 'renderer', 'remote-shim.ts');
    const contract = read('src', 'shared', 'backend-contract.ts');
    for (const ch of [...fam.req, ...(fam.push ?? [])]) {
      expect(preload, `${ch} missing from preload.ts`).toContain(`'${ch}'`);
      // buddy answers locally in the shim (no channel name there); its methods are pinned in the buddy test.
      if (name !== 'buddy helper' && name !== 'pages phase 2') expect(shim, `${ch} missing from remote-shim.ts`).toContain(`'${ch}'`);
      if (fam.contract) expect(contract, `${ch} missing from backend-contract.ts`).toContain(`'${ch}'`);
    }
    if (fam.table) for (const ch of fam.req) expectTableEntry(fam.table, (fam.konst ?? konstOf)(ch), ch);
  });
});

describe('dev:* and shell:open-external', () => {
  // Desktop-only must be a REFUSAL, not an omission: the shim's `dev` namespace is hand-built, so a channel
  // left out is `undefined` and a phone user reads "…is not a function" as why setup failed.
  it('a desktop-only dev channel is refused on remote, never merely missing', () => {
    for (const t of DESKTOP_ONLY_DEV) {
      expect(read('src', 'main', 'preload.ts'), `${t} must exist on desktop`).toContain(`'${t}'`);
      expect(read('src', 'renderer', 'remote-shim.ts'), `${t} must route through the shim so remote REFUSES it`).toContain(`'${t}'`);
    }
    expect(read('src', 'renderer', 'remote-unsupported.ts')).toContain("'dev:'");
  });

  it('shell:open-external is invoked by the shim and every surface gates on the SCHEME (http/https only)', () => {
    expect(read('src', 'renderer', 'remote-shim.ts')).toContain("invoke('shell:open-external'");
    // The scheme check is the security boundary: file:, intent: and javascript: must never reach an opener.
    expect(read('src', 'main', 'ipc', 'shell.ts')).toMatch(/\^https\?:\\\/\\\//);
  });
});

describe('account and social: no hand-written copy left', () => {
  it('account:* are served by main/ipc/account.ts and no marketplace:auth:* string remains', () => {
    const src = read('src', 'main', 'ipc', 'account.ts');
    for (const t of FAMILIES['account:*'].req) expect(src).toContain(`IPC.${konstOf(t)}`);
    expect(read('src', 'main', 'marketplace-api-handlers.ts')).not.toMatch(/ipcMain\.handle\(\s*"account:/);
    for (const p of [['src', 'main', 'preload.ts'], ['src', 'renderer', 'remote-shim.ts'], ['src', 'main', 'marketplace-api-handlers.ts']] as const) {
      expect(read(...p)).not.toContain('marketplace:auth:');
    }
  });

  it('social:* and arcade:* are not registered by hand in their handler files', () => {
    for (const t of FAMILIES['social:*'].req) expect(read('src', 'main', 'social-handlers.ts'), t).not.toContain(`ipcMain.handle("${t}"`);
    for (const t of FAMILIES['arcade:*'].req) expect(read('src', 'main', 'arcade-handlers.ts'), t).not.toContain(`"${t}"`);
  });
});

describe('browser:* channel parity', () => {
  const REQUESTS = [...read('src', 'shared', 'backend-contract.ts').matchAll(/^\s*(BROWSER_[A-Z_]+):\s*'(browser:[^']+)'/gm)]
    .filter(([, k]) => !['BROWSER_STATE_CHANGED', 'BROWSER_FRAME', 'BROWSER_INFO_CHANGED'].includes(k));
  it('names twenty request channels (non-vacuity)', () => {
    expect(REQUESTS.length).toBe(20);
  });
  it('each is a desktopOnly table entry, in preload and remote-shim', () => {
    const table = read('src', 'main', 'ipc', 'browser.ts');
    const preload = read('src', 'main', 'preload.ts');
    const shim = read('src', 'renderer', 'remote-shim.ts');
    for (const [, konst, channel] of REQUESTS) {
      expect(table, `${channel}: no desktopOnly entry`).toMatch(new RegExp(`name: IPC\\.${konst}, kind: '(handle|on)', desktopOnly: true`));
      expect(preload, `${channel}: not in preload`).toContain(`IPC.${konst}`);
      // Fire-and-forget sends (picture acks, clicks, panel size) are no-ops on a phone.
      if (!['BROWSER_FRAME_ACK', 'BROWSER_INPUT', 'BROWSER_VIEW_SIZE'].includes(konst)) expect(shim, `${channel}: not in remote-shim`).toContain(`'${channel}'`);
    }
  });
});

describe('forwarded arguments and push wiring', () => {
  // Audit W24: a bridge that drops tailRows silently reverts to the handler's default tail.
  it('terminal:get-screen-text forwards tailRows in preload and in the shim', () => {
    expect(read('src', 'main', 'preload.ts')).toMatch(/ipcRenderer\.invoke\('terminal:get-screen-text',\s*\{\s*sessionId,\s*tailRows\s*\}\)/);
    expect(read('src', 'renderer', 'remote-shim.ts')).toMatch(/invoke\('terminal:get-screen-text',\s*\{\s*sessionId,\s*tailRows\s*\}\)/);
  });

  // A dropped SECOND argument is invisible elsewhere: main gets an empty patch and the dialog shows a save that
  // did not happen. preload can't be imported (contextBridge at load), so the call shape is pinned as text.
  it('preload forwards every argument of the two-argument models channels', () => {
    const src = read('src', 'main', 'preload.ts');
    expect(src).toContain('ipcRenderer.invoke(IPC.MODELS_SET_SETTINGS, { modelId, patch })');
    expect(src).toContain('ipcRenderer.invoke(IPC.MODELS_DOWNLOAD, { repo, quant })');
  });

  it('pushes still reach every window and every phone', () => {
    const src = read('src', 'main', 'ipc-handlers.ts');
    for (const ch of ['engine:install-progress', 'engine:status-changed']) expect(src).toContain(`remoteServer?.broadcast({ type: '${ch}'`);
    expect(src).toContain('send(IPC.ENGINE_INSTALL_PROGRESS, p)');
    expect(src).toContain('send(IPC.ENGINE_STATUS_CHANGED, s)');
    expect(src).toContain('send(IPC.MODELS_DOWNLOAD_PROGRESS, p)');
    expect(src).toContain("remoteServer?.broadcast({ type: 'models:download-progress'");
    // One publish reaches the windows and every phone (publish.ts); session-publish-equivalence.test.ts pins what each receives.
    expect(src).toContain('publish(sessionId, IPC.NATIVE_MODEL_STATE, full)');
    expect(src).toContain('publish(e.sessionId, IPC.NATIVE_PERMISSION_MODE, e)');
    expect(src).toContain('wireDocCommentsPush(');
  });

  it('native:permission-mode push is consumed by preload and the shim (the chip in every window and phone depends on it)', () => {
    const preload = read('src', 'main', 'preload.ts');
    expect(preload).toContain(`NATIVE_PERMISSION_MODE: 'native:permission-mode'`);
    expect(preload).toContain('onPermissionMode:');
    const shim = read('src', 'renderer', 'remote-shim.ts');
    expect(shim).toContain(`case 'native:permission-mode':`);
    expect(shim).toContain('onPermissionMode:');
  });

  it('native:supported is a plain flag on both surfaces: preload exposes it, the shim says false', () => {
    const preload = read('src', 'main', 'preload.ts');
    expect(preload).toMatch(/native:\s*\{/);
    expect(preload).toMatch(/supported:/);
    const shim = read('src', 'renderer', 'remote-shim.ts');
    expect(shim).toMatch(/native:\s*\{/);
    expect(shim).toMatch(/supported:\s*false/);
  });
});

describe('session:menu-lock channel parity', () => {
  // One lease so a desktop window and a phone can never both type arrows into one startup dialog (e.g. trusting a folder).
  it('is declared under one constant, invoked by preload and the shim, and served by one entry over the shared host lock', () => {
    const preload = read('src', 'main', 'preload.ts');
    expect(read('src', 'shared', 'backend-contract.ts')).toMatch(/SESSION_MENU_LOCK:\s*'session:menu-lock'/);
    expect(preload).toMatch(/SESSION_MENU_LOCK:\s*'session:menu-lock'/);
    expect(preload).toMatch(/ipcRenderer\.invoke\(IPC\.SESSION_MENU_LOCK\b/);
    expect(read('src', 'renderer', 'remote-shim.ts')).toContain(`invoke('session:menu-lock'`);
    expect(read('src', 'main', 'ipc', 'session.ts')).toMatch(/IPC\.SESSION_MENU_LOCK,[^\n]*menuAnswerLock\.handle\(/);
    expect(read('src', 'main', 'remote-server.ts')).not.toContain("case 'session:menu-lock'");
  });
});

describe('system:back and system:notify-stack-state parity', () => {
  const sites = {
    'preload.ts': read('src', 'main', 'preload.ts'),
    'types.ts': read('src', 'shared', 'backend-contract.ts'),
    'remote-shim.ts': read('src', 'renderer', 'remote-shim.ts'),
    'HostJsBridge.kt': readSourceFile(path.join(__dirname, '../../app/src/main/kotlin/com/youcoded/app/bridge/HostJsBridge.kt')),
  };
  test.each(['system:notify-stack-state', 'system:back'])('%s appears in every file that carries it', (channel) => {
    for (const [siteName, source] of Object.entries(sites)) expect(source, `expected '${channel}' in ${siteName}`).toContain(channel);
  });
});

describe('native:* and provider:* channel table', () => {
  const PROVIDER = ['list', 'upsert', 'remove', 'test', 'set-key', 'catalog', 'services', 'refresh-catalog'].map((a) => `provider:${a}`);
  const NATIVE_TABLE = ['native:send', 'native:interrupt', 'native:set-binding', 'native:switch-model', 'native:set-permission-mode',
    'native:get-permission-mode', 'native:get-step-guard', 'native:set-step-guard', 'native:sessions-list', 'native:get-context-preferences',
    'native:set-context-preferences', 'native:queue-remove', 'native:compact', 'native:clear'];

  // preload may reach a channel through its constant instead of the literal, so either counts.
  it('preload exposes, the shim names, and the table serves every one (provider also has no hand-written copy)', () => {
    const preload = read('src', 'main', 'preload.ts');
    const shim = read('src', 'renderer', 'remote-shim.ts');
    const tables = read('src', 'main', 'ipc', 'native.ts') + read('src', 'main', 'ipc', 'provider.ts');
    for (const t of [...NATIVE_TABLE, ...PROVIDER]) {
      expect(preload.includes(`'${t}'`) || preload.includes(`IPC.${konstOf(t)}`), `${t} missing from preload.ts`).toBe(true);
      expect(shim, `${t} missing from remote-shim.ts`).toContain(`'${t}'`);
      expect(tables, `${t} missing from ipc/native.ts / ipc/provider.ts`).toContain(`IPC.${konstOf(t)}`);
    }
    for (const t of PROVIDER) expectTableEntry('provider', konstOf(t), t);
  });

  // One table entry each, so a phone is answered by the same body as a window and no second `case` can be forgotten.
  it.each(['native:get-permission-mode', 'native:get-step-guard', 'native:set-step-guard', 'native:send', 'native:queue-remove', 'native:queue-send-now', 'native:sessions-list'])(
    '%s is a table entry with no leftover case in remote-server.ts', (channel) => {
      expect(read('src', 'main', 'ipc', 'native.ts')).toMatch(new RegExp(`name: IPC\\.${konstOf(channel)}, kind: 'handle'`));
      expect(read('src', 'main', 'remote-server.ts')).not.toContain(`case '${channel}'`);
    });
});

// Welcome back: the sessions open at last shutdown. Desktop-only; a phone is told there is nothing to offer.
describe('session:reopen-list / session:forget-reopen / window close prompt parity', () => {
  it('reopen: preload and shim carry both, the table awaits the store, and a phone gets the empty answer from the entry', () => {
    const preload = read('src', 'main', 'preload.ts');
    expect(preload).toContain("'session:reopen-list'");
    expect(preload).toContain("'session:forget-reopen'");
    expect(preload).toMatch(/reopenList:.*ipcRenderer\.invoke\(IPC\.SESSION_REOPEN_LIST\)/s);
    expect(preload).toMatch(/forgetReopen:.*ipcRenderer\.invoke\(IPC\.SESSION_FORGET_REOPEN/s);
    const shim = read('src', 'renderer', 'remote-shim.ts');
    expect(shim).toContain("invoke('session:reopen-list')");
    expect(shim).toContain("invoke('session:forget-reopen'");
    // desktopOnly with the "nothing to offer" answer declared as the refusal: the real store never runs for a phone.
    const table = read('src', 'main', 'ipc', 'session.ts');
    expect(table).toMatch(/IPC\.SESSION_REOPEN_LIST, kind: 'handle', desktopOnly: true, refusal: \{ kind: 'reply', payload: \[\] \}/);
    expect(table).toMatch(/IPC\.SESSION_FORGET_REOPEN, kind: 'handle', desktopOnly: true, refusal: \{ kind: 'reply', payload: \{ ok: true \} \}/);
    expect(table).toContain('await store.ready');
    expect(read('src', 'main', 'ipc-handlers.ts')).not.toMatch(/ipcMain\.handle\(IPC\.SESSION_(REOPEN_LIST|FORGET_REOPEN)/);
    expect(read('src', 'main', 'remote-server.ts')).not.toMatch(/case 'session:(reopen-list|forget-reopen)'/);
  });

  // Electron-only (window.claude.window): the trio must be ABSENT from the shim, not answered there.
  it('close prompt: identical strings in preload and contract, exposed on window.claude.window, pushed and answered by main', () => {
    const preload = read('src', 'main', 'preload.ts');
    for (const [name, channel] of [['WINDOW_CLOSE_REQUEST', 'window:close-request'], ['WINDOW_ANSWER_CLOSE', 'window:answer-close'],
      ['WINDOW_CLOSE_REQUEST_CANCELLED', 'window:close-request-cancelled']] as const) {
      expect(preload).toContain(`${name}: '${channel}'`);
      expect(read('src', 'shared', 'backend-contract.ts')).toContain(`${name}: '${channel}'`);
    }
    expect(preload).toMatch(/onCloseRequest:.*ipcRenderer\.on\(IPC\.WINDOW_CLOSE_REQUEST/s);
    expect(preload).toMatch(/answerClose:.*ipcRenderer\.invoke\(IPC\.WINDOW_ANSWER_CLOSE/s);
    expect(preload).toMatch(/onCloseRequestCancelled:.*ipcRenderer\.on\(IPC\.WINDOW_CLOSE_REQUEST_CANCELLED/s);
    const main = read('src', 'main', 'main.ts');
    expect(main).toContain('IPC.WINDOW_CLOSE_REQUEST');
    expect(main).toContain('IPC.WINDOW_CLOSE_REQUEST_CANCELLED');
    expectTableEntry('window', 'WINDOW_ANSWER_CLOSE', 'window:answer-close');
    expect(main).toMatch(/answerClose:[^\n]*closeRequests\.answer\(/);
    expect(read('src', 'main', 'ipc-handlers.ts')).not.toContain('WINDOW_ANSWER_CLOSE');
  });
});

describe('models:* and engine:set-* channel parity', () => {
  // [channel, constant] — both halves checked: the NAME declared AND the constant USED (a name alone passes on a
  // constant nobody wired to a method, which the renderer cannot call).
  const channels: Array<[string, string]> = [
    'engine:set-backend', 'engine:set-context', 'engine:set-config', 'engine:prereqs', 'engine:run-in-terminal',
    'models:curated', 'models:search', 'models:quants', 'models:download', 'models:download-cancel', 'models:delete',
    'models:installed', 'models:resume', 'models:settings', 'models:set-settings', 'models:add-vision', 'endpoints:detect',
    // model memory lifecycle
    'engine:models', 'models:memory-check', 'models:load',
  ].map((c) => [c, konstOf(c)]);
  const pushChannels = ['models:download-progress', 'engine:models-changed', 'native:model-state'];
  const tableFile = (ch: string) => (ch.startsWith('engine:') ? 'engine' : ch.startsWith('endpoints:') ? 'provider' : 'models');

  it('preload declares AND wires, the shim invokes (not merely names), and the table serves each', () => {
    const preload = read('src', 'main', 'preload.ts');
    // `invoke('name'`, not the bare name: REJECT_ON_NOT_OK also lists some, which would stay green with the method deleted.
    const shim = read('src', 'renderer', 'remote-shim.ts');
    for (const [ch, konst] of channels) {
      expect(preload).toContain(`'${ch}'`);
      expect(preload).toContain(`IPC.${konst}`);
      expect(shim).toContain(`invoke('${ch}'`);
      expectTableEntry(tableFile(ch), konst, ch);
    }
    for (const ch of pushChannels) {
      expect(preload).toContain(`'${ch}'`);
      expect(shim).toContain(`'${ch}'`);
    }
  });

  it('a phone is served every request-response channel by the table', async () => {
    const { findChannel } = await import('../src/main/ipc/channel-table');
    const notServed = channels.map(([ch]) => ch).filter((ch) => {
      const def = findChannel(ch);
      return !def || def.desktopOnly || def.remoteAllowed === false;
    });
    expect(notServed).toEqual([]);
    // WHY 120 s: the first import of the whole channel table is slow on a loaded machine (timed out at 30 s under load).
  }, 120_000);
});

describe('office, docComments: per-feature wiring', () => {
  const preload = read('src', 'main', 'preload.ts');
  const shim = read('src', 'renderer', 'remote-shim.ts');

  it('office channels are answered by the main-process handlers and a refused call is named Office', () => {
    const handlers = read('src', 'main', 'office', 'office-ipc.ts');
    for (const ch of [...OFFICE, 'office:changed']) expect(handlers, ch).toContain(`'${ch}'`);
    expect(read('src', 'renderer', 'remote-unsupported.ts')).toContain(`'office:'`);
  });

  // Desktop-only handshakes: carried by preload and main, and by no other host.
  it.each([
    ['the unsaved-files quit prompt', 'unsaved-quit.ts', ['office:unsaved-prompt', 'office:proceed', 'office:other-unsaved', 'office:dismiss']],
    ['the journal-before-close handshake', 'office/office-journal-sync.ts', ['office:journal-request', 'office:journal-done']],
    ['the live-comments handshake', 'office/office-comments.ts', ['office:comments-request', 'office:comments-answer', 'office:comments-changed']],
  ] as const)('%s is carried by preload and main only', (_n, file, chans) => {
    const main = read('src', 'main', ...file.split('/'));
    for (const ch of chans) {
      expect(preload).toContain(`'${ch}'`);
      expect(main).toContain(`'${ch}'`);
      expect(shim).not.toContain(`'${ch}'`);
    }
  });

  it('docComments: one table entry each, no ipcMain left, and watch/unwatch reject on a failed reply in the shim', () => {
    const entries = read('src', 'main', 'ipc', 'doc-comments.ts');
    const server = read('src', 'main', 'remote-server.ts');
    expect(read('src', 'main', 'doc-comments', 'ipc-handlers.ts')).not.toContain('ipcMain');
    for (const ch of DOC_COMMENTS) {
      expect(entries, `${ch}: no entry`).toContain(`name: DOC_COMMENTS_IPC.${ch.slice(12).toUpperCase().replace(/-/g, '_')}`);
      expect(server).not.toContain(`case '${ch}':`);
    }
    // A failed watch must reject, never resolve as "subscribed, no changes yet" (full behaviour: remote-shim-refusals.test.ts).
    const block = shim.match(/REJECT_ON_NOT_OK[\s\S]*?\]\);/);
    expect(block, 'REJECT_ON_NOT_OK block not found').toBeTruthy();
    expect(block![0]).toContain(`'docComments:watch'`);
    expect(block![0]).toContain(`'docComments:unwatch'`);
  });
});

describe('marketplace feedback and shim payload shapes', () => {
  it('the thumb handlers forward the TOTALS, not just the vote', () => {
    // A handler that rebuilds { vote } and forgets thumbs_up/down passes every component test (they mock the
    // channel) and ships a lit thumb beside "No votes yet" on reopen.
    const src = read('src', 'main', 'ipc', 'marketplace.ts');
    const helper = src.slice(src.indexOf('const thumbs ='), src.indexOf('export const marketplaceChannels'));
    expect(helper, 'the thumbs helper must forward thumbs_up').toContain('thumbs_up');
    expect(helper, 'the thumbs helper must forward thumbs_down').toContain('thumbs_down');
    for (const ch of ['IPC.MARKETPLACE_THUMB,', 'IPC.MARKETPLACE_THUMB_GET,']) {
      const start = src.indexOf(`name: ${ch}`);
      expect(start, `${ch} handler not found`).toBeGreaterThan(-1);
      expect(src.slice(start, start + 400), `${ch} must answer through thumbs()`).toContain('thumbs(');
    }
  });

  // Android reads msg.payload.optString("plugin_id"): a bare string payload arrives empty and the call silently
  // does nothing on a phone. Legal shapes: an object literal, `input` (an object type), or (arcade/chatgpt) nothing.
  it.each([
    ['marketplace', FAMILIES['marketplace feedback'].req, false],
    ['arcade', FAMILIES['arcade:*'].req, true],
    ['chatgpt', ['chatgpt:status', 'chatgpt:sign-in', 'chatgpt:cancel-sign-in', 'chatgpt:sign-out'], true],
  ] as const)('the shim sends an OBJECT payload for every %s channel, never a bare id or positional args', (_n, types, allowNothing) => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const t of types) {
      const call = src.match(new RegExp(`invoke\\('${t}'(,\\s*([^)]*))?\\)`));
      expect(call, `no invoke('${t}', ...) found in remote-shim.ts`).toBeTruthy();
      const arg = (call![2] ?? '').trim();
      const ok = arg.startsWith('{') || (allowNothing && arg === '') || (!allowNothing && arg === 'input');
      expect(ok, `invoke('${t}') must pass an object literal${allowNothing ? ' or nothing' : ' or input'}, got: ${arg}`).toBe(true);
    }
  });
});

describe('buddy:* helper channel parity', () => {
  // Desktop-Electron only by decision: no remote-server arm, so the gap stays a recorded decision, not an oversight.
  const TYPES = FAMILIES['buddy helper'].req;
  it('is served by table entries through the constants, exposed on the preload and shim buddy APIs, and has NO remote-server arm', () => {
    for (const t of TYPES) expectTableEntry('buddy', konstOf(t), t);
    const preload = read('src', 'main', 'preload.ts');
    const shim = read('src', 'renderer', 'remote-shim.ts');
    for (const m of ['helperStatus', 'installHelper', 'removeHelper']) {
      expect(preload, `buddy.${m} is not exposed by preload.ts`).toContain(`${m}: (`);
      // The shim answers locally and never names the channel, so the methods are what must exist.
      expect(shim, `buddy.${m} is missing from remote-shim.ts`).toContain(`${m}: `);
    }
    for (const t of TYPES) expect(read('src', 'main', 'remote-server.ts'), `${t} appeared in remote-server.ts`).not.toContain(`'${t}'`);
  });
});

describe('voice:* channel parity', () => {
  // Surface-specific: preload and main carry every channel; the phone's shim the five shared ones plus the push.
  const preload = read('src', 'main', 'preload.ts');
  const shim = read('src', 'renderer', 'remote-shim.ts');
  const SHARED = ['voice:status', 'voice:download', 'voice:start', 'voice:stop', 'voice:cancel'];
  const DESKTOP_ONLY = ['voice:audio', 'voice:mic-access']; // the phone's recogniser owns the mic / the Activity owns the permission
  const PUSH = 'voice:event';

  it('preload declares every channel, the table serves them, and the handlers file only sends the push', () => {
    for (const t of [...SHARED, ...DESKTOP_ONLY, PUSH]) expect(preload, t).toContain(`'${t}'`);
    for (const t of [...SHARED, 'voice:mic-access']) expectTableEntry('voice', konstOf(t), t);
    // voice:audio streams ten times a second, so it is a fire-and-forget `on` entry on purpose.
    expect(read('src', 'main', 'ipc', 'voice.ts')).toMatch(/name: IPC\.VOICE_AUDIO, kind: 'on'/);
    const handlers = read('src', 'main', 'voice', 'voice-handlers.ts');
    expect(handlers).not.toContain('ipcMain');
    expect(handlers).toMatch(/const EVENT_CHANNEL = 'voice:event'/);
    expect(handlers).toMatch(/send\(EVENT_CHANNEL/);
  });

  // Scoped to the shim's `voice` block (a bare absence check also passes if the namespace vanishes).
  const shimVoiceBlock = (() => {
    const start = shim.search(/^ {4}voice: \{/m);
    if (start < 0) return null;
    const end = shim.indexOf('\n    },', start);
    return end < 0 ? shim.slice(start) : shim.slice(start, end);
  })();

  it("the shim carries the five shared channels and the push, in a findable `voice` block", () => {
    for (const t of [...SHARED, PUSH]) expect(shim, t).toContain(`'${t}'`);
    expect(shimVoiceBlock).not.toBeNull();
    for (const m of ['status', 'download', 'start', 'stop', 'cancel', 'onEvent']) {
      expect(shimVoiceBlock!, `voice.${m} missing from remote-shim.ts`).toMatch(new RegExp(`^ {6}${m}\\s*[:(]`, 'm'));
    }
  });

  it.each([['sendAudio', 'voice:audio'], ['micAccess', 'voice:mic-access']])(
    'EXCEPTION: %s is desktop-only and never sent over the bridge', (method, channel) => {
      expect(preload, `${method} must exist on the desktop`).toContain(method);
      expect(shimVoiceBlock!, `${method} must NOT be on the Android shim`).not.toContain(method);
      expect(shim).not.toContain(`'${channel}'`);
    });
});

describe('sign-in channel parity (openrouter, chatgpt, claude-code)', () => {
  // A bare toContain("'chatgpt:status'") is satisfied by the IPC constants table alone; deleting every method from
  // the exposed object once shipped green, so each is checked as an actual invoke through the constant.
  it.each([
    ['openrouter', { 'openrouter:sign-in-status': 'OPENROUTER_SIGN_IN_STATUS', 'openrouter:sign-in': 'OPENROUTER_SIGN_IN', 'openrouter:cancel-sign-in': 'OPENROUTER_CANCEL_SIGN_IN' }],
    ['chatgpt', { 'chatgpt:status': 'CHATGPT_STATUS', 'chatgpt:sign-in': 'CHATGPT_SIGN_IN', 'chatgpt:cancel-sign-in': 'CHATGPT_CANCEL_SIGN_IN', 'chatgpt:sign-out': 'CHATGPT_SIGN_OUT' }],
  ] as const)('%s: invoked by preload through the constant, in the shim, served by table entries', (ns, consts) => {
    const preload = read('src', 'main', 'preload.ts');
    const shim = read('src', 'renderer', 'remote-shim.ts');
    for (const [t, c] of Object.entries(consts)) {
      expect(preload, `${t} missing from preload.ts`).toContain(`'${t}'`);
      expect(preload, `${t} is only in the constants table`).toMatch(new RegExp(`ipcRenderer\\.invoke\\(IPC\\.${c}\\b`));
      expect(shim, `${t} missing from remote-shim.ts`).toContain(`'${t}'`);
      expect(read('src', 'shared', 'backend-contract.ts')).toContain(`${c}: '${t}'`);
      expectTableEntry(ns, c, t);
    }
    // A phone's sign-in is the entry's policy refusal (`false`): the browser tab and 127.0.0.1:1455 listener live on the computer.
    expect(read('src', 'main', 'ipc', `${ns}.ts`)).toMatch(new RegExp(`name: IPC\\.${ns.toUpperCase()}_SIGN_IN, kind: 'handle', remoteAllowed: false, refusal: \\{ kind: 'reply', payload: false \\}`));
  });

  // `supported` is read as `=== true`: undefined on any surface hides the card in the workbench/acceptance deck.
  it('the supported flag is set on every surface', () => {
    const mock = read('src', 'renderer', 'dev', 'workbench', 'mock-shim.ts');
    const preload = read('src', 'main', 'preload.ts');
    const shim = read('src', 'renderer', 'remote-shim.ts');
    expect(preload).toMatch(/openrouter:\s*\{\s*supported: process\.env\.YOUCODED_NATIVE !== '0'/);
    expect(mock).toMatch(/const openrouter = \{[\s\S]*?supported: true,/);
    expect(shim).toMatch(/openrouter:\s*\{\s*supported: false,/);
    expect(preload).toMatch(/chatgpt:\s*\{\s*supported: process\.env\.YOUCODED_CHATGPT !== '0'/);
    expect(mock).toMatch(/const chatgpt = \{[\s\S]*?supported: true,/);
    expect(shim).toMatch(/chatgpt:\s*\{\s*get supported\(\): boolean \{ return .*capabilities\?\.chatgptAccount === true;/);
  });

  it('claude-code:status and :install go through the constant, the table and the shim; the workbench mock answers status', () => {
    const preload = read('src', 'main', 'preload.ts');
    const shim = read('src', 'renderer', 'remote-shim.ts');
    expect(preload).toContain(`'claude-code:status'`);
    expect(preload, 'preload never invokes CLAUDE_CODE_STATUS').toContain('ipcRenderer.invoke(IPC.CLAUDE_CODE_STATUS');
    expect(preload).toContain('ipcRenderer.invoke(IPC.CLAUDE_CODE_INSTALL');
    expect(shim).toContain(`'claude-code:status'`);
    expect(shim).toContain(`invoke('claude-code:install')`);
    for (const [c, t] of [['CLAUDE_CODE_STATUS', 'claude-code:status'], ['CLAUDE_CODE_INSTALL', 'claude-code:install']]) {
      expect(read('src', 'shared', 'backend-contract.ts')).toContain(`${c}: '${t}'`);
      expectTableEntry('claude-code', c, t);
    }
    expect(read('src', 'renderer', 'dev', 'workbench', 'mock-shim.ts')).toMatch(/const claudeCode = \{ status:/);
  });

  // The original bug: both read firstRun.getState() (a SETUP record that is bare {currentStep:'COMPLETE'} on every
  // later launch) as the sign-in answer, greying out every Claude model on a working install.
  it('neither the model menu nor the Claude Code card reads the setup wizard again, and an unreadable status degrades to "unknown"', () => {
    for (const f of [['src', 'renderer', 'components', 'model', 'availability.ts'], ['src', 'renderer', 'components', 'ModelProvidersPopup.tsx']]) {
      expect(read(...f), `${f.join('/')} reaches window.claude.firstRun for a sign-in answer again`).not.toMatch(/\.firstRun[?.[]/);
      expect(read(...f), `${f.join('/')} reads authComplete again`).not.toMatch(/authComplete\s*[=?.]/);
    }
    expect(read('src', 'renderer', 'components', 'model', 'availability.ts')).toMatch(/return \{ state: 'unknown' \};/);
    expect(read('src', 'main', 'ipc', 'claude-code.ts')).toMatch(/CLAUDE_CODE_STATUS[\s\S]{0,500}state: 'unknown'/);
  });
});

describe('first-run local channels and the ChatGPT wiring that has no other guard', () => {
  it('every first-run local channel is invoked by preload and answered by the shim', () => {
    const preload = read('src', 'main', 'preload.ts');
    const shim = read('src', 'renderer', 'remote-shim.ts');
    for (const [constName, method] of [['FIRST_RUN_LOCAL_SETUP', 'localSetup'], ['FIRST_RUN_CONNECT_LOCAL_APP', 'connectLocalApp'],
      ['FIRST_RUN_LOCAL_DOWNLOAD', 'localDownload'], ['FIRST_RUN_RESUME_LOCAL_DOWNLOAD', 'resumeLocalDownload']]) {
      expect(preload, `${constName} never invoked by preload`).toContain(`ipcRenderer.invoke(IPC.${constName}`);
      expect(shim, `${method} missing from remote-shim firstRun`).toMatch(new RegExp(`\\b${method}:`));
    }
  });

  // The band above the message box is read AFTER setup, when main.ts wires no wizard: registerIpcHandlers (every launch) must bind them.
  it('the band channels are registered every launch and both first-run paths wire the setup channels', () => {
    const entries = read('src', 'main', 'ipc', 'first-run.ts');
    expect(entries).toContain('name: IPC.FIRST_RUN_LOCAL_DOWNLOAD,');
    expect(entries).toContain('name: IPC.FIRST_RUN_RESUME_LOCAL_DOWNLOAD,');
    expect(read('src', 'main', 'ipc-handlers.ts')).toContain('bindFirstRunNative(');
    const main = read('src', 'main', 'main.ts');
    expect(main.match(/bindFirstRunManager\(\{/g)?.length ?? 0).toBe(2);
    expect(main.match(/wireSetupDownloadHandoff\(\(\) =>/g)?.length ?? 0).toBe(2);
  });

  // Nothing else reads main.ts and each is one line whose deletion is silent.
  it('the ChatGPT kill switch reaches the handlers, the background poll and the first-run arm', () => {
    expect(read('src', 'main', 'create-runtime.ts'), 'the kill switch no longer gates the user-facing handle')
      .toMatch(/chatgptForUi[^\n]*process\.env\.YOUCODED_CHATGPT !== '0'/);
    const main = read('src', 'main', 'main.ts');
    // The poll refreshes the token and a rejected refresh deletes the saved sign-in: an ungated poll turns "off" into "sign out".
    expect(main, 'ChatGptAuth is constructed without the pollUsage gate').toMatch(/pollUsage:\s*chatgptEnabled/);
    expect(main, 'the kill switch is not read into chatgptEnabled').toMatch(/const chatgptEnabled = process\.env\.YOUCODED_CHATGPT !== '0'/);
    // Otherwise the first-run arm would open a browser tab and bind port 1455 with the feature off.
    expect(main).toMatch(/chatgptAuth: chatgptEnabled \? chatgptAuth : null/);
    expect(read('src', 'main', 'ipc', 'first-run.ts')).toMatch(/mode === 'chatgpt' && wizard\?\.chatgptAuth/);
  });

  it('re-showing the setup wizard marks setup complete first, so it cannot strand an established install', () => {
    const main = read('src', 'main', 'main.ts');
    const i = main.indexOf("forceStep('AUTHENTICATE')");
    expect(i, 'main.ts no longer re-shows the wizard - update this guard').toBeGreaterThan(0);
    // forceStep writes AUTHENTICATE and isFirstRun reads it: without the mark the next launch re-runs the installers against a working install.
    expect(main.slice(Math.max(0, i - 400), i), 'markSetupCompleted() must run before forceStep(AUTHENTICATE)').toContain('markSetupCompleted()');
  });
});

describe('pages:* live socket, video and ownership', () => {
  const SOCKET = ['pages:socket-open', 'pages:socket-send', 'pages:socket-close', 'pages:socket-ping'];
  const SOCKET_EVENT = 'pages:socket-event';
  const VIDEO = ['pages:video-start', 'pages:video-stop', 'pages:video-ping'];

  // The pages bridge lives in remote-pages-bridge.ts (the shim is at its line budget).
  it('every phase 2 type is invoked by the pages bridge', () => {
    const shim = read('src', 'renderer', 'remote-pages-bridge.ts');
    for (const t of FAMILIES['pages phase 2'].req) expect(shim, t).toContain(`invoke('${t}'`);
  });

  it('main, not the renderer, is where a pasted key from a phone is refused', () => {
    // The door that took the call says who is asking (ctx.door), never the payload.
    expect(read('src', 'main', 'ipc', 'pages.ts')).toMatch(/\.approve\([\s\S]{0,200}?remote: ctx\.door === 'remote'/);
    expect(read('src', 'main', 'ipc-handlers.ts')).not.toMatch(/pagesService\.approve\(/);
  });

  it('every live socket and camera video call is ONE table entry, declared in pages-types, the contract, preload and the bridge', () => {
    const types = read('src', 'shared', 'pages-types.ts');
    const preload = read('src', 'main', 'preload.ts');
    const contract = read('src', 'shared', 'backend-contract.ts');
    const shim = read('src', 'renderer', 'remote-pages-bridge.ts');
    for (const t of [...SOCKET, ...VIDEO]) {
      expect(types, t).toContain(`'${t}'`);
      expect(contract, t).toContain(`'${t}'`);
      expect(preload, t).toContain(`'${t}'`);
      expect(shim, t).toContain(`invoke('${t}'`);
      expectTableEntry('pages', konstOf(t), t);
    }
    expect(PAGE_SOCKET_CHANNELS).toEqual({ open: 'pages:socket-open', send: 'pages:socket-send', close: 'pages:socket-close', ping: 'pages:socket-ping', event: SOCKET_EVENT });
    expect(PAGE_VIDEO_CHANNELS).toEqual({ start: 'pages:video-start', stop: 'pages:video-stop', ping: 'pages:video-ping' });
  });

  it('the socket-event push is declared, subscribed in preload, handled by the shim, and sent only to the owner', () => {
    expect(read('src', 'shared', 'pages-types.ts')).toContain(`'${SOCKET_EVENT}'`);
    expect(read('src', 'main', 'preload.ts')).toContain(`'${SOCKET_EVENT}'`);
    expect(read('src', 'renderer', 'remote-shim.ts')).toContain(`case '${SOCKET_EVENT}':`);
    const owner = read('src', 'main', 'pages', 'page-owner.ts');
    expect(owner).toContain('PAGE_SOCKET_CHANNELS.event');
    expect(owner).not.toMatch(/\.broadcast\(|enqueueForRestoring/); // a phone's events never go through broadcast or the restore queue
    expect(read('src', 'main', 'ipc', 'pages.ts')).toMatch(/ctx\.clientId[\s\S]{0,200}?clientOwnerKey/); // owner comes from the door, never the request
  });

  it('a window or phone going away stops its sockets and videos (behaviour: remote-server-connections.test.ts)', () => {
    expect(read('src', 'main', 'pages', 'page-owner.ts')).toContain('svc.closeOwner(key)');
    expect(read('src', 'main', 'remote-server.ts')).toContain('closeOwner(clientOwnerKey(client.id))');
    expect(read('src', 'shared', 'pages-types.ts')).toContain('PAGE_VIDEO_CHANNELS');
  });
});

// Terminal flow control's ack is DESKTOP-WINDOW-ONLY: a slow phone must never stall the desktop, so each surface
// handles it differently — pinned so a future "parity fix" does not give phones the brake.
describe('session:terminal-ack (terminal flow control)', () => {
  const preload = read('src', 'main', 'preload.ts');
  const contract = read('src', 'shared', 'backend-contract.ts');
  const sessionTable = read('src', 'main', 'ipc', 'session.ts');
  const shim = read('src', 'renderer', 'remote-shim.ts');

  it('desktop: same string in preload and contract, sent by ackOutput, handled in main through the table', () => {
    expect(preload).toContain("TERMINAL_ACK: 'session:terminal-ack'");
    expect(contract).toContain("TERMINAL_ACK: 'session:terminal-ack'");
    expect(preload).toMatch(/ackOutput:[^\n]*\n[^\n]*ipcRenderer\.send\(IPC\.TERMINAL_ACK/);
    expect(sessionTable).toMatch(/name: IPC\.TERMINAL_ACK, kind: 'on', desktopOnly: true, refusal: \{ kind: 'silent' \}/);
    expect(read('src', 'main', 'ipc-handlers.ts')).toContain('terminalOutput.ack(');
    expect(read('src', 'main', 'terminal-output-router.ts')).toContain('const ack = (');
  });

  it('remote clients: the shim sends nothing and the host refuses a stray ack silently (never reaches the PTY worker)', () => {
    expect(shim).toMatch(/ackOutput: \(_sessionId: string, _chars: number\) => \{\}/);
    expect(shim).not.toMatch(/fire\('session:terminal-ack'/);
    expect(read('src', 'main', 'remote-server.ts')).not.toMatch(/ackOutput|bounceSize/);
  });

  it('the repaint request is desktop-window-only the same way: shim no-op, silent refusal for a phone', () => {
    expect(preload).toContain("TERMINAL_REPAINT: 'session:terminal-repaint'");
    expect(contract).toContain("TERMINAL_REPAINT: 'session:terminal-repaint'");
    expect(sessionTable).toMatch(/name: IPC\.TERMINAL_REPAINT, kind: 'on', desktopOnly: true, refusal: \{ kind: 'silent' \}/);
    expect(shim).toMatch(/requestRepaint: \(_sessionId: string\) => \{\}/);
  });
});
