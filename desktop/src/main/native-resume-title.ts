// Resume-time title re-apply for native sessions.
//
// WHY this module exists: the renderer names a resumed session 'Resuming…' as a
// placeholder, and the only thing that renames a native session pill is an
// automatic naming pass (session-namer.ts), which fires when a name is
// GENERATED. A session that already has a name is not renamed at every reply
// (that is the point), so nothing re-pushed the stored name and the pill stayed
// on the placeholder for the life of the session. This puts the stored title
// back on the live session right after the resume completes.
//
// It also carries a name the user typed: the manual name is projected onto
// ConversationRecord.title (conversations/service.ts), so the stored title read
// here is already the effective one.
//
// Deps are injected (same pattern as session-namer.ts) because the real
// collaborators are a Conversation Store read and two IPC sends — and because a
// fake that cannot fail certifies the bug it should catch (youcoded #177).
import { isRealSessionName } from '../shared/session-title';

export interface ResumeTitleDeps {
  /** Reads the stored title for this native conversation. Native ids are
   *  identity-mapped, so the session id IS the store's record id. */
  getStoredTitle: (sessionId: string) => Promise<string | undefined>;
  /** Pushes the name onto the live session — the same SESSION_RENAMED send +
   *  broadcastRename pair the title feeder's onTitle uses. */
  onTitle: (sessionId: string, title: string, opts?: { provisional: boolean }) => void;
  /** The Resume Browser row's own name for this session — its opening words
   *  when nothing better exists. Optional so a caller without a session store
   *  keeps the old stored-title-only behaviour. */
  getOpeningTitle?: (sessionId: string) => Promise<string | undefined>;
}

/**
 * Re-broadcast a resumed native session's stored title so its header pill
 * stops showing the 'Resuming…' placeholder.
 *
 * Returns the title that was applied, or null when nothing was applied — which
 * covers both "there was no real title to apply" and "a collaborator threw".
 * The two are deliberately not distinguished: no caller reads the value (it is
 * `void`-called), and the return exists for the tests.
 *
 * NEVER throws and NEVER rejects: a resume must not fail because a title could
 * not be read. A no-op here is harmless — the session is untitled, and the
 * title feeder will generate one at the next turn-complete.
 */
export async function reapplyStoredTitle(
  deps: ResumeTitleDeps,
  sessionId: string,
): Promise<string | null> {
  try {
    const stored = await deps.getStoredTitle(sessionId);
    // Guardrail: only ever plant a REAL name. Broadcasting a placeholder here
    // would overwrite a good live name with 'Untitled' / 'New Session'.
    if (isRealSessionName(stored)) {
      const title = stored!.trim();
      deps.onTitle(sessionId, title);
      return title;
    }
    // No stored title (a conversation older than the title feeder, or every
    // naming attempt failed offline). Destin, 2026-09-02: the pill shows the
    // first message's opening words — the same name the Resume Browser row the
    // user just clicked shows. PROVISIONAL: the caller must not let it count as
    // a title, or the namer would never give this conversation a real one.
    const opening = await deps.getOpeningTitle?.(sessionId);
    if (!isRealSessionName(opening)) return null;
    const title = opening!.trim();
    deps.onTitle(sessionId, title, { provisional: true });
    return title;
  } catch {
    return null;
  }
}

/** The live session name a "does this conversation already have a title?"
 *  check may use: the live name, unless it is still the provisional opening
 *  words this module planted. WHY: those words are only there so the pill
 *  matches the Resume Browser row; counting them as a title would stop the
 *  namer from ever giving the conversation a real one. */
export function nameForTitleCheck(liveName: string | undefined, provisional: string | undefined): string | undefined {
  return liveName !== undefined && liveName === provisional ? undefined : liveName;
}
