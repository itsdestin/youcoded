// What a page may do with the person's chats (spec 2026-10-16, "Pages read and change chats").
//
// A page with an APPROVED `chats` line can ask the host for its chat list, open one of those chats after a
// real click, and (only with access `full`) set tags, a note and the Priority / Complete marks. The page
// never sees what was said in a chat: only the facts the Resume list already shows.
//
// WHY this lives apart from PageHost.tsx: PageHost is the one place a frame's messages are heard, but the
// rules (scope filter, what a chat looks like, which calls change things) are plain functions that a test
// can run without a frame. PageHost passes in the loaded page and a "was that a real click" check; nothing
// in here is trusted from the page beyond the request's own fields, each of which is checked again.
//
// Built on the calls the Resume list already uses (`session.browse`, `setTag`, `setNote`, `setFlag`,
// `tags.list`), so a paired phone gets the same answers through the same path and no second store exists.
import type { PageChat, PageChatScope, PageChatsAnswer, PageConnectionStatus, PageDocument } from '../../../shared/pages-types';
import { PAGE_CHATS_REFUSED } from '../../../shared/pages-types';
import type { PastSession } from '../../../shared/types';
import type { TagRecord } from '../../../shared/tags';

type ChatsLine = Extract<PageConnectionStatus, { kind: 'chats' }>;

/** The page's approved `chats` line, or null. Read from the LOADED document each time (design review 1,
 *  finding 17), never from a copy the page's own script could have posted. */
function approvedChatsLine(page: PageDocument | null): ChatsLine | null {
  const c = page?.connections?.find((x): x is ChatsLine => x.kind === 'chats' && x.approved);
  return c ?? null;
}

/** Same page, same approved line (access and scope), judged between two readings of the loaded document.
 *  WHY: the work is asynchronous. A page swapped, closed, or whose line was removed or widened/narrowed
 *  while the list was read must not be answered from the old yes. */
function sameGrant(a: ChatsLine, page: PageDocument | null): boolean {
  const b = approvedChatsLine(page);
  return !!b && b.access === a.access && JSON.stringify(b.scope) === JSON.stringify(a.scope);
}

/** The project's name as the Resume list shows it: the last part of its folder path. */
function projectName(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || p;
}

function inScope(scope: PageChatScope, row: PastSession, tagIds: ReadonlySet<string>): boolean {
  if ('all' in scope) return true;
  if ('projects' in scope) {
    const path = row.projectPath;
    if (!path) return false;
    // The name as the app shows it, or the exact folder path.
    return scope.projects.includes(projectName(path)) || scope.projects.includes(path);
  }
  // A tag the page named by its id or its name; the tag's own id is what a chat carries.
  return (row.tags ?? []).some((id) => tagIds.has(id));
}

/** The ids of the registry tags a scope's `tag` text means: matched by id, or by name ignoring case. */
function scopeTagIds(scope: PageChatScope, tags: readonly TagRecord[]): Set<string> {
  if (!('tag' in scope)) return new Set();
  const want = scope.tag.trim().toLowerCase();
  return new Set(tags.filter((t) => t.id === scope.tag || t.label.trim().toLowerCase() === want).map((t) => t.id));
}

