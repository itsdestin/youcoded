// Drawer host for a previewed past conversation. Reads bounded slices through
// chatsearch:read and pages backwards on demand — there is deliberately no
// "load everything" (a 42 MB transcript would cross IPC and be markdown-
// rendered bubble by bubble, inside a 480px pane, on a phone).
import { useCallback, useEffect, useRef, useState } from 'react';
import ConversationTranscript from './project-view/ConversationTranscript';
import { ErrorState } from './ui/states';
import { BugReportPopup } from './development/BugReportPopup';
import type { ReportContext } from './development/ReportDesign';
import { COPY, READ_TAIL_DEFAULT, type TranscriptMessage, type ChatsearchProvider } from '../../shared/chatsearch-refs';

// Fix (2026-08-27): the conversation title for the right-click scaffold (A3)
// now arrives as a `title` prop instead of being resolved a second time in
// here. SessionDrawer already resolves this same id for its own header
// (title, Resume eligibility, tags — spec A1/A2/A4) and has had the title on
// hand since the moment the preview was opened (activePreview.title) — this
// pane used to re-run chatsearch:resolve for the exact same id just to get
// the same string, purely because the two changes landed in separate commits
// that couldn't touch each other's file yet. Passing '' is fine: the same
// string an unresolved/untitled conversation always had — askPreviewContext
// (build-menu.ts) already falls back to COPY.untitled when it's empty.
type Phase = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

