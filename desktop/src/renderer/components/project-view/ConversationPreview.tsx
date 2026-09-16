// ConversationPreview — read-only preview of a past conversation in Project
// View's centered detail overlay. The transcript is SessionPreviewPane, the
// same pane the Resume browser and the side drawer show, so a conversation
// previews identically wherever it is opened.
//
// WHY (2026-09-16): this used to load its own flattened copy of the
// conversation (project:conversation-history), stop at 20 messages and offer
// "Open full transcript". Destin asked for one preview that looks like the
// chat and loads older messages as you scroll up, like the chat does — which
// also means a huge conversation is never read in one go.
//
// IMPORTANT: This component NEVER spawns a Claude process. Only the explicit
// "Resume in Claude" button leads to a live session, and that is handled
// entirely by the parent via the `onResume` prop.
import type { PastSession } from '../../../shared/types';
import { ProjectDetailOverlay } from './ProjectDetailOverlay';
import SessionPreviewPane from '../SessionPreviewPane';
import { TOOL_BTN_ACCENT, PlayIcon } from './detail-tool-icons';
// Compact relative-time for the meta strip (shared util).
import { formatRelativeTime as relTime } from '../../utils/format-time';

interface ConversationPreviewProps {
  session: PastSession;
  onClose: () => void;
  onResume: (session: PastSession) => void;
}

export function ConversationPreview({ session, onClose, onResume }: ConversationPreviewProps) {
  const tools = (
    <button type="button" className={TOOL_BTN_ACCENT} onClick={() => onResume(session)}>
      <PlayIcon size={13} />
      Resume in Claude
    </button>
  );

  // The pane's own caption already says "read-only"; the strip keeps the one
  // fact the pane does not show.
  const meta = <span>{relTime(session.lastModified)}</span>;

  return (
    <ProjectDetailOverlay title={session.name || 'Untitled'} onClose={onClose} tools={tools} meta={meta}>
      <SessionPreviewPane
        provider={session.provider === 'native' ? 'native' : 'claude'}
        id={session.sessionId}
        title={session.name || ''}
        projectSlug={session.projectSlug}
      />
    </ProjectDetailOverlay>
  );
}
