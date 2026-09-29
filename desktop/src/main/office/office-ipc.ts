// The office:* channels: how the renderer reaches the Office editors' main-process half.
// Structurally a sibling of voice/voice-handlers.ts — one register function called from
// main.ts, one channel list pinned beside preload.ts's strings.
//
// WHY main re-checks everything (design section 3a, review 2 R2-7): the renderer checks each
// editor request too, but only as a convenience. Here an office:invoke is refused unless its
// command is on the allow-list AND its token names a document the ASKING window opened
// (event.sender). A compromised or confused renderer can therefore never drive another
// window's document, nor ask the editor host for anything outside the allow-list.
//
// WHY no electron import: ipcMain is passed in (and typed structurally), so the tests drive
// these handlers with a fake that records them. main.ts passes the real one.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { OFFICE_MAX_BYTES, type OfficeFile, type OfficeOpen, type OfficeSaveCopyResult, type OfficeStatus, type OfficeVersion } from '../../shared/office-types';
import { authorizeArtifactWrite } from '../artifacts/write-authorization';
import { log } from '../logger';
import { createOfficeCommands, OFFICE_COMMANDS } from './office-commands';
import type { createSessions, OfficeSession } from './office-sessions';
import { formatFor } from './x2t';
import * as versions from './versions';

type Sessions = ReturnType<typeof createSessions>;

// Byte-identical to the strings in preload.ts (and remote-shim.ts, SessionService.kt);
// tests/ipc-channels.test.ts pins all four.
const CHANNELS = [
  'office:status',
  'office:create',
  'office:pick',
  'office:open',
  'office:invoke',
  'office:close',
  'office:versions',
  'office:restore',
  'office:save-copy',
] as const;

// WHY a local literal, not imported: office-protocol.ts keeps its scheme constant private on
// purpose (main.ts pins the same literal in its privileged-scheme list). The origin handed to
// the renderer is this scheme plus the document token, the host the protocol handler reads.
const SCHEME = 'office';

const MSG = {
  unavailable: "Office isn't included in this build.",
  missing: 'This file no longer exists.',
  unsupported: "Office can't open this kind of file yet.",
  tooLarge: "This file is larger than 200 MB, which Office can't open.",
  protected: "Office can't open files in this protected folder.",
  needsConfirm: "Office can't open settings files like this one yet.",
  noPermission: "Office doesn't have permission to open this file.",
  openElsewhere: 'This file is already open in another window.',
  couldNotOpen: "Office couldn't open this file.",
  couldNotCopy: "Office couldn't save a copy of this file.",
  refused: 'refused',
  notYet: 'Not available yet.',
  changeProtected: "Office can't change files in this protected folder.",
  changeNeedsConfirm: "Office can't change settings files like this one yet.",
  folderGone: "This file's folder no longer exists.",
  stillSaving: 'This file is still being saved. Try again in a moment.',
  couldNotRestore: "Office couldn't restore this version.",
} as const;

/** WHY 10 minutes (design section 3): while a file keeps changing, one extra kept version per
 *  10 minutes of work — autosave itself writes every few seconds, far too often to keep each. */
const AUTOSAVE_SNAPSHOT_MS = 10 * 60 * 1000;

/** The part of Electron's ipcMain these handlers use. */
export interface OfficeIpcMain {
  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void;
  removeHandler(channel: string): void;
}

