// The read-only timeline a previewed past conversation is drawn with — the
// Resume browser, the side drawer and the Projects page all use it (through
// SessionPreviewPane).
//
// WHY it renders the chat's OWN components from a reducer-built state
// (2026-09-16): previews used to draw their own simplified bubbles from
// flattened text, so a conversation looked one way in the preview and another
// once resumed — background notes showed as the user's bubbles, tools became
// "3 tools — not shown", reasoning vanished. Destin: "conversations look more
// like they will after they resume". So this is ChatView's timeline switch
// with everything live taken out: the entries, the components and the props
// are the same, and anything that only makes sense in a running session is
// skipped. MUST mirror ChatView.tsx's `state.timeline.map` (and BubbleFeed.tsx)
// for the entry kinds it draws.
import React from 'react';
import UserMessage from './UserMessage';
import SpecialistReportCard from './SpecialistReportCard';
import AssistantTurnBubble from './AssistantTurnBubble';
import UsageCard from './UsageCard';
import SystemMarker from './SystemMarker';
import SkillInvocationCard from './SkillInvocationCard';
import { shouldRenderAssistantTurn, type SessionChatState } from '../state/chat-types';
import { findArchiveBoundary } from '../state/archive-boundary';
import { useTheme } from '../state/theme-context';
import type { SessionProvider } from '../../shared/types';
import type { EntryFolding } from '../hooks/use-entry-folding';

export default function PreviewTimeline({ state, sessionId, provider, folding }: {
  state: SessionChatState;
  /** The preview's reducer key (previewSessionKey) — never a live session's id,
   *  so file chips and helper cards look nothing up against a running chat. */
  sessionId: string;
  provider: SessionProvider;
  /** Perf cycle 3's fold controller (use-entry-folding.ts) — optional so this
   *  component still renders standalone (e.g. a future caller with no scroll
   *  container to fold against) without every entry needing a null check. */
  folding?: EntryFolding;
}) {
  const { showTimestamps } = useTheme();
  const { index: lastArchiveIdx } = React.useMemo(() => findArchiveBoundary(state.timeline), [state.timeline]);
  return (
    <>
      {state.timeline.map((entry, idx) => {
        let key: string;
        let content: React.ReactNode;
        switch (entry.kind) {
          case 'user':
            key = entry.message.id;
            content = entry.injected ? (
              <SpecialistReportCard message={entry.message} injected={entry.injected} meta={entry.injectedMeta}
                sessionId={sessionId} showTimestamps={showTimestamps} />
            ) : (
              <UserMessage message={entry.message} sessionId={sessionId} showTimestamps={showTimestamps} />
            );
            break;
          case 'assistant-turn': {
            const turn = state.assistantTurns.get(entry.turnId);
            if (!shouldRenderAssistantTurn(turn)) return null;
            key = entry.turnId;
            content = (
              <AssistantTurnBubble turn={turn} toolGroups={state.toolGroups} toolCalls={state.toolCalls}
                sessionId={sessionId} provider={provider} showTimestamps={showTimestamps} />
            );
            break;
          }
          case 'usage-card':
            key = entry.snapshot.entryId;
            content = <UsageCard snapshot={entry.snapshot} />;
            break;
          case 'system-marker':
            key = entry.marker.id;
            content = <SystemMarker marker={entry.marker} />;
            break;
          case 'skill-invocation':
            key = entry.id;
            content = (
              <SkillInvocationCard skillId={entry.skillId} displayName={entry.displayName} args={entry.args}
                skillPath={entry.skillPath} sessionId={sessionId} />
            );
            break;
          // Live-only entries: an answerable prompt, the /compact spinner and the
          // /copy picker belong to a running session. A page read off disk never
          // produces them, and a button here would act on nothing.
          default:
            return null;
        }
        // Same fade ChatView gives everything above the last /clear or /compact.
        const archived = lastArchiveIdx >= 0 && idx < lastArchiveIdx;
        // WHY: same fold as ChatView.tsx (its `state.timeline.map` wrapper) —
        // this timeline MUST mirror it, since the preview is read far enough
        // back that it hits the same far-off-DOM-node cost the chat does, and
        // it has no virtualization of its own. `registerEntry` is stable (the
        // hook's contract), so passing it directly as `ref` never causes a
        // per-render detach/reattach.
        const folded = folding?.isFolded(key) ?? false;
        const foldHeight = folded ? folding!.heightOf(key) : undefined;
        return (
          // timeline-entry + in-view: the chat's own wrapper classes. `in-view`
          // is what theme glass keys on (`[data-wallpaper] .in-view .bg-inset`),
          // so a bubble here is frosted exactly like one in the chat.
          <div key={key} ref={folding?.registerEntry} data-entry-key={key}
            className={`timeline-entry in-view${archived ? ' opacity-60' : ''}`}
            style={folded && foldHeight ? { height: foldHeight } : undefined}>
            {folded && foldHeight ? null : content}
          </div>
        );
      })}
    </>
  );
}
