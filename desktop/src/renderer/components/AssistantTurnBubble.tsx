import React, { useState } from 'react';
import { AssistantTurn, abnormalStopReason } from '../state/chat-types';
import { ToolCallState, ToolGroupState, SessionProvider } from '../../shared/types';
import { assistantName } from '../utils/assistant-name';
import { hasNestedAsk } from '../utils/specialist-cards';
import { buildToolGroupHeadline } from '../utils/tool-group-summary';
import MarkdownContent from './MarkdownContent';
import { SessionRefsEnabled } from './session-refs-context';
import ToolCard, { StackedSkillsCard } from './ToolCard';
import { DeliverablesCard, isSentFilesTool, isSentLinksTool, SENT_FILES_TOOL } from './DeliverablesCard';
import { isSendUserLinkToolName } from '../../shared/send-user-link';
import { CheckIcon, FailIcon, ChevronIcon, QuestionIcon, StoppedIcon } from './Icons';
import BrailleSpinner from './BrailleSpinner';
import { formatBubbleTime } from '../utils/format-time';
import { useTheme } from '../state/theme-context';
import { useExpandAllToggle, getInitialExpanded } from '../hooks/useExpandAllToggle';
import { isPlaceholderModelId } from '../../shared/model-ids';
import { resolveModelBrand } from './provider-brand';
import { ProviderIcon } from './ProviderIcon';

interface Props {
  turn: AssistantTurn;
  toolGroups: Map<string, ToolGroupState>;
  toolCalls: Map<string, ToolCallState>;
  sessionId: string;
  /** Session provider — drives provider-aware stop-reason copy (native vs Claude). */
  provider?: SessionProvider;
  showTimestamps: boolean;
}

// Non-end_turn stop reasons rendered inline under the affected turn.
// `tool_use` is filtered upstream at transcript-watcher.ts (it means "awaiting
// tool result", not a real completion). `end_turn` — the normal completion —
// reaches the reducer but is filtered at the render gate below, because it
// carries no abnormal signal worth surfacing. The keys below are the
// ones that ARE worth surfacing (truncation / refusal / etc.).
// The two subject-carrying lines swap in the assistant's display name; the rest
// are provider-neutral. That name is now "Your assistant" for every provider
// (Destin, 2026-09-10) — see utils/assistant-name.ts.
function stopReasonCopy(reason: string, provider: SessionProvider | undefined): string {
  const name = assistantName(provider, { capitalized: true }); // "Your assistant"
  const map: Record<string, string> = {
    max_tokens: `Response truncated — ${name} hit the output token limit.`,
    stop_sequence: 'Response stopped at a configured stop sequence.',
    refusal: `${name} declined to respond.`,
    pause_turn: 'Extended thinking paused mid-turn.',
    interrupted: 'Interrupted.',
    // Deliberately provider-neutral (no assistantName interpolation): this
    // sentence is about the user's own action, not about the assistant. Without
    // it a dismissed turn is visually identical to a session that silently died,
    // and the user can't trust either signal.
    question_dismissed: 'Question closed — waiting for you.',
    // Empty-step recovery (spec 2026-08-21): the harness already retried once
    // silently; this is the honest end after a SECOND contentless step —
    // "twice" states that verified fact (error-message standards: specific
    // and accurate). "Retrying may help" stays: it refers to a LATER manual
    // nudge, which recovered all three observed live incidents — distinct
    // from the immediate auto-retry that just failed.
    // Deliberately provider-neutral ("The model") — the failure belongs to
    // the model, not the assistant persona.
    empty_response: 'The model returned an empty response twice. Retrying may help.',
  };
  return map[reason] ?? `Response ended: ${reason}.`;
}


// Collapsible disclosure for the model's reasoning / chain of thought.
// Collapsed by default — user explicitly chose this UX so reasoning doesn't
// dominate the chat view. Expanding reveals the full markdown body.
// Used by AssistantTurnBubble when a VisualBubble carries reasoning content
// (always streamed before its associated text bubble).
function ReasoningSection({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(() => getInitialExpanded());
  useExpandAllToggle(() => setExpanded(true), () => setExpanded(false));
  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-2xs text-fg-muted hover:text-fg-dim select-none"
        title="Show the model's reasoning"
      >
        <ChevronIcon className="w-3 h-3" expanded={expanded} />
        <span className="italic">{expanded ? 'Hide reasoning' : 'Show reasoning'}</span>
      </button>
      {expanded && (
        <div className="mt-1 pl-2 border-l-2 border-edge-dim text-[12.5px] text-fg-dim">
          <MarkdownContent content={content} />
        </div>
      )}
    </div>
  );
}