export default function SessionPreviewPane({ provider, id, title }: { provider: ChatsearchProvider; id: string; title: string }) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Fix 2: a failed "Load older" reports its error HERE, near the paging
  // control, instead of through `phase` — `phase` stays 'ready' so the
  // messages already on screen are never replaced by a full-pane error.
  // WHY an object and not a bare string: `message` can legitimately be ''
  // (backend gave no reason — see the `load()` WHY comment below), and a
  // bare '' is falsy, which would make the "did this fail at all" check
  // below silently treat a real, unexplained failure as no failure and
  // re-show the "Load older" button as if nothing happened.
  const [olderError, setOlderError] = useState<{ message: string } | null>(null);
  const [scrollKey, setScrollKey] = useState(0);

  // Fix 1: generation token guarding every in-flight read. Bumped by every
  // loadNewest() call (mount, prop swap, or Retry); a response is applied
  // only if the token it captured is still current. WHY: this pane can be
  // reused for a NEW conversation without unmounting (the drawer swaps
  // provider/id in place when the user previews a second conversation before
  // the first finishes loading) — without this guard, the first request's
  // late response would land after the second's and overwrite the correct
  // conversation with the wrong one. Same pattern as ConversationPreview.tsx's
  // `cancelled` flag, generalized to a counter so loadOlder can share it.
  const genRef = useRef(0);

  // Opens BugReportPopup for the "no reason given" branch of a read failure
  // (case (b) below) — same one-destination pattern as SettingsPanel's
  // Tailscale setup error and PermissionsSection's load failure: both
  // "Report bug" and "Diagnose with the assistant" land on this popup, which already
  // wraps dev:summarize-issue + dev:submit-issue.
  const [reportContext, setReportContext] = useState<ReportContext | null>(null);

  const load = useCallback(async (before?: number) => {
    const req = before === undefined ? { provider, id, tail: READ_TAIL_DEFAULT } : { provider, id, tail: READ_TAIL_DEFAULT, before };
    const res = await (window.claude as any).chatsearch.read(req);
    if (!res?.ok) {
      // WHY: never invent a cause for a failure nobody diagnosed. `res.error`
      // is the real reason when chatsearch:read supplied one — surfaced
      // verbatim below. When it did not, `new Error(undefined)` yields an
      // EMPTY message (not a guessed string like the old
      // 'Unknown error reading the transcript'), which the render below reads
      // as "we don't know why" and shows the general Report-bug/Diagnose card
      // instead of asserting a specific cause that might not even be true —
      // the read may not have failed at all. This line is what
      // tests/status-strip-authority.test.tsx's "no user-facing error falls
      // back to a hardcoded cause" guard checks; don't put the fallback back.
      throw new Error(res?.error);
    }
    return res as { messages: TranscriptMessage[]; hasMore: boolean };
  }, [provider, id]);

  const loadNewest = useCallback(() => {
    const myGen = ++genRef.current;
    setPhase({ kind: 'loading' }); setMessages([]); setOlderError(null); setLoadingOlder(false);
    return load().then((r) => {
      if (genRef.current !== myGen) return; // superseded — see genRef comment above
      setMessages(r.messages); setHasMore(r.hasMore); setPhase({ kind: 'ready' }); setScrollKey((k) => k + 1);
    }).catch((e) => {
      if (genRef.current !== myGen) return;
      // e.message is '' exactly when load() couldn't find a real reason —
      // keep it '' rather than falling back to String(e) ('Error'), which
      // would just be a different hardcoded guess wearing a JS-native mask.
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : '' });
    });
  }, [load]);

  useEffect(() => { void loadNewest(); }, [loadNewest]);

  const loadOlder = async () => {
    if (!messages.length) return;
    const beforeSeq = messages[0].seq;
    const myGen = genRef.current; // captured, not bumped: a swap bumps it via loadNewest, which invalidates this response too
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const r = await load(beforeSeq);
      if (genRef.current !== myGen) return;
      setMessages((m) => [...r.messages, ...m]); setHasMore(r.hasMore);
    } catch (e: any) {
      if (genRef.current !== myGen) return;
      // Fix 2: keep the already-loaded messages on screen and report the
      // failure next to "Load older" instead of blowing away the pane. Retry
      // re-runs loadOlder() with the SAME beforeSeq (messages[0] didn't
      // change on failure), so it retries this backwards page, not the
      // newest slice. Same '' handling as loadNewest's catch above.
      setOlderError({ message: e instanceof Error ? e.message : '' });
    } finally {
      if (genRef.current === myGen) setLoadingOlder(false);
    }
  };

  return (
    // bg-canvas: the drawer's <aside> is bg-inset (SessionDrawer.tsx), and so is
    // the assistant bubble ConversationTranscript renders (bg-inset — same
    // token as its own background is exactly the invisible-bubble bug this
    // pane shipped with). The real chat never has this collision because its
    // bubbles sit on the app-shell's bg-canvas, not on another bg-inset
    // surface (ChatView's .chat-pane paints no background of its own — see
    // the comment on that rule in globals.css — so bg-canvas is what's
    // actually behind a real assistant bubble). Painting THIS pane bg-canvas
    // reproduces that same canvas-under-bubble relationship instead of
    // recoloring the shared bubble, so ConversationPreview (which already
    // sits on a contrasting bg-panel via ProjectDetailOverlay's OverlayPanel)
    // doesn't need to change. Precedent for a bg-canvas "well" nested inside
    // this same bg-inset aside: the rename input a few dozen lines up.
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-canvas">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {/* WHY: this pane deliberately has NO header/close of its own — the
            drawer's top bar (SessionDrawer.tsx) already supplies the title
            and the single close button, the same way it does for an open
            file. This pane used to draw a second title/close row here, which
            was the "two X's" bug Destin flagged; don't reintroduce one. The
            read-only/lane info that row used to carry still matters, so it
            gets a quiet caption line instead — no close control, no size
            change to the drawer's own bar. */}
        <div className="mb-2 text-xs text-fg-muted">{COPY.paneSubtitle(provider)}</div>
        {phase.kind === 'loading' && <p className="text-sm text-fg-muted">{COPY.loading}</p>}
        {/* First load has nothing to show behind it, so a full-pane error is
            correct here. Two shapes per docs/error-message-standards.md:
            phase.message set → the real reason, verbatim, with Retry (case a).
            phase.message === '' → we don't have one; say so and offer the two
            actions instead of asserting a cause nobody checked (case b). */}
        {phase.kind === 'error' && (
          phase.message
            ? <ErrorState mode="recoverable" message={`${COPY.errReadPrefix}${phase.message}`} onRetry={() => void loadNewest()} />
            : (
              <ErrorState
                mode="general"
                title={COPY.errReadUnknownTitle}
                explainer={COPY.errReadUnknownExplainer}
                onReportBug={() => setReportContext({ surface: 'Reading a past conversation' })}
                onDiagnose={() => setReportContext({ surface: 'Reading a past conversation', diagnose: true })}
              />
            )
        )}
        {phase.kind === 'ready' && (
          <ConversationTranscript messages={messages} scrollToEndKey={scrollKey}
            conversationId={id} conversationTitle={title}
            olderHint={hasMore
              ? (
                <div className="py-2 text-center">
                  {olderError ? (
                    olderError.message
                      ? <ErrorState mode="recoverable" variant="inline" message={`${COPY.errReadPrefix}${olderError.message}`} onRetry={() => void loadOlder()} />
                      : (
                        <ErrorState
                          mode="general"
                          title={COPY.errReadUnknownTitle}
                          explainer={COPY.errReadUnknownExplainer}
                          onReportBug={() => setReportContext({ surface: 'Loading older messages' })}
                          onDiagnose={() => setReportContext({ surface: 'Loading older messages', diagnose: true })}
                        />
                      )
                  ) : (
                    <button type="button" className="rounded-md border border-edge bg-well px-3 py-1 text-xs text-fg hover:bg-inset disabled:opacity-50" disabled={loadingOlder} onClick={loadOlder}>{COPY.loadOlder}</button>
                  )}
                </div>
              )
              : <div className="py-2 text-center text-[11.5px] text-fg-muted">— {COPY.startOfConversation} —</div>} />
        )}
      </div>
      <BugReportPopup open={!!reportContext} onClose={() => setReportContext(null)} context={reportContext ?? undefined} />
    </div>
  );
}
