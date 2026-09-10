// desktop/src/main/sync-spaces/service.ts
// Composition root: owns the singleton ManagedRoots/SpaceManager/Engine and
// exposes the functions IPC + remote-server call. Mirrors the sync-state.ts
// singleton pattern (setSyncService).
import os from 'os';
import { BrowserWindow } from 'electron';
import { ManagedRoots } from './managed-roots';
import { SpaceManager, repoNameForSpace } from './space-manager';
import { GitTransport } from './git-transport';
import { SpaceSyncEngine } from './engine';
import { DailyBackup, BackupTarget } from './daily-backup';
import { importProjectFolder } from './import-project';
import { createSyncHubSocket } from '../sync-hub-socket';
import { getGithubClient } from '../github-client';
import type { LeaseResult, SyncHubEvent } from '../sync-hub-socket';
import { readProjectRegistry, ensureProjectEntry, setProjectDisplayName, setProjectStopped, setProjectDescription } from './project-registry';
import { planReconcile, activeManagedSpaces } from './materialization-planner';
import type { SpaceSyncEvent, SyncSpace } from './types';

let roots: ManagedRoots | null = null;
let manager: SpaceManager | null = null;
let engine: SpaceSyncEngine | null = null;
let backup: DailyBackup | null = null;
let backupTimer: ReturnType<typeof setInterval> | null = null;
let recentEvents: SpaceSyncEvent[] = [];
let logFn: (m: string) => void = console.log;

// SyncHub (Plan 1b): the WebSocket that relays "something changed" signals
// between this account's devices. Held for the enabled lifetime; the engine's
// 120s poll is the fallback when it's down. hubStatus feeds syncSpacesStatus().
let hubSocket: ReturnType<typeof createSyncHubSocket> | null = null;
let hubStatus: 'off' | 'connecting' | 'connected' | 'disconnected' = 'off';

// Durable per-MACHINE id (machineIdentity.id from main.ts), threaded into the hub
// connection so the DO can key this device's sync recency. Null on machines with
// no durable id (dev-only / no built app) — we then connect without a deviceId.
let machineId: string | null = null;

// Per-device sync recency (Task 3): machineId → epoch-ms of that device's most
// recent successful sync. Seeded from the hub's hello snapshot (sync-map) and
// advanced by each live signal that carries a deviceId + server timestamp. This
// is the field surfaced on getSyncStatus()/status:data so the "Your devices" rows
// can show real recency. Reset on teardown so a stale map never outlives the hub.
let lastSyncByDevice: Record<string, number> = {};
// Read by sync-state.ts's getSyncStatus() and ipc-handlers' buildStatusData()
// (the status:data push) — the two paths SyncPanel reads recency from.
export function getLastSyncByDevice(): Record<string, number> { return lastSyncByDevice; }

/** Max persisted last-COMPLETED-sync-CYCLE across this device's spaces (ms), or
 *  null when sync is off / has never completed a cycle. NOT "last successful
 *  sync": corruption and auth failures now THROW (spec §1) and correctly stop
 *  this from advancing, but a cycle that completes without shipping anything
 *  still stamps it — the engine emits 'synced' after pull+push regardless of
 *  push.pushed, and git-transport's offline path is silent-by-design (a failed
 *  retry push whose stderr matches isNetworkFailureStderr falls through
 *  without throwing, returning {pushed:false}). So a device offline for days,
 *  or hitting a lock-contended cycle, still advances this value every ~120s
 *  poll with nothing actually synced. Read it as "sync last ran", not "sync
 *  last succeeded". */
export function getSelfLastSyncEpochMs(): number | null {
  if (!manager || !roots) return null;
  let max: number | null = null;
  for (const s of roots.spaces()) {
    const t = manager.lastSyncFor(s.id);
    if (t != null && (max === null || t > max)) max = t;
  }
  return max;
}

/** Live: any space's sync currently in flight. */
export function isSyncSpacesSyncing(): boolean {
  return engine?.anySyncing() ?? false;
}

// Auth store facade (marketplace token) wired from main.ts. Read lazily per
// connect so a mid-session sign-in/out takes effect without an app restart.
// Kept as a narrow facade so service.ts doesn't import the whole auth store.
let authStore: { getToken(): string | null } | null = null;
export function setSyncSpacesAuthStore(store: { getToken(): string | null } | null): void {
  authStore = store;
}