/** The part of Electron's WebContents (event.sender) these handlers use. */
interface OfficeSender {
  id: number;
  once(event: 'destroyed', listener: () => void): unknown;
  isDestroyed?(): boolean;
  on?(event: 'did-start-navigation', listener: (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => void): unknown;
  send?(channel: string, ...args: unknown[]): void;
}

export interface OfficeIpcDeps {
  /** The live session registry, or null when Office cannot run (see office-session-registry.ts).
   *  WHY a getter, fetched per request: the registry goes away at quit, and a handler must
   *  then answer "unavailable" instead of opening a session in a folder being removed. */
  getSessions(): Sessions | null;
  /** Whether the add-on is installed and matches the pinned version (officeAvailable()). */
  available(): Promise<boolean>;
  /** The add-on folder, for the translator (officeRoot()). */
  root: string;
  /** Where kept versions live (app.getPath('userData'), read after the dev-profile override). */
  userData: string;
  /** Where "Save a copy…" goes (the system save dialog); null when cancelled. Tests pass a fake.
   *  WHY optional: main.ts does not pass it — the real one lives in office-dialogs.ts, loaded
   *  only when a copy is asked for, so this file itself never imports electron. */
  pickCopyTarget?(sender: unknown, filePath: string): Promise<string | null | { refused: string }>;
  /** Tidy every kept version (each file's rules, then 1 GB across files) this long after
   *  registering. WHY a delay (main.ts passes 30 s): it reads every kept file's index and may
   *  delete copies — work that must never compete with the first window opening. Tests leave it
   *  out, so nothing is scheduled. */
  pruneVersionsAfterMs?: number;
  /** Test seam: the translator (a fake that copies). Production uses x2t. */
  convert?: Parameters<typeof createOfficeCommands>[0]['convert'];
}



const fail = (message: string): OfficeOpen => ({ ok: false, message });

export function registerOfficeIpc(ipcMain: OfficeIpcMain, deps: OfficeIpcDeps): void {
  // WHY: ipcMain.handle throws on re-registration. Clearing first keeps hot-reload dev
  // sessions (scripts/run-dev.sh) from crashing on reload.
  for (const ch of CHANNELS) ipcMain.removeHandler(ch);
  ipcMain.removeHandler('office:lost-saves'); // desktop only, so not in CHANNELS (see below)
  if (deps.pruneVersionsAfterMs !== undefined) {
    // pruneAll never throws (it logs); the catch is belt and braces for a timer nobody awaits.
    setTimeout(() => { void versions.pruneAll(deps.userData).catch(() => {}); }, deps.pruneVersionsAfterMs);
  }

  // WHY one commands instance per registry, not one per request: the command runner keeps
  // each document's queue (one save at a time), which only works if every request for that
  // document goes through the same instance. Rebuilt only if the registry itself changes.
  let commands: { reg: Sessions; run: ReturnType<typeof createOfficeCommands> } | null = null;
  const commandsFor = (reg: Sessions) => {
    if (commands?.reg !== reg) commands = { reg, run: createOfficeCommands({ root: deps.root, sessions: reg, onOpened, onSaved, convert: deps.convert }) };
    return commands.run;
  };

  // ── Kept versions (Task 7): both run inside the document's command queue, and a failure is
  // only logged there — the open or save itself has already succeeded. ──
  async function onOpened(s: OfficeSession): Promise<void> {
    await versions.snapshot(deps.userData, s.path, 'opened', await fsp.readFile(s.path));
  }
  async function onSaved(s: OfficeSession, before: Buffer | null): Promise<void> {
    // `before` is the file as it was just before this save — the state worth keeping.
    if (!before || Date.now() - s.lastSnapshotAt <= AUTOSAVE_SNAPSHOT_MS) return;
    await versions.snapshot(deps.userData, s.path, 'autosave', before);
    s.lastSnapshotAt = Date.now();
  }

  const isReady = async (): Promise<Sessions | null> => {
    const reg = deps.getSessions();
    return reg && (await deps.available()) ? reg : null;
  };

  // WHY track windows: a window that closes (or crashes) never sends office:close, and its
  // documents' temp folders would otherwise stay until quit. One listener per window.
  const watched = new Set<number>();
  // WHY count opens (fix round 1): a window can hold the same file in more than one place (a
  // tab, and an Edit in a file panel), and each place is handed the same token. Only the
  // last one's close may tear the session down. Keyed by window, then token.
  const opens = new Map<number, Map<string, number>>();
  // ── Saves lost to a reload (fix round 6, M4) ──
  // WHY: a reload lets go of a save still with main (the renderer's 4 s cap); if that save then
  // fails, the page that asked is gone and its failure would vanish. So main counts each
  // window's page loads, remembers a save that failed after its page changed, and the new page
  // takes the list (office:lost-saves) and shows "An Office document couldn't be saved.".
  const pageLoads = new Map<number, number>();
  const lost = new Map<number, string[]>();
  function watch(sender: OfficeSender): void {
    const id = sender.id;
    if (watched.has(id)) return;
    watched.add(id);
    sender.on?.('did-start-navigation', (details) => {
      if (details?.isMainFrame && !details.isSameDocument) pageLoads.set(id, (pageLoads.get(id) ?? 0) + 1);
    });
    sender.once('destroyed', () => {
      watched.delete(id);
      opens.delete(id);
      pageLoads.delete(id);
      lost.delete(id);
      void deps.getSessions()?.closeAllFor(id).catch((e) => log('WARN', 'Office', 'closing a gone window\'s documents failed', { error: String(e) }));
    });
  }

  // WHY: two opens of one file racing (a double click) must not make two sessions for it —
  // one editor per file (design section 5). The second waits for the first one's session.
  const opening = new Map<string, Promise<OfficeSession>>();

  async function open(sender: OfficeSender, filePath: unknown): Promise<OfficeOpen> {
    const reg = await isReady();
    if (!reg) return fail(MSG.unavailable);
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return fail(MSG.couldNotOpen);

    // WHY the realpath is the session's path (review P1-6): a file reached through a link is
    // the same file, so it maps to the same session, and every later check (the protected
    // folders, versions) judges the real location rather than the spelling it was given.
    let realPath: string;
    try {
      const auth = await authorizeArtifactWrite({ projectRoot: path.dirname(filePath), fullPath: filePath, mustStayInRoot: false });
      if (!auth.ok) {
        if (auth.error === 'protected-path') return fail(MSG.protected);
        // A confirm step for settings-like files is design task 8's; until then, refuse.
        if (auth.error === 'needs-confirm') return fail(MSG.needsConfirm);
        return fail(MSG.missing);
      }
      realPath = auth.realPath;
      // WHY stat after authorizing: the authorization accepts a missing file whose folder
      // exists (it is also used for saving new files), so existence is checked here.
      const info = await fsp.stat(realPath);
      if (!info.isFile() || formatFor(realPath) === null) return fail(MSG.unsupported);
      if (info.size > OFFICE_MAX_BYTES) return fail(MSG.tooLarge);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return fail(MSG.missing);
      if (code === 'EACCES' || code === 'EPERM') return fail(MSG.noPermission);
      // WHY general: the cause is not known for certain, so the message guesses nothing; the
      // detail goes to the log (docs/error-message-standards.md).
      log('ERROR', 'Office', 'office:open failed', { error: String(e), code: code ?? null });
      return fail(MSG.couldNotOpen);
    }

    let session = reg.byPath(realPath);
    if (!session) {
      let pending = opening.get(realPath);
      if (!pending) {
        pending = reg.open(realPath, sender.id);
        opening.set(realPath, pending);
        const clear = () => void opening.delete(realPath);
        pending.then(clear, clear);
      }
      try {
        session = await pending;
      } catch (e) {
        log('ERROR', 'Office', 'office:open could not start a session', { error: String(e) });
        return fail(MSG.couldNotOpen);
      }
    }
    // WHY refuse rather than hand over the token: the token is bound to the window that
    // opened the file, so another window could not use it anyway (invoke re-checks the owner).
    if (session.senderId !== sender.id) return fail(MSG.openElsewhere);
    // WHY (fix round 1): the window can close while main was opening. Its destroyed event has
    // then already run (or never will be listened for), so nothing would ever close this
    // session, and it would keep the file claimed until quit.
    if (sender.isDestroyed?.()) {
      void reg.close(session.token).catch(() => {});
      return fail(MSG.couldNotOpen);
    }
    watch(sender);
    const mine = opens.get(sender.id) ?? new Map<string, number>();
    opens.set(sender.id, mine);
    mine.set(session.token, (mine.get(session.token) ?? 0) + 1);
    return { ok: true, token: session.token, origin: `${SCHEME}://${session.token}` };
  }

  async function invoke(sender: OfficeSender, token: unknown, cmd: unknown, args: unknown): Promise<unknown> {
    if (typeof token !== 'string' || typeof cmd !== 'string' || !OFFICE_COMMANDS.has(cmd)) throw new Error(MSG.refused);
    const reg = deps.getSessions();
    const s = reg?.get(token);
    if (!reg || !s || s.senderId !== sender.id) throw new Error(MSG.refused);
    // WHY a plain object only: the commands read named fields from it; anything else (an
    // array, null) is treated as no arguments rather than reaching them.
    const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    const page = pageLoads.get(sender.id) ?? 0;
    try {
      return await commandsFor(reg)(token, cmd, a);
    } catch (e) {
      // The page that asked was reloaded meanwhile: keep the failure for the new one (M4).
      if (cmd === 'save_file' && (pageLoads.get(sender.id) ?? 0) !== page && !sender.isDestroyed?.()) {
        lost.set(sender.id, [...(lost.get(sender.id) ?? []), s.path]);
        try { sender.send?.('office:saves-lost'); } catch { /* the window is going */ }
      }
      throw e;
    }
  }

  async function close(sender: OfficeSender, token: unknown): Promise<void> {
    if (typeof token !== 'string') return;
    const reg = deps.getSessions();
    // WHY silent for someone else's token: closing is only ever a request about the asking
    // window's own documents; anything else changes nothing.
    if (!reg || reg.get(token)?.senderId !== sender.id) return;
    const mine = opens.get(sender.id);
    const left = (mine?.get(token) ?? 1) - 1;
    if (left > 0) { mine!.set(token, left); return; }
    mine?.delete(token);
    // reg.close waits (capped) for a save still queued for this document before its temp goes.
    await reg.close(token);
  }

  // "Save a copy…" for a document whose save keeps failing (the owner's decision, fix round 1).
  // Same checks as invoke: the token must be one this window opened.
  async function saveCopy(sender: OfficeSender, token: unknown, mode: unknown): Promise<OfficeSaveCopyResult> {
    const reg = deps.getSessions();
    const s = typeof token === 'string' ? reg?.get(token) : undefined;
    if (!reg || !s || s.senderId !== sender.id) return { ok: false, message: MSG.refused };
    const run = commandsFor(reg);
    if (mode === 'check') return { ok: true, possible: run.canCopy(s.token) };
    if (mode === 'again') {
      try {
        const r = await run.saveCopyAgain(s.token);
        if (!r) return { ok: false, message: MSG.couldNotCopy };
        return { ok: true, folder: path.basename(path.dirname(r.target)), path: r.target, unchanged: r.unchanged };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : MSG.couldNotCopy };
      }
    }
    const pick = deps.pickCopyTarget ?? (await import('./office-dialogs')).pickCopyTarget;
    const target = await pick(sender, s.path);
    if (!target) return { ok: false, cancelled: true };
    if (typeof target !== 'string') return { ok: false, message: target.refused };
    try {
      await run.saveCopy(s.token, target);
      // The folder's name only — never a full path on screen (the owner's rule for this message).
      return { ok: true, folder: path.basename(path.dirname(target)), path: target };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : MSG.couldNotCopy };
    }
  }

  // The versions of a file, newest first. WHY the real path: versions are keyed on it (the
  // session's path), so a file named through a link shows the same list.
  async function listVersions(filePath: unknown): Promise<OfficeVersion[]> {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return [];
    const real = await fsp.realpath(filePath).catch(() => filePath);
    return versions.list(deps.userData, real);
  }

  // Put a kept version back (design section 3; restore-while-open in versions.ts's caller here).
  // WHY through the document's queue when it is open: a save already asked for lands first (and
  // is kept as 'before-restore'); the editor's later saves are refused until it reloads — main
  // then tells its window (office:changed), whose editor reopens the restored file.
  async function restoreVersion(sender: OfficeSender, filePath: unknown, id: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
    const reg = await isReady();
    if (!reg) return { ok: false, message: MSG.unavailable };
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || typeof id !== 'string') return { ok: false, message: MSG.couldNotRestore };
    let realPath: string;
    try {
      const auth = await authorizeArtifactWrite({ projectRoot: path.dirname(filePath), fullPath: filePath, mustStayInRoot: false });
      if (!auth.ok) {
        if (auth.error === 'protected-path') return { ok: false, message: MSG.changeProtected };
        if (auth.error === 'needs-confirm') return { ok: false, message: MSG.changeNeedsConfirm };
        // A missing FILE is fine (restoring brings it back); this is its folder.
        return { ok: false, message: MSG.folderGone };
      }
      realPath = auth.realPath;
    } catch (e) {
      log('ERROR', 'Office', 'office:restore could not check the file', { error: String(e) });
      return { ok: false, message: MSG.couldNotRestore };
    }
    if (formatFor(realPath) === null) return { ok: false, message: MSG.unsupported };
    const s = reg.byPath(realPath);
    // Another window's editor holds it: that window would keep editing the old document.
    if (s && s.senderId !== sender.id) return { ok: false, message: MSG.openElsewhere };
    // Closing (its last save may still land after ours) or about to open: not now.
    if (!s && reg.inUse(realPath)) return { ok: false, message: MSG.stillSaving };
    const work = () => versions.restore(deps.userData, realPath, id);
    if (!s) return work();
    let r: { ok: true } | { ok: false; message: string };
    try {
      r = await commandsFor(reg).exclusive(s.token, work, (x) => x.ok);
    } catch (e) {
      // The document closed (or quit began) while the restore waited its turn: nothing was done.
      log('WARN', 'Office', 'office:restore did not run', { error: String(e) });
      return { ok: false, message: MSG.couldNotRestore };
    }
    if (r.ok) {
      try { sender.send?.('office:changed', { path: realPath, token: s.token }); } catch { /* the window is going */ }
    }
    return r;
  }

  ipcMain.handle('office:open', (e, filePath) => open(e.sender, filePath));
  ipcMain.handle('office:versions', (_e, filePath) => listVersions(filePath));
  ipcMain.handle('office:restore', (e, filePath, id) => restoreVersion(e.sender, filePath, id));
  ipcMain.handle('office:save-copy', (e, token, mode) => saveCopy(e.sender, token, mode));
  ipcMain.handle('office:invoke', (e, token, cmd, args) => invoke(e.sender, token, cmd, args));
  ipcMain.handle('office:close', (e, token) => close(e.sender, token));
  // Desktop only, like the close/quit handshake: the remote client and the phone have no editors.
  ipcMain.handle('office:lost-saves', (e): string[] => {
    const id = (e.sender as OfficeSender).id;
    const list = lost.get(id) ?? [];
    lost.delete(id);
    return list;
  });

  // ── Pending: placeholders until the start screen's backend lands ──
  // Task 8 (the start screen's lists, new files, the picker) replaces each of these. Until then
  // they answer the empty shape, never a pretend success.
  ipcMain.handle('office:status', async (): Promise<OfficeStatus> => ({ available: (await isReady()) !== null, recent: [], project: null }));
  ipcMain.handle('office:create', async (): Promise<{ ok: false; message: string }> => ({ ok: false, message: MSG.notYet }));
  ipcMain.handle('office:pick', async (): Promise<OfficeFile | null> => null);
}
