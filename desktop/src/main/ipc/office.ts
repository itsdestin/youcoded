// office.ts — Office's channels (office:status / create / pick / open / invoke / close / versions / restore / save-copy, and the
// window's answers to main's pushes: journal-done / other-unsaved / proceed / dismiss / comments-answer / comments-changed).
// The computer's own windows only.
//
// WHY (2026-10-04, one-core merge of master's Office): master wrote these as `ipcMain.handle` / `ipcMain.on` calls inside
// main/office/office-ipc.ts, office-comments.ts, unsaved-quit.ts and office-journal-sync.ts. After the one-core move a feature
// channel is a table entry, so the name, the types and the phone's refusal live here and the guard test
// (channel-table-complete.test.ts) keeps it that way. `desktopOnly`: a phone gets the same refusal master's host gave
// ("Office isn't available via remote access yet."): the phone shim words it, the table refuses the call before any handler runs.
//
// WHY the handlers are not rewritten: those four modules keep their own tested logic and take their listeners through a small
// injected object (`ipc`), which is how their ~1,300 lines of tests drive them. `officeIpc` below IS that object: main.ts hands
// it to them (registerOfficeIpc, registerOfficeComments, watchUnsavedEdits, syncJournals), and each table entry below forwards
// its one payload object to whatever they registered, as the positional arguments they always took. So there is one place a
// channel is declared (here) and no module registers with Electron itself. Behaviour is unchanged.
import { defineChannel, type MainChannelDef } from './channel-def';
import { IPC } from '../../shared/backend-contract';

type Listener = (event: { sender: any }, ...args: any[]) => unknown;
const handlers = new Map<string, Listener>();
const listeners = new Map<string, Set<Listener>>();

/** WHY the checks (merge review, 2026-10-04): this object stands in for ipcMain, so without them a module could register a
 *  channel the table never declared (no types, no phone refusal, no preload entry) and the guard test could not see it, or
 *  register one twice, as ipcMain.handle refuses. A channel must be a table entry of the matching kind. */
function declared(channel: string, kind: 'handle' | 'on'): void {
  const def = officeChannels.find((d) => d.name === channel);
  if (!def || def.kind !== kind) throw new Error(`${channel} is not an Office '${kind}' channel in the table (main/ipc/office.ts).`);
}

/** The slice of ipcMain the Office modules were written against (handle / removeHandler / on / off), kept in-process. */
export const officeIpc = {
  handle(channel: string, fn: Listener): void {
    declared(channel, 'handle');
    if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    handlers.set(channel, fn);
  },
  removeHandler(channel: string): void { handlers.delete(channel); },
  on(channel: string, fn: Listener): void { declared(channel, 'on'); (listeners.get(channel) ?? listeners.set(channel, new Set()).get(channel)!).add(fn); },
  off(channel: string, fn: Listener): void { listeners.get(channel)?.delete(fn); },
};

/** A request: the module that registered the channel answers. Before it has (a window asking too early) the call fails, as an
 *  unregistered ipcMain.handle did. */
function ask(channel: string, event: { sender: unknown }, ...args: unknown[]): unknown {
  const fn = handlers.get(channel);
  if (!fn) return Promise.reject(new Error(`Office is not ready (${channel}).`));
  return fn(event as { sender: any }, ...args);
}
/** A fire-and-forget message from a window: every module that listens for it hears it. */
function tell(channel: string, event: { sender: unknown }, ...args: unknown[]): void {
  for (const l of [...(listeners.get(channel) ?? [])]) l(event as { sender: any }, ...args);
}

export const officeChannels: MainChannelDef[] = [
  defineChannel({ name: IPC.OFFICE_STATUS, kind: 'handle', desktopOnly: true, handler: ({ projectRoot }, ctx) => ask(IPC.OFFICE_STATUS, { sender: ctx.sender }, projectRoot) as any }),
  defineChannel({ name: IPC.OFFICE_CREATE, kind: 'handle', desktopOnly: true, handler: ({ kind, projectRoot }, ctx) => ask(IPC.OFFICE_CREATE, { sender: ctx.sender }, kind, projectRoot) as any }),
  defineChannel({ name: IPC.OFFICE_PICK, kind: 'handle', desktopOnly: true, handler: (_p, ctx) => ask(IPC.OFFICE_PICK, { sender: ctx.sender }) as any }),
  defineChannel({ name: IPC.OFFICE_OPEN, kind: 'handle', desktopOnly: true, handler: ({ path }, ctx) => ask(IPC.OFFICE_OPEN, { sender: ctx.sender }, path) as any }),
  defineChannel({ name: IPC.OFFICE_INVOKE, kind: 'handle', desktopOnly: true, handler: ({ token, cmd, args }, ctx) => ask(IPC.OFFICE_INVOKE, { sender: ctx.sender }, token, cmd, args) }),
  defineChannel({ name: IPC.OFFICE_CLOSE, kind: 'handle', desktopOnly: true, handler: ({ token }, ctx) => ask(IPC.OFFICE_CLOSE, { sender: ctx.sender }, token) as any }),
  defineChannel({ name: IPC.OFFICE_VERSIONS, kind: 'handle', desktopOnly: true, handler: ({ path }, ctx) => ask(IPC.OFFICE_VERSIONS, { sender: ctx.sender }, path) as any }),
  defineChannel({ name: IPC.OFFICE_RESTORE, kind: 'handle', desktopOnly: true, handler: ({ path, versionId }, ctx) => ask(IPC.OFFICE_RESTORE, { sender: ctx.sender }, path, versionId) as any }),
  defineChannel({ name: IPC.OFFICE_SAVE_COPY, kind: 'handle', desktopOnly: true, handler: ({ token, mode, data }, ctx) => ask(IPC.OFFICE_SAVE_COPY, { sender: ctx.sender }, token, mode, data) as any }),
  // The window's answers to main's pushes. `on`: fire-and-forget, nothing comes back.
  defineChannel({ name: IPC.OFFICE_JOURNAL_DONE, kind: 'on', desktopOnly: true, handler: ({ id }, ctx) => tell(IPC.OFFICE_JOURNAL_DONE, { sender: ctx.sender }, id) }),
  defineChannel({ name: IPC.OFFICE_OTHER_UNSAVED, kind: 'on', desktopOnly: true, handler: ({ names }, ctx) => tell(IPC.OFFICE_OTHER_UNSAVED, { sender: ctx.sender }, names) }),
  defineChannel({ name: IPC.OFFICE_PROCEED, kind: 'on', desktopOnly: true, handler: (_p, ctx) => tell(IPC.OFFICE_PROCEED, { sender: ctx.sender }) }),
  defineChannel({ name: IPC.OFFICE_DISMISS, kind: 'on', desktopOnly: true, handler: (_p, ctx) => tell(IPC.OFFICE_DISMISS, { sender: ctx.sender }) }),
  defineChannel({ name: IPC.OFFICE_COMMENTS_ANSWER, kind: 'on', desktopOnly: true, handler: ({ id, result, token }, ctx) => tell(IPC.OFFICE_COMMENTS_ANSWER, { sender: ctx.sender }, id, result, token) }),
  defineChannel({ name: IPC.OFFICE_COMMENTS_CHANGED, kind: 'on', desktopOnly: true, handler: ({ token }, ctx) => tell(IPC.OFFICE_COMMENTS_CHANGED, { sender: ctx.sender }, token) }),
];