// Lease client bridge (Plan 2b Task 8). The lease client lives in main.ts (it
// needs sessionIdMap via ipc-handlers), but the hub SOCKET lives here — so this
// module exposes a thin passthrough for the client's request() transport, and a
// listener facade to forward the hub's UNSOLICITED lease-events back to the
// client. Both are narrow facades so service.ts never imports the lease client.

// Route a lease op to the hub socket. Returns null when the hub is down (the
// lease client treats null as "no answer" and falls back to its file / never-block).
export function hubLeaseRequest(op: string, sessionId: string, deviceId: string): Promise<LeaseResult | null> {
  // Debug: takeover/lease failures are silent by design (never-block), which made
  // "takeover didn't happen" undiagnosable from logs (2026-07-23). Log every op +
  // whether the hub could answer — `null` here means the op had NO delivery path.
  if (!hubSocket) {
    console.warn(`[lease] ${op} ${sessionId.slice(0, 8)}: hub socket absent (status=${hubStatus}) — no delivery path, answering null`);
    return Promise.resolve(null);
  }
  return hubSocket.request(op, sessionId, deviceId).then(
    (r) => { console.log(`[lease] ${op} ${sessionId.slice(0, 8)}: ${r ? `ok=${r.ok} holder=${r.holder?.deviceId?.slice(0, 8) ?? 'none'}` : 'null (hub gave no answer)'}`); return r; },
    (e) => { console.warn(`[lease] ${op} ${sessionId.slice(0, 8)}: hub request failed: ${e?.message ?? e}`); throw e; },
  );
}

type LeaseEvent = Extract<SyncHubEvent, { type: 'lease-event' }>;
let leaseEventListener: ((ev: LeaseEvent) => void) | null = null;
// main.ts wires this to leaseClient.handleTakeoverRequest so a hub takeover-request
// reaches the holder. Kept as a facade so service.ts doesn't import the lease client.
export function setSyncSpacesLeaseEventListener(fn: ((ev: LeaseEvent) => void) | null): void { leaseEventListener = fn; }

// The ONE factory for every GitTransport this service creates (engine,
// materialize, create, import) — so the app-token credential provider can
// never be forgotten at a single site. getAuthToken feeds the transport's
// per-call inline credential helper: app/gh token when one exists (cached in
// the client), null otherwise (system credential helper keeps working — the
// no-migration guarantee). Failure-tolerant: a client error means "no token".
function makeTransport(): GitTransport {
  return new GitTransport({
    deviceName: os.hostname(),
    getAuthToken: async () => {
      try { return (await getGithubClient()?.getToken())?.token ?? null; }
      catch { return null; }
    },
    // Thread the service log into the transport so repair() traces (which tier
    // ran, what it deleted) land in the same main-process log as the rest of
    // sync-spaces. Late-bound on purpose: logFn is reassigned by
    // startSyncSpaces, and a direct `log: logFn` would freeze the default.
    log: (m) => logFn(m),
  });
}

// Why: enable(true) racing enable(false) (two windows, or panel double-click)
// would otherwise interleave — the disable stops the half-started engine and
// the resuming start adds watchers to a dead instance. Chaining every
// transition onto the previous one makes toggles strictly sequential.
let transition: Promise<void> = Promise.resolve();

// Cross-device project discovery (2026-07-12). Single-flight + one coalesced
// rerun (mirrors the engine's syncSpace guard) so overlapping triggers (boot,
// hub-connected, Personal-updated) can't race two createProject calls for one name.
let discovering = false;
let discoverAgain = false;

// main.ts wires this to RemoteServer.broadcast so engine events also reach
// remote browser / Android clients. There is NO central push forwarder in this
// app — each emit site fans out to BOTH BrowserWindows and remote clients (see
// how ipc-handlers.ts sends transcript/status pushes via webContents AND
// remoteServer.broadcast). This keeps service.ts free of a remote-server import
// (remote-server imports THIS module, so importing back would be circular).
let remoteBroadcast: ((e: SpaceSyncEvent) => void) | null = null;
export function setSyncSpacesRemoteBroadcaster(fn: ((e: SpaceSyncEvent) => void) | null): void {
  remoteBroadcast = fn;
}

