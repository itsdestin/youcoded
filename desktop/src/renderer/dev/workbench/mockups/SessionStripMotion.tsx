// src/renderer/dev/workbench/mockups/SessionStripMotion.tsx
//
// The REAL session strip, alone, wired to its own little session list — so
// its motion (a click opening the name, a hover peek, a drag, and the incoming
// conversation arriving below) can be FELT in a review pane instead of watched
// in a recording. Destin, 2026-08-31: "the videos are just rough to compare."
//
// Nothing here is redrawn. The strip is `SessionStrip` itself; the pane below
// it uses the same `useOneShotWindow` + `.switch-arrival` pair ChatView uses,
// keyed the same way (on the pane being the active session), so what arrives
// here is what arrives in the app. What IS new is only the arrangement.
// (The rounds in compare/registry.tsx once took `motion`, `select` and
// `arrival` props that swapped review scaffolds in globals.css; Destin picked
// Soft, Press and Spring on 2026-09-02 and those became the only behaviour, so
// the props and the scaffolds went — every old round now renders what shipped.)
//
// Dev-only, like the rest of dev/.
import React, { useMemo, useReducer, useState } from 'react';
import SessionStrip from '../../../components/SessionStrip';
import { ArtifactProvider } from '../../../state/ArtifactContext';
import { artifactReducer, initialArtifactState } from '../../../state/artifact-tracker';
import { useOneShotWindow } from '../../../hooks/use-one-shot-window';
import type { SessionStatusColor } from '../../../components/StatusDot';

interface DemoSession {
  id: string; name: string; cwd: string; permissionMode: string;
  provider?: string; harnessId?: string; model?: string; status: SessionStatusColor;
}

