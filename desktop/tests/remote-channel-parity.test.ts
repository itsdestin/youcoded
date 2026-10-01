// Every remote channel exists on every surface it needs: the shim (src/renderer/remote-shim.ts),
// the WS host (src/main/remote-server.ts), preload, the desktop IPC handlers and Android.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSource, readStripped, assertPatternMatches } from './helpers/guard-scope';

describe('remote channels — every channel is answered', () => {
  // WHY: readSource already normalises \r\n/\r — the old inline .replace() here is redundant now.
  const read = (rel: string) => readSource(fileURLToPath(new URL(rel, import.meta.url)));
  const shim = read('../src/renderer/remote-shim.ts');
  const server = read('../src/main/remote-server.ts');
  // Comment-blanked copies for the guards below: the WHY comments beside a case
  // quote channel names, and a guard reading raw text would count the explanation
  // of a missing case as the case.
  const shimCode = readStripped(fileURLToPath(new URL('../src/renderer/remote-shim.ts', import.meta.url)));
  const serverCode = readStripped(fileURLToPath(new URL('../src/main/remote-server.ts', import.meta.url)));

  /** Every `remote:*` channel the shim asks the host for an answer on. */
  function invokedRemoteChannels(): string[] {
    return [...new Set([...shim.matchAll(/invoke\('(remote:[^']+)'/g)].map(m => m[1]))].sort();
  }

  // WHY (2026-10-01 one-core R3-8): the remote:* administration channels are channel-table entries (main/ipc/remote-admin.ts), so a
  // channel the host "answers" is a `case` OR an entry the phone is not left to the unsupported default for: one it may call, or one
  // that carries the refusal `refusal: hostAdminRefusal` (the answer a phone has always been given). The entries are read as text, one
  // `defineChannel({ name: IPC.X ...` each, with each constant resolved to its channel string through the contract.
  const contractSource = read('../src/shared/backend-contract.ts');
  const adminSource = readStripped(fileURLToPath(new URL('../src/main/ipc/remote-admin.ts', import.meta.url)));
  const adminEntries = adminSource.split('defineChannel({').slice(1).map((chunk) => {
    const konst = /name: IPC\.([A-Z0-9_]+)/.exec(chunk)?.[1] ?? '';
    const head = chunk.slice(0, 260);
    return {
      name: new RegExp(`\\b${konst}: '([^']+)'`).exec(contractSource)?.[1] ?? `?${konst}`,
      answered: !/desktopOnly: true/.test(head) && (!/remoteAllowed: false/.test(head) || /refusal: hostAdminRefusal/.test(head)),
      refused: /remoteAllowed: false/.test(head) && /refusal: hostAdminRefusal/.test(head),
    };
  });

  /** Every `remote:*` channel the WS host answers: a `case`, or a table entry that is not left to the unsupported default. */
  function hostedRemoteChannels(): string[] {
    return [...new Set([
      ...[...server.matchAll(/case '(remote:[^']+)':/g)].map(m => m[1]),
      ...adminEntries.filter(e => e.answered).map(e => e.name),
    ])].sort();
  }

  /**
   * A channel has five surfaces (`.claude/rules/ipc-bridge.md`), and `remote-server.ts` — the
   * host a remote BROWSER talks to — is the one that gets forgotten, because every other
   * surface is exercised by simply running the desktop app.
   *
   * This is the guard that was missing. `remote:status` shipped to preload, the shim, the
   * desktop IPC handlers and Android, and not to the host; the panel requests it in the same
   * `Promise.all` as the config, the Tailscale info and the device list, so one missing case
   * opened the whole Remote Access screen blank on a phone. Every test that could have caught
   * it was a `toContain` over source text for the channels somebody remembered to list.
   */
  describe('every remote channel the shim invokes is answered by the host', () => {
    it('leaves none of them to the unsupported default', () => {
      const missing = invokedRemoteChannels().filter(c => !hostedRemoteChannels().includes(c));
      expect(missing).toEqual([]);
    });

    it('finds real channels on both sides, so an empty diff cannot pass vacuously', () => {
      // Without this, deleting `invoke(` from the shim would make the test above pass.
      expect(invokedRemoteChannels()).toContain('remote:status');
      expect(invokedRemoteChannels()).toContain('remote:devices:unpair');
      expect(hostedRemoteChannels().length).toBeGreaterThanOrEqual(invokedRemoteChannels().length);
    });

    it('rejects, rather than resolving, on every channel the host refuses', () => {
      // The host answers `{ok:false}` to host administration. The shim turns that into a
      // rejection only for channels in REJECT_ON_NOT_OK; anywhere else it resolves as an
      // ordinary value and the caller reads a refusal as success — which is how Unpair
      // removed a row from the list for a device that kept full access.
      // WHY (2026-10-01 one-core R3-8): the refusals are table entries that carry `refusal: hostAdminRefusal`.
      expect(adminEntries.filter(e => e.name.startsWith('?'))).toEqual([]);
      const refused = adminEntries.filter(e => e.refused).map(e => e.name).sort();
      expect(refused.length).toBeGreaterThan(0);
      const rejectList = /export const REJECT_ON_NOT_OK[^[]*\[([\s\S]*?)\n\]\);/.exec(shim)?.[1] ?? '';
      const unguarded = refused.filter(c => !rejectList.includes(`'${c}'`));
      expect(unguarded).toEqual([]);
    });
  });

  // ── Batch 3: the file channels (design 2026-09-10 §8, review R2-16) ──────────
  //
  // The same shape of guard, for the prefixes the phone's Files screens live on.
  // Before batch 3 the shim invoked fourteen `artifacts:` / `project:` channels
  // and the host had a case for ONE; every other request fell to the unsupported
  // default and the phone's file lists were empty. This is the guard that would
  // have said so.

  const INVOKE = (prefix: string) => new RegExp(`invoke\\('(${prefix}[^']+)'`, 'g');
  const CASE = (prefix: string) => new RegExp(`case '(${prefix}[^']+)':`, 'g');
  const unique = (src: string, re: RegExp) => [...new Set([...src.matchAll(re)].map(m => m[1]))].sort();

  /**
   * The file channels the host deliberately does NOT answer: every one is a
   * WRITE, and editing over remote is not in batch 3 ("Not in this batch"). A
   * phone that asks gets the honest `unsupported` refusal and the toast that
   * names the feature. Bridge one and delete its row here — the honesty checks
   * below fail on a stale exemption.
   */
  const FILE_WRITES_NOT_OVER_REMOTE = [
    'artifacts:save',
    'artifacts:append-version',
    'artifacts:import-file',
    'artifacts:include-external',
    'artifacts:exclude',
    'artifacts:delete-project',
    'artifacts:rename',
    'artifacts:remove-record',
    'project:write-context-file',
  ];

  // WHY (2026-09-30 one-core R3-7): the artifacts: and project: channels are channel-table entries
  // (main/ipc/artifacts.ts, project.ts), so "answered by the host" is now "has a table entry the phone is not
  // refused from". The scan reads those two files as text (one `defineChannel({ name: IPC.X ...` per entry; a
  // `remoteAllowed: false` on the entry is the refusal) and resolves each constant to its channel string through
  // the contract, so an entry that loses its name or its refusal changes this answer.
  const contract = read('../src/shared/backend-contract.ts');
  const valueOf = (konst: string) => new RegExp(`\\b${konst}: '([^']+)'`).exec(contract)?.[1];
  function tableEntries(file: string): Array<{ name: string; phone: boolean }> {
    const src = readStripped(fileURLToPath(new URL(`../src/main/ipc/${file}.ts`, import.meta.url)));
    return src.split('defineChannel({').slice(1).map((chunk) => {
      const konst = /name: IPC\.([A-Z0-9_]+)/.exec(chunk)?.[1] ?? '';
      const head = chunk.slice(0, 200);
      return { name: valueOf(konst) ?? `?${konst}`, phone: !/remoteAllowed: false|desktopOnly: true/.test(head) };
    });
  }
  const hostedFileChannels = (prefix: string) => [
    ...unique(serverCode, CASE(prefix)),
    ...[...tableEntries('artifacts'), ...tableEntries('project')].filter((e) => e.phone && e.name.startsWith(prefix)).map((e) => e.name),
  ];
  const refusedByTable = () => [...tableEntries('artifacts'), ...tableEntries('project')].filter((e) => !e.phone).map((e) => e.name);

  describe('every file channel a phone reads through is answered by the host', () => {
    it('the patterns can see real channels on both sides, so an empty diff is not vacuous', () => {
      assertPatternMatches(INVOKE('artifacts:'), "invoke('artifacts:get', { projectRoot, artifactId })", 'a shim invoke of an artifacts: channel');
      expect(unique(shimCode, INVOKE('artifacts:'))).toContain('artifacts:get');
      expect(hostedFileChannels('artifacts:')).toContain('artifacts:get');
      expect(unique(shimCode, INVOKE('project:'))).toContain('project:list-context');
      expect(hostedFileChannels('project:')).toContain('project:list-context');
      // Every entry's constant resolved to a real channel string (a typo would read as "?KONST").
      expect([...tableEntries('artifacts'), ...tableEntries('project')].filter((e) => e.name.startsWith('?'))).toEqual([]);
    });

    for (const prefix of ['artifacts:', 'project:']) {
      it(`leaves no ${prefix} read to the unsupported default`, () => {
        const invoked = unique(shimCode, INVOKE(prefix));
        const hosted = hostedFileChannels(prefix);
        const missing = invoked.filter(c => !hosted.includes(c) && !FILE_WRITES_NOT_OVER_REMOTE.includes(c));
        expect(missing).toEqual([]);
      });
    }

    it('the exemption list is honest: each entry is still invoked by the shim and still refused to a phone', () => {
      const invoked = [...unique(shimCode, INVOKE('artifacts:')), ...unique(shimCode, INVOKE('project:'))];
      const hosted = [...hostedFileChannels('artifacts:'), ...hostedFileChannels('project:')];
      expect(FILE_WRITES_NOT_OVER_REMOTE.filter(c => !invoked.includes(c))).toEqual([]);
      // A write that gained a phone-allowed entry is bridged now; its row here would claim otherwise.
      expect(FILE_WRITES_NOT_OVER_REMOTE.filter(c => hosted.includes(c))).toEqual([]);
      // And the table really does refuse every one of them (the answer the phone has always been given).
      expect(FILE_WRITES_NOT_OVER_REMOTE.filter(c => !refusedByTable().includes(c))).toEqual([]);
    });
  });

  // ── Batch 2's bare frames (design 2026-09-10 §1, §7; review R2-16) ────────────
  //
  // `client:ready` is sent by the shim with no id and no reply; `pty:reset:<sid>`
  // is pushed by the host. Neither goes through invoke() or a response, so the
  // prefix guards above cannot see them. Checked as a PAIR — if either side names
  // the string, the other must — rather than as presence, because batch 2 is
  // built on a sibling branch: presence would be red here until the merge, and a
  // one-sided name after the merge is exactly the drift this file exists to catch.
  describe('the bare frames batch 2 adds are named on both ends or neither', () => {
    for (const name of ['client:ready', 'pty:reset']) {
      it(`${name}`, () => {
        const inShim = shimCode.includes(`'${name}`);
        const inHost = serverCode.includes(`'${name}`);
        expect(inShim, `${name}: shim ${inShim ? 'names' : 'lacks'} it, host ${inHost ? 'names' : 'lacks'} it`).toBe(inHost);
      });
    }
  });
});

describe('remote channels — device list channels', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const preload = read('../src/main/preload.ts');
  const handlers = read('../src/main/ipc-handlers.ts');
  const shim = read('../src/renderer/remote-shim.ts');
  const kotlin = read('../../app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt');
  const CHANNELS = ['remote:devices:list', 'remote:devices:rename', 'remote:devices:unpair'];

  describe('the device list exists on every platform', () => {
    it('each channel is registered in preload, the desktop handlers and the shim', () => {
      // WHY a parity test and not a type: a bridge type (SharedBridge in shared/backend-contract.ts)
      // compares SHAPES, so a channel missing from one side of the bridge type-checks and
      // then does nothing at runtime.
      for (const c of CHANNELS) {
        expect(preload).toContain(`'${c}'`);
        expect(shim).toContain(`'${c}'`);
      }
      // WHY remote-admin.ts (2026-10-01 one-core R3-8): the three are channel-table entries now, not ipc-handlers.ts handlers.
      const adminEntries = read('../src/main/ipc/remote-admin.ts');
      expect(adminEntries).toContain('name: IPC.REMOTE_DEVICES_LIST');
      expect(adminEntries).toContain('name: IPC.REMOTE_DEVICES_RENAME');
      expect(adminEntries).toContain('name: IPC.REMOTE_DEVICES_UNPAIR');
      expect(handlers).not.toContain('ipcMain.handle(IPC.REMOTE_DEVICES');
    });

    it('Android answers all three rather than falling through to unsupported', () => {
      // The bridge types in shared/backend-contract.ts cannot see Kotlin, so a missing case here is invisible until a
      // phone hits it. Every channel must appear in the when-block.
      for (const c of CHANNELS) expect(kotlin).toContain(`"${c}"`);
    });

    it('the channel that looked like it removed access is gone, not merely unused', () => {
      // remote:disconnect-client closed the socket and left the credential valid. Keeping it
      // beside Unpair would put two near-identical labels with very different consequences
      // next to each other.
      expect(preload).not.toContain('disconnectClient');
      expect(shim).not.toContain('disconnectClient:');
      expect(kotlin).not.toContain('"remote:disconnect-client"');
      expect(read('../src/main/remote-server.ts')).not.toContain('disconnectClient(clientId: string)');
      // And it has no case in the WS host either. It briefly had one, answering an explicit
      // `{ok:false}` so an un-upgraded client would be told no — but a shim only converts
      // `{ok:false}` into an error for channels in its own REJECT_ON_NOT_OK list, and no
      // released version lists this one, so that "refusal" resolved as an ordinary value.
      // The `default:` arm answers `{unsupported:true}`, which every shim version rejects.
      expect(read('../src/main/remote-server.ts')).not.toContain("case 'remote:disconnect-client'");
    });
  });
});

// Remote access batch 2, design §6 "Surfaces" (T4): the strip's two channels on
// every surface. Preload declares them (desktop never shows the strip), desktop
// IPC answers not-remote, the shim implements them, the host handles
// remote:rehydrate (remote-channel-parity.test.ts checks the host case), and
// Android relies on its catch-all. App's own use was pinned in
// remote-place-app-wiring.test.ts, deleted 2026-09-16 (Plan B Task 4, no replacement —
// see state/remote-place.ts).
describe('remote channels — rehydrate channels', () => {
  const src = (...p: string[]) => readStripped(join(__dirname, '..', 'src', ...p));

  describe('remote:rehydrate and remote:conversation-status surfaces', () => {
    it('both IPC maps name remote:rehydrate', () => {
      const constant = /REMOTE_REHYDRATE:\s*'remote:rehydrate'/;
      assertPatternMatches(constant, "REMOTE_REHYDRATE: 'remote:rehydrate',", 'the IPC map entry');
      expect(src('main', 'preload.ts')).toMatch(constant);
      expect(src('shared', 'backend-contract.ts')).toMatch(constant);
    });

    it('preload declares rehydrate, reportHydrate and the status push', () => {
      const preload = src('main', 'preload.ts');
      const invoke = /rehydrate:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(IPC\.REMOTE_REHYDRATE\)/;
      assertPatternMatches(invoke, 'rehydrate: () => ipcRenderer.invoke(IPC.REMOTE_REHYDRATE)', 'the preload invoke');
      expect(preload).toMatch(invoke);
      const report = /reportHydrate:\s*\([^)]*\)\s*=>\s*\{\s*\}/;
      assertPatternMatches(report, 'reportHydrate: (_report: { seq?: number; kept: string[] }) => {}', 'an empty arrow');
      expect(preload).toMatch(report);
      const status = /remoteConversationStatus:\s*\([^)]*\)\s*=>\s*\(\)\s*=>\s*\{\s*\}/;
      assertPatternMatches(status, 'remoteConversationStatus: (_cb: unknown) => () => {}', 'a no-op subscriber');
      expect(preload).toMatch(status);
    });

    it('desktop IPC answers not-remote — a desktop has no remote copy to refresh', () => {
      const handler = /ipcMain\.handle\(IPC\.REMOTE_REHYDRATE,[\s\S]{0,300}?ok:\s*false,\s*code:\s*'not-remote'/;
      assertPatternMatches(handler, "ipcMain.handle(IPC.REMOTE_REHYDRATE, async () => ({ ok: false, code: 'not-remote' }))", 'the refusal');
      expect(src('main', 'ipc-handlers.ts')).toMatch(handler);
    });

    it('the shim invokes remote:rehydrate and exposes reportHydrate and the status push', () => {
      const shim = src('renderer', 'remote-shim.ts');
      const inv = /invoke\('remote:rehydrate',\s*\{\s*seq/;
      assertPatternMatches(inv, "invoke('remote:rehydrate', { seq })", 'the shim invoke');
      expect(shim).toMatch(inv);
      expect(shim).toMatch(/reportHydrate:\s*\(/);
      expect(shim).toMatch(/remoteConversationStatus:\s*\(/);
    });

    it('the workbench no longer lists them as mock-only', () => {
      const mockOnly = src('renderer', 'dev', 'workbench', 'mock-only.ts');
      expect(mockOnly).not.toMatch(/channel:\s*'on\.remoteConversationStatus'/);
      expect(mockOnly).not.toMatch(/channel:\s*'remote\.rehydrate'/);
    });
  });
});
