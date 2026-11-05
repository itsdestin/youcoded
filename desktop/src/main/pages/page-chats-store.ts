// page-chats-store.ts — which chats belong to which page, for the page's assistant (pages-finish step 3; build
// design youcoded-dev/docs/active/specs/2026-11-05-pages-step3-build.md, section A).
//
// A page chat is an ordinary chat (it shows in the session strip and in Resume under its project); this file
// only remembers that it was started for a page, so the page can reopen its last chat and list its earlier
// ones. WHY main and not the renderer: a phone opens the same page's chat and must find the same chats.
//
// Two ids per chat: `sessionId`, the running program's id (gone when it ends), and `conversationId`, the saved
// conversation Resume reopens. A Claude Code chat learns its conversation id from its first hook event, so a
// chat is recorded by its session id first and given its conversation id when main learns it.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../atomic-write';
import type { PageAssistantChat } from '../../shared/pages-types';

type Stored = Omit<PageAssistantChat, 'live'>;

/** At most this many remembered per page (the Earlier chats list); the least recently used go first. */
const MAX_PER_PAGE = 30;

export class PageChatsStore {
  private chats: Stored[] | null = null;
  private loading: Promise<Stored[]> | null = null;
  private saving: Promise<void> = Promise.resolve();
  /** Running sessions, so a list can say which chats are live without asking the session manager. */
  private live = new Set<string>();
  /** WHY strictly increasing: "the chat used last" is an order, and two uses inside one millisecond must not tie. */
  private lastStamp = 0;
  private stamp(): number { this.lastStamp = Math.max(Date.now(), this.lastStamp + 1); return this.lastStamp; }

  constructor(private readonly file: () => string) {}

  private async load(): Promise<Stored[]> {
    if (this.chats) return this.chats;
    this.loading ??= (async () => {
      try {
        const j = JSON.parse(await fs.readFile(this.file(), 'utf8')) as { chats?: unknown };
        const list = Array.isArray(j.chats) ? j.chats.filter((c): c is Stored => !!c && typeof (c as Stored).pageId === 'string') : [];
        // WHY drop session ids on load: they name programs from an earlier run of the app, which are gone.
        this.chats = list.map(({ sessionId: _gone, ...c }) => c);
      } catch { this.chats = []; }
      return this.chats;
    })();
    return this.loading;
  }

  private save(): void {
    const body = JSON.stringify({ v: 1, chats: this.chats ?? [] });
    // One write at a time, in order; a failed write is retried by the next change.
    this.saving = this.saving.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file()), { recursive: true });
      await atomicWrite(this.file(), body);
    });
  }

  /** Resolves once every change so far is on disk (tests, and a clean quit). */
  whenSaved(): Promise<void> { return this.saving.catch(() => {}); }

  /** A session was just started for a page (new, or resuming `conversationId`). */
  async started(pageId: string, sessionId: string, provider: 'claude' | 'native', cwd: string, conversationId?: string): Promise<void> {
    const chats = await this.load();
    const now = this.stamp();
    const at = conversationId ? chats.findIndex((c) => c.conversationId === conversationId) : -1;
    if (at >= 0) chats[at] = { ...chats[at], sessionId, usedAt: now };
    else chats.unshift({ pageId, sessionId, provider, cwd, startedAt: now, usedAt: now, ...(conversationId ? { conversationId } : {}) });
    this.live.add(sessionId);
    this.prune(pageId);
    this.save();
  }

  /** Main learned the saved conversation's id for a running session (a no-op for a chat not started for a page). */
  async conversationKnown(sessionId: string, conversationId: string): Promise<void> {
    const chats = await this.load();
    const c = chats.find((x) => x.sessionId === sessionId);
    if (!c || c.conversationId === conversationId) return;
    // A resumed conversation can already have a row of its own: keep one.
    const dupe = chats.findIndex((x) => x !== c && x.conversationId === conversationId);
    if (dupe >= 0) chats.splice(dupe, 1);
    c.conversationId = conversationId;
    this.save();
  }

  /** A message was sent in a running session; the page's last chat is the one used last. */
  async used(sessionId: string): Promise<string | null> {
    const chats = await this.load();
    const c = chats.find((x) => x.sessionId === sessionId);
    if (!c) return null;
    c.usedAt = this.stamp();
    this.save();
    return c.pageId;
  }

  /** The page a running session belongs to, or null. */
  async pageOf(sessionId: string): Promise<string | null> {
    if (!this.live.has(sessionId)) return null;
    return (await this.load()).find((x) => x.sessionId === sessionId)?.pageId ?? null;
  }

  /** A session ended. A chat that never got a conversation id (closed before its first message) is forgotten:
   *  there is nothing to reopen. */
  async ended(sessionId: string): Promise<void> {
    if (!this.live.delete(sessionId)) return;
    const chats = await this.load();
    const at = chats.findIndex((x) => x.sessionId === sessionId);
    if (at < 0) return;
    if (!chats[at].conversationId) chats.splice(at, 1);
    else delete chats[at].sessionId;
    this.save();
  }

  /** A page's chats, the one used last first. */
  async list(pageId: string): Promise<PageAssistantChat[]> {
    const chats = await this.load();
    return chats.filter((c) => c.pageId === pageId)
      .sort((a, b) => b.usedAt - a.usedAt)
      .map((c) => ({ ...c, live: !!c.sessionId && this.live.has(c.sessionId) }));
  }

  private prune(pageId: string): void {
    const mine = (this.chats ?? []).filter((c) => c.pageId === pageId).sort((a, b) => b.usedAt - a.usedAt);
    const drop = new Set(mine.slice(MAX_PER_PAGE).filter((c) => !c.sessionId));
    if (drop.size) this.chats = (this.chats ?? []).filter((c) => !drop.has(c));
  }
}
