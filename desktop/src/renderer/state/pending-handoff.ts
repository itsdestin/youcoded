import type { HandoffAttemptResult, HandoffCreateParams, SessionInfo } from '../../shared/types';

type Api = Pick<typeof window.claude.session.handoff, 'begin' | 'status' | 'wait' | 'retry' | 'savedCopy' | 'force' | 'cancel'>;
export type PendingTab = {
  tabId: string;
  conversationId: string;
  provider: 'claude' | 'native';
  projectSlug: string;
  name: string;
  cwd: string;
  phase: 'waiting' | 'incomplete' | 'failed';
  holder?: { deviceId: string; device: string };
  cause?: string;
  launchInNewWindow?: boolean;
};

/** WHY a local generation: the backend owns admission but cannot retract a late IPC
 * reply after this renderer closed a tab. A closed tab never binds that reply. */
export class PendingHandoff {
  private current: (PendingTab & { attemptId?: string; generation: number; create: HandoffCreateParams }) | null = null;
  private generation = 0;

  constructor(
    private readonly api: Api,
    private readonly changed: (result: HandoffAttemptResult | null, tab?: PendingTab) => void,
    private readonly admitted: (tabId: string, session: SessionInfo, detach: boolean) => void,
    private readonly orphaned: (session: SessionInfo) => void = () => {},
  ) {}

  get active(): PendingTab | null { return this.current; }
  rename(tabId: string, name: string): void {
    const tab = this.current;
    if (!tab || tab.tabId !== tabId || !name.trim()) return;
    tab.name = name;
    this.changed(null, tab);
  }
  private live(tab: NonNullable<typeof this.current>, generation: number): boolean {
    return this.current === tab && generation === this.generation;
  }

  async begin(conversationId: string, provider: 'claude' | 'native', create: HandoffCreateParams,
    projectSlug = '', savedName?: string, launchInNewWindow = false): Promise<string> {
    // WHY: use the selected saved name only for display. Backend creation keeps
    // its recognizable RESUMING_* placeholder so automatic naming still works.
    const tab: PendingTab & { attemptId?: string; generation: number; create: HandoffCreateParams } = {
      tabId: `pending-handoff:${crypto.randomUUID()}`, conversationId, provider, projectSlug,
      name: savedName || 'Conversation', cwd: create.cwd, phase: 'waiting',
      launchInNewWindow, create, generation: ++this.generation,
    };
    this.current = tab;
    this.changed(null, tab);
    await this.start(tab);
    return tab.tabId;
  }

  private async start(tab: NonNullable<typeof this.current>): Promise<void> {
    const generation = tab.generation;
    try {
      const result = await this.api.begin(tab.conversationId, tab.provider, tab.create);
      if (!this.live(tab, generation)) { void this.api.cancel(result.id).catch(() => {}); return; }
      tab.attemptId = result.id;
      this.accept(tab, result, generation);
    } catch {
      if (this.live(tab, generation)) this.accept(tab, { id: tab.attemptId ?? '', status: 'failed' }, generation);
    }
  }

  private async restart(tab: NonNullable<typeof this.current>): Promise<void> {
    // WHY: backend failed is terminal and released its reservation. Retrying its
    // old id is refused. Mint a new nonce on the same tab/draft; fence late replies.
    tab.generation = ++this.generation;
    tab.attemptId = undefined;
    tab.phase = 'waiting';
    tab.cause = undefined;
    this.changed(null, tab);
    await this.start(tab);
  }

