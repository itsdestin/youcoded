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
import { shouldRenderAssistantTurn, userEntryRenderKind, planAskQuestion, type SessionChatState } from '../state/chat-types';
import { PlanAskLine } from './plans/PlanAskLine';
import { findArchiveBoundary } from '../state/archive-boundary';
import { useTheme } from '../state/theme-context';
import type { SessionProvider } from '../../shared/types';

export default function PreviewTimeline({ state, sessionId, provider }: {
  state: SessionChatState;
  /** The preview's reducer key (previewSessionKey) — never a live session's id,
   *  so file chips and helper cards look nothing up against a running chat. */
  sessionId: string;
  provider: SessionProvider;
}) {
  const { showTimestamps } = useTheme();
  const { index: lastArchiveIdx } = React.useMemo(() => findArchiveBoundary(state.timeline), [state.timeline]);
  return (
    <>
      {state.timeline.map((entry, idx) => {
        let key: string;
        let content: React.ReactNode;
        switch (entry.kind) {
          case 'user': {
            // Task 10/11: a plan notice is hidden or drawn as the one-line
            // "You asked…" — shared render kind, as in ChatView.
            const renderKind = userEntryRenderKind(entry);
            if (renderKind === 'hide') return null;
            key = entry.message.id;
            content = renderKind === 'ask-line' ? <PlanAskLine question={planAskQuestion(entry.message.content)} /> : entry.injected ? (
              <SpecialistReportCard message={entry.message} injected={entry.injected} meta={entry.injectedMeta}
                sessionId={sessionId} showTimestamps={showTimestamps} />
            ) : (
              <UserMessage message={entry.message} sessionId={sessionId} showTimestamps={showTimestamps} />
            );
            break;
          }
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
        return (
          // timeline-entry + in-view: the chat's own wrapper classes. `in-view`
          // is what theme glass keys on (`[data-wallpaper] .in-view .bg-inset`),
          // so a bubble here is frosted exactly like one in the chat.
          <div key={key} className={`timeline-entry in-view${archived ? ' opacity-60' : ''}`}>
            {content}
          </div>
        );
      })}
    </>
  );
}
