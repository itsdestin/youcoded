export interface SessionStartTicket<T> { readonly sessionId: string; readonly value: T }

/** Cancels pre-live startup without confusing it with a live writer's teardown. */
export class SessionStartRegistry<T> {
  private pending = new Map<string, SessionStartTicket<T>>();
  private closed = false;
  constructor(private readonly dispose: (value: T) => void) {}

  begin(sessionId: string, value: T): SessionStartTicket<T> {
    if (this.closed) throw new Error('The session runtime is shutting down.');
    this.cancel(sessionId);
    const ticket = { sessionId, value };
    this.pending.set(sessionId, ticket);
    return ticket;
  }
  has(sessionId: string): boolean { return this.pending.has(sessionId); }
  get(sessionId: string): T | undefined { return this.pending.get(sessionId)?.value; }
  isCurrent(ticket: SessionStartTicket<T>): boolean { return !this.closed && this.pending.get(ticket.sessionId) === ticket; }
  assertCurrent(ticket: SessionStartTicket<T>): void {
    if (!this.isCurrent(ticket)) throw new Error('This conversation was closed before startup finished.');
  }
  finish(ticket: SessionStartTicket<T>): void {
    // WHY identity, not ID: an old completion must not remove a replacement's ticket.
    if (this.pending.get(ticket.sessionId) === ticket) this.pending.delete(ticket.sessionId);
  }
  cancel(sessionId: string): void {
    const ticket = this.pending.get(sessionId);
    this.pending.delete(sessionId);
    if (ticket) this.dispose(ticket.value);
  }
  reopen(): void { this.closed = false; }
  close(): void {
    this.closed = true;
    for (const id of [...this.pending.keys()]) this.cancel(id);
  }
}