function StopReasonFooter({ reason, provider }: { reason: string; provider: SessionProvider | undefined }) {
  const copy = stopReasonCopy(reason, provider);
  return (
    <div className="text-xs text-fg-muted italic mt-1 pl-1 border-l-2 border-edge-dim" role="status">
      {copy}
    </div>
  );
}

// Opt-in per-turn transcript metadata. Gated in the bubble render by
// `showTurnMetadata` (default false) — most users never see it. Mono for
// scannable numbers; muted tokens only so it stays unobtrusive across themes.
function TurnMetadataStrip({ turn }: { turn: AssistantTurn }) {
  if (!turn.usage && !turn.model) return null;
  const u = turn.usage;
  // Fix: this used to render a percentage over
  // (input + output + cacheRead + cacheCreation). On the native runtime that
  // double-counts — an OpenAI-compatible provider's inputTokens ALREADY contains
  // the cached reads — so a turn that genuinely reused 98.7% of its prompt
  // displayed as 49%. A raw count needs no denominator, so it cannot be wrong in
  // either runtime's accounting; the StatusBar's Reuse chip is where the ratio
  // lives, and it resolves the denominator per source (Destin, 2026-08-16).

  return (
    <div
      className="text-[10.5px] text-fg-muted mt-1 pl-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono select-text"
      title="Per-turn metadata from transcript"
    >
      {/* Fix: `<synthetic>` is CC's placeholder for a notice it wrote itself
          (session limit, out of credits, /login), not a model — printing it
          raw here showed the user a fake model name. Nothing replaces it: the
          turn genuinely ran on no model. */}
      {turn.model && !isPlaceholderModelId(turn.model) && (() => {
        // The mark only; the id stays raw and mono. This strip exists to show
        // the EXACT transcript values, so prettifying the id here would defeat
        // its purpose — the mark just makes the company scannable when a long
        // conversation switched models partway through.
        const b = resolveModelBrand(turn.model);
        return (
          <span className="inline-flex items-center gap-1">
            {b?.icon && <span style={{ color: b.color }} className="inline-flex"><ProviderIcon icon={b.icon} size={10} /></span>}
            <span>{turn.model}</span>
          </span>
        );
      })()}
      {u && (
        <>
          <span>in {u.inputTokens.toLocaleString()}</span>
          <span>out {u.outputTokens.toLocaleString()}</span>
          {u.cacheReadTokens > 0 && <span>cached {u.cacheReadTokens.toLocaleString()}</span>}
        </>
      )}
    </div>
  );
}

/** Renders a collapsed summary for 2+ tools in a group. Exported so the
 * workbench tool gallery (?mode=workbench&view=tools) can render fixtures with
 * the same grouping treatment real chat uses (single visual unit + shared
 * bg-inset on cards). */