// Main-process subscribers (conversations service materializes on 'synced').
// Renderer/remote consumers use the existing window/remote fan-outs; this hook
// exists because main-process modules have no webContents to receive on.
const localListeners = new Set<(e: SpaceSyncEvent) => void>();

export function onSyncSpacesEvent(fn: (e: SpaceSyncEvent) => void): () => void {
  localListeners.add(fn);
  return () => localListeners.delete(fn);
}

function broadcast(e: SpaceSyncEvent): void {
  // Stamp at emit time — the renderer derives "Last synced N min ago" from it,
  // so every stored + fanned-out copy must carry the same timestamp.
  const stamped: SpaceSyncEvent = { ...e, at: Date.now() };
  recentEvents = [...recentEvents.slice(-49), stamped];
  // Persist "this space has actually synced" evidence. Safe to key on the bare
  // 'synced' type: the engine now refuses to emit it for a space with no
  // remote (it provisions or errors instead), so every 'synced' that reaches
  // here really completed a pull+push against GitHub. The panel gates its
  // green "All synced" on this marker — recentEvents alone is per-boot and
  // can't distinguish "synced before" from "never synced".
  try {
    if (stamped.type === 'synced' && stamped.at) manager?.recordSyncSuccess(stamped.spaceId, stamped.at);
  } catch { /* a failed marker write must never block event delivery */ }
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('syncspaces:event', stamped); } catch { /* window closing */ }
  }
  // Fan out to remote clients too (see comment on remoteBroadcast above).
  try { remoteBroadcast?.(stamped); } catch { /* remote server not up / closing */ }
  // Fan out to main-process subscribers (each isolated — same rationale as the
  // window/remote blocks). Runs BEFORE the hub send so a bad listener can't
  // strand the cross-device signal, and its own try/catch keeps one throwing
  // listener from aborting the rest.
  for (const fn of localListeners) {
    try { fn(stamped); } catch { /* one bad listener must not strand the rest */ }
  }
  // A local push means this account's OTHER devices should pull now — signal
  // the room LAST, isolated in its own try/catch like the fan-outs above:
  // broadcast() is the single fan-out chokepoint invoked from the engine's
  // onEvent, and a hub send must never block or kill local event delivery.
  // Signalling is best-effort anyway — the 120s poll covers any miss. Guard on
  // type + pushed so hub-status / error / pull-only events never recurse into
  // a send.
  try {
    if (stamped.type === 'synced' && stamped.pushed && hubSocket) {
      const space = roots?.spaces().find(s => s.id === stamped.spaceId);
      if (space) hubSocket.sendSignal('space-updated', repoNameForSpace(space));
    }
  } catch { /* best-effort — the poll fallback covers it */ }

  // A Personal pull that APPLIED changes may have added/renamed/stopped registry
  // records — reconcile. Guarded to Personal + updated so it fires only when the
  // registry could have changed; runDiscovery is single-flight so bursts coalesce.
  try {
    if (stamped.type === 'synced' && stamped.updated && roots) {
      const personal = roots.spaces().find((s) => s.kind === 'personal');
      if (personal && stamped.spaceId === personal.id) void runDiscovery();
    }
  } catch { /* discovery is best-effort — boot/connect retries */ }
}

/** Called once from main.ts after app ready. Roots always exist (the picker
 *  needs them); the engine only starts when the user enabled sync.
 *  getBackupTargets is async because the backend config read (getSyncConfig)
 *  is async — the daily backup timer awaits it fresh each cycle. */
export async function startSyncSpaces(getBackupTargets: () => Promise<BackupTarget[]>, log: (m: string) => void, machineIdArg: string | null = null): Promise<void> {
  logFn = log;
  // Stash the durable machineId so startEngine (here AND on a later enable toggle)
  // can hand it to the hub socket for per-device recency keying.
  machineId = machineIdArg;
  roots = new ManagedRoots();
  roots.ensure();
  manager = new SpaceManager();
  if (manager.isEnabled()) await startEngine(logFn);
  backup = new DailyBackup();
  // runIfDue never throws by contract, but resolving the targets (async config
  // read) can — guard so the hourly timer can never become an unhandled reject.
  const runBackup = async () => {
    try { await backup!.runIfDue(activeSpaces(), await getBackupTargets(), logFn); }
    catch (e: any) { logFn(`sync-spaces: daily backup check failed: ${String(e?.message ?? e)}`); }
  };
  backupTimer = setInterval(() => { void runBackup(); }, 60 * 60 * 1000);
  (backupTimer as any).unref?.();
  void runBackup();
}

