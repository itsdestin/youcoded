// ConversationPreview — read-only transcript preview shown in the shared centered
// detail overlay (Task 3.2). Loads a session's message history via the
// project:conversation-history IPC (which does NOT launch Claude — it parses the
// JSONL transcript on disk) and renders it via the shared ConversationTranscript
// bubble list (markdown-rendered, no filepath chips — see that component).
//
// IMPORTANT: This component NEVER spawns a Claude process. Only the explicit
// "Resume in Claude" button leads to a live session, and that is handled entirely
// by the parent via the `onResume` prop. "Open full transcript" just re-fetches
// the same read-only history with `all: true`.
import { useEffect, useState } from 'react';
import type { PastSession, HistoryMessage } from '../../../shared/types';
import { ProjectDetailOverlay } from './ProjectDetailOverlay';
import ConversationTranscript from './ConversationTranscript';
import { TOOL_BTN_ACCENT, TOOL_BTN_NEUTRAL, PlayIcon } from './detail-tool-icons';
// Compact relative-time for the meta strip (shared util).
import { formatRelativeTime as relTime } from '../../utils/format-time';

interface ConversationPreviewProps {
  project: { path: string };
  session: PastSession;
  onClose: () => void;
  onResume: (session: PastSession) => void;
}

export function ConversationPreview({ project, session, onClose, onResume }: ConversationPreviewProps) {
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [loading, setLoading] = useState(true);
  // `all` flips to true once the user clicks "Open full transcript"; we re-fetch
  // with count=0/all=true and disable the button so a second click is a no-op.
  const [all, setAll] = useState(false);

  // Load the (preview-length) history on mount and whenever the session changes.
  // A `cancelled` flag guards against a late response from a previous session
  // overwriting the current one (the overlay can be reused for a new session
  // without unmounting if the parent swaps `session` in place).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setAll(false);
    setMessages([]);
    (async () => {
      try {
        const res = await (window.claude as any).project.conversationHistory(
          project.path, session.sessionId, 20, false,
        );
        if (cancelled) return;
        setMessages(res?.ok ? (res.messages ?? []) : []);
      } catch {
        if (!cancelled) setMessages([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [session.sessionId, project.path]);

  // "Open full transcript" — re-fetch the same read-only history with all=true.
  // Still no Claude launch; this just reads more lines from the same JSONL.
  const loadFullTranscript = async () => {
    setLoading(true);
    try {
      const res = await (window.claude as any).project.conversationHistory(
        project.path, session.sessionId, 0, true,
      );
      setMessages(res?.ok ? (res.messages ?? []) : []);
      setAll(true);
    } catch {
      /* leave current messages in place on failure */
    } finally {
      setLoading(false);
    }
  };

  // project:list-conversations deliberately carries NO total message count (the
  // preview is a bounded head-read — counting would mean parsing every
  // transcript). So until "Open full transcript", the meta labels what's shown
  // as a preview slice rather than implying the loaded count is the total.
  const shownCount = messages.length;
  // Top-of-list hint on a preview slice: older messages exist above the cut.
  const showOlderHint = !all && shownCount > 0;

  // Header tools: Resume (accent) + Open full transcript (neutral).
  const tools = (
    <>
      <button type="button" className={TOOL_BTN_ACCENT} onClick={() => onResume(session)}>
        <PlayIcon size={13} />
        Resume in Claude
      </button>
      <button type="button" className={TOOL_BTN_NEUTRAL} onClick={loadFullTranscript} disabled={all}>
        {all ? 'Showing full transcript' : 'Open full transcript'}
      </button>
    </>
  );

  // Meta strip: "last N messages · 2d ago · read-only preview" (labelled as a
  // slice until the full transcript is loaded — the true total isn't known).
  const meta = (
    <>
      <span>{all ? `${shownCount} messages` : `last ${shownCount} messages`}</span>
      <span className="text-fg-faint">·</span>
      <span>{relTime(session.lastModified)}</span>
      <span className="text-fg-faint">·</span>
      <span>read-only preview</span>
    </>
  );

  return (
    <ProjectDetailOverlay title={session.name || 'Untitled'} onClose={onClose} tools={tools} meta={meta}>
      {/* Message list */}
      <div className="px-5 py-4">
        {loading ? (
          <p className="text-sm text-fg-muted">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-fg-muted">No messages to preview.</p>
        ) : (
          // Bubbles mirror the real chat view: user on the RIGHT in accent
          // (UserMessage.tsx), Claude on the LEFT in inset (AssistantTurnBubble.tsx)
          // — same rounding + max-widths, so the preview reads as the same
          // conversation the user remembers. No role captions; the sides carry
          // that, like the live chat. Rendered by the same ConversationTranscript
          // the Session Drawer's SessionPreviewPane uses, so both surfaces agree
          // on markdown rendering and gap markers.
          <ConversationTranscript
            messages={messages}
            scrollToEndKey={loading}
            olderHint={showOlderHint ? (
              // The "there's more above" hint sits at the TOP — that's the OLDER
              // side now that the preview anchors to the latest message.
              <div className="text-center text-xs text-fg-muted py-2">
                — showing the last {shownCount} messages — use "Open full transcript" for everything —
              </div>
            ) : null}
          />
        )}
      </div>
    </ProjectDetailOverlay>
  );
}