export function CollapsedToolGroup({ tools, sessionId }: { tools: ToolCallState[]; sessionId: string }) {
  const [expanded, setExpanded] = useState(() => getInitialExpanded());
  useExpandAllToggle(() => setExpanded(true), () => setExpanded(false));

  // Specialists 1c: a Task card whose helper is still working counts as
  // running even though its tool result (the launch ack) already landed —
  // otherwise a group of background hires read "all complete" while one of
  // them was mid-job. A helper waiting on the user is called out too.
  const stillWorking = (t: ToolCallState) => t.specialistRun?.status === 'running';
  // WHY a stopped Task can retain `status: 'running'` until its interrupted
  // tool result arrives. Its specialist run is the authoritative lifecycle,
  // so a terminal run must immediately settle this group's spinner.
  const groupRunning = (t: ToolCallState) => t.specialistRun ? stillWorking(t) : t.status === 'running';
  const runningCount = tools.filter(groupRunning).length;
  const failedCount = tools.filter((t) => t.status === 'failed').length;
  // WHY the group icon reflects only the latest call: an earlier failure is
  // already preserved in the group's detail text, while the top-level status
  // should describe the most recent result.
  const latestToolFailed = tools.at(-1)?.status === 'failed';
  const stoppedCount = tools.filter((t) => t.specialistRun?.status === 'interrupted').length;
  const askingCount = tools.filter(hasNestedAsk).length;
  // Plain-language "Created a file and ran a command" in place of the raw
  // "N tools (Bash, Write)" — Q1-Q5, 2026-09-06 tool-group-readability deck.
  const headline = buildToolGroupHeadline(tools);

  return (
    <div className="border border-edge rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-inset/50 transition-colors"
      >
        {askingCount > 0 ? (
          <QuestionIcon className="w-3.5 h-3.5 shrink-0 text-amber-500" />
        ) : runningCount > 0 ? (
          <BrailleSpinner size="sm" />
        ) : latestToolFailed ? (
          <FailIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
        ) : stoppedCount > 0 ? (
          <span data-testid="tool-group-stopped"><StoppedIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" /></span>
        ) : (
          <CheckIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
        )}
        <span className="text-fg-faint text-xs select-none">|</span>
        <span className="text-xs text-fg-dim flex-1">
          {headline}
          {/* Q5a folds an already-failed item into the headline itself while
              something else is still running ("+2 completed, 1 failed") — this
              suffix only fires once the group has fully settled (Q3a). */}
          {runningCount === 0 && failedCount > 0 && ` — ${failedCount} failed`}
          {runningCount === 0 && stoppedCount > 0 && ` — ${stoppedCount} stopped`}
          {askingCount > 0 && <span className="text-amber-500">{` — ${askingCount} waiting on you`}</span>}
        </span>
        <ChevronIcon className="w-3.5 h-3.5 shrink-0 text-fg-muted" expanded={expanded} />
      </button>
      {expanded && (
        // Fix: no bg — lets bubble color show through so header + body share
        // one seamless background. Each ToolCard carries its own bg-inset
        // to give tools a distinct "lifted" color vs the group wrapper.
        <div className="px-2 pb-1.5 space-y-0.5 rounded-b-lg">
          {tools.map((tool) => (
            <ToolCard key={tool.toolUseId} tool={tool} sessionId={sessionId} inGroup />
          ))}
        </div>
      )}
    </div>
  );
}

// Walks ONE bubble's tool groups and returns its SendUserFile/SendUserLink
// calls in invocation order. The card renders inside the bubble — last, after
// the tool cards — so the hoist is per bubble, unlike Skills (per turn).
// View-layer reorder only; reducer state untouched.
function collectBubbleSentFiles(
  bubble: VisualBubble,
  toolGroups: Map<string, ToolGroupState>,
  toolCalls: Map<string, ToolCallState>,
): ToolCallState[] {
  const out: ToolCallState[] = [];
  for (const groupId of bubble.toolGroupIds) {
    const group = toolGroups.get(groupId);
    if (!group) continue;
    for (const id of group.toolIds) {
      const t = toolCalls.get(id);
      if (isSentFilesTool(t) || isSentLinksTool(t)) out.push(t);
    }
  }
  return out;
}

/**
 * Splits a turn's segments into visual bubbles.
 *
 * THE RULE (Destin, 2026-09-02): a bubble is everything the assistant did up
 * to and including the moment it SPOKE, shown as exactly three things in a
 * fixed order — ONE reasoning section, ONE message, ONE tool group. Silent
 * steps (reasoning, tool calls, more reasoning) accumulate into the open
 * bubble until visible text (or a plan) lands: their thoughts merge into the
 * single reasoning section at the top, their tools into the single group at
 * the bottom. Tool groups that directly follow the text join that group too.
 * The NEXT reasoning or text after the assistant has spoken opens a new
 * bubble:  reasoning → text → [split] → reasoning again.
 *
 * Before this, every reasoning segment opened a bubble, so a run of silent
 * tool steps read as a column of "Show reasoning / one tool" bubbles, with
 * the turn's closing thought in a bubble of its own. Claude Code turns are
 * unchanged: they carry no reasoning content, and text still splits text.
 * Renderer-only: the transcript and the reducer's segments are untouched.
 */