// The spaces the engine should actually run — spaces() minus stopped projects
// (spec §7 single enforcement point). Reads the registry on disk each call;
// cheap (a small dir of tiny files).
function activeSpaces() {
  if (!roots) return [];
  return activeManagedSpaces(readProjectRegistry(roots.personalRoot), roots.spaces());
}

// Materialize one registered project this device is missing. ORDERING IS
// LOAD-BEARING (spec §7): ensureRemote FIRST (uses only the id — a gh-auth
// failure creates NOTHING); createProject makes the empty folder; addSpace makes
// it a live, poll-retriable space BEFORE the first pull (a failed pull leaves a
// recoverable empty space, not an orphan); setRemote + syncSpace's first-sync
// pull adopts origin/main (unborn local main → checkout -B main origin/main).
async function materializeProject(entry: { name: string; repoName: string }): Promise<void> {
  if (!engine || !roots || !manager) return;
  const e = engine;
  const url = await manager.ensureRemote({ id: `project:${entry.name}`, kind: 'project', root: '' });
  const created = roots.createProject(entry.name);
  if (!created.ok) return; // taken locally between plan and now — idempotent no-op
  const space = roots.spaces().find((s) => s.id === `project:${entry.name}`);
  if (!space || engine !== e) return; // disabled mid-materialize — next boot/connect adds it
  await e.addSpace(space);
  const transport = makeTransport();
  await transport.setRemote(space, url);
  await e.syncSpace(space);
}

// Reconcile local projects against the synced registry: materialize missing
// active projects, detach stopped ones (keeping the folder). Reads the registry
// ON DISK — callers ensure freshness (startEngine awaits a Personal pull; the
// broadcast/connected triggers fire after a Personal sync) — rather than syncing
// Personal itself (which would recurse through the broadcast trigger). Never
// throws: a per-project failure becomes an error event and retries next
// boot/connect. Single-flight with one coalesced rerun.
async function runDiscovery(): Promise<void> {
  if (!engine || !roots) return;
  if (discovering) { discoverAgain = true; return; }
  discovering = true;
  try {
    do {
      discoverAgain = false;
      if (!engine || !roots) break;
      const registry = readProjectRegistry(roots.personalRoot);
      const localNames = roots.listProjects().map((p) => p.name);
      const liveNames = engine.liveSpaceIds()
        .filter((id) => id.startsWith('project:')).map((id) => id.slice('project:'.length));
      const plan = planReconcile(registry, localNames, liveNames);
      for (const name of plan.toStop) {
        if (!engine) break;
        // 'projects-changed' tells the renderer to refetch its folder/project
        // lists so the detached project's badge updates live (see the event
        // comment in types.ts). Sentinel spaceId 'projects' — NOT the real
        // project id — so it can't mask that space's error/synced dot state.
        // Emitted only on a successful change.
        try { await engine.removeSpace(`project:${name}`); broadcast({ type: 'projects-changed', spaceId: 'projects' }); } // keep the folder
        catch (err: any) { broadcast({ type: 'error', spaceId: `project:${name}`, message: `Could not stop syncing "${name}": ${String(err?.message ?? err)}` }); }
      }
      for (const entry of plan.toMaterialize) {
        if (!engine || !roots) break;
        // Emit AFTER a successful materialize so a project synced from another
        // device shows up in the picker + Project View immediately (dogfood fix,
        // 2026-07-13) instead of only after a manual reopen. Sentinel spaceId
        // 'projects' (see the toStop emit above / types.ts) — a real project id
        // here would land after materializeProject's own error event (syncSpace
        // never throws) and flip the dot to green over a failed first sync.
        try { await materializeProject(entry); broadcast({ type: 'projects-changed', spaceId: 'projects' }); }
        catch (err: any) { broadcast({ type: 'error', spaceId: `project:${entry.name}`, message: `Could not add project "${entry.name}" from another device: ${String(err?.message ?? err)}` }); }
      }
    } while (discoverAgain);
  } finally {
    discovering = false;
  }
}

