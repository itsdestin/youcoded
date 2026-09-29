import { useEffect, useMemo, useRef } from 'react';
import type { SessionChatState } from '../state/chat-types';
import type { ChatFindAdapter } from '../components/ContentFindBar';
import { ChatMessageFindIndex, extractMessageFindRows, messageBodyBlocks, resolveBodyRanges } from '../components/chat-message-find';

/** Source-backed Find for loaded chat messages. No work on a streamed render:
 * reconciliation happens on query/navigation only, and the cache expires on close. */
export function useChatMessageFind(
  state: SessionChatState,
  open: boolean,
  contentRef: React.RefObject<HTMLElement | null>,
  getEntryEl: (key: string) => HTMLElement | undefined,
  revealAndPin: (key: string) => () => void,
  unfoldNearViewport: () => void,
  releaseStick: () => void,
): ChatFindAdapter {
  const indexRef = useRef<ChatMessageFindIndex | null>(null);
  if (!indexRef.current) indexRef.current = new ChatMessageFindIndex();
  const stateRef = useRef(state);
  stateRef.current = state;
  const listeners = useRef(new Set<(phase: 'pending' | 'refresh') => void>());
  const lastInputs = useRef({ timeline: state.timeline, turns: state.assistantTurns });
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searching = useRef(false);
  const refreshOwed = useRef(false);
  const emitRefresh = () => { for (const listener of listeners.current) listener('refresh'); };
  useEffect(() => {
    const previous = lastInputs.current;
    lastInputs.current = { timeline: state.timeline, turns: state.assistantTurns };
    if (!open || (previous.timeline === state.timeline && previous.turns === state.assistantTurns)) return;
    // WHY: a trailing debounce never fires under continuous <80ms streaming.
    // Throttle from the FIRST changed revision; don't abort an in-flight corpus.
    if (refreshTimer.current != null) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      if (searching.current) refreshOwed.current = true;
      else emitRefresh();
    }, 80);
  }, [open, state.timeline, state.assistantTurns]);
  useEffect(() => () => { if (refreshTimer.current != null) clearTimeout(refreshTimer.current); refreshTimer.current = null; refreshOwed.current = false; }, [open]);
  useEffect(() => { if (!open) indexRef.current?.clear(); }, [open]);
  useEffect(() => () => { indexRef.current?.clear(); }, []);

  return useMemo(() => {
    const expected = new Map<string, number>();
    const hitKey = (id: string, body: number) => `${id}\u0000${body}`;
    const agrees = (id: string, bodyIndex: number, body: HTMLElement) => {
      const source = indexRef.current?.blocksOf(id, bodyIndex);
      const actual = messageBodyBlocks(body);
      return !!source && source.length === actual.length && source.every((value, i) => value === actual[i]);
    };
    return {
      subscribe(listener) {
        listeners.current.add(listener);
        return () => { listeners.current.delete(listener); };
      },
      async search(query, signal) {
        // WHY: opening Find must not parse loaded Markdown before any query.
        if (!query) { indexRef.current?.clear(); expected.clear(); return { hits: [], pending: false }; }
        const { timeline, assistantTurns } = stateRef.current;
        const index = indexRef.current!;
        if (timeline.some((entry) => entry.kind === 'assistant-turn' && !assistantTurns.has(entry.turnId)))
          return { hits: [], pending: true };
        // Yield after short slices; no partial match count escapes. Reuse unchanged
        // bodies and discard an aborted generation before it can update the cache.
        searching.current = true;
        const finish = () => {
          searching.current = false;
          if (refreshOwed.current) {
            refreshOwed.current = false;
            // After this immutable snapshot publishes, schedule the next source
            // revision. A task gives React the completed count a paint opportunity.
            setTimeout(() => { if (!signal.aborted) emitRefresh(); }, 0);
          }
        };
        const hits = await index.prepareSearch(extractMessageFindRows(timeline, assistantTurns), query, signal);
        if (!hits || signal.aborted) { finish(); return null; }
        const counts = new Map<string, number>();
        for (const hit of hits) counts.set(hitKey(hit.id, hit.body), (counts.get(hitKey(hit.id, hit.body)) ?? 0) + 1);
        // A live stream may have advanced while this immutable snapshot was
        // prepared. Publish its complete count, then refresh to the next revision;
        // comparing its blocks to newer DOM would fabricate a permanent pending.
        const advanced = stateRef.current.timeline !== timeline || stateRef.current.assistantTurns !== assistantTurns;
        const mounted = advanced ? [] : contentRef.current?.querySelectorAll<HTMLElement>('[data-message-find-body]') ?? [];
        let sliceStart = performance.now();
        let checked = 0;
        for (const body of mounted) {
          if (signal.aborted) { finish(); return null; }
          // A newer revision can commit during a yield; never validate its DOM
          // against the prior immutable source generation.
          if (stateRef.current.timeline !== timeline || stateRef.current.assistantTurns !== assistantTurns) break;
          const id = body.closest<HTMLElement>('[data-entry-key]')?.dataset.entryKey;
          if (!id) continue;
          const bodyIndex = Number(body.dataset.messageFindBody);
          if (!agrees(id, bodyIndex, body)
              || resolveBodyRanges(body, query).length !== (counts.get(hitKey(id, bodyIndex)) ?? 0))
            { finish(); return { hits: [], pending: true }; }
          // The mounted set is usually tiny but can contain many rows before
          // idle folding. Its DOM projection must not become the new long task.
          if (++checked >= 12 || performance.now() - sliceStart >= 6) {
            await new Promise<void>((done) => setTimeout(done, 0));
            sliceStart = performance.now(); checked = 0;
          }
        }
        if (signal.aborted) { finish(); return null; }
        expected.clear();
        for (const [key, count] of counts) expected.set(key, count);
        finish();
        return { hits, pending: false };
      },
      beforeReveal: releaseStick,
      pin(hit) { return revealAndPin(hit.id); },
      afterScroll: unfoldNearViewport,
      async resolve(hit, query, signal) {
        const row = getEntryEl(hit.id);
        if (!row || signal.aborted) return null;
        const readBody = () => row.querySelector<HTMLElement>(`[data-message-find-body="${hit.body}"]`);
        let body = readBody();
        if (!body) {
          // WHY: reveal publishes React state; wait for its DOM commit instead
          // of guessing how many frames an offscreen row needs to mount.
          body = await new Promise<HTMLElement | null>((done) => {
            const root = contentRef.current;
            if (!root || signal.aborted) { done(null); return; }
            const observer = new MutationObserver(() => {
              const next = readBody();
              if (next || !row.isConnected) finish(next);
            });
            const finish = (next: HTMLElement | null) => {
              observer.disconnect();
              signal.removeEventListener('abort', aborted);
              done(next);
            };
            const aborted = () => finish(null);
            signal.addEventListener('abort', aborted, { once: true });
            observer.observe(root, { childList: true, subtree: true });
            if (readBody()) finish(readBody());
          });
        }
        if (!body || signal.aborted || !row.isConnected || !agrees(hit.id, hit.body, body)) return null;
        const ranges = resolveBodyRanges(body, query);
        if (ranges.length !== expected.get(hitKey(hit.id, hit.body))) return null;
        return ranges[hit.ordinal] ?? null;
      },
    };
  }, [contentRef, getEntryEl, revealAndPin, unfoldNearViewport, releaseStick]);
}