function toChat(row: PastSession, tagsById: ReadonlyMap<string, TagRecord>): PageChat {
  const iso = (ms: number | undefined) => (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
  return {
    id: row.sessionId,
    name: row.name,
    lastActive: iso(row.lastModified) ?? new Date(0).toISOString(),
    created: iso(row.created),
    tags: (row.tags ?? []).flatMap((id) => { const t = tagsById.get(id); return t ? [{ id: t.id, name: t.label, color: t.color }] : []; }),
    note: row.note ?? '',
    project: row.projectPath ? { name: projectName(row.projectPath), path: row.projectPath } : null,
    // The Resume card's own wording: the model id without its trailing release date.
    model: row.lastUsedModel?.modelId ? row.lastUsedModel.modelId.replace(/-\d{8}$/, '') : null,
    pinned: row.flags?.priority === true,
    complete: row.flags?.complete === true,
    branch: row.branch ?? null,
    open: row.open === true,
  };
}

// ── One read shared by a burst of calls ─────────────────────────────────────
// A page that redraws on every keystroke could ask for the list that often, and each read scans every
// conversation. Calls within CACHE_MS share one read; a change made through this module drops it at once.
const CACHE_MS = 3000;
let cache: { at: number; read: Promise<{ rows: PastSession[]; tags: TagRecord[] | null } | null> } | null = null;

function claude(): any { return (window as unknown as { claude?: any }).claude; }

async function readAll(): Promise<{ rows: PastSession[]; tags: TagRecord[] | null } | null> {
  const api = claude();
  if (typeof api?.session?.browse !== 'function') return null;
  try {
    const [rows, tags] = await Promise.all([
      api.session.browse({ includeOpen: true }),
      // An unreadable registry is not an empty one (error inventory 2026-09-10): the tag calls then refuse.
      Promise.resolve(api.tags?.list?.() ?? []).catch(() => null),
    ]);
    if (!Array.isArray(rows)) return null;
    // `tags: null` = the tag list could not be read. Calls that need it (a tag scope, setTag) then refuse.
    return { rows: rows as PastSession[], tags: Array.isArray(tags) ? (tags as TagRecord[]) : null };
  } catch { return null; }
}

function loadAll() {
  const now = Date.now();
  if (!cache || now - cache.at > CACHE_MS) {
    const mine = { at: now, read: readAll() };
    cache = mine;
    // A failed read is not kept: the next call tries again.
    void mine.read.then((r) => { if (r === null && cache === mine) cache = null; });
  }
  return cache.read;
}

/** Forget the shared read (a change was just made; a test starts clean). */
export function resetPageChatsCache(): void { cache = null; }

// ── The requests ─────────────────────────────────────────────────────────────
type Parsed =
  | { op: 'list' }
  | { op: 'resume'; chat: string }
  | { op: 'setTag'; chat: string; tag: string; on: boolean }
  | { op: 'setNote'; chat: string; text: string }
  | { op: 'setMark'; chat: string; mark: 'pinned' | 'complete'; on: boolean };

const MAX_NOTE = 8000; // the same limit the app's own note box enforces (session:set-note)

function parse(raw: unknown): Parsed | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  const chat = typeof r.chat === 'string' && r.chat && r.chat.length <= 200 ? r.chat : null;
  switch (r.op) {
    case 'list': return { op: 'list' };
    case 'resume': return chat ? { op: 'resume', chat } : null;
    case 'setTag': return chat && typeof r.tag === 'string' && r.tag.trim() && r.tag.length <= 200 && typeof r.on === 'boolean' ? { op: 'setTag', chat, tag: r.tag, on: r.on } : null;
    case 'setNote': return chat && typeof r.text === 'string' ? { op: 'setNote', chat, text: r.text } : null;
    case 'setMark': return chat && (r.mark === 'pinned' || r.mark === 'complete') && typeof r.on === 'boolean' ? { op: 'setMark', chat, mark: r.mark, on: r.on } : null;
    default: return null;
  }
}

export interface PageChatsContext {
  /** The loaded page document RIGHT NOW (a ref's current value), read again after every wait. */
  page: () => PageDocument | null;
  /** True only if the person just clicked in THIS page (window activation AND the frame holds focus). */
  clicked: () => boolean;
}