async function startEngine(log: (m: string) => void): Promise<void> {
  const transport = makeTransport();
  // Provision-on-demand hook for the engine: every sync cycle for a remote-less
  // space retries repo provisioning through here (poll, debounce, "Sync now"),
  // so a failed enable — gh missing, not signed in — self-heals once the user
  // fixes the cause, instead of staying remote-less until an app restart.
  const ensureProvisioned = async (space: SyncSpace) => {
    const url = await manager!.ensureRemote(space);
    await transport.setRemote(space, url);
  };
  // Capture this start's instance locally: if a disable (or another start)
  // supersedes us mid-loop, the module-level `engine` no longer points at `e`
  // and we must stop OUR instance ourselves — otherwise its chokidar watchers
  // leak with nothing left holding a reference to close them.
  const e = new SpaceSyncEngine(transport, { onEvent: broadcast, ensureProvisioned });
  engine = e;
  for (const space of activeSpaces()) { // stopped projects never re-added (spec §7 gate)
    if (engine !== e) { await e.stop(); return; } // superseded — clean up and bail (no socket created yet)
    try {
      await e.addSpace(space);
      // Same closure the engine retries with — provisioning here surfaces a
      // failure IMMEDIATELY at enable time (the error event below) instead of
      // waiting for the first sync cycle to discover it.
      await ensureProvisioned(space);
      void e.syncSpace(space); // initial reconcile
    } catch (err: any) {
      log(`sync-spaces: failed to start space ${space.id}: ${String(err?.message ?? err)}`);
      broadcast({ type: 'error', spaceId: space.id, message: String(err?.message ?? err) });
    }
  }

  // Supersession guard: while we were awaiting addSpace above, a disable (or a
  // newer start) may have replaced our engine — the app-boot start isn't
  // chained through `transition`, so it can race a disable/enable pair. A
  // superseded run owns NO global state: it must not create a socket and must
  // not touch hubStatus — the newer run's live socket may already have set it
  // to 'connected', and stamping 'connecting'/'off' here would make
  // syncSpacesStatus() lie until the next disconnect/reconnect. (Our engine
  // was already stopped by whichever transition superseded us.) Everything
  // below the check is synchronous, so it can't be re-raced.
  if (engine !== e) return;

  // Cross-device discovery: await a fresh Personal pull so the registry is
  // current, register this device's own projects, then reconcile.
  const personalSpace = roots!.spaces().find((s) => s.kind === 'personal');
  if (personalSpace) { try { await e.syncSpace(personalSpace); } catch { /* offline — poll/connect retries */ } }
  if (engine !== e) return; // disabled while we synced Personal — bail
  backfillRegistry();
  void runDiscovery();

  // SyncHub (Plan 1b): instant "something changed" signals between this
  // account's devices. The 120s poll in the engine stays as the fallback —
  // SyncHub being down never blocks sync, it only makes it less instant (spec §6).
  hubStatus = 'connecting';
  const spaceForKey = (key: string) =>
    roots!.spaces().find((s) => repoNameForSpace(s) === key) ?? null;
  hubSocket = createSyncHubSocket({
    getToken: () => authStore?.getToken() ?? null,
    deviceName: os.hostname(),
    // Durable machineId (undefined when this machine has none) — keys the DO's
    // per-device recency map so a relayed signal maps to a "Your devices" row.
    deviceId: machineId ?? undefined,
    onEvent: (ev) => {
      if (ev.type === 'signal') {
        // Recency (Task 3): a signal carrying the durable deviceId + server
        // timestamp records that peer's most recent sync. Independent of kind so
        // any future signal type still advances recency. Math.max guards against
        // out-of-order replay/live interleaving so recency never moves backwards.
        if (ev.deviceId && ev.at) {
          lastSyncByDevice[ev.deviceId] = Math.max(lastSyncByDevice[ev.deviceId] ?? 0, ev.at);
        }
        if (ev.kind === 'space-updated') {
          // Another device pushed — pull that space now. syncSpace is single-flight
          // + coalescing, so signal bursts and hello-replay dupes are free.
          const space = spaceForKey(ev.spaceKey);
          if (space && engine) void engine.syncSpace(space);
        }
      } else if (ev.type === 'sync-map') {
        // Seed/replace from the hub's hello snapshot — the DO's durable map is
        // authoritative (it already includes every recorded peer signal), so a
        // reconnect starts fully populated rather than rebuilding from live only.
        lastSyncByDevice = ev.map;
      } else if (ev.type === 'connected') {
        hubStatus = 'connected';
        console.log('[lease] hub connected');
        broadcast({ type: 'hub-status', spaceId: 'hub', status: 'connected' });
        // Reconcile-on-connect: pull anything missed while we were offline.
        if (engine && roots) for (const s of activeSpaces()) void engine.syncSpace(s);
        void runDiscovery(); // retry any project a prior materialize missed; apply stop tombstones
      } else if (ev.type === 'disconnected') {
        hubStatus = 'disconnected';
        console.log('[lease] hub disconnected');
        broadcast({ type: 'hub-status', spaceId: 'hub', status: 'disconnected' });
      } else if (ev.type === 'lease-event') {
        // DO-pushed lease notification (released/taken/takeover-request). Forward
        // to main.ts's listener (the lease client filters by held session).
        console.log(`[lease] hub event received: ${JSON.stringify({ ...ev, type: undefined })}`);
        leaseEventListener?.(ev);
      }
    },
  });
  hubSocket.setDesired(true);
}