// Exported for test: AssistantTurnBubble.test.tsx pins the BUG A mis-attribution
// fix directly against this pure function rather than through full component render.
export interface VisualBubble {
  key: string;
  /** Every reasoning segment of the bubble, joined by a blank line, keyed by
   *  the first one's messageId. */
  reasoning?: { content: string; messageId: string };
  text?: { content: string; messageId: string };
  plan?: { content: string; messageId: string; planFilePath?: string; allowedPrompts?: unknown };
  /** Every tool group in the bubble, in call order. Rendered as ONE group. */
  toolGroupIds: string[];
}

// Exported for test (see VisualBubble comment above).
// Perf (cycle 1, N3): typed as Pick<…, 'segments'> on purpose — this function
// reads NOTHING but the segments, and the component's useMemo below depends on
// exactly that (it keys on turn.segments, not turn). If this ever needs another
// field, the type will force the memo key to widen with it.
export function splitIntoBubbles(turn: Pick<AssistantTurn, 'segments'>): VisualBubble[] {
  const bubbles: VisualBubble[] = [];
  let current: VisualBubble | null = null;
  const spoken = () => !!(current && (current.text || current.plan));
  const open = (key: string): VisualBubble => {
    current = { key, toolGroupIds: [] };
    return current;
  };

  for (const seg of turn.segments) {
    if (seg.type === 'reasoning') {
      // Reasoning after the assistant has spoken → new bubble. Otherwise it
      // merges into the open bubble's single reasoning section.
      if (spoken()) { bubbles.push(current!); current = null; }
      const bubble = current ?? open(`reasoning-${seg.messageId}`);
      bubble.reasoning = bubble.reasoning
        ? { ...bubble.reasoning, content: `${bubble.reasoning.content}\n\n${seg.content}` }
        : { content: seg.content, messageId: seg.messageId };
    } else if (seg.type === 'text') {
      // A second stretch of speech is its own bubble (Claude Code's
      // text / tool / text shape keeps one bubble per text block).
      if (spoken()) { bubbles.push(current!); current = null; }
      const bubble = current ?? open(seg.messageId);
      bubble.text = { content: seg.content, messageId: seg.messageId };
    } else if (seg.type === 'plan') {
      // A plan counts as speech; the following ExitPlanMode group attaches below.
      if (spoken()) { bubbles.push(current!); current = null; }
      const bubble = current ?? open(seg.messageId);
      bubble.plan = { content: seg.content, messageId: seg.messageId, planFilePath: seg.planFilePath, allowedPrompts: seg.allowedPrompts };
    } else if (seg.type === 'tool-group') {
      // A tool never splits: it belongs to whatever the assistant was doing —
      // the silent step before it, or the sentence it just said.
      const bubble = current ?? open(`tools-${seg.groupId}`);
      bubble.toolGroupIds.push(seg.groupId);
    } else {
      // A segment type this bundle does not know about. The remote browser and
      // the Android WebView load a bundle that can be OLDER than the host that
      // sends them turns, so this is reachable in normal use, not a corruption.
      // Render nothing: the previous `else` treated anything unrecognised as a
      // tool group, which pushed `undefined` as a group id and drew an empty
      // card for a segment it could not read.
    }
  }
  if (current) bubbles.push(current);
  return bubbles;
}

/**
 * Would this bubble paint anything? A bubble earns its shell only if it will.
 * Three kinds of tool card are rendered SOMEWHERE ELSE and so do not count:
 * a Skill (floats to the last bubble's trailing row), a SendUserFile (the
 * deliverables card — counted by the caller via `sentFiles`), and a tool
 * awaiting approval (pinned at the bottom of the timeline). Mirrors the
 * filters in ToolGroupInline — keep the two in step.
 *
 * Fix (2026-09-02, bubble grouping): a bubble whose only tool was awaiting
 * approval, or whose only tool was the Skill that opens a "/skill" turn,
 * rendered as a bare empty shell above the real reply. Pinned by
 * tests/bubble-grouping-scenarios.test.tsx.
 */