  private accept(tab: NonNullable<typeof this.current>, result: HandoffAttemptResult, generation: number): void {
    if (!this.live(tab, generation)) {
      // WHY: backend cancel refuses an attempt that already admitted, so a
      // writer started just as the user closed the tab would keep running
      // unseen. Close it; a reused pre-existing writer is not ours to close.
      if (result.status === 'admitted' && !('reused' in result.session && result.session.reused)) this.orphaned(result.session);
      return;
    }
    if (result.status === 'admitted') {
      this.current = null;
      // WHY: a reused writer belongs to its original window, not a new one.
      this.admitted(tab.tabId, result.session, !!tab.launchInNewWindow && !('reused' in result.session && result.session.reused));
      this.changed(result);
    } else if (result.status === 'waiting') {
      tab.phase = 'waiting';
      this.changed(result, tab);
      void this.api.wait(result.id).then((next) => this.accept(tab, next, generation)).catch(() => {
        this.accept(tab, { id: result.id, status: 'failed' }, generation);
      });
    } else {
      // WHY: only backend incomplete has the approved uncertainty notice.
      // Terminal failure and lost transport must not offer a no-op old-id retry.
      tab.phase = result.status === 'incomplete' ? 'incomplete' : 'failed';
      tab.cause = undefined;
      if (result.status === 'incomplete') {
        tab.cause = result.cause;
        if (result.holder) tab.holder = result.holder;
      }
      this.changed(result, tab);
    }
  }

  private async act(tabId: string, call: (id: string) => Promise<HandoffAttemptResult>): Promise<void> {
    const tab = this.current;
    if (!tab || tab.tabId !== tabId || !tab.attemptId || tab.phase !== 'incomplete') return;
    const generation = tab.generation;
    tab.phase = 'waiting';
    this.changed({ id: tab.attemptId, status: 'waiting' }, tab);
    try { this.accept(tab, await call(tab.attemptId), generation); }
    catch { this.accept(tab, { id: tab.attemptId, status: 'failed' }, generation); }
  }
  async retry(tabId: string): Promise<void> {
    const tab = this.current;
    if (!tab || tab.tabId !== tabId) return;
    if (tab.phase !== 'failed') return this.act(tabId, (id) => this.api.retry(id));
    if (!tab.attemptId) return this.restart(tab);
    // A failed transport call does not prove backend termination. Re-query its
    // owner before minting a new attempt or replaying an old operation.
    const generation = tab.generation;
    tab.phase = 'waiting';
    this.changed({ id: tab.attemptId, status: 'waiting' }, tab);
    let state: HandoffAttemptResult;
    try { state = await this.api.status(tab.attemptId); }
    catch {
      if (this.live(tab, generation)) this.accept(tab, { id: tab.attemptId, status: 'failed' }, generation);
      return;
    }
    if (!this.live(tab, generation)) return;
    if (state.status === 'failed' || state.status === 'cancelled') return this.restart(tab);
    if (state.status === 'incomplete') {
      this.accept(tab, state, tab.generation);
      return this.act(tabId, (id) => this.api.retry(id));
    }
    this.accept(tab, state, tab.generation);
  }
  savedCopy(tabId: string): Promise<void> { return this.act(tabId, (id) => this.api.savedCopy(id, true)); }
  async continueWithSavedCopy(tabId: string, askForce: (device: string) => Promise<boolean>,
    forceRefused: () => void = () => {}): Promise<void> {
    await this.savedCopy(tabId);
    const tab = this.current;
    if (!tab || tab.tabId !== tabId || tab.phase !== 'incomplete' || tab.cause !== 'lease-denied' || !tab.holder) return;
    // WHY: continuing a saved copy is NOT force consent. The distinct short
    // confirmation names the exact holder the backend will conditionally check.
    const holder = tab.holder;
    if (!await askForce(holder.device || holder.deviceId)) return;
    await this.force(tabId, holder.deviceId);
    // WHY: a refused takeover (holder changed, relay unavailable) lands back on
    // the same notice; without a word the confirmed click looks ignored.
    const after = this.current;
    if (after?.tabId === tabId && after.phase === 'incomplete') forceRefused();
  }
  force(tabId: string, expectedHolderId: string): Promise<void> {
    const tab = this.current;
    if (!tab || tab.tabId !== tabId || tab.holder?.deviceId !== expectedHolderId) return Promise.resolve();
    return this.act(tabId, (id) => this.api.force(id, true, expectedHolderId));
  }
  close(tabId: string): boolean {
    const tab = this.current;
    if (!tab || tab.tabId !== tabId) return false;
    // Invalidate synchronously, including the interval between begin and its reply.
    this.generation++;
    this.current = null;
    this.changed(null);
    if (tab.attemptId) void this.api.cancel(tab.attemptId).catch(() => {});
    return true;
  }
  dispose(): void { if (this.current) this.close(this.current.tabId); }
}