/** Answer one `youcoded:chats` request from a page. Always resolves; a refusal is `{ ok: false, reason }`. */
export async function answerPageChats(raw: unknown, ctx: PageChatsContext): Promise<PageChatsAnswer<{ chats?: PageChat[] }>> {
  const line = approvedChatsLine(ctx.page());
  if (!line) return { ok: false, reason: PAGE_CHATS_REFUSED.notAllowed };
  const req = parse(raw);
  if (!req) return { ok: false, reason: PAGE_CHATS_REFUSED.badRequest };
  // WHY the click is judged first, before any wait: activation lasts only seconds, and a page cannot open a
  // chat on a timer (the same rule as startSession).
  if (req.op === 'resume' && !ctx.clicked()) return { ok: false, reason: PAGE_CHATS_REFUSED.noClick };
  const changes = req.op === 'setTag' || req.op === 'setNote' || req.op === 'setMark';
  if (changes && line.access !== 'full') return { ok: false, reason: PAGE_CHATS_REFUSED.notAllowedToChange };
  if (req.op === 'setNote' && req.text.length > MAX_NOTE) return { ok: false, reason: PAGE_CHATS_REFUSED.noteTooLong };

  const all = await loadAll();
  if (!all) return { ok: false, reason: PAGE_CHATS_REFUSED.unavailable };
  // The page may have been closed, swapped or re-decided while the list was read.
  if (!sameGrant(line, ctx.page())) return { ok: false, reason: PAGE_CHATS_REFUSED.closed };

  // A tag scope (or a tag change) cannot be judged without the tag list; an unreadable one is not an empty one.
  if (all.tags === null && (req.op === 'setTag' || 'tag' in line.scope)) return { ok: false, reason: PAGE_CHATS_REFUSED.unavailable };
  const tagList = all.tags ?? [];
  const tagsById = new Map(tagList.map((t) => [t.id, t]));
  const scopeIds = scopeTagIds(line.scope, tagList);
  const visible = all.rows.filter((r) => inScope(line.scope, r, scopeIds));
  if (req.op === 'list') return { ok: true, chats: visible.map((r) => toChat(r, tagsById)) };

  // Everything below names one chat: it must be one of the chats this page may see.
  const row = visible.find((r) => r.sessionId === req.chat);
  if (!row) return { ok: false, reason: PAGE_CHATS_REFUSED.outOfScope };

  if (req.op === 'resume') {
    // The Resume list disables these rows too: no folder here, or the record has not arrived yet.
    if (row.missingProject || row.notSyncedYet || !row.projectSlug || !row.projectPath) return { ok: false, reason: PAGE_CHATS_REFUSED.cannotResume };
    // The same event the chat-search Resume row sends: App.tsx resumes it, or switches to it if it is open.
    window.dispatchEvent(new CustomEvent('youcoded:resume-session', { detail: {
      claudeSessionId: row.sessionId, projectSlug: row.projectSlug, projectPath: row.projectPath, provider: row.provider,
    } }));
    return { ok: true };
  }

  const session = claude()?.session;
  let res: { ok?: boolean; error?: string } | undefined;
  try {
    if (req.op === 'setTag') {
      const want = req.tag.trim().toLowerCase();
      const tag = tagList.find((t) => t.id === req.tag || t.label.trim().toLowerCase() === want);
      if (!tag) return { ok: false, reason: PAGE_CHATS_REFUSED.unknownTag };
      res = await session.setTag(row.sessionId, tag.id, req.on);
    } else if (req.op === 'setNote') {
      res = await session.setNote(row.sessionId, req.text);
    } else {
      // "Pinned" in a page's words is the app's Priority mark ("pins to top"); "complete" is its own.
      res = await session.setFlag(row.sessionId, req.mark === 'pinned' ? 'priority' : 'complete', req.on);
    }
  } catch (e) {
    return { ok: false, reason: e instanceof Error && e.message ? e.message : 'The change could not be saved.' };
  } finally {
    // Whatever happened, the next list must be read fresh.
    resetPageChatsCache();
  }
  return res?.ok === false ? { ok: false, reason: typeof res.error === 'string' && res.error ? res.error : 'The change could not be saved.' } : { ok: true };
}