function bubblePaintsSomething(
  bubble: VisualBubble,
  toolGroups: Map<string, ToolGroupState>,
  toolCalls: Map<string, ToolCallState>,
  sentFilesCount: number,
): boolean {
  if (bubble.plan || sentFilesCount > 0) return true;
  if (bubble.text && bubble.text.content.trim() !== '') return true;
  if (bubble.reasoning && bubble.reasoning.content.trim() !== '') return true;
  for (const groupId of bubble.toolGroupIds) {
    const group = toolGroups.get(groupId);
    if (!group) continue;
    for (const id of group.toolIds) {
      const t = toolCalls.get(id);
      // Name comparison, not isSentFilesTool(): that type predicate narrows
      // `t` to never on its false branch, which tsc rejects at the next line.
      // A link delivery counts like a file: a bubble whose ONLY content is a
      // link must still paint (it's a deliverable, not a no-op turn).
      if (!t || t.toolName === 'Skill' || t.toolName === SENT_FILES_TOOL || isSendUserLinkToolName(t.toolName)) continue;
      if (t.status !== 'awaiting-approval') return true;
    }
  }
  return false;
}

// Walks the turn's tool-group segments and returns every Skill ToolCallState
// in invocation order. Used by the bubble render to pull Skills OUT of their
// groups (where ToolGroupInline now filters them) and render them as a
// trailing row of standalone cards on the last bubble of the turn.
function collectTurnSkills(
  turn: Pick<AssistantTurn, 'segments'>,
  toolGroups: Map<string, ToolGroupState>,
  toolCalls: Map<string, ToolCallState>,
): ToolCallState[] {
  const skills: ToolCallState[] = [];
  for (const seg of turn.segments) {
    if (seg.type !== 'tool-group') continue;
    const group = toolGroups.get(seg.groupId);
    if (!group) continue;
    for (const id of group.toolIds) {
      const t = toolCalls.get(id);
      if (t && t.toolName === 'Skill') skills.push(t);
    }
  }
  return skills;
}

/**
 * Returns the IDs of every tool group this turn renders (its own `tool-group`
 * segments). A turn's rendered output depends ONLY on its own segments plus
 * the tool/group entries reachable from these IDs — not on the rest of the
 * session-lifetime `toolCalls`/`toolGroups` Maps. This set is the basis for
 * the memo comparator below.
 */
function turnGroupIds(turn: AssistantTurn): string[] {
  const ids: string[] = [];
  for (const seg of turn.segments) {
    if (seg.type === 'tool-group') ids.push(seg.groupId);
  }
  return ids;
}

/**
 * Custom equality for React.memo.
 *
 * WHY: `toolCalls` and `toolGroups` are session-lifetime Maps shared by EVERY
 * turn in the conversation. The reducer hands ChatView a fresh Map reference
 * whenever ANY tool updates, so React's default shallow compare (which treats
 * two Maps with identical contents as different) re-renders every assistant
 * turn on every streaming frame — even completed turns whose tools never
 * changed. Each of those re-renders re-runs splitIntoBubbles() and re-parses
 * the turn's markdown (react-markdown + highlight.js), which was the dominant
 * per-frame cost while Claude types.
 *
 * A turn's rendered output is a pure function of:
 *   - `turn` (its segments/metadata) — compared by reference; the reducer
 *     replaces the turn object only when that turn actually changes.
 *   - the tool/group entries REACHABLE from the turn's own tool-group segments.
 * So we compare those entries individually. If none of THIS turn's tools or
 * groups changed, a sibling turn's activity must not re-render this one.
 *
 * The primitives (sessionId/provider/showTimestamps) are compared by value.
 *
 * Returns true when the component can skip re-rendering.
 */