// Tear the SyncHub socket down. setDesired(false) stops its reconnect loop
// BEFORE destroy() closes the current socket, so no retry fires after teardown.
// Matches where `engine` is nulled — the hub belongs to the engine's lifetime.
function teardownHub(): void {
  hubSocket?.setDesired(false);
  hubSocket?.destroy();
  hubSocket = null;
  hubStatus = 'off';
  // Drop the recency map with the socket — a stale map must not outlive the hub
  // (sign-out / disable). The next connect's hello re-seeds it authoritatively.
  lastSyncByDevice = {};
}

export async function stopSyncSpaces(): Promise<void> {
  if (backupTimer) clearInterval(backupTimer);
  teardownHub();
  await engine?.stop();
  engine = null;
}

// Cheap SYNCHRONOUS "is sync on?" check. Reads the same enable flag
// syncSpacesStatus() exposes, without the async project-registry read that
// function does. Used by the CC SessionStart lease-acquire gate so we don't take
// a lease (+ 30s renew timer + Personal/Leases writes) for users who never
// enabled sync — leases only coordinate CROSS-DEVICE writers, which only exist
// once a conversation is actually synced.
export function isSyncSpacesEnabled(): boolean {
  return manager?.isEnabled() ?? false;
}

// ---- IPC-facing functions (also used by remote-server cases) ----
export async function syncSpacesStatus() {
  const registry = roots ? readProjectRegistry(roots.personalRoot) : [];
  const byName = new Map(registry.map((e) => [e.name, e]));
  return {
    enabled: manager?.isEnabled() ?? false,
    spaces: roots?.spaces().map((s) => {
      const name = s.id.startsWith('project:') ? s.id.slice('project:'.length) : '';
      const rec = byName.get(name);
      return {
        ...s,
        remote: manager?.remoteFor(s.id) ?? null,
        // Persisted "has ever completed a real sync" marker (ms epoch or null).
        // The panel's status ladder gates green on this — a device that has
        // never synced must read as hydrating/setting-up, never "All synced".
        lastSyncAt: manager?.lastSyncFor(s.id) ?? null,
        // Read-time overlay (spec §8): synced display name + lifecycle state.
        displayName: rec?.displayName ?? name,
        // Read-time overlay: peers pick up a description written on another
        // device without any local write. UNLIKE displayName above (which
        // falls back to the space's own name), an unset description falls
        // back to null, not to any name-shaped default.
        description: rec?.description ?? null,
        state: rec?.state ?? (s.kind === 'project' ? 'active' : undefined),
      };
    }) ?? [],
    recentEvents,
    syncHub: hubStatus, // SyncHub connection state (Plan 1b): 'off' when sync disabled
  };
}

