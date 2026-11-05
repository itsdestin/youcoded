// page-assistant-session.ts — where a chat for a page meets session start-up and the transcript (pages-finish
// step 3; build design youcoded-dev/docs/active/specs/2026-11-05-pages-step3-build.md §B–D). ipc-handlers.ts calls
// these three at its own points; the logic lives here so that file does not grow.
import path from 'node:path';
import { getPagesService } from './pages-service';
import { buildPageAssistantNote } from './page-assistant-note';
import { log } from '../logger';
import type { CreateSessionOpts } from '../session-manager';
import type { SessionInfo } from '../../shared/types';
import type { TranscriptEvent } from '../../shared/transcript-event-types';

export interface PageChatStart { id: string; note: string }

/** Before the session is made. WHY the note is built HERE and a caller's `appendSystemPrompt` is always dropped:
 *  instructions to the model come from the page on disk, never from a window's or a phone's request. A NEW page
 *  chat starts in the page's project folder (the folder holding Pages/<page>/, so it sits under a real project in
 *  Resume); a resumed one keeps its conversation's own folder. */
export async function preparePageChat(raw: CreateSessionOpts): Promise<{ opts: CreateSessionOpts; page: PageChatStart | null }> {
  const { appendSystemPrompt: _callerPrompt, pageId, ...opts } = raw;
  if (typeof pageId !== 'string' || !pageId || opts.provider === 'shell') return { opts, page: null };
  const svc = getPagesService();
  const dir = svc ? await svc.store.pageDir(pageId) : null;
  const summary = dir ? (await svc!.store.list()).find((p) => p.id === pageId) : undefined;
  if (!dir || !summary) throw new Error('This page is no longer in your library.');
  const cwd = opts.resumeSessionId ? opts.cwd : path.dirname(path.dirname(dir));
  const note = await buildPageAssistantNote(summary, dir, cwd);
  return { opts: { ...opts, cwd, ...(opts.provider !== 'native' ? { appendSystemPrompt: note } : {}) }, page: { id: summary.id, note } };
}

/** Right after the session is made, synchronously, before the nextTick that forwards session-created: every
 *  window sees `pageId` on the first announcement, so none switches to the chat. */
export function pageChatStarted(info: SessionInfo, page: PageChatStart, resumeSessionId: string | undefined, setNativeNote: (id: string, note: string) => void): void {
  info.pageId = page.id;
  if (info.provider === 'native') setNativeNote(info.id, page.note);
  void getPagesService()?.assistantChats.started(page.id, info.id, info.provider === 'native' ? 'native' : 'claude', info.cwd, resumeSessionId ?? (info.provider === 'native' ? info.id : undefined))
    .catch((e) => log('WARN', 'Pages', 'could not remember the page chat', { error: String(e) }));
}

/** A request in a page's chat first saves the page as it is (the Versions list's "Before …"), and makes that chat
 *  the page's last one. WHY at the transcript's user line, for both runtimes: it is the one place every send path
 *  meets (window, phone, queue), and it comes before the model has run any tool. WHY the age check: a resumed
 *  conversation's earlier lines must not be taken for new requests. */
export function notePageRequest(event: TranscriptEvent): void {
  if (event.type !== 'user-message') return;
  const svc = getPagesService();
  const data = event.data as { text?: unknown } | undefined;
  const text = typeof data?.text === 'string' ? data.text : '';
  if (!svc || !text.trim() || (Number.isFinite(event.timestamp) && Date.now() - event.timestamp > 120_000)) return;
  void svc.assistantChats.used(event.sessionId)
    .then((pageId) => (pageId ? svc.versions.checkpoint(pageId, text) : false))
    .catch((e) => log('WARN', 'Pages', 'could not save a page version', { error: String(e) }));
}
