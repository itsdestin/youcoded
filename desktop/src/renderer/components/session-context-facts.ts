// The two facts the strip and the panel must agree on, in one place.
//
// They disagreed once already: the strip and the panel each decided "was
// anything left out" from their own expression, so a change to one silently made
// an amber strip open a panel saying everything fit. This is the shared answer.
import { useEffect, useRef, useState } from 'react';
import type { SessionContext, SessionContextText } from '../state/chat-types';

/** Was something actually left out when this chat started?
 *
 *  Three real things, and only real ones:
 *   - the project's instruction file was outlined to fit;
 *   - add-ons were dropped because their tools did not fit;
 *   - the model was never told its skills exist (below the catalog threshold the
 *     Skill tool is not attached at all — the user can still start one by typing
 *     /name, but the assistant cannot reach for one itself).
 *
 *  A skill being TOO LONG is deliberately not here. Skills are read when they are
 *  used, not when the chat starts, so on a fresh session that cut has not
 *  happened; it is reported on the skill's own row, in the future tense, where it
 *  is true. Turning the strip amber for it would be claiming a loss that may
 *  never occur. */
export function wasTrimmed(ctx: SessionContext): boolean {
  return !!(
    ctx.projectInstructions?.truncated
    || ctx.skillsOffered === false
    || (ctx.droppedMcpServers && ctx.droppedMcpServers.length > 0)
  );
}

type Fetched = { state: 'loading' } | { state: 'error' } | { state: 'ready'; value: SessionContextText };

/** One file's text, fetched the first time its row is opened.
 *
 *  WHY not shipped with the rest of the context: the installed skills on this
 *  machine are 619 KB of text (measured 2026-09-10). Pushing that into every
 *  session, holding it in memory, and re-sending it to a phone over a WebSocket
 *  to show text nobody has asked to read is not a trade worth making. A local
 *  disk read is about a millisecond, so the row still opens to its text.
 *
 *  `enabled` is false while the row is closed, so nothing is read until someone
 *  actually looks. */
export function useSessionContextText(
  sessionId: string | undefined,
  kind: 'project' | 'user' | 'skill',
  id: string | undefined,
  enabled: boolean,
): Fetched | null {
  const [fetched, setFetched] = useState<Fetched | null>(null);
  // Ignore a reply that arrives after the panel closed or the row changed —
  // setState on an unmounted tree is a warning, and a stale reply landing in a
  // different row's slot would show one file's text under another's name.
  const wantRef = useRef(0);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    const want = ++wantRef.current;
    setFetched({ state: 'loading' });
    let live = true;
    void (async () => {
      try {
        const res = await window.claude?.native?.sessionContextText?.(sessionId, kind, id);
        if (!live || want !== wantRef.current) return;
        setFetched(res && 'text' in res ? { state: 'ready', value: res } : { state: 'error' });
      } catch {
        if (live && want === wantRef.current) setFetched({ state: 'error' });
      }
    })();
    return () => { live = false; };
  }, [enabled, sessionId, kind, id]);

  return fetched;
}