function repoNameFor(name: string): string {
  return repoNameForSpace({ id: `project:${name}`, kind: 'project', root: '' });
}

async function pushPersonal(): Promise<void> {
  if (!engine || !roots) return;
  const personal = roots.spaces().find((s) => s.kind === 'personal');
  if (personal) await engine.syncSpace(personal); // push the registry change to peers
}

/** Rename = change the SYNCED display name only (no folder move). Propagates via
 *  the Personal space; peers relabel via the read-time overlay in the status
 *  payload (spec §8). */
export async function syncSpacesRenameProject(name: string, displayName: string) {
  if (!roots) return { ok: false as const, error: 'Sync is still starting up — try again in a moment' };
  await setProjectDisplayName(roots.personalRoot, name, repoNameFor(name), displayName);
  await pushPersonal();
  return { ok: true as const };
}

/** Describe = change the SYNCED description only. Propagates via the Personal
 *  space; peers pick it up through the read-time overlay above. */
export async function syncSpacesSetProjectDescription(name: string, description: string) {
  if (!roots) return { ok: false as const, error: 'Sync is still starting up — try again in a moment' };
  await setProjectDescription(roots.personalRoot, name, repoNameFor(name), description);
  await pushPersonal();
  return { ok: true as const };
}

/** Stop syncing = tombstone the registry record, push it, then detach the live
 *  space locally while KEEPING the folder (spec §7). The activeSpaces() gate
 *  keeps it detached on every future boot; the tombstone stops peers from
 *  re-materializing and detaches their live space via runDiscovery's toStop. */
export async function syncSpacesStopProject(name: string) {
  if (!roots) return { ok: false as const, error: 'Sync is still starting up — try again in a moment' };
  await setProjectStopped(roots.personalRoot, name, repoNameFor(name));
  await pushPersonal();
  if (engine) await engine.removeSpace(`project:${name}`);
  return { ok: true as const };
}

export async function syncSpacesEnable(enabled: boolean) {
  manager!.setEnabled(enabled);
  // Chain this toggle onto the previous one (see `transition` comment above).
  // The .catch() keeps a failed earlier transition from poisoning every later
  // toggle — its error was already reported to the caller who triggered it.
  const run = transition.catch(() => { /* previous transition already surfaced its error */ }).then(async () => {
    if (enabled && !engine) await startEngine(logFn);
    if (!enabled && engine) {
      // Null BEFORE stopping so any still-in-flight start (the app-boot one
      // isn't chained through `transition`) sees the supersession immediately
      // and cleans up its own instance instead of watching a dead engine.
      const current = engine;
      engine = null;
      teardownHub(); // stop cross-device signalling too — the engine is going away
      await current.stop();
    }
  });
  transition = run;
  await run;
  return syncSpacesStatus();
}

export async function syncSpacesSyncNow(spaceId?: string) {
  // spaceId narrows to one space (the Project View hero's "Sync now" button);
  // no arg keeps the SyncPanel's existing sync-everything behavior.
  if (!engine || !roots) {
    // WHY: returning success when sync is disabled makes the renderer's retry
    // button look broken; the caller needs a real rejection to show feedback.
    throw new Error('Turn on Backup & Sync before trying again.');
  }
  const targets = roots.spaces().filter((s) => !spaceId || s.id === spaceId);
  if (targets.length === 0) {
    throw new Error('This synced space is no longer available. Refresh and try again.');
  }
  for (const s of targets) void engine.syncSpace(s);
  return { ok: true };
}