function assistantTurnPropsAreEqual(prev: Props, next: Props): boolean {
  if (prev.turn !== next.turn) return false;
  if (prev.sessionId !== next.sessionId) return false;
  if (prev.provider !== next.provider) return false;
  if (prev.showTimestamps !== next.showTimestamps) return false;

  // Same turn object (checked above) ⇒ same segments ⇒ same group IDs. We only
  // need to walk one side's IDs.
  const groupIds = turnGroupIds(next.turn);
  for (const gid of groupIds) {
    const prevGroup = prev.toolGroups.get(gid);
    const nextGroup = next.toolGroups.get(gid);
    if (prevGroup !== nextGroup) return false;
    if (!nextGroup) continue;
    for (const toolId of nextGroup.toolIds) {
      if (prev.toolCalls.get(toolId) !== next.toolCalls.get(toolId)) return false;
    }
  }
  return true;
}

export default React.memo(function AssistantTurnBubble({ turn, toolGroups, toolCalls, sessionId, provider, showTimestamps }: Props) {
  // Read opt-in metadata preference here so the strip below only renders when
  // the user has explicitly turned it on in PreferencesPopup (default false).
  const { showTurnMetadata } = useTheme();
  // splitIntoBubbles is pure over the turn's SEGMENTS, so cache it on those.
  // Perf (cycle 1, N3): this used to key on `turn`, but the reducer mints a new
  // turn object for every change to the turn — a streamed delta, but also a
  // model capture, a usage/stopReason stamp at turn-complete, a tool status
  // change routed through this turn — so while a turn was live the memo never
  // hit and every one of those re-split the turn from scratch. `segments` is
  // only replaced when a segment actually changes, so keying on it makes the
  // split happen exactly when its input does. Combined with the memo
  // comparator below, completed turns still never re-split (and never
  // re-parse their markdown) on a sibling's streaming frame. Pinned by
  // tests/assistant-turn-split-depends-on-segments.test.tsx.
  const segments = turn.segments;
  const bubbles = React.useMemo(() => splitIntoBubbles({ segments }), [segments]);
  // Skills are reordered to the end of the turn's last bubble (view-layer only).
  // ToolGroupInline filters Skills out of their groups; this list backs the
  // trailing standalone-card row below. Same segments-only key as above.
  const turnSkills = React.useMemo(
    () => collectTurnSkills({ segments }, toolGroups, toolCalls),
    [segments, toolGroups, toolCalls],
  );

  // Only bubbles that will paint something get a shell (see
  // bubblePaintsSomething). The trailing skill row, the footer and the
  // timestamp all live on the LAST shown bubble, so "last" is measured on
  // this list, not on the raw split. A turn whose only content is its Skill
  // card (a "/skill" turn before the reply streams) keeps its final shell so
  // that row has a home.
  const withFiles = bubbles.map((bubble) => ({
    bubble,
    sentFiles: collectBubbleSentFiles(bubble, toolGroups, toolCalls),
  }));
  let shown = withFiles.filter(({ bubble, sentFiles }) =>
    bubblePaintsSomething(bubble, toolGroups, toolCalls, sentFiles.length));
  if (shown.length === 0 && turnSkills.length > 0) shown = withFiles.slice(-1);

  // Empty-step recovery (spec 2026-08-21, decision 4): a fully-contentless
  // turn has ZERO bubbles, so the per-bubble stopReason footer below can never
  // fire — yet an abnormal stopReason on such a turn is exactly the signal
  // that must not be lost (an 'empty_response' turn with no bubbles IS the
  // bug's worst case). Render a footer-only row for it. Zero-bubble turns
  // with a normal/absent stopReason keep rendering nothing, byte-for-byte.
  // Deliberately NOT wrapped in the assistant-bubble shell: there is no
  // message here, and an empty bubble would imply one.
  if (shown.length === 0) {
    if (!abnormalStopReason(turn.stopReason)) return null;
    return (
      <div className="flex justify-start px-4 py-0.5">
        <div className="max-w-[85%]">
          {showTurnMetadata && <TurnMetadataStrip turn={turn} />}
          <StopReasonFooter reason={turn.stopReason!} provider={provider} />
          {/* Same trailer members as the bubble path below — the timestamp
              matters MOST here: "when did it go silent?" is the first question
              an empty_response row raises. */}
          {showTimestamps && turn.timestamp && (
            <div className="bubble-timestamp text-4xs text-fg-muted/60 text-right mt-1 -mb-0.5 select-none leading-none">
              {formatBubbleTime(turn.timestamp)}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      {shown.map(({ bubble, sentFiles }, i) => {
        const hasTools = bubble.toolGroupIds.length > 0;
        // A sent-files card counts as content: a bubble holding only that card
        // must get the prose padding, not the tight tools-only padding.
        const hasContent = !!(bubble.text || bubble.plan || sentFiles.length);
        const hasReasoning = !!bubble.reasoning;
        const toolsOnly = hasTools && !hasContent && !hasReasoning;
        const reasoningOnly = hasReasoning && !hasContent && !hasTools;
        const isLastBubble = i === shown.length - 1;
        return (
          <div key={bubble.key} className="flex justify-start px-4 py-0.5">
            <div className={`assistant-bubble max-w-[85%] break-words rounded-2xl rounded-bl-sm bg-inset text-sm text-fg px-5 ${toolsOnly ? 'py-2.5' : hasTools ? 'pt-4 pb-3' : reasoningOnly ? 'py-2.5' : 'py-3.5'}`}>
              {/* Fixed order, one of each (Destin, 2026-09-02): the reasoning
                  section, the message, the tool group. */}
              {bubble.reasoning && (
                <ReasoningSection content={bubble.reasoning.content} />
              )}
              {bubble.text && (
                // Pass sessionId so MarkdownContent can render inline FilepathToken chips
                // for detected file paths in this session's artifact set.
                // SessionRefsEnabled: this is the ONE place a `conversations`
                // fence becomes a reference block with live Preview/Resume rows.
                // Everywhere else MarkdownContent renders (a previewed past
                // conversation, an artifact) it stays plain text — ids from
                // another device would resolve to a block of dead rows.
                <SessionRefsEnabled.Provider value={true}>
                  <MarkdownContent content={bubble.text.content} sessionId={sessionId} />
                </SessionRefsEnabled.Provider>
              )}
              {bubble.plan && (
                <PlanBubbleContent
                  content={bubble.plan.content}
                  planFilePath={bubble.plan.planFilePath}
                  allowedPrompts={bubble.plan.allowedPrompts}
                />
              )}
              {hasTools && (
                <ToolGroupInline
                  groupIds={bubble.toolGroupIds}
                  toolGroups={toolGroups}
                  toolCalls={toolCalls}
                  sessionId={sessionId}
                  afterText={!!bubble.text}
                />
              )}
              {/* Sent-files card: LAST in the bubble, after the tool cards
                  (Destin 2026-08-25). Its calls were filtered out of the groups
                  above, so this is the only place they render. */}
              {sentFiles.length > 0 && (
                <DeliverablesCard tools={sentFiles} sessionId={sessionId} />
              )}
              {/* Trailing-Skills row: Skills are reordered to the end of the turn's
                  last bubble so they read as a status footer rather than co-mingled
                  with substantive tool output. ToolGroupInline filters Skills out
                  upstream so this is the only place they render. */}
              {isLastBubble && turnSkills.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {/* Two or more skills stack into ONE card ("Invoked 2 skills:
                      brainstorming and writing-plans") rather than a card per
                      invocation — Destin, 2026-09-02 (deck B-7). */}
                  {turnSkills.length === 1 ? (
                    <ToolCard key={turnSkills[0].toolUseId} tool={turnSkills[0]} sessionId={sessionId} />
                  ) : (
                    <StackedSkillsCard skills={turnSkills} />
                  )}
                </div>
              )}
              {/* Opt-in metadata strip. Renders once per turn (last bubble only) and
                  only when the user has enabled `showTurnMetadata`. Placed above the
                  stopReason footer so a truncated turn still shows both, in that order. */}
              {isLastBubble && showTurnMetadata && <TurnMetadataStrip turn={turn} />}
              {/* Render stopReason explainer only once per turn — on the last bubble.
                  Gate out `end_turn` (normal completion) — it reaches the reducer but
                  carries no abnormal signal worth surfacing to the user. */}
              {isLastBubble && abnormalStopReason(turn.stopReason) && <StopReasonFooter reason={turn.stopReason!} provider={provider} />}
              {showTimestamps && isLastBubble && turn.timestamp && (
                <div className="bubble-timestamp text-4xs text-fg-muted/60 text-right mt-1 -mb-0.5 select-none leading-none">
                  {formatBubbleTime(turn.timestamp)}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}, assistantTurnPropsAreEqual);

/**
 * Renders a plan-mode plan (from ExitPlanMode tool input) as a distinct section
 * inside an assistant bubble. Shows a "Plan" header, the markdown body, and
 * (collapsed by default) the list of allowedPrompts Claude intends to run.
 */
function PlanBubbleContent({
  content,
  planFilePath,
  allowedPrompts,
}: {
  content: string;
  planFilePath?: string;
  allowedPrompts?: unknown;
}) {
  const [showPrompts, setShowPrompts] = useState(() => getInitialExpanded());
  useExpandAllToggle(() => setShowPrompts(true), () => setShowPrompts(false));
  const prompts = Array.isArray(allowedPrompts) ? allowedPrompts : [];
  const fileName = planFilePath
    ? planFilePath.replace(/\\/g, '/').split('/').pop()
    : undefined;

  return (
    <div className="border border-accent/40 rounded-md bg-accent/5 px-3 py-2 my-0.5">
      <div className="flex items-center gap-2 mb-1 text-xs font-medium text-fg-2">
        <span>📋 Plan</span>
        {fileName && (
          <span className="text-fg-muted font-normal truncate">{fileName}</span>
        )}
      </div>
      <MarkdownContent content={content} />
      {prompts.length > 0 && (
        <div className="mt-2 pt-2 border-t border-edge-dim">
          <button
            onClick={() => setShowPrompts((v) => !v)}
            className="text-2xs text-fg-muted hover:text-fg-dim flex items-center gap-1"
          >
            <ChevronIcon className="w-3 h-3" expanded={showPrompts} />
            {prompts.length} allowed {prompts.length === 1 ? 'action' : 'actions'} if approved
          </button>
          {showPrompts && (
            <pre className="mt-1 text-2xs text-fg-dim bg-panel rounded-sm p-2 overflow-auto max-h-40">
              {JSON.stringify(prompts, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Renders a bubble's tool groups inline as ONE group, in call order: a
 *  bubble shows a single tool group (Destin, 2026-09-02), however many silent
 *  steps fed it. */
function ToolGroupInline({
  groupIds,
  toolGroups,
  toolCalls,
  sessionId,
  afterText = false,
}: {
  groupIds: string[];
  toolGroups: Map<string, ToolGroupState>;
  toolCalls: Map<string, ToolCallState>;
  sessionId: string;
  /** A group right after the spoken text gets a little more room above it. */
  afterText?: boolean;
}) {
  const toolIds = groupIds.flatMap((gid) => toolGroups.get(gid)?.toolIds ?? []);
  if (toolIds.length === 0) return null;

  const tools = toolIds
    .map((id) => toolCalls.get(id))
    // Skip undefined AND skip Skill tools — Skills render as a trailing
    // standalone row outside any group via AssistantTurnBubble (see
    // collectTurnSkills + the trailing-skills div on the last bubble).
    // View-layer reorder; reducer state untouched.
    // SendUserFile/SendUserLink are ALSO pulled out: they render as the
    // DeliverablesCard at the end of the bubble, after the tool cards
    // (collectBubbleSentFiles).
    .filter((t): t is ToolCallState => t !== undefined && t.toolName !== 'Skill' && !isSentFilesTool(t) && !isSentLinksTool(t));

  if (tools.length === 0) return null;

  // Skip awaiting-approval tools — they render as standalone bubbles at the bottom of the timeline.
  // (A Task card whose HELPER is asking stays put: those asks are managed from
  // the specialists popup — SpecialistsChip — not by moving the card. Destin, 1c round 1.)
  const restTools = tools.filter((t) => t.status !== 'awaiting-approval');
  if (restTools.length === 0) return null;

  return (
    <div className={`my-0.5 space-y-0.5 ${afterText ? 'mt-1.5' : ''}`}>
      {restTools.length === 1 ? (
        <ToolCard tool={restTools[0]} sessionId={sessionId} />
      ) : (
        <CollapsedToolGroup tools={restTools} sessionId={sessionId} />
      )}
    </div>
  );
}
