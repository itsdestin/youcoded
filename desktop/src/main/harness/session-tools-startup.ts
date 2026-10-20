import { randomUUID } from 'node:crypto';
import type { NativeStartupAction, NativeStartupBody, NativeStartupState } from '../../shared/native-startup';
import type { McpLease } from './mcp/mcp-manager';

const HOST_ID = randomUUID();
let nextGeneration = 0;

type Hooks = {
  isCurrent(): boolean;
  install(lease: McpLease | undefined, isCurrent: () => boolean): Promise<void>;
  ready(): void;
};

/** Owns one session generation's optional connections, not its transcript or sends. */
export class SessionToolsStartup {
  private hooks: Hooks | undefined;
  private attached = false;
  private closed = false;
  private attempt = 0;
  private outcome = false;
  private acquired: McpLease | undefined;
  private acquireFailed = false;
  private released = new WeakSet<McpLease>();
  private readonly generation = ++nextGeneration;
  private revision = 0;
  private current: NativeStartupState = { phase: 'opening', hostId: HOST_ID, generation: this.generation, revision: 0 };
  private task: Promise<void> = Promise.resolve();

  constructor(private readonly deps: {
    acquire(retry: boolean): Promise<McpLease | undefined>;
    changed(state: NativeStartupState): void;
    reportError?(error: unknown): void;
  }) {}

  get state(): NativeStartupState { return this.current; }
  get isReady(): boolean { return !this.closed && this.hooks?.isCurrent() === true && this.current.phase === 'ready'; }
  get hasOutcome(): boolean { return this.outcome; }
  get isAttached(): boolean { return this.attached; }
  get lease(): McpLease | undefined { return this.acquired; }
  get pending(): Promise<void> { return this.task; }

  connect(): void { this.begin(false); }

  activate(hooks: Hooks): void {
    if (this.closed) return;
    this.hooks = hooks;
    this.attached = true;
    if (this.outcome) this.task = this.apply(this.attempt);
    else this.set({ phase: 'connecting', attemptId: randomUUID() });
  }

  act(attemptId: string, action: NativeStartupAction): boolean {
    const state = this.current;
    if (!this.live() || state.phase !== 'failed' || state.attemptId !== attemptId) return false;
    if (action === 'continue') {
      if (!state.canContinue) return false;
      this.set({ phase: 'connecting', attemptId: randomUUID() });
      this.task = this.install(this.attempt, true);
    } else if (action === 'retry') {
      this.begin(true);
    } else return false;
    return true;
  }

  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    ++this.attempt;
    this.hooks = undefined;
  }

  async dispose(): Promise<void> {
    this.cancel();
    // WHY not await this.task: tab closure must not wait for an optional handshake.
    // Its completion checks the attempt and releases only the lease it received.
    await this.release(this.acquired);
  }

  private live(): boolean { return !this.closed && this.hooks?.isCurrent() === true; }
  private set(state: NativeStartupBody): void {
    this.current = { ...state, hostId: HOST_ID, generation: this.generation, revision: ++this.revision };
    if (this.live()) this.deps.changed(this.current);
  }

  private begin(retry: boolean): void {
    if (this.closed) return;
    const attempt = ++this.attempt;
    const previous = this.acquired;
    // WHY: keep healthy holders registered until the replacement has its own
    // lease, and keep the retained lease reachable by dispose while it waits.
    this.acquireFailed = false;
    this.outcome = false;
    if (this.hooks) this.set({ phase: 'connecting', attemptId: randomUUID() });
    this.task = (async () => {
      if (this.closed || attempt !== this.attempt || (this.hooks && !this.live())) return;
      let lease: McpLease | undefined;
      try { lease = await this.deps.acquire(retry); }
      catch (error) {
        if (this.closed || attempt !== this.attempt) return;
        this.deps.reportError?.(error);
        this.acquireFailed = true;
      }
      if (this.closed || attempt !== this.attempt || (this.hooks && !this.live())) {
        await this.release(lease);
        return;
      }
      this.acquired = lease;
      if (previous !== lease) await this.release(previous);
      // WHY: releasing a retired connection may yield to close/cancel too.
      if (this.closed || attempt !== this.attempt || (this.hooks && !this.live())) return;
      this.outcome = true;
      if (this.hooks) await this.apply(attempt);
    })();
  }

  private async apply(attempt: number): Promise<void> {
    if (!this.live() || attempt !== this.attempt) return;
    const issues = this.acquired?.unavailableServers ?? [];
    if (this.acquireFailed || issues.length > 0) {
      this.set({ phase: 'failed', attemptId: randomUUID(), cause: 'tools', issues: [...issues], canContinue: true });
      return;
    }
    await this.install(attempt, false);
  }

  private async install(attempt: number, skipping: boolean): Promise<void> {
    if (!this.live() || attempt !== this.attempt) return;
    const hooks = this.hooks!;
    try {
      const current = () => this.live() && this.hooks === hooks && attempt === this.attempt;
      await hooks.install(this.acquired, current);
      // WHY exact hook/attempt identity: a late completion cannot ready a reopened tab.
      if (!this.live() || this.hooks !== hooks || attempt !== this.attempt) return;
      const skipped = skipping ? this.acquired?.unavailableServers?.map(issue => issue.label) ?? [] : [];
      this.set({ phase: 'ready', ...(skipped.length ? { skippedTools: skipped } : {}) });
      hooks.ready();
    } catch (error) {
      if (!this.live() || attempt !== this.attempt) return;
      this.deps.reportError?.(error);
      // A history/install failure is not permission to bypass history reconstruction.
      this.set({ phase: 'failed', attemptId: randomUUID(), cause: 'preparation', issues: [], canContinue: false });
    }
  }

  private async release(lease: McpLease | undefined): Promise<void> {
    if (!lease || this.released.has(lease)) return;
    this.released.add(lease);
    try { await lease.release(); } catch (error) { this.deps.reportError?.(error); }
  }
}
