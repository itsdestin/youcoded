// One entry of ChatView's timeline: its `.timeline-entry` wrapper, the entry's
// body, and (for an archived entry) its hint sibling.
//
// WHY a memoised component of its own (perf, 2026-09-24): ChatView re-renders
// once per streamed word in the chat on screen — it must, the live reply is
// growing. It used to build every row inline in its own render, so each word
// re-rendered every card that is not itself memoised (markers, prompt / usage /
// skill / copy cards, and the archived-entry hints) and re-reconciled every
// wrapper, in a conversation of any length. Measured with 24 entries and 40
// words: 40 renders of each of those, where only the live reply changed.
// As a memoised row with stable props, a word re-renders only the row whose
// entry actually changed — the reply being written.
// Guard: tests/ChatView-render-cost.test.tsx ("a streamed word re-renders…").
//
// Stable props are the whole trick (renderer-lists.md → "A memoised row gets
// stable props"): the reducer keeps every unchanged entry, turn, toolCalls and
// toolGroups by reference; callbacks arrive as ChatView's stable callbacks or
// through `actionsRef` (latest-handlers ref), and nothing here receives a fresh
// object from ChatView's render. The markup is exactly what ChatView rendered
// inline before, so the DOM is unchanged.
import React from 'react';
import type { AssistantTurn, TimelineEntry } from '../state/chat-types';
import type { ChatAction } from '../state/chat-types';
import type { ToolCallState, ToolGroupState, SessionProvider } from '../../shared/types';
import UserMessage from './UserMessage';
import SpecialistReportCard from './SpecialistReportCard';
import AssistantTurnBubble from './AssistantTurnBubble';
import PromptCard, { type PromptCardButton } from './PromptCard';
import UsageCard from './UsageCard';
import SystemMarker from './SystemMarker';
import SkillInvocationCard from './SkillInvocationCard';
import CompactingCard from './CompactingCard';
import CopyPicker from './CopyPicker';
import { TimelineEntryHint } from './TimelineEntryHint';
import { archivedTooltip } from '../state/archive-boundary';
import type { PromptAnswerResult } from '../state/prompt-input';

/** What a row may call back into ChatView. Read through a ref at call time so
 *  a row that skipped rendering never holds a stale handler. */
export interface TimelineRowActions {
  // WHY it returns the answer's promise (merge with master 2026-09-24): PromptCard
  // shows "Claude Code didn't take that" from it; dropping it here would hide failures.
  promptSelect: (promptId: string, button: PromptCardButton, label: string, promptTitle?: string) => void | Promise<PromptAnswerResult> | undefined;
  dispatch: (action: ChatAction) => void;
}

interface Props {
  entry: TimelineEntry;
  /** The `data-entry-key` (and React key) ChatView resolved for this entry. */
  entryKey: string;
  /** Assistant-turn rows only — undefined for every other kind, so a tool
   *  event (a new toolCalls Map) does not re-render marker/card rows. */
  turn?: AssistantTurn;
  toolGroups?: Map<string, ToolGroupState>;
  toolCalls?: Map<string, ToolCallState>;
  sessionId: string;
  provider?: SessionProvider;
  showTimestamps: boolean;
  /** Above the last /compact or /clear: faded, with a hint beside it. */
  archived: boolean;
  archiveKind: 'compact' | 'clear' | null;
  /** Folded (use-entry-folding): the wrapper keeps this height, body omitted.
   *  Undefined when the entry is not folded. */
  foldHeight: number | undefined;
  attachEntry: (el: HTMLDivElement | null) => (() => void) | void;
  getEntryEl: (key: string) => HTMLElement | undefined;
  actionsRef: React.RefObject<TimelineRowActions>;
}

function renderContent(p: Props): React.ReactNode {
  const { entry, sessionId, showTimestamps } = p;
  switch (entry.kind) {
    case 'user':
      // A host-injected user-role turn (a delivered specialist report) is an
      // EVENT for the assistant, not anyone's words — a compact collapsed card,
      // see SpecialistReportCard. MUST mirror BubbleFeed.tsx.
      return entry.injected ? (
        <SpecialistReportCard
          message={entry.message}
          injected={entry.injected}
          meta={entry.injectedMeta}
          sessionId={sessionId}
          showTimestamps={showTimestamps}
        />
      ) : (
        <UserMessage message={entry.message} sessionId={sessionId} showTimestamps={showTimestamps} />
      );
    case 'assistant-turn':
      // ChatView only builds this row after shouldRenderAssistantTurn(turn).
      return (
        <AssistantTurnBubble
          turn={p.turn!}
          toolGroups={p.toolGroups!}
          toolCalls={p.toolCalls!}
          sessionId={sessionId}
          provider={p.provider}
          showTimestamps={showTimestamps}
        />
      );
    case 'prompt': {
      const { promptId, title } = entry.prompt;
      return (
        <PromptCard
          prompt={entry.prompt}
          sessionId={sessionId}
          // Built once per row render (not per ChatView render), and reads the
          // live handler through the ref when clicked.
          onSelect={(button, label) => p.actionsRef.current?.promptSelect(promptId, button, label, title)}
        />
      );
    }
    // /cost and /usage snapshot.
    case 'usage-card':
      return <UsageCard snapshot={entry.snapshot} />;
    // /clear and /compact dividers
    case 'system-marker':
      return <SystemMarker marker={entry.marker} />;
    // /skill-name — a compact card, never the instructions themselves.
    case 'skill-invocation':
      return (
        <SkillInvocationCard
          skillId={entry.skillId}
          displayName={entry.displayName}
          args={entry.args}
          skillPath={entry.skillPath}
          sessionId={sessionId}
        />
      );
    // /compact spinner (and resume-from-summary)
    case 'compacting':
      return <CompactingCard startedAt={entry.startedAt} />;
    // /copy multi-block picker
    case 'copy-picker': {
      const pickerId = entry.id;
      const dismiss = () => p.actionsRef.current?.dispatch({ type: 'DISMISS_COPY_PICKER', sessionId, id: pickerId });
      return (
        <CopyPicker
          id={pickerId}
          options={entry.options}
          onCopy={(text, label) => {
            navigator.clipboard.writeText(text).catch(() => {});
            dismiss();
            // onToast would be nicer but ChatView doesn't have it — minimal UX for now
            void label;
          }}
          onDismiss={dismiss}
        />
      );
    }
    default:
      return null;
  }
}

function ChatTimelineRow(p: Props) {
  const { entryKey, archived, foldHeight } = p;
  // Folded: render the wrapper at exactly the height its body last occupied
  // and omit the body. The wrapper stays in the DOM so the scroll height, the
  // observers and captureScrollAnchor's `.timeline-entry` query all see an
  // unchanged list.
  const folded = !!foldHeight;
  // WHY the hint is a SIBLING, and only for archived entries: a wrapping
  // <Tooltip> per entry ran its state and effects for every message on every
  // streamed word, with empty text almost always. The entry element stays first
  // in the fragment either way, so archiving it never rebuilds it — see
  // TimelineEntryHint.tsx.
  return (
    <>
      <div
        ref={p.attachEntry}
        data-entry-key={entryKey}
        className={`timeline-entry in-view${archived ? ' opacity-60 transition-opacity' : ''}`}
        style={folded ? { height: foldHeight } : undefined}
      >
        {folded ? null : renderContent(p)}
      </div>
      {archived && (
        <TimelineEntryHint entryKey={entryKey} getEntry={p.getEntryEl} text={archivedTooltip(p.archiveKind)} />
      )}
    </>
  );
}

export default React.memo(ChatTimelineRow);