// Awaitable counterpart to syncSpacesSyncNow, for the takeover handoff barrier.
// syncSpacesSyncNow is fire-and-forget (void engine.syncSpace) so a UI "Sync now"
// click never blocks on the network — but that means its Promise resolves BEFORE
// any git pull/push runs, which is exactly why the takeover "mirror-before-release"
// barrier didn't exist (2026-07-18 investigation §3.2): the holder's flush and the
// requester's pre-materialize pull both returned before the final turn reached the
// space. This variant resolves only AFTER each targeted space's pull+push settles,
// so the caller can genuinely sequence "push landed" before "peer pulls".
//
// Bounded by timeoutMs: on timeout we resolve anyway (the push keeps running in the
// background) because a handoff must never hard-block on a slow network — the cost
// of a timed-out wait is the pre-fix behavior (the turn may arrive a beat late),
// never a wedged handoff. engine.syncSpace never throws (fully try/caught inside),
// so allSettled is belt-and-suspenders.
export async function syncSpacesSyncNowAwaited(spaceId: string, timeoutMs: number): Promise<void> {
  // Capture engine/roots into locals: both are module-level `let` nulled on teardown,
  // and a sync-disable could null them between the guard and the async resolution.
  const eng = engine;
  const r = roots;
  if (!eng || !r) return;
  const targets = r.spaces().filter((s) => s.id === spaceId);
  if (targets.length === 0) return;
  await Promise.race([
    Promise.allSettled(targets.map((s) => eng.syncSpace(s))),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

// Register a project so peers can discover it. repoName is derived purely from
// the id, so ensureProjectEntry writes the same file on every device (§8).
function registerProject(name: string, root: string): void {
  if (!roots) return;
  ensureProjectEntry(roots.personalRoot, {
    name,
    repoName: repoNameForSpace({ id: `project:${name}`, kind: 'project', root }),
  });
}

// One-time on enable: register every project already on this device so
// pre-existing / sync-was-off projects enter the registry. Idempotent
// (ensureProjectEntry is create-if-absent — no churn, no clobber).
//
// ISOLATE each registration (review #2): registerProject → ensureProjectEntry
// THROWS on a name isSafeName rejects. `listProjects()` returns ANY directory on
// disk, and macOS/Linux permit folder names Windows can't (`notes:2026`, a
// trailing space, …). An un-isolated throw here propagated out of startEngine,
// so discovery never ran and SyncHub never connected for the whole session while
// basic space sync (which started earlier) made it LOOK fine. A bad name just
// can't be a registry filename — skip it and keep going; create/import stay
// strict (their names are validateSyncName-gated, so they never throw here).
function backfillRegistry(): void {
  if (!roots) return;
  for (const p of roots.listProjects()) {
    try { registerProject(p.name, p.path); }
    catch (err: any) { logFn(`sync-spaces: skipped registering "${p.name}" (unsafe name): ${String(err?.message ?? err)}`); }
  }
}

export async function syncSpacesCreateProject(name: string) {
  const result = roots!.createProject(name);
  if (result.ok) registerProject(name, result.path);
  if (result.ok && engine) {
    const space = roots!.spaces().find(s => s.id === `project:${name}`)!;
    try {
      await engine.addSpace(space);
      const transport = makeTransport();
      await transport.init(space);
      await transport.setRemote(space, await manager!.ensureRemote(space));
      // No initial syncSpace here: a freshly created folder is empty — the
      // first file change (debounce) or the 2-minute poll drives the first sync.
    } catch { /* engine events surface the failure */ }
  }
  return result;
}

/** Spec §3 import flows: move an existing folder into ~/YouCoded/Projects/ and
 *  make it a synced space. liveCwds comes from the caller (ipc-handlers /
 *  remote-server own the SessionManager) so this module stays free of a
 *  session-manager import. Unlike createProject, an imported folder HAS
 *  content — kick an immediate syncSpace instead of waiting for the poll. */
export async function syncSpacesImportProject(sourcePath: string, name: string, liveCwds: string[]) {
  if (!roots) return { ok: false as const, error: 'Sync is still starting up — try again in a moment' };
  const result = await importProjectFolder({
    sourcePath, name, liveCwds,
    projectsRoot: roots.projectsRoot,
    youcodedRoot: roots.youcodedRoot,
  });
  if (result.ok) registerProject(name, result.path);
  if (result.ok && engine) {
    const space = roots.spaces().find(s => s.id === `project:${name}`);
    if (space) {
      try {
        await engine.addSpace(space);
        const transport = makeTransport();
        await transport.init(space);
        await transport.setRemote(space, await manager!.ensureRemote(space));
        void engine.syncSpace(space); // imported content should reach the remote now, not at the next poll
      } catch { /* engine error events surface the failure (same contract as createProject) */ }
    }
  }
  return result;
}

export function getManagedRoots(): ManagedRoots | null { return roots; }