// Names of three different lengths, a mix of Claude Code and native sessions on
// several brands (so the All Sessions menu's "runtime · model" line shows every
// kind of mark), enough dots to drag across. Mirrors fixtures/sessions.ts's
// shape; a copy rather than an import because this list needs a status colour
// per row and is reordered by the drag, which the fixture's sessions must not be.
const SESSIONS: DemoSession[] = [
  { id: 'm-1', name: 'fix chat scroll stick', cwd: '/w/youcoded', permissionMode: 'normal', provider: 'claude', model: 'sonnet', status: 'green' },
  { id: 'm-2', name: 'theme contrast pass', cwd: '/w/themes', permissionMode: 'normal', provider: 'native', harnessId: 'coder', model: 'qwen/qwen3-coder', status: 'gray' },
  { id: 'm-3', name: 'gpt-5.6 debug session', cwd: '/w/marketplace', permissionMode: 'normal', provider: 'native', harnessId: 'coder', model: 'openai/gpt-5.6', status: 'blue' },
  { id: 'm-4', name: 'notes', cwd: '/w/notes', permissionMode: 'normal', provider: 'claude', model: 'haiku', status: 'gray' },
  { id: 'm-5', name: 'roadmap restructure', cwd: '/w/youcoded-dev', permissionMode: 'normal', provider: 'claude', model: 'opus[1m]', status: 'red' },
  { id: 'm-6', name: 'landing copy', cwd: '/w/youcoded', permissionMode: 'normal', provider: 'claude', model: 'fable', status: 'gray' },
  // Enough that the row overflows into dots even at the widest pane the deck
  // gives it (1400px): with only six, every name fit and there was nothing
  // left to hover or drag (seen 2026-09-01 the moment panes went full-width).
  { id: 'm-7', name: 'gemini flash test', cwd: '/w/youcoded', permissionMode: 'normal', provider: 'native', harnessId: 'coder', model: 'google/gemini-2.5-flash', status: 'gray' },
  { id: 'm-8', name: 'claude via openrouter', cwd: '/w/youcoded', permissionMode: 'normal', provider: 'native', harnessId: 'assistant', model: 'anthropic/claude-sonnet-5', status: 'amber' },
  { id: 'm-9', name: 'grok-3 reasoning test', cwd: '/w/marketplace', permissionMode: 'normal', provider: 'native', harnessId: 'coder', model: 'x-ai/grok-3', status: 'gray' },
  { id: 'm-10', name: 'perf cycle 4', cwd: '/w/youcoded', permissionMode: 'normal', provider: 'claude', model: 'sonnet', status: 'green' },
  { id: 'm-11', name: 'arcade leaderboards', cwd: '/w/youcoded', permissionMode: 'normal', provider: 'claude', status: 'gray' },
  // A local weight file: the label strips the quantisation and split suffixes.
  { id: 'm-12', name: 'deepseek r1 reasoning', cwd: '/w/marketplace', permissionMode: 'normal', provider: 'native', harnessId: 'assistant', model: 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf', status: 'blue' },
];

const LINES: Record<string, string[]> = {
  'm-1': ['The scroll container was re-arming auto-scroll on every prepend.', 'Anchored the prepend to an element instead — the position holds now.'],
  'm-2': ['Meadow Mist outlines dropped to 50% alpha behind the glass.', 'Raised them to 80%; the sky still shows through.'],
  'm-3': ['Reproduced the 402 rendering as [object Object].', 'The provider error now carries its own message through.'],
  'm-4': ['Three things to bring up Thursday.', 'Added the fourth from the call.'],
  'm-5': ['Per-area files, claim anchors, a roadmap-check tool.', 'Draft is at docs/active/specs — waiting on the taxonomy.'],
  'm-6': ['Cut "does real work" from the hero.', 'Leads with the concrete difference now, in nine words.'],
  'm-7': ['Flash returned the tool call as prose.', 'Switched the schema to strict; it calls the tool now.'],
  'm-8': ['The chip said Connected while every turn 401d.', 'The chip now asks OpenRouter before it says so.'],
  'm-9': ['Reasoning traces were landing in the reply.', 'They stay in the thinking block.'],
  'm-10': ['Baseline captured on the 12,100-message transcript.', 'Prepend is anchored; scroll cost is flat.'],
  'm-11': ['Head-to-head records read 4W - 2L now.', 'The ribbon is in the picker.'],
  'm-12': ['R1 stalls after the first tool result.', 'Reproduced; it is the stop sequence.'],
};

function reorder<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** One conversation pane. Mirrors ChatView's gate exactly: the window opens on
 *  the pane BECOMING active, and `&& active` keeps the leaving pane still. */
function Pane({ session, active }: { session: DemoSession; active: boolean }) {
  const arriving = useOneShotWindow(active) && active;
  if (!active) return null;
  return (
    <div className={`px-3 py-2 flex flex-col gap-2${arriving ? ' switch-arrival' : ''}`}>
      {LINES[session.id].map((line, i) => (
        <div
          key={i}
          className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-2xs leading-snug ${i % 2 === 0 ? 'self-end bg-accent/15 text-fg' : 'self-start bg-inset text-fg-2'}`}
        >
          {line}
        </div>
      ))}
    </div>
  );
}

export function SessionStripMotionDemo() {
  const [sessions, setSessions] = useState(SESSIONS);
  const [activeId, setActiveId] = useState(SESSIONS[0].id);
  // SessionStrip calls useArtifactDispatch() at its top level (the All Sessions menu's
  // "Manage projects…" dispatches into it). A real reducer, so the menu works.
  const [artifactState, artifactDispatch] = useReducer(artifactReducer, initialArtifactState);
  const artifact = useMemo(() => ({ state: artifactState, dispatch: artifactDispatch }), [artifactState]);
  const statuses = useMemo(() => new Map(sessions.map((s) => [s.id, s.status])), [sessions]);

  return (
    <div className="flex flex-col gap-2">
      {/* The header row: the strip's PARENT is what the packer reads its width
          budget from, so it sits in a flex-1 wrapper exactly as in HeaderBar. */}
      <div className="flex items-center gap-2 rounded-lg border border-edge bg-panel px-2 py-1">
        {/* Centred, as HeaderBar centres its cluster: the strip sits in the
            middle of the header, not against its left edge. */}
        <div className="flex-1 min-w-0 flex justify-center">
          <ArtifactProvider value={artifact}>
            <SessionStrip
              sessions={sessions}
              activeSessionId={activeId}
              sessionStatuses={statuses}
              onSelectSession={setActiveId}
              onReorderSessions={(from, to) => setSessions((list) => reorder(list, from, to))}
              onCloseSession={(id) => setSessions((list) => list.filter((s) => s.id !== id))}
              onCreateSession={() => undefined}
              onOpenResumeBrowser={() => undefined}
            />
          </ArtifactProvider>
        </div>
      </div>
      {/* The conversation below: one pane per session, only the active one
          rendered — the same "the outgoing one is not animated" rule ChatView
          has, because there is nothing left to animate. */}
      <div className="h-28 rounded-lg border border-edge-dim bg-canvas overflow-hidden">
        {sessions.map((s) => <Pane key={s.id} session={s} active={s.id === activeId} />)}
      </div>
      <p className="text-3xs text-fg-muted px-1">
        Click a dot to switch. Hover one to peek its name. Drag a pill along the row to reorder it.
      </p>
    </div>
  );
}
