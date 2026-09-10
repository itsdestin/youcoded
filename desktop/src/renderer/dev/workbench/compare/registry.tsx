// src/renderer/dev/workbench/compare/registry.tsx
//
// The authored candidate sets for the comparison view. THIS is the file Claude
// edits between rounds; CompareView.tsx is the harness and shouldn't need to
// change to add a comparison.
//
// ── The rule that keeps this honest ──────────────────────────────────────────
// Candidates are built from the REAL primitives and the REAL tokens — Button,
// Toggle, TagChip, fieldClasses, bg-inset, text-3xs. Never redraw a control by
// hand "close enough". The whole reason this lives in the app rather than in a
// static mockup is that the winner should paste into the production component
// and look identical, and that only holds if the pieces were already the
// production pieces.
//
// What IS new code here is the ARRANGEMENT under comparison, and only that.
// A candidate that reimplements a Toggle is a bug in the candidate.
//
// ── Adding a round ───────────────────────────────────────────────────────────
// Append a Round to the surface's `rounds` array with `basis` naming what it
// came from. The view picks up the new round on HMR and advances to it once the
// previous round has a recorded pick. Don't delete old rounds — the breadcrumb
// IS the record of how a design got where it did.
import React from 'react';
import {
  Button,
  Callout,
  Radio,
  RadioGroup,
  SegmentedTabs,
  SettingRow,
  Toggle,
  fieldClasses, CloseButton } from '../../../components/ui';
import { TagChip } from '../../../components/tags/TagChip';
import { TagPicker } from '../../../components/tags/TagPicker';
import { NoteEditor } from '../../../components/tags/NoteEditor';
import { useTagRegistry } from '../../../hooks/useTagRegistry';
// chatsearch-present Round 4: the same responsive/collapse-state hooks
// DeliverablesCard.tsx (branch feat/send-user-file-card, unmerged — see that
// round's header comment) drives its filmstrip and header with. Real hooks
// from THIS branch, not redrawn.
import { useNarrowViewport } from '../../../hooks/use-narrow-viewport';
import { useExpandAllToggle, getInitialExpanded } from '../../../hooks/useExpandAllToggle';
import { PRIORITY_TAG, PRIORITY_HINT } from '../../../components/tags/built-in-tags';
// Shared with the shipping surfaces — a candidate must draw the SAME mark the
// app does, or the comparison is against something that doesn't exist.
import { TagGlyph, NotePageGlyph, PencilGlyph } from '../../../components/tags/glyphs';
import { FilepathToken } from '../../../components/FilepathToken';
import { UnifiedDiff } from '../../../components/diff/UnifiedDiff';
import MarkdownContent from '../../../components/MarkdownContent';
import type { TagRecord } from '../../../../shared/tags';
// voice-mic: the REAL composer against a per-pane fake of window.claude.voice.
import InputBar from '../../../components/InputBar';
import { ChatProvider } from '../../../state/chat-context';
import { SkillProvider } from '../../../state/skill-context';
import { createVoiceMock } from '../mock-shim';
import { VoiceStyleContext, DEFAULT_VOICE_STYLE, type VoiceStyle } from '../../../components/VoiceButton';
// chatsearch-present Round 6: the real label→color resolver ChatsearchFindCard
// uses — reused (not re-derived) so a tag rendered here can never disagree
// with a tag rendered on the search-result row about what color it gets, and
// an unmatched label always falls back to the same neutral color rather than
// a candidate-invented one.
import { DEFAULT_TAG_COLOR } from '../../../../shared/tags';
import { useTagLabelIndex, resolveChatsearchTags, type ChipTag } from '../../../components/tool-views/chatsearch-tags';
import type { NativePermissionMode } from '../../../../shared/permission-types';
// The mode copy, reproduced verbatim from the shipping screen — the candidate
// these rounds called VariantC, which is now components/PermissionsSection.tsx.
// See permission-modes.ts's header for why it is a copy rather than an import.
import {
  ALWAYS_ASKS,
  MODES,
  MODE_ARIA,
  MODE_IDS,
  MODE_LOCATION_NOTE,
  SECTION_LABEL,
  type PermissionModeDef,
} from './permission-modes';
import type { CompareSurface } from './types';
// session-strip-motion / session-switch-arrival: the REAL SessionStrip in a
// demo host, so its motion is felt rather than watched. Every round has been
// picked (2026-09-02) and each candidate now renders what shipped; they once
// differed only in a data-motion / data-arrival attribute the host set — a
// review scaffold in globals.css, since deleted — never in code.
import { SessionStripMotionDemo } from '../mockups/SessionStripMotion';
// buddy-sleep: the REAL MascotRig on the app's own default rig, running the
// actual settle → breathe → wake. A sleep pose cannot be judged from a still —
// two thirds of it is motion.
import { BuddySleepDemo } from '../mockups/BuddySleep';
import { FriendlyMascots } from '../mockups/FriendlyMascots';
// The REAL derivation the shipping card will use — a candidate that hardcoded
// its options would be comparing wording against something that cannot happen.
import { bashGrantOptions } from '../../../../shared/bash-grant-shapes';
// The ask card's status glyph — same mark ToolCard's awaiting-approval header draws.
// ChatIcon is the app's real "this is a conversation" mark (SessionStrip tabs,
// ChatView header) — reused below so a search-result row can say "past
// conversation" with the same glyph the rest of the app uses for that idea.
// ChevronIcon (Round 2): the SAME disclosure mark ToolCard's own header,
// SpecialistReportCard, and ToolBody's AgentSection all use — an open/close
// control here must draw the mark the owner already reads as "expand/collapse"
// everywhere else, not a new one.
// AttachIcon (chatsearch-present Round 2): the app's real paperclip glyph —
// reused by the present-attachments candidate as its leading mark, so "this
// reads like an attached item" is drawn with the same paperclip the app
// already uses for attachments, not a new invented mark.
import { QuestionIcon, ChatIcon, ChevronIcon, AttachIcon } from '../../../components/Icons';
// present-inline-mentions (Round 7): the shared L4 .layer-surface shell — the
// same panel class every anchored popup in the app already draws from
// (AnchorTip, FileFilterPopover) — reused for the mention chip's popover so
// it isn't a fourth hand-rolled "floating box" style.
import { OverlayPanel } from '../../../components/overlays/Overlay';
// Chat search results round: the real copy contract, the resolved-conversation
// shape, and the seven-state fake index — same sources ChatsearchFindCard,
// ChatsearchShowCard, and the fixtures module itself use, so a candidate here
// can never say something the shipped card wouldn't.
import { COPY, providerLabel, type ResolvedConversation } from '../../../../shared/chatsearch-refs';
import { formatRelativeTime } from '../../../utils/format-time';
// Presented-conversation round (chatsearch-present): the real metadata-line
// component search rows already share, reused rather than re-laid-out so the
// "tags · project · date" composition can never drift between the two surfaces.
import { ChatsearchMetaLine } from '../../../components/tool-views/ChatsearchMetaLine';
import {
  CHATSEARCH_FIXTURE,
  CS_RESUMABLE,
  CS_MISSING_PROJECT,
  CS_NOT_SYNCED,
  CS_TOMBSTONE,
  CS_NATIVE,
} from '../fixtures/chatsearch';

// ── SFX — Session context panel ──────────────────────────────────────────────
// Step 3 (2026-08-17, broadened): the session-start "what did the assistant
// begin with" panel. Round 1 compares the two restyling directions Destin asked
// for — a card-led layout (A) vs a tabbed layout (B) — against the current
// shipped panel as basis. Both are built from the REAL primitives: cards, chips,
// SettingRow, FilepathToken outlinks, the SegmentedTabs control.

/** A complete context record — all surfaces present. The compare fixtures are
 *  complete by construction; the real panel guards absent sections. This is the
 *  widest shape the candidates render; structurally assignable to SessionContext. */
interface CompleteSessionContext {
  modelLabel: string;
  contextWindowTokens: number;
  summary: string;
  systemPrompt: string;
  projectInstructions: { path: string; text: string; fullText?: string | null; truncated: boolean; note?: string | null };
  skills: Array<{ id: string; label: string; path?: string | null; truncated?: boolean; fullText?: string | null; note?: string | null }>;
  tools: string[];
  droppedMcpServers: string[];
}

/** The trimmed native-session fixture, verbatim from the workbench native.jsonl. */
const SFX_CTX: CompleteSessionContext = {
  modelLabel: 'qwen2.5-coder:14b',
  contextWindowTokens: 16384,
  summary: 'Context was trimmed to fit qwen2.5-coder:14b’s window.',
  systemPrompt: 'You are YouCoded, a hyper-personalized AI assistant. You help the user build software, research, and manage life-admin tasks. Follow the project’s instructions and use the available tools when they help.',
  projectInstructions: {
    path: '/home/destin/youcoded-dev/wecoded-themes/CLAUDE.md',
    // What the model received — the outline. Headings kept, bodies cut.
    text: '# CLAUDE.md\n\n## Theme authoring\n- Tokens are named --bg-*, --fg-*, --border-*\n- Every theme ships a dark variant\n\n## Marketplace\n- Publish via /theme-builder\n\n## Building\n- npm run build\n\n…',
    // The full file on disk — the diff compares this to `text`.
    fullText: '# CLAUDE.md\n\n# Theme authoring\n\nWeCoded themes are defined by a semantic token system. Every color the\ninterface uses is a CSS custom property, not a raw hex value, so a theme\npack can restyle the whole app without touching a component.\n\nTokens are named --bg-*, --fg-*, --border-*. All --bg-* and --fg-* tokens\nmust form an accessible pair: contrast ratio 4.5:1 at normal text size,\n3:1 at large. Every theme ships a dark variant that re-derives the same\nset from a darker base.\n\nCustom CSS is supported but must never re-define a token — it layers\nON TOP of the semantic system, and only after the tokens have applied.\n\n# Marketplace\n\nPublish a theme via the /theme-builder skill. The registry validates the\nmanifest, checks token coverage, and renders the preview image.\n\n# Building\n\nThemes are plain CSS. Run `npm run build` to emit the distributable\npack and validate the manifest against the registry schema.\n\n# Testing\n\nEvery token must be present in at least one state of the app. The\ncontrast audit script in scripts/audit-theme-contrast.mjs walks every\nsurface and fails on a token pair below 3:1.\n\n# Releases\n\nVersion bumps happen through the marketplace-publisher skill. A release\nrequires a clean audit, a changelog entry, and a tagged commit.\n',
    truncated: true,
    note: '3 of 12 sections kept (headings only)',
  },
  skills: [
    {
      id: 'theme-builder',
      label: 'theme-builder',
      path: '/home/destin/youcoded-dev/wecoded-themes/skills/theme-builder/SKILL.md',
      truncated: true,
      note: 'body cut to fit the window',
      fullText: '# Theme Builder\n\nUse this skill to build, preview, and publish a WeCoded theme.\n\n## When to use it\n- The user wants a new theme or to restyle an existing one\n- The user asks to publish or update a theme on the registry\n\n## Steps\n1. Load the current token set from the active theme.\n2. Present the color palette as a before/after preview.\n3. On approval, write the theme pack and run the audit.\n4. Publish via /marketplace-publisher.\n\n## Rules\n- Never hand-write a hex value; always derive from a token.\n- Keep the dark variant in lockstep with the light one.\n',
    },
    { id: 'marketplace-publisher', label: 'marketplace-publisher', path: '/home/destin/youcoded-dev/wecoded-marketplace/skills/marketplace-publisher/SKILL.md' },
    { id: 'chatsearch', label: 'chatsearch', path: '/home/destin/youcoded-dev/youcoded/desktop/skills/chatsearch/SKILL.md' },
  ],
  tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'TodoWrite'],
  droppedMcpServers: ['docs-index'],
};

/** The cloud (untrimmed) fixture — the "everything loaded" state. */
const SFX_CTX_FULL: CompleteSessionContext = {
  modelLabel: 'claude-sonnet-4-6',
  contextWindowTokens: 200000,
  summary: 'Started with the full project context.',
  systemPrompt: 'You are YouCoded, a hyper-personalized AI assistant.',
  projectInstructions: {
    path: '/home/destin/youcoded-dev/youcoded/CLAUDE.md',
    text: '# CLAUDE.md\n\n## About This Project\nYouCoded is an open-source cross-platform AI assistant app.',
    truncated: false,
  },
  skills: [
    { id: 'theme-builder', label: 'theme-builder', path: '/x/SKILL.md' },
    { id: 'chatsearch', label: 'chatsearch', path: '/x/SKILL.md' },
  ],
  tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'TodoWrite', 'Task', 'WebFetch'],
  droppedMcpServers: [],
};

/** A "loaded" pill — the green-full state, matching StatusBar's live color. */
function StatusPill({ tone, children }: { tone: 'ok' | 'warn'; children: React.ReactNode }) {
  const c = tone === 'ok' ? '#4CAF50' : '#FF9800';
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-3xs font-medium border"
      style={{ color: c, backgroundColor: `color-mix(in srgb, ${c} 12%, transparent)`, borderColor: `color-mix(in srgb, ${c} 30%, transparent)` }}
    >
      {children}
    </span>
  );
}

/** A tool chip — the same recipe as TagChip but neutral (tools aren't tags). */
function ToolChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-1.5 py-[1px] rounded-sm text-3xs leading-none bg-inset/60 border border-edge-dim text-fg-2">
      {label}
    </span>
  );
}

/** The truncation diff toggle. When a surface was trimmed and the host carries
 *  the full original text, this renders a small segmented pair — "Supplied" /
 *  "Full vs supplied" — so the user can flip between the truncated copy the
 *  model actually received and the UnifiedDiff showing exactly what it missed
 *  (deleted rows = removed content). Falls back to the supplied text alone when
 *  no full text exists (the host could not provide it; the outlink remains).
 */
function TruncationDiff({ fullText, supplied, label }: {
  fullText?: string | null;
  supplied: string;
  label: string;
}) {
  const [showDiff, setShowDiff] = React.useState(false);
  const diffable = !!fullText && fullText !== supplied;

  if (!diffable) {
    return (
      <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-fg-2 bg-inset/50 rounded-lg p-3 border border-edge-dim">
        {supplied}
      </pre>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {/* The toggle itself — the app's segmented pair recipe, mini. */}
      <div className="flex items-center gap-1 self-start bg-inset/50 rounded-lg p-0.5">
        {(['supplied', 'diff'] as const).map((mode) => {
          const active = (mode === 'diff') === showDiff;
          return (
            <button
              key={mode}
              type="button"
              onClick={() => setShowDiff(mode === 'diff')}
              className={`px-2 py-0.5 rounded-md text-3xs font-medium transition-colors ${
                active ? 'bg-accent text-on-accent' : 'text-fg-2 hover:bg-inset'
              }`}
            >
              {mode === 'supplied' ? 'Supplied' : 'Full vs supplied'}
            </button>
          );
        })}
      </div>
      {showDiff ? (
        <UnifiedDiff oldStr={fullText} newStr={supplied} />
      ) : (
        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-fg-2 bg-inset/50 rounded-lg p-3 border border-edge-dim">
          {supplied}
        </pre>
      )}
      {showDiff && (
        <p className="text-3xs text-fg-muted leading-snug">
          Red lines are {label} content the model did not receive — trimmed to fit the window.
        </p>
      )}
    </div>
  );
}

/** The shared panel chrome — a real-dialog body, not the fixed Dialog. */
function SfxPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="px-4 pt-4 pb-3 border-b border-edge">
        <h2 className="text-sm font-bold text-fg">Session context</h2>
        <p className="text-2xs text-fg-muted mt-0.5">What the assistant began this session with</p>
      </div>
      <div className="px-4 py-4 space-y-4">{children}</div>
      <div className="mt-auto border-t border-edge px-4 pt-4 pb-4">
        <Button variant="secondary" size="md" className="w-full">Manage Assistant Settings</Button>
        <p className="text-2xs text-fg-muted mt-1.5 leading-snug">Coming soon — open the full assistant settings, model, and context management.</p>
      </div>
    </div>
  );
}

/** The one-line status summary at the top of the Overview tab — amber on trim,
 *  green when everything loaded. Rendered in its own inset card. */
function SfxStatusLine({ ctx, trimmed }: { ctx: CompleteSessionContext; trimmed: boolean }) {
  return (
    <p className="text-2xs leading-relaxed">
      <span className={`font-medium ${trimmed ? 'text-[#FF9800]' : 'text-[#4CAF50]'}`}>
        {trimmed ? '⚠ ' : '✓ '}
      </span>
      <span className="text-fg-2">
        {trimmed
          ? ctx.summary
          : `Started with the full project context — ${(ctx.skills ?? []).length} skills, ${(ctx.tools ?? []).length} tools, project instructions.`}
      </span>
    </p>
  );
}

const WORK_TAG = { label: 'work', color: 'tag-blue' } as const;
const NOTE = 'blocked on the gh dead-end';
// A realistic long note. Short fixture text made every overflow treatment look
// identical, which is exactly the failure mode the workbench's stress scenario
// exists to prevent — see the spec's fidelity contract.
const NOTE_LONG = 'blocked on the gh dead-end — the token refresh works locally but CI '
  + 'still 403s on the first push, so I parked it until we can test against a clean runner';

/** The check-in-a-circle used by the Resume Browser card and the close prompt.
 *  Duplicated here rather than imported because it is a private helper of
 *  CloseSessionPrompt — if a candidate wins and that changes, export it and
 *  delete this. */
function CompleteGlyph({ done, className = '' }: { done: boolean; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" fill={done ? 'currentColor' : 'none'} />
      <path d="M8 12.5l2.5 2.5L16 9.5" stroke={done ? 'var(--canvas)' : 'currentColor'} />
    </svg>
  );
}

// ── Close-session prompt: the collapsed summary row ──────────────────────────
// Round 1 seeds the view with a question that is genuinely open rather than a
// demo: the summary landed on 2026-07-31 and has not been reviewed. It is the
// first thing you see when closing a session, so it sets the tone for a dialog
// most people will use without reading.

function SummaryCard() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="group w-full text-left rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex items-start gap-3 transition-colors hover:border-edge hover:bg-well"
      >
        <span className="min-w-0 flex-1 flex flex-col gap-1.5">
          <span className="flex flex-wrap items-center gap-1">
            <TagChip tag={PRIORITY_TAG} />
            <TagChip tag={WORK_TAG} />
          </span>
          <span className="block text-2xs text-fg-2 truncate">{NOTE}</span>
        </span>
        <span className="text-3xs text-fg-muted group-hover:text-fg transition-colors shrink-0 mt-0.5">Edit</span>
      </button>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

function SummaryLabelled() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Tags &amp; note</label>
          <button type="button" className="text-3xs text-fg-muted hover:text-fg transition-colors">Edit</button>
        </div>
        {/* No card at all — the chips sit directly on the dialog, the way the
            Resume Browser card's own chip line does. One less box. */}
        <div className="flex flex-wrap items-center gap-1">
          <TagChip tag={PRIORITY_TAG} />
          <TagChip tag={WORK_TAG} />
        </div>
        <p className="text-2xs text-fg-2 truncate">{NOTE}</p>
      </div>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

function SummaryMerged() {
  const [done, setDone] = React.useState(false);
  // One box for both jobs: the filing summary and the complete decision live in
  // a single bordered group, so the dialog body is one object instead of two.
  return (
    <div className="rounded-lg border border-edge-dim bg-inset divide-y divide-edge-dim">
      <button type="button" className="group w-full text-left px-3 py-2.5 flex items-start gap-3 transition-colors hover:bg-well">
        <span className="min-w-0 flex-1 flex flex-col gap-1.5">
          <span className="flex flex-wrap items-center gap-1">
            <TagChip tag={PRIORITY_TAG} />
            <TagChip tag={WORK_TAG} />
          </span>
          <span className="block text-2xs text-fg-2 truncate">{NOTE}</span>
        </span>
        <span className="text-3xs text-fg-muted group-hover:text-fg transition-colors shrink-0 mt-0.5">Edit</span>
      </button>
      <div className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-well">
        <CompleteGlyph done={done} className={`w-5 h-5 shrink-0 transition-colors ${done ? 'text-accent' : 'text-fg-faint'}`} />
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-fg">Mark complete</span>
          <span className="block text-3xs text-fg-muted leading-snug">Hides it from the resume list unless you turn on Show Complete.</span>
        </span>
        <Toggle checked={done} onChange={setDone} aria-label="Mark complete" />
      </div>
    </div>
  );
}

/** The shipped Mark-complete row, shared by the candidates that keep it separate. */
function CompleteRow({ done, onChange }: { done: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-edge-dim bg-inset px-3 py-2.5 transition-colors hover:border-edge hover:bg-well">
      <CompleteGlyph done={done} className={`w-5 h-5 shrink-0 transition-colors ${done ? 'text-accent' : 'text-fg-faint'}`} />
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-fg">Mark complete</span>
        <span className="block text-3xs text-fg-muted leading-snug">Hides it from the resume list unless you turn on Show Complete.</span>
      </span>
      <Toggle checked={done} onChange={onChange} aria-label="Mark complete" />
    </div>
  );
}

// ── Round 2: the summary card's internals ────────────────────────────────────
// A won round 1, so the structure is settled: a summary card with the Mark
// complete row separate beneath it. What is still open is how the card ORGANISES
// what it holds — chips, note, and the way in.
//
// All three keep CompleteRow identical below them, so the only difference on
// screen is the thing being compared.

/** Icon-led. A tag glyph and a note glyph stand in for labels, matching the
 *  Resume Browser card's bottom line, which already uses a folder and a layers
 *  glyph the same way. Empty state: one muted "No tags or note" line, no icons. */
function CardIconRows() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="group w-full text-left rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex items-start gap-3 transition-colors hover:border-edge hover:bg-well"
      >
        <span className="min-w-0 flex-1 flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 min-w-0">
            <TagGlyph className="w-3 h-3 shrink-0 text-fg-muted" />
            <span className="flex flex-wrap items-center gap-1 min-w-0">
              <TagChip tag={PRIORITY_TAG} />
              <TagChip tag={WORK_TAG} />
            </span>
          </span>
          <span className="flex items-center gap-1.5 min-w-0">
            <NoteGlyph className="w-3 h-3 shrink-0 text-fg-muted" />
            <span className="block text-2xs text-fg-2 truncate">{NOTE}</span>
          </span>
        </span>
        <span className="text-3xs text-fg-muted group-hover:text-fg transition-colors shrink-0 mt-0.5">Edit</span>
      </button>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** Labelled sections inside the card — the same uppercase micro-labels the rest
 *  of the app's forms use. Most explicit and most scannable; also the tallest,
 *  and it repeats a vocabulary the chips already carry. Empty state: the labels
 *  stay, each with a muted "None". */
function CardLabelled() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="group w-full text-left rounded-lg border border-edge-dim bg-inset px-3 py-2.5 transition-colors hover:border-edge hover:bg-well"
      >
        <span className="flex items-start gap-3">
          <span className="min-w-0 flex-1 flex flex-col gap-2">
            <span className="block">
              <span className="block text-4xs font-medium text-fg-muted tracking-wider uppercase mb-1">Tags</span>
              <span className="flex flex-wrap items-center gap-1">
                <TagChip tag={PRIORITY_TAG} />
                <TagChip tag={WORK_TAG} />
              </span>
            </span>
            <span className="block">
              <span className="block text-4xs font-medium text-fg-muted tracking-wider uppercase mb-1">Note</span>
              <span className="block text-2xs text-fg-2 truncate">{NOTE}</span>
            </span>
          </span>
          <span className="text-3xs text-fg-muted group-hover:text-fg transition-colors shrink-0">Edit</span>
        </span>
      </button>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** Note-led. The note is the human sentence you actually wrote; the chips are
 *  filing. So the note takes the top line at full text colour and the chips sit
 *  under it as metadata, which is the inverse of the shipped emphasis. "Edit"
 *  moves to a footer link so the top line starts at the card edge. Empty state:
 *  the footer link becomes the whole affordance ("Add tags or a note"). */
function CardNoteLed() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="group w-full text-left rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex flex-col gap-2 transition-colors hover:border-edge hover:bg-well"
      >
        <span className="block text-xs text-fg leading-snug line-clamp-2">{NOTE}</span>
        <span className="flex items-center gap-1 flex-wrap">
          <TagChip tag={PRIORITY_TAG} />
          <TagChip tag={WORK_TAG} />
          <span className="ml-auto text-3xs text-fg-muted group-hover:text-fg transition-colors">Edit</span>
        </span>
      </button>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

// ── Round 3: within the icon-led card ────────────────────────────────────────
// Icon-led won round 2, so glyphs-instead-of-labels is settled. What is still
// open is density and alignment: how much vertical space the card takes, where
// the text hangs, and how the way in is drawn.

/** One line. Chips and note share a single truncating row, which makes the card
 *  the same height as the Mark complete row below it — two equal bands instead
 *  of a tall block over a short one. Costs the note its space: anything past a
 *  few words is an ellipsis. Empty: the row reads "No tags or note". */
function CardOneLine() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="group w-full text-left rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex items-center gap-2 transition-colors hover:border-edge hover:bg-well"
      >
        <TagGlyph className="w-3 h-3 shrink-0 text-fg-muted" />
        <span className="flex items-center gap-1 shrink-0">
          <TagChip tag={PRIORITY_TAG} />
          <TagChip tag={WORK_TAG} />
        </span>
        <NoteGlyph className="w-3 h-3 shrink-0 text-fg-muted ml-1" />
        <span className="text-2xs text-fg-2 truncate min-w-0 flex-1">{NOTE}</span>
        <span className="text-3xs text-fg-muted group-hover:text-fg transition-colors shrink-0">Edit</span>
      </button>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** Gutter-aligned. The glyphs sit in a fixed left column so the chips and the
 *  note text start on the SAME left edge — in the round-2 version each row set
 *  its own indent, so they were a pixel or two apart. Edit becomes a pencil in
 *  the corner: the whole card is already the target, so the word was doing
 *  nothing the hover state doesn't. Empty: one gutter row, muted. */
function CardGutter() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="group relative w-full text-left rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex flex-col gap-1.5 transition-colors hover:border-edge hover:bg-well"
      >
        <span className="grid grid-cols-[16px_1fr] items-center gap-x-1.5 gap-y-1.5 pr-6">
          <TagGlyph className="w-3 h-3 text-fg-muted" />
          <span className="flex flex-wrap items-center gap-1 min-w-0">
            <TagChip tag={PRIORITY_TAG} />
            <TagChip tag={WORK_TAG} />
          </span>
          <NoteGlyph className="w-3 h-3 text-fg-muted" />
          <span className="text-2xs text-fg-2 truncate min-w-0">{NOTE}</span>
        </span>
        <span className="absolute top-2.5 right-3 text-fg-faint group-hover:text-fg transition-colors">
          <PencilGlyph className="w-3.5 h-3.5" />
        </span>
      </button>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** Note as a quotation. Same two rows, but the note gets a left rule and sits
 *  in the muted text colour, so "these are labels I applied" and "this is a
 *  sentence I wrote" separate at a glance rather than on inspection. Tallest of
 *  the three. Empty: the rule disappears with the note. */
function CardQuote() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="group w-full text-left rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex items-start gap-3 transition-colors hover:border-edge hover:bg-well"
      >
        <span className="min-w-0 flex-1 flex flex-col gap-2">
          <span className="flex items-center gap-1.5 min-w-0">
            <TagGlyph className="w-3 h-3 shrink-0 text-fg-muted" />
            <span className="flex flex-wrap items-center gap-1 min-w-0">
              <TagChip tag={PRIORITY_TAG} />
              <TagChip tag={WORK_TAG} />
            </span>
          </span>
          <span className="block border-l-2 border-edge pl-2 text-2xs text-fg-muted leading-snug line-clamp-2">
            {NOTE}
          </span>
        </span>
        <span className="text-3xs text-fg-muted group-hover:text-fg transition-colors shrink-0 mt-0.5">Edit</span>
      </button>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

// ── Round 4: the note's glyph and its text treatment ─────────────────────────
// B (gutter + pencil) won round 3, so the layout is settled: glyphs in a fixed
// left column, chips and note sharing one left edge, a pencil in the corner.
//
// TWO CHANGES, ONE COMPARED. The note glyph moves from the notebook-with-a-
// pencil to a lined PAGE (NotePageGlyph below) in all three candidates — that
// was a direct instruction, not a question, and the old glyph read as "edit a
// note" when this row only DISPLAYS one. The pencil in the corner is the edit
// affordance; two pencils in one card was the confusion.
//
// What IS being compared is the note TEXT: box it, quote it, or just let it be
// the biggest thing in the card. The icon stays identical across all three on
// purpose — varying two things at once means the pick can't tell you which one
// you preferred.

/** Boxed. The note sits in its own `bg-well` container, one step deeper than
 *  the card, so it reads as CONTENT held by the card rather than another line
 *  of metadata. Most structure, most pixels. Empty: the box goes with it. */
function CardNoteBoxed() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <GutterCard>
        <span className="grid grid-cols-[16px_1fr] items-center gap-x-1.5 gap-y-1.5 pr-6">
          <TagGlyph className="w-3 h-3 text-fg-muted" />
          <span className="flex flex-wrap items-center gap-1 min-w-0">
            <TagChip tag={PRIORITY_TAG} />
            <TagChip tag={WORK_TAG} />
          </span>
          <NotePageGlyph className="w-3 h-3 text-fg-muted self-start mt-1" />
          <span className="rounded-md bg-well px-2 py-1 text-2xs text-fg-2 leading-snug line-clamp-2 min-w-0">
            {NOTE}
          </span>
        </span>
      </GutterCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** Quoted. Italic, muted, in typographic quotes — no box at all. Says "these
 *  are your words" through typography instead of a container, which keeps the
 *  card as light as round 3's. Empty: nothing left behind. */
function CardNoteQuoted() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <GutterCard>
        <span className="grid grid-cols-[16px_1fr] items-center gap-x-1.5 gap-y-1.5 pr-6">
          <TagGlyph className="w-3 h-3 text-fg-muted" />
          <span className="flex flex-wrap items-center gap-1 min-w-0">
            <TagChip tag={PRIORITY_TAG} />
            <TagChip tag={WORK_TAG} />
          </span>
          <NotePageGlyph className="w-3 h-3 text-fg-muted" />
          <span className="text-2xs text-fg-muted italic truncate min-w-0">“{NOTE}”</span>
        </span>
      </GutterCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** Undecorated, but promoted. No box and no quotes — instead the note is simply
 *  the most prominent thing in the card: full text colour at the chip row's
 *  size, with the page glyph doing all the labelling. Lightest, and it bets
 *  that the glyph is enough context. Empty: the row disappears. */
function CardNotePlain() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <GutterCard>
        <span className="grid grid-cols-[16px_1fr] items-center gap-x-1.5 gap-y-1.5 pr-6">
          <TagGlyph className="w-3 h-3 text-fg-muted" />
          <span className="flex flex-wrap items-center gap-1 min-w-0">
            <TagChip tag={PRIORITY_TAG} />
            <TagChip tag={WORK_TAG} />
          </span>
          <NotePageGlyph className="w-3 h-3 text-fg-muted" />
          <span className="text-xs text-fg truncate min-w-0">{NOTE}</span>
        </span>
      </GutterCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

// ── Round 5: within the quoted note ──────────────────────────────────────────
// B (italic in quotes) won round 4, so the direction is settled: typography
// rather than a container. What is still open is the one thing a short fixture
// note could never show — what happens when the note is actually long, which is
// most real notes. All three use NOTE_LONG for exactly that reason.
//
// The axis is overflow, and it is a genuine trade: a fixed height keeps the
// dialog's primary button where the user expects it, an unbounded one respects
// what they wrote. Italic is varied alongside it because at text-2xs italic
// costs real legibility, and that only shows up over two full lines.

/** Round 4's winner, unchanged, on a long note. One line, ellipsis. The card
 *  never changes height no matter what was written — and you can read about
 *  four words of it. */
function CardQuoteOneLine() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <GutterCard>
        <NoteGutter>
          <span className="text-2xs text-fg-muted italic truncate min-w-0">“{NOTE_LONG}”</span>
        </NoteGutter>
      </GutterCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** Two lines, then ellipsis. Roughly a full sentence gets through, and the card
 *  still has a ceiling — it can grow by one line and no further. Italic kept. */
function CardQuoteTwoLines() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <GutterCard>
        <NoteGutter align="start">
          <span className="text-2xs text-fg-muted italic leading-snug line-clamp-2 min-w-0">“{NOTE_LONG}”</span>
        </NoteGutter>
      </GutterCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** Unclamped, and NOT italic. The note wraps to whatever it needs, so nothing
 *  the user wrote is hidden — at the cost of an unbounded card that pushes
 *  "Close session" down the dialog. Roman rather than italic because two or
 *  three full lines of italic at this size is where it stops being comfortable;
 *  the quotes carry the signal on their own. */
function CardQuoteFull() {
  const [done, setDone] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <GutterCard>
        <NoteGutter align="start">
          <span className="text-2xs text-fg-muted leading-snug min-w-0">“{NOTE_LONG}”</span>
        </NoteGutter>
      </GutterCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** The settled gutter grid — tag row above, note row below, page glyph in the
 *  fixed column. `align` lifts the glyph to the first text line when the note
 *  wraps, instead of centring it against a two-line block. */
function NoteGutter({ children, align = 'center' }: {
  children: React.ReactNode; align?: 'center' | 'start';
}) {
  return (
    <span className={`grid grid-cols-[16px_1fr] gap-x-1.5 gap-y-1.5 pr-6 ${align === 'start' ? 'items-start' : 'items-center'}`}>
      <TagGlyph className={`w-3 h-3 text-fg-muted ${align === 'start' ? 'mt-0.5' : ''}`} />
      <span className="flex flex-wrap items-center gap-1 min-w-0">
        <TagChip tag={PRIORITY_TAG} />
        <TagChip tag={WORK_TAG} />
      </span>
      <NotePageGlyph className={`w-3 h-3 text-fg-muted ${align === 'start' ? 'mt-0.5' : ''}`} />
      {children}
    </span>
  );
}

/** The round-3 winner's shell, shared so round 4 can vary only what is inside
 *  it — card, hover, and the corner pencil are identical across all three. */
function GutterCard({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative w-full text-left rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex flex-col gap-1.5 transition-colors hover:border-edge hover:bg-well"
    >
      {children}
      <span className="absolute top-2.5 right-3 text-fg-faint group-hover:text-fg transition-colors">
        <PencilGlyph className="w-3.5 h-3.5" />
      </span>
    </button>
  );
}

// ── Round 6: the edit flow ───────────────────────────────────────────────────
// The card is settled through round 5. What is being refined now is what
// happens when you act on it — how you get into editing, whether you can still
// see what is applied while you do, and how you get out.
//
// These candidates run the REAL TagPicker and NoteEditor against the mock
// backend, not stand-ins: an edit flow can only be judged by using it, and a
// fake picker would hide exactly the friction being compared.

/** Shared editing state, so all three candidates start from the same content
 *  and the only difference on screen is the flow. */
function useDraft() {
  const registry = useTagRegistry();
  const [tagIds, setTagIds] = React.useState<Set<string>>(new Set(['tag_work']));
  const [priority, setPriority] = React.useState(true);
  const [note, setNote] = React.useState(NOTE_LONG);
  const toggleTag = (id: string, next: boolean) => setTagIds((prev) => {
    const s = new Set(prev); if (next) s.add(id); else s.delete(id); return s;
  });
  // Typed narrowing rather than `filter(Boolean)` — the latter leaves
  // TagRecord|undefined and every consumer then needs a guard.
  const chips = [...tagIds]
    .map((id) => registry.byId.get(id))
    .filter((t): t is TagRecord => !!t);
  return { registry, tagIds, toggleTag, priority, setPriority, note, setNote, chips };
}

/** The settled summary body — round 5's B. Shared by the flows that show it. */
function SummaryBody({ chips, priority, note }: {
  chips: TagRecord[]; priority: boolean; note: string;
}) {
  return (
    <span className="grid grid-cols-[16px_1fr] items-start gap-x-1.5 gap-y-1.5 pr-6">
      <TagGlyph className="w-3 h-3 text-fg-muted mt-0.5" />
      <span className="flex flex-wrap items-center gap-1 min-w-0">
        {priority && <TagChip tag={PRIORITY_TAG} />}
        {chips.map((t) => <TagChip key={t.id} tag={t} />)}
        {!priority && chips.length === 0 && <span className="text-2xs text-fg-muted">No tags</span>}
      </span>
      <NotePageGlyph className="w-3 h-3 text-fg-muted mt-0.5" />
      {note.trim()
        ? <span className="text-2xs text-fg-muted italic leading-snug line-clamp-2 min-w-0">“{note.trim()}”</span>
        : <span className="text-2xs text-fg-muted min-w-0">No note</span>}
    </span>
  );
}

/** The editor body, identical in every flow that has one. */
function EditorBody({ d }: { d: ReturnType<typeof useDraft> }) {
  return (
    <div className="flex flex-col gap-1.5">
      <TagPicker
        appliedIds={d.tagIds}
        onToggle={d.toggleTag}
        registry={d.registry}
        onManageTags={() => {}}
        builtIns={[{ tag: PRIORITY_TAG, hint: PRIORITY_HINT, applied: d.priority, onToggle: d.setPriority }]}
      />
      <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mt-1">Note</label>
      <NoteEditor value={d.note} onSave={d.setNote} />
    </div>
  );
}

/** REPLACE — what ships today. The card swaps to the editor; a "Done" text link
 *  swaps it back. Least chrome, but while editing you cannot see the summary
 *  you were changing, and "Done" is a small target for the only way out. */
function FlowReplace() {
  const d = useDraft();
  const [done, setDone] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      {editing ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Tags</label>
            <button type="button" onClick={() => setEditing(false)}
              className="text-3xs text-fg-muted hover:text-fg transition-colors">Done</button>
          </div>
          <EditorBody d={d} />
        </div>
      ) : (
        <GutterCard onClick={() => setEditing(true)}>
          <SummaryBody chips={d.chips} priority={d.priority} note={d.note} />
        </GutterCard>
      )}
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** EXPAND — the summary stays put as a header and the editor opens beneath it
 *  inside the same card, so you can see what you are changing while you change
 *  it. The pencil becomes a chevron. Costs height: summary and editor are on
 *  screen together. */
function FlowExpand() {
  const d = useDraft();
  const [done, setDone] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-edge-dim bg-inset overflow-hidden">
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          aria-expanded={editing}
          className="group relative w-full text-left px-3 py-2.5 transition-colors hover:bg-well"
        >
          <SummaryBody chips={d.chips} priority={d.priority} note={d.note} />
          <span className="absolute top-2.5 right-3 text-fg-faint group-hover:text-fg transition-colors">
            <ChevronGlyph className={`w-3.5 h-3.5 transition-transform ${editing ? 'rotate-180' : ''}`} />
          </span>
        </button>
        {editing && (
          <div className="border-t border-edge-dim px-3 py-2.5">
            <EditorBody d={d} />
          </div>
        )}
      </div>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** NO MODE — nothing to enter or leave. Applied chips carry an × , a dashed
 *  "+ tag" chip drops the picker in below, and the note row becomes a field
 *  when clicked. Fewest clicks to a small change; the card is busier at rest,
 *  and there is no single "I'm done" moment. */
function FlowInline() {
  const d = useDraft();
  const [done, setDone] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const [notingNote, setNotingNote] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex flex-col gap-2">
        <div className="grid grid-cols-[16px_1fr] items-start gap-x-1.5 gap-y-2">
          <TagGlyph className="w-3 h-3 text-fg-muted mt-0.5" />
          <div className="flex flex-wrap items-center gap-1 min-w-0">
            {d.priority && <TagChip tag={PRIORITY_TAG} onRemove={() => d.setPriority(false)} />}
            {d.chips.map((t) => <TagChip key={t.id} tag={t} onRemove={() => d.toggleTag(t.id, false)} />)}
            <button type="button" onClick={() => setPicking((v) => !v)}
              className="px-1.5 py-[1px] rounded-sm text-3xs leading-none border border-dashed border-edge text-fg-muted hover:text-fg transition-colors">
              + tag
            </button>
          </div>
          <NotePageGlyph className="w-3 h-3 text-fg-muted mt-0.5" />
          {notingNote ? (
            <NoteEditor value={d.note} onSave={(t) => { d.setNote(t); setNotingNote(false); }} />
          ) : (
            <button type="button" onClick={() => setNotingNote(true)}
              className="text-left text-2xs text-fg-muted italic leading-snug line-clamp-2 min-w-0 hover:text-fg-2 transition-colors">
              {d.note.trim() ? `“${d.note.trim()}”` : 'Add a note…'}
            </button>
          )}
        </div>
        {picking && (
          <div className="border-t border-edge-dim pt-2">
            <TagPicker
              appliedIds={d.tagIds}
              onToggle={d.toggleTag}
              registry={d.registry}
              onManageTags={() => {}}
              builtIns={[{ tag: PRIORITY_TAG, hint: PRIORITY_HINT, applied: d.priority, onToggle: d.setPriority }]}
            />
          </div>
        )}
      </div>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

// ── Round 7: keeping the card while editing ──────────────────────────────────
// A (replace in place) won round 6, but it dropped the card on the way in — the
// editor became a bare labelled section on the dialog, so the body visibly
// changed shape when you clicked. All three candidates here fix that: the
// bordered container stays put and only its CONTENTS swap, which is B's
// containment with A's one-thing-at-a-time.
//
// That leaves one real question. With the editor open the pencil is gone (you
// are already editing), so the way OUT needs its own affordance, and it is the
// only control in the card that is not part of the editor.

/** The card that holds either state, so the border, fill and padding are
 *  literally the same element before and after the swap — nothing shifts. */
function EditCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-edge-dim bg-inset px-3 py-2.5">{children}</div>
  );
}

/** Summary content, as a click target filling the card. */
function EditCardSummary({ d, onEdit }: { d: ReturnType<typeof useDraft>; onEdit: () => void }) {
  return (
    <button type="button" onClick={onEdit} className="group relative w-full text-left">
      <SummaryBody chips={d.chips} priority={d.priority} note={d.note} />
      <span className="absolute top-0 right-0 text-fg-faint group-hover:text-fg transition-colors">
        <PencilGlyph className="w-3.5 h-3.5" />
      </span>
    </button>
  );
}

/** Done as a text link where the pencil was — the exit sits exactly where the
 *  way in was, so the corner is consistently "the control for this card".
 *  Quietest, and the smallest target. */
function FlowCardLink() {
  const d = useDraft();
  const [done, setDone] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <EditCard>
        {editing ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Tags</label>
              <button type="button" onClick={() => setEditing(false)}
                className="text-3xs text-fg-muted hover:text-fg transition-colors">Done</button>
            </div>
            <EditorBody d={d} />
          </div>
        ) : <EditCardSummary d={d} onEdit={() => setEditing(true)} />}
      </EditCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** A checkmark in the corner, replacing the pencil in place. The card's corner
 *  always holds its one control and the glyph says which mode you are in —
 *  pencil to edit, check to finish. No words, same target size as the pencil. */
function FlowCardCheck() {
  const d = useDraft();
  const [done, setDone] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <EditCard>
        {editing ? (
          <div className="relative flex flex-col gap-1.5">
            <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase pr-6">Tags</label>
            <button type="button" onClick={() => setEditing(false)} aria-label="Done editing"
              className="absolute top-0 right-0 text-fg-muted hover:text-fg transition-colors">
              <CheckGlyph className="w-3.5 h-3.5" />
            </button>
            <EditorBody d={d} />
          </div>
        ) : <EditCardSummary d={d} onEdit={() => setEditing(true)} />}
      </EditCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

/** A full-width Done button closing the card. Unmissable and impossible to
 *  fumble, and it reads as "commit this section" — which is a small lie, since
 *  nothing is committed until the dialog's own button. Tallest by a row. */
function FlowCardButton() {
  const d = useDraft();
  const [done, setDone] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <EditCard>
        {editing ? (
          <div className="flex flex-col gap-2">
            <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Tags</label>
            <EditorBody d={d} />
            <Button variant="secondary" size="sm" className="w-full" onClick={() => setEditing(false)}>Done</Button>
          </div>
        ) : <EditCardSummary d={d} onEdit={() => setEditing(true)} />}
      </EditCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

// ── Round 8: tightening the editor ───────────────────────────────────────────
// C (full-width button) won round 7, with the label changed from "Done" to
// "Save" on a darker pill. All three candidates below carry that same button,
// so it is settled, not compared:
//
//   `secondary` is the outline — too quiet for the one action closing a
//   section. `primary` is the accent, which would compete with the dialog's own
//   "Close session". So SaveButton is a filled NEUTRAL pill: bg-well with a
//   border, rounded-full. Darker than the card it sits in, quieter than accent.
//
// What is compared is the editor above it, which measured 9 stacked bands in
// round 7: label, search, four tag rows, a manage link, a second label, and a
// three-row textarea. Each candidate cuts that a different way.

/** The settled Save control. Pill, filled, neutral — deliberately not accent,
 *  which belongs to the dialog's own confirm. */
function SaveButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-full bg-well border border-edge-dim px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-edge hover:border-edge focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      Save
    </button>
  );
}

/** MERGED HEADERS. The two section labels stop owning their own lines: "Tags"
 *  shares its row with "Manage tags…", and the note loses its label entirely —
 *  its placeholder already says what it is. Rows tighten and the note drops to
 *  two lines. Same structure, three bands less. */
function EditTightHeaders({ d, onSave }: { d: ReturnType<typeof useDraft>; onSave: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Tags</label>
        <button type="button" className="text-3xs text-fg-muted hover:text-fg transition-colors">Manage tags…</button>
      </div>
      <TagPicker
        appliedIds={d.tagIds}
        onToggle={d.toggleTag}
        registry={d.registry}
        builtIns={[{ tag: PRIORITY_TAG, hint: PRIORITY_HINT, applied: d.priority, onToggle: d.setPriority }]}
      />
      <NoteEditor value={d.note} onSave={d.setNote} placeholder="Add a note…" />
      <SaveButton onClick={onSave} />
    </div>
  );
}

/** APPLIED FIRST. What is already on the conversation sits as removable chips
 *  directly under the search, and the list beneath offers only what is NOT
 *  applied. With three tags on, the list you scan is three rows shorter — and
 *  "what does this have" stops being a hunt through checkboxes. */
function EditAppliedFirst({ d, onSave }: { d: ReturnType<typeof useDraft>; onSave: () => void }) {
  const unapplied = d.registry.tags.filter((t) => !t.archived && !d.tagIds.has(t.id));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {d.priority && <TagChip tag={PRIORITY_TAG} onRemove={() => d.setPriority(false)} />}
        {d.chips.map((t) => <TagChip key={t.id} tag={t} onRemove={() => d.toggleTag(t.id, false)} />)}
        {!d.priority && d.chips.length === 0 && <span className="text-3xs text-fg-muted">No tags yet</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t border-edge-dim pt-2">
        {!d.priority && (
          <button type="button" onClick={() => d.setPriority(true)}
            className="opacity-60 hover:opacity-100 transition-opacity">
            <TagChip tag={PRIORITY_TAG} />
          </button>
        )}
        {unapplied.map((t) => (
          <button key={t.id} type="button" onClick={() => d.toggleTag(t.id, true)}
            className="opacity-60 hover:opacity-100 transition-opacity">
            <TagChip tag={t} />
          </button>
        ))}
        <button type="button" className="px-1.5 py-[1px] rounded-sm text-3xs leading-none border border-dashed border-edge text-fg-muted hover:text-fg transition-colors">
          + new
        </button>
      </div>
      <NoteEditor value={d.note} onSave={d.setNote} placeholder="Add a note…" />
      <SaveButton onClick={onSave} />
    </div>
  );
}

/** ONE WELL. Tags and note share a single inset container split by a divider,
 *  so the editor reads as one object rather than two stacked sections. No
 *  labels at all — a tag row and a text field do not need naming. The most
 *  compact, and the furthest from the app's existing form language. */
function EditOneWell({ d, onSave }: { d: ReturnType<typeof useDraft>; onSave: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-md bg-well border border-edge-dim divide-y divide-edge-dim">
        <div className="p-2">
          <TagPicker
            appliedIds={d.tagIds}
            onToggle={d.toggleTag}
            registry={d.registry}
            builtIns={[{ tag: PRIORITY_TAG, hint: PRIORITY_HINT, applied: d.priority, onToggle: d.setPriority }]}
          />
        </div>
        <div className="p-2">
          <NoteEditor value={d.note} onSave={d.setNote} placeholder="Add a note…" />
        </div>
      </div>
      <SaveButton onClick={onSave} />
    </div>
  );
}

// ── Round 9: mechanics of the applied/available split ────────────────────────
// B (applied first, rest as chips) won round 8 on concept: what is ON sits
// apart from what is available, and both are chips rather than checkbox rows.
// Round 9 keeps that and varies the MECHANIC — how a tag gets added, removed,
// and where the available set lives when you are not using it.
//
// The note field and the Save pill are identical in all three.

/** TOKEN FIELD. Applied tags live INSIDE the search input, the way an email
 *  To: field works: type to filter, Enter adds the top match or creates,
 *  Backspace on an empty field removes the last chip, × removes any. One
 *  control instead of two rows — and the search that round 8's B gave up comes
 *  back for free, because it is the same box. */
function EditTokenField({ d, onSave }: { d: ReturnType<typeof useDraft>; onSave: () => void }) {
  const [q, setQ] = React.useState('');
  const matches = d.registry.tags.filter((t) => !t.archived && !d.tagIds.has(t.id)
    && (!q || t.label.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="flex flex-col gap-2">
      <div className={fieldClasses('sm', 'flex flex-wrap items-center gap-1 min-h-[34px] cursor-text')}>
        {d.priority && <TagChip tag={PRIORITY_TAG} onRemove={() => d.setPriority(false)} />}
        {d.chips.map((t) => <TagChip key={t.id} tag={t} onRemove={() => d.toggleTag(t.id, false)} />)}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches[0]) { e.preventDefault(); d.toggleTag(matches[0].id, true); setQ(''); }
            // Backspace on an empty field peels the last chip — the behaviour
            // that makes a token field feel like a field rather than a list.
            if (e.key === 'Backspace' && !q && d.chips.length) d.toggleTag(d.chips[d.chips.length - 1].id, false);
          }}
          placeholder={d.priority || d.chips.length ? '' : 'Add tags…'}
          aria-label="Add tags"
          className="flex-1 min-w-[80px] bg-transparent text-2xs text-fg placeholder:text-fg-muted outline-none"
        />
      </div>
      {q && (
        <div className="flex flex-wrap items-center gap-1">
          {matches.map((t) => (
            <button key={t.id} type="button" onClick={() => { d.toggleTag(t.id, true); setQ(''); }}
              className="opacity-70 hover:opacity-100 transition-opacity"><TagChip tag={t} /></button>
          ))}
          {matches.length === 0 && (
            <span className="text-3xs text-fg-muted">Enter to create “{q}”</span>
          )}
        </div>
      )}
      <NoteEditor value={d.note} onSave={d.setNote} placeholder="Add a note…" />
      <SaveButton onClick={onSave} />
    </div>
  );
}

/** CHIPS + "+" DISCLOSURE. At rest the editor shows ONLY what is applied, plus
 *  a "+". The available set costs nothing until you ask for it, which is the
 *  tightest resting state of the three — at the price of one extra click for
 *  every add, and a list that appears and disappears under your cursor. */
function EditPlusDisclosure({ d, onSave }: { d: ReturnType<typeof useDraft>; onSave: () => void }) {
  const [open, setOpen] = React.useState(false);
  const unapplied = d.registry.tags.filter((t) => !t.archived && !d.tagIds.has(t.id));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {d.priority && <TagChip tag={PRIORITY_TAG} onRemove={() => d.setPriority(false)} />}
        {d.chips.map((t) => <TagChip key={t.id} tag={t} onRemove={() => d.toggleTag(t.id, false)} />)}
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="w-5 h-5 rounded-full border border-dashed border-edge text-fg-muted hover:text-fg hover:border-edge transition-colors flex items-center justify-center text-3xs leading-none">
          +
        </button>
      </div>
      {open && (
        <div className="flex flex-wrap items-center gap-1 rounded-md bg-well border border-edge-dim p-2">
          {!d.priority && (
            <button type="button" onClick={() => d.setPriority(true)}
              className="opacity-70 hover:opacity-100 transition-opacity"><TagChip tag={PRIORITY_TAG} /></button>
          )}
          {unapplied.map((t) => (
            <button key={t.id} type="button" onClick={() => d.toggleTag(t.id, true)}
              className="opacity-70 hover:opacity-100 transition-opacity"><TagChip tag={t} /></button>
          ))}
          <button type="button" className="px-1.5 py-[1px] rounded-sm text-3xs leading-none border border-dashed border-edge text-fg-muted hover:text-fg transition-colors">
            + new
          </button>
        </div>
      )}
      <NoteEditor value={d.note} onSave={d.setNote} placeholder="Add a note…" />
      <SaveButton onClick={onSave} />
    </div>
  );
}

/** TWO COLUMNS. Applied on the left, available on the right, both always
 *  visible; clicking a chip moves it across. Nothing is hidden and nothing
 *  toggles, so the state is never in doubt — but it spends horizontal space the
 *  380px dialog does not really have, and each column wraps sooner. */
function EditTwoColumns({ d, onSave }: { d: ReturnType<typeof useDraft>; onSave: () => void }) {
  const unapplied = d.registry.tags.filter((t) => !t.archived && !d.tagIds.has(t.id));
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-4xs font-medium text-fg-muted tracking-wider uppercase">On</span>
          <div className="flex flex-wrap items-start gap-1 content-start min-h-[48px] rounded-md bg-well border border-edge-dim p-1.5">
            {d.priority && (
              <button type="button" onClick={() => d.setPriority(false)}><TagChip tag={PRIORITY_TAG} /></button>
            )}
            {d.chips.map((t) => (
              <button key={t.id} type="button" onClick={() => d.toggleTag(t.id, false)}><TagChip tag={t} /></button>
            ))}
            {!d.priority && d.chips.length === 0 && <span className="text-3xs text-fg-muted px-0.5">None</span>}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-4xs font-medium text-fg-muted tracking-wider uppercase">Available</span>
          <div className="flex flex-wrap items-start gap-1 content-start min-h-[48px] rounded-md bg-well border border-edge-dim p-1.5">
            {!d.priority && (
              <button type="button" onClick={() => d.setPriority(true)} className="opacity-70 hover:opacity-100 transition-opacity">
                <TagChip tag={PRIORITY_TAG} />
              </button>
            )}
            {unapplied.map((t) => (
              <button key={t.id} type="button" onClick={() => d.toggleTag(t.id, true)} className="opacity-70 hover:opacity-100 transition-opacity">
                <TagChip tag={t} />
              </button>
            ))}
          </div>
        </div>
      </div>
      <NoteEditor value={d.note} onSave={d.setNote} placeholder="Add a note…" />
      <SaveButton onClick={onSave} />
    </div>
  );
}

// ── Round 10: organising the tag chips ───────────────────────────────────────
// Round 9 was the wrong axis. R8·B was liked for its LAYOUT — applied above,
// available below, plain chips, plain click — and round 9 answered "tighten it"
// by making the interaction cleverer, which is the opposite. These three keep
// R8·B's mechanic exactly (click a chip, that is all) and vary only how the
// chips are ORGANISED on the page.

/** An available chip drawn as an outline rather than a dimmed fill. TagChip
 *  sets its background with an inline style, which no className can override,
 *  so this is a local variant — if it wins, TagChip gains an `outline` prop and
 *  this goes away. */
function OutlineChip({ tag }: { tag: { label: string; color: string } }) {
  const c = `var(--${tag.color})`;
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded-sm text-3xs leading-none border border-dashed"
      style={{ color: c, borderColor: `color-mix(in srgb, ${c} 45%, transparent)` }}
    >
      {tag.label}
    </span>
  );
}

/** ONE FLOW. No two blocks and no rule — applied chips first, a single dot
 *  separator, then the available ones dimmed, all in one wrapped run. You read
 *  it left to right as "these are on … these are not". Fewest bands of the
 *  three; the boundary is a single character, which is either elegant or
 *  invisible depending on how many tags are applied. */
function EditFlowOne({ d, onSave }: { d: ReturnType<typeof useDraft>; onSave: () => void }) {
  const unapplied = d.registry.tags.filter((t) => !t.archived && !d.tagIds.has(t.id));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {d.priority && <TagChip tag={PRIORITY_TAG} onRemove={() => d.setPriority(false)} />}
        {d.chips.map((t) => <TagChip key={t.id} tag={t} onRemove={() => d.toggleTag(t.id, false)} />)}
        <span className="text-fg-faint text-3xs px-1">·</span>
        {!d.priority && (
          <button type="button" onClick={() => d.setPriority(true)} className="opacity-50 hover:opacity-100 transition-opacity">
            <TagChip tag={PRIORITY_TAG} />
          </button>
        )}
        {unapplied.map((t) => (
          <button key={t.id} type="button" onClick={() => d.toggleTag(t.id, true)} className="opacity-50 hover:opacity-100 transition-opacity">
            <TagChip tag={t} />
          </button>
        ))}
      </div>
      <NoteEditor value={d.note} onSave={d.setNote} placeholder="Add a note…" />
      <SaveButton onClick={onSave} />
    </div>
  );
}

/** OUTLINE VS FILLED. Still two groups, but the difference is drawn rather than
 *  faded: applied chips keep their fill, available ones are dashed outlines. No
 *  divider rule is needed because the styling already separates them, and a
 *  dashed outline reads as "not yet" the way opacity never quite does. */
function EditOutline({ d, onSave }: { d: ReturnType<typeof useDraft>; onSave: () => void }) {
  const unapplied = d.registry.tags.filter((t) => !t.archived && !d.tagIds.has(t.id));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {d.priority && <TagChip tag={PRIORITY_TAG} onRemove={() => d.setPriority(false)} />}
        {d.chips.map((t) => <TagChip key={t.id} tag={t} onRemove={() => d.toggleTag(t.id, false)} />)}
        {!d.priority && d.chips.length === 0 && <span className="text-3xs text-fg-muted">No tags yet</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {!d.priority && (
          <button type="button" onClick={() => d.setPriority(true)} className="hover:opacity-70 transition-opacity">
            <OutlineChip tag={PRIORITY_TAG} />
          </button>
        )}
        {unapplied.map((t) => (
          <button key={t.id} type="button" onClick={() => d.toggleTag(t.id, true)} className="hover:opacity-70 transition-opacity">
            <OutlineChip tag={t} />
          </button>
        ))}
      </div>
      <NoteEditor value={d.note} onSave={d.setNote} placeholder="Add a note…" />
      <SaveButton onClick={onSave} />
    </div>
  );
}

/** FIXED STRIP. Applied chips wrap freely; the available set is ONE row that
 *  scrolls sideways. The editor's height then never changes as the registry
 *  grows — the thing that makes every wrapped-cloud design worse the longer you
 *  use the app. Costs discoverability: tags past the right edge are only found
 *  by scrolling. */
function EditFixedStrip({ d, onSave }: { d: ReturnType<typeof useDraft>; onSave: () => void }) {
  const unapplied = d.registry.tags.filter((t) => !t.archived && !d.tagIds.has(t.id));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {d.priority && <TagChip tag={PRIORITY_TAG} onRemove={() => d.setPriority(false)} />}
        {d.chips.map((t) => <TagChip key={t.id} tag={t} onRemove={() => d.toggleTag(t.id, false)} />)}
        {!d.priority && d.chips.length === 0 && <span className="text-3xs text-fg-muted">No tags yet</span>}
      </div>
      <div className="flex items-center gap-1 overflow-x-auto rounded-md bg-well border border-edge-dim px-1.5 py-1">
        {!d.priority && (
          <button type="button" onClick={() => d.setPriority(true)} className="shrink-0 opacity-70 hover:opacity-100 transition-opacity">
            <TagChip tag={PRIORITY_TAG} />
          </button>
        )}
        {unapplied.map((t) => (
          <button key={t.id} type="button" onClick={() => d.toggleTag(t.id, true)} className="shrink-0 opacity-70 hover:opacity-100 transition-opacity">
            <TagChip tag={t} />
          </button>
        ))}
        <button type="button" className="shrink-0 px-1.5 py-[1px] rounded-sm text-3xs leading-none border border-dashed border-edge text-fg-muted hover:text-fg transition-colors">
          + new
        </button>
      </div>
      <NoteEditor value={d.note} onSave={d.setNote} placeholder="Add a note…" />
      <SaveButton onClick={onSave} />
    </div>
  );
}

/** Round 7's winning shell, with the editor body swapped per candidate. */
function EditFlowCard({ render }: {
  render: (d: ReturnType<typeof useDraft>, onSave: () => void) => React.ReactNode;
}) {
  const d = useDraft();
  const [done, setDone] = React.useState(false);
  const [editing, setEditing] = React.useState(true);   // open, since it is what is being judged
  return (
    <div className="flex flex-col gap-3">
      <EditCard>
        {editing ? render(d, () => setEditing(false)) : <EditCardSummary d={d} onEdit={() => setEditing(true)} />}
      </EditCard>
      <CompleteRow done={done} onChange={setDone} />
    </div>
  );
}

function CheckGlyph({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

function ChevronGlyph({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M19 9l-7 7-7-7" />
    </svg>
  );
}




/** The notebook glyph the StatusBar tags chip already uses for "has a note". */
function NoteGlyph({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
  );
}

/** Dialog chrome around a candidate, so the body is judged at its real width
 *  with the real header and footer either side of it. */
function InDialog({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="px-4 pt-4 pb-3 border-b border-edge">
        <h2 className="text-sm font-bold text-fg">Close session</h2>
        <p className="text-2xs text-fg-muted mt-1 truncate">fix chat scroll stick</p>
      </div>
      <div className="px-4 py-4">{children}</div>
      <div className="px-4 pb-4 flex items-center gap-2 justify-end">
        <Button variant="ghost" size="sm">Cancel</Button>
        <Button size="sm">Close session</Button>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SURFACE 2 — Settings → Permissions, the mode control
// ═════════════════════════════════════════════════════════════════════════════
//
// WHAT IS ACTUALLY BEING DECIDED. The Permissions screen opens with a control
// for how much the assistant checks with you: three modes, one obviously-safe
// default (Ask first) and two progressively riskier ones. A first round of
// design was rejected by the owner in these words:
//
//   "all three offered UIs make it look like i'm selecting a permissions mode,
//    when that selection actually does fucking nothing."
//
// TWO SEPARATE PROBLEMS live in that sentence, and only one of them is a design
// problem. The setting being inert is being fixed in the main process — a
// persisted default mode that new conversations start in. So every candidate
// here is authored as a control that GENUINELY OWNS A VALUE: it takes `value`
// and `onChange`, and the pane drives them from its own state. Nothing here
// carries copy or an affordance implying a setting that does not exist.
//
// What is left for this surface is the design half: the three forms that exist
// today all present the modes as three interchangeable options, and they are
// not interchangeable — they are a default and two escalations away from it.
//
// FRAME. `panel` at 420px, which is the real thing: the Permissions dialog is
// size="panel" (DIALOG_WIDTHS.panel = min(420px, 88vw)) and never gets wider.
// These definitions wrap at that width, which is most of what there is to judge.
// The real <Dialog> is NOT rendered — it is fixed-position and would stack every
// pane in the middle of the screen (see types.ts).

type ModeControlProps = {
  value: NativePermissionMode;
  onChange: (next: NativePermissionMode) => void;
};

/** One mode as a radio-list row: the <Radio> lives in SettingRow's icon slot and
 *  the whole tile is the hit target, so you never have to aim at the 14px
 *  circle. Shared by the candidates that use this row shape, so the only thing
 *  differing between them is the arrangement AROUND the rows. */
function ModeRow({ m, value, onChange }: { m: PermissionModeDef } & ModeControlProps) {
  return (
    <SettingRow
      variant="item"
      title={m.label}
      description={m.line}
      selected={value === m.id}
      onSelect={() => onChange(m.id)}
      // Roving tabindex: only the chosen option is tabbable, so Tab enters and
      // leaves the group in one stop (what native radios give free).
      radioTabIndex={value === m.id ? 0 : -1}
    />
  );
}

// ── Round 1: the three controls that already exist ───────────────────────────
// Verbatim in behaviour and copy from VariantC.tsx's `?mc=1|2|3` scaffold, so
// the lineage starts from something real rather than from a blank page. The one
// change is the prop names — `value`/`onChange` instead of `mode`/`onChange` —
// because a control that owns a value is what the next round is arguing about.

/** 1 — RADIO LIST (VariantC's recommendation, and its default with no `?mc`).
 *
 *  K3's "any option needs a description" form: a <RadioGroup> (one tab stop,
 *  arrow keys walk it) around three <SettingRow variant="item">s. */
function ModeRadioList({ value, onChange }: ModeControlProps) {
  return (
    <RadioGroup
      aria-label={MODE_ARIA}
      options={MODE_IDS}
      value={value}
      onChange={(id) => onChange(id as NativePermissionMode)}
      className="space-y-1"
    >
      {MODES.map((m) => (
        <ModeRow key={m.id} m={m} value={value} onChange={onChange} />
      ))}
    </RadioGroup>
  );
}

/** 2 — SEGMENTED, WITH THE WHOLE KEY SHOWN.
 *
 *  The picker stays a single row (the most compact of the three) and all three
 *  definitions print beneath it as a fixed key. The key is deliberately
 *  UNEMPHASISED — the segmented control already draws the selection in
 *  bg-accent, and a second selected/unselected treatment down here would be a
 *  hand-rolled active/inactive pair in everything but name. */
function ModeSegmentedWithKey({ value, onChange }: ModeControlProps) {
  return (
    <>
      <SegmentedTabs
        variant="contained"
        aria-label={MODE_ARIA}
        tabs={MODES.map((m) => ({ id: m.id, label: m.label }))}
        value={value}
        onChange={(id) => onChange(id as NativePermissionMode)}
      />
      <ul className="mt-2 space-y-1.5">
        {MODES.map((m) => (
          <li key={m.id} className="text-2xs text-fg-muted leading-relaxed">
            <span className="text-fg-2 font-medium">{m.label}</span> — {m.line}
          </li>
        ))}
      </ul>
    </>
  );
}

/** 3 — ROWS WITH THE RADIO ON THE RIGHT.
 *
 *  Same rows, opposite geometry: the <Radio> sits in SettingRow's `control`
 *  slot, so the title and its definition get the row's full left edge — the
 *  thing worth comparing at 420px, where these definitions wrap. The whole row
 *  still selects, and SettingRow stops the Radio's own click from bubbling back
 *  into it, so one tap is one change. */
function ModeTrailingRadios({ value, onChange }: ModeControlProps) {
  return (
    <RadioGroup
      aria-label={MODE_ARIA}
      options={MODE_IDS}
      value={value}
      onChange={(id) => onChange(id as NativePermissionMode)}
      className="space-y-1"
    >
      {MODES.map((m) => (
        <SettingRow
          key={m.id}
          variant="item"
          title={m.label}
          description={m.line}
          onClick={() => onChange(m.id)}
          control={
            <Radio
              checked={value === m.id}
              onChange={() => onChange(m.id)}
              tabIndex={value === m.id ? 0 : -1}
              aria-label={m.label}
            />
          }
        />
      ))}
    </RadioGroup>
  );
}

// ── Round 2: forms that are not a picker of three equals ─────────────────────
// The axis is the SHAPE of the choice, not its copy — every mode definition is
// still the verbatim string from permission-modes.ts in all three, so a pick
// tells you which presentation you preferred rather than which sentence.

/** A — STATE FIRST. At rest this is not a picker at all: one row states how the
 *  assistant behaves today, with a quiet "Change" beside it. Clicking it opens
 *  the full three-option list, and choosing closes it again, so picking a mode
 *  is a deliberate second step rather than the screen's opening question.
 *
 *  The trade, stated plainly: at rest you can no longer compare the three
 *  definitions, which is precisely what VariantC's second owner review bought by
 *  printing all three at once. This candidate bets that a SETTING should read as
 *  its current value, and that the comparison is one click away when you
 *  actually want it. */
function ModeStateFirst({ value, onChange }: ModeControlProps) {
  const [changing, setChanging] = React.useState(false);
  // MODE_IDS covers every NativePermissionMode, so this cannot miss — but fall
  // back rather than assert, since a bad `!` here would blank the whole pane.
  const current = MODES.find((m) => m.id === value) ?? MODES[0];

  if (!changing) {
    return (
      <SettingRow
        variant="item"
        title={current.label}
        description={current.line}
        // Ghost is the family's lightest button: the row is a statement of
        // state, and the way to change it should not out-shout the state.
        control={
          <Button variant="ghost" size="sm" onClick={() => setChanging(true)}>
            Change
          </Button>
        }
      />
    );
  }

  return (
    <RadioGroup
      aria-label={MODE_ARIA}
      options={MODE_IDS}
      value={value}
      onChange={(id) => {
        onChange(id as NativePermissionMode);
        setChanging(false);
      }}
      className="space-y-1"
    >
      {MODES.map((m) => (
        <ModeRow
          key={m.id}
          m={m}
          value={value}
          onChange={(next) => {
            onChange(next);
            setChanging(false);
          }}
        />
      ))}
    </RadioGroup>
  );
}

/** B — DEFAULT, THEN THE STEP-UPS. All three rows stay visible and all three
 *  definitions stay readable, but they stop being a flat stack: Ask first sits
 *  alone as the plain choice, and the two that trade oversight for fewer
 *  interruptions are held in ONE bordered card under a label saying what they
 *  have in common.
 *
 *  Containment rather than indent, deliberately — the rejected Permissions
 *  design expressed "these belong to that" with 8px of padding and nothing else,
 *  and the fix that stuck (VariantC's FolderCard) was a border on all four
 *  sides. Same class recipe here: rounded-lg border border-edge bg-well. */
function ModeStepUps({ value, onChange }: ModeControlProps) {
  const [base, ...stepUps] = MODES;
  return (
    <RadioGroup
      aria-label={MODE_ARIA}
      options={MODE_IDS}
      value={value}
      onChange={(id) => onChange(id as NativePermissionMode)}
      className="space-y-2"
    >
      <ModeRow m={base} value={value} onChange={onChange} />
      <div className="rounded-lg border border-edge bg-well overflow-hidden pt-2.5 px-1 pb-1">
        {/* Authored copy classifying the rows under it — a section label, and it
            takes the canonical spelling. px-2 lands it on the same left edge as
            the row titles beneath (the rows carry their own px-3 inside the
            card's px-1). */}
        <h3 className={`${SECTION_LABEL} px-2`}>Fewer interruptions</h3>
        <div className="space-y-1">
          {stepUps.map((m) => (
            <ModeRow key={m.id} m={m} value={value} onChange={onChange} />
          ))}
        </div>
      </div>
    </RadioGroup>
  );
}

/** Indent per step. A key whose lines hang progressively further right reads as
 *  a staircase, which is the whole point of this candidate — so the values are
 *  named here rather than computed, and there are exactly as many as MODES. */
const STEP_INDENT = ['', 'pl-3', 'pl-6'];

/** C — A SCALE, NOT A ROW OF TABS. The compact segmented picker survives — it is
 *  by far the smallest of the forms — but it is reframed as an axis: the ends
 *  are named underneath it, and the key below steps one indent further right per
 *  mode, so left-to-right and top-to-bottom both mean the same thing.
 *
 *  Nothing in the key is emphasised by selection, for R1·B's reason: the
 *  segmented control already draws the selection, and a second active/inactive
 *  treatment down here would be a hand-rolled choice group in all but name. */
function ModeScale({ value, onChange }: ModeControlProps) {
  return (
    <>
      <SegmentedTabs
        variant="contained"
        aria-label={MODE_ARIA}
        tabs={MODES.map((m) => ({ id: m.id, label: m.label }))}
        value={value}
        onChange={(id) => onChange(id as NativePermissionMode)}
      />
      {/* The axis. Not a section label — no uppercase, no tracking — because
          these are the ends of a scale, not a heading over a group. */}
      <div className="mt-1.5 flex items-center justify-between text-3xs text-fg-muted">
        <span>Checks with you most</span>
        <span>Checks with you least</span>
      </div>
      <ul className="mt-2.5 space-y-1.5">
        {MODES.map((m, i) => (
          <li key={m.id} className={`text-2xs text-fg-muted leading-relaxed ${STEP_INDENT[i]}`}>
            <span className="text-fg-2 font-medium">{m.label}</span> — {m.line}
          </li>
        ))}
      </ul>
    </>
  );
}

/** The always-ask list, identical in every candidate. It is here rather than
 *  cropped out because Full auto's definition ends "The list below is the
 *  exception" — judged without a list below it, that sentence points at nothing.
 *  Copied from VariantC's section 2, including the reason it is a quiet card and
 *  not a stack of rows: there is nothing here to toggle, and <SettingRow>s would
 *  promise a control that does not exist. */
function AlwaysAsksSection() {
  return (
    <div>
      <h3 className={SECTION_LABEL}>Things it always asks about</h3>
      <div className="rounded-lg bg-inset/50 px-3 py-2.5 space-y-1.5">
        <p className="text-3xs text-fg-muted">Even on Full auto:</p>
        <ul className="text-2xs text-fg-2 leading-relaxed list-disc pl-4 space-y-1">
          {ALWAYS_ASKS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Mounts one mode control in the dialog it actually lives in: the Permissions
 *  header band above it, the section label it sits under, and the always-asks
 *  section below. The state is HERE — every candidate is a real control over a
 *  real value, so it responds like the setting it is about to become. */
function ModePane({ control: Control }: { control: React.ComponentType<ModeControlProps> }) {
  const [mode, setMode] = React.useState<NativePermissionMode>('ask');
  return (
    <div className="flex flex-col">
      {/* Dialog.tsx's own header geometry, not the real <Dialog> — see the
          surface comment above for why the component itself cannot be used. */}
      <div className="px-4 py-3 border-b border-edge">
        <h2 className="text-sm font-bold text-fg">Permissions</h2>
      </div>
      {/* px-4 py-4 space-y-5 is Dialog's scroll-body track, so the control is
          judged with the padding it will really have. */}
      <div className="px-4 py-4 space-y-5">
        <div>
          {/* Matches the explainer's own "How much it asks" section, so the (i)
              reads as the long version of what is on screen. */}
          <h3 className={SECTION_LABEL}>How much it asks</h3>
          <Control value={mode} onChange={setMode} />
        </div>
        <AlwaysAsksSection />
      </div>
    </div>
  );
}

// ── Round 3: not a control at all ────────────────────────────────────────────
// R1 and R2 were discarded TOGETHER, and the fault was not styling. All six
// candidates were CONTROLS — radio lists, segmented tabs, a row with a Change
// button — and every one of them read as a live selector for a setting this
// screen does not own:
//
//   "this IS NOT AND SHOULD NOT BE A REAL PERMISSIONS SELECTOR. it still looks
//    like a live selector that changes a setting"
//
// The reason it can never be one: permission mode is per-CONVERSATION state,
// owned by NativeSessionHost and set from the status-bar chip at the bottom of
// the chat. There is no app-wide default for this screen to write to, so a
// control here would either do nothing (a lie in the shape of a control) or
// force the invention of a setting that does not exist. The R2 header above
// bet that the inertness would be fixed in the main process and the design
// question was the shape of the picker; that bet was wrong, and this round is
// where it is paid off.
//
// So every candidate below is a PRESENTATION OF REFERENCE CONTENT: three terms
// and their definitions, printed as facts, exactly the way ALWAYS_ASKS is. No
// selected state, no radios, no tabs, nothing focusable, no hover affordance —
// and each one prints MODE_LOCATION_NOTE, so the reader is told where the mode
// really is changed rather than left hunting this screen for it.
//
// THE AXIS IS CONTAINMENT: a card of its own (A), no container at all (B), or
// one container shared with the always-asks list below (C). Copy is identical
// in all three, MODES verbatim, so a pick names the presentation.
//
// Most of this is text, so most of it is plain tokens rather than primitives —
// which is the honest answer here, not a shortcut. There is no primitive for
// "three definitions", and reaching for <SettingRow> to get one would put row
// geometry (and its click affordance) around content that is not a row.

/** The run-in definitions A and C share: the term in full text colour, its
 *  sentence continuing on the same line. Identical in both on purpose, so what
 *  separates those two candidates is the container and nothing else. */
function RunInDefinitions() {
  return (
    <div className="space-y-2">
      {MODES.map((m) => (
        <p key={m.id} className="text-2xs text-fg-2 leading-relaxed">
          <span className="font-medium text-fg">{m.label}</span>
          {' — '}
          {m.line}
        </p>
      ))}
    </div>
  );
}

/** A — THE QUIET CARD. The same `bg-inset/50` informational surface the
 *  always-asks list uses, which is already this screen's established way of
 *  saying "this is a fact about the app, there is nothing to operate here". The
 *  card does the grouping, so the three terms only need weight rather than
 *  lines of their own. This is what the component does today. */
function ModeRefCard() {
  return (
    <div className="rounded-lg bg-inset/50 px-3 py-2.5 space-y-2">
      <RunInDefinitions />
      <p className="text-3xs text-fg-muted">{MODE_LOCATION_NOTE}</p>
    </div>
  );
}

/** B — NO CARD, A REAL DEFINITION LIST. <dl>/<dt>/<dd> is the markup for terms
 *  and their definitions, which is literally what this content is; a screen
 *  reader then announces it as a definition list rather than as three
 *  paragraphs. Nothing is drawn at all — no fill, no border — so there is no
 *  box a reader could mistake for a group of options.
 *
 *  Dropping the card costs the grouping, so the terms take that job back by
 *  standing on their own line at text-xs. That is the same move, not a second
 *  one: without a container the labels have to be the structure. It also puts
 *  the three names in a column you can scan without reading the sentences. */
function ModeRefDefinitions() {
  return (
    <>
      <dl className="space-y-2.5">
        {MODES.map((m) => (
          <div key={m.id}>
            <dt className="text-xs font-medium text-fg">{m.label}</dt>
            <dd className="text-2xs text-fg-2 leading-relaxed">{m.line}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-3xs text-fg-muted">{MODE_LOCATION_NOTE}</p>
    </>
  );
}

/** C — ONE EXPLANATION. The modes and the always-asks list share a SINGLE
 *  bg-inset/50 card, divided into bands. Full auto's own definition ends "The
 *  list below is the exception" — here that list is inside the same box instead
 *  of in a separate section under its own heading, so the sentence points at
 *  something the eye already reads as part of the same statement.
 *
 *  Both headings survive: the always-asks label becomes the second band's
 *  header, the way VariantC's folder cards carry band headers inside a card.
 *  MODE_LOCATION_NOTE closes the whole card rather than just the modes, because
 *  by then it is the one thing left to say. Costs the one-section-per-idea
 *  rhythm the rest of the screen keeps, and it is the tallest single object on
 *  the page. */
function ModeRefCoupled() {
  return (
    <div>
      <h3 className={SECTION_LABEL}>How much it asks</h3>
      <div className="rounded-lg bg-inset/50">
        <div className="px-3 py-2.5">
          <RunInDefinitions />
        </div>
        <div className="border-t border-edge-dim px-3 py-2.5">
          <h3 className={SECTION_LABEL}>Things it always asks about</h3>
          <p className="text-3xs text-fg-muted">Even on Full auto:</p>
          <ul className="mt-1.5 text-2xs text-fg-2 leading-relaxed list-disc pl-4 space-y-1">
            {ALWAYS_ASKS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="border-t border-edge-dim px-3 py-2">
          <p className="text-3xs text-fg-muted">{MODE_LOCATION_NOTE}</p>
        </div>
      </div>
    </div>
  );
}

/** Round 3's pane. Same dialog chrome as ModePane and NO STATE — there is
 *  nothing on this screen that owns a value any more, and a useState here would
 *  be scaffolding for a control that is not being built.
 *
 *  The body is authored by the candidate instead of being pre-drawn, because C
 *  deliberately merges the modes with the always-asks section and so cannot be
 *  handed a fixed "h3 + control + AlwaysAsksSection" sandwich. */
function ReferencePane({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="px-4 py-3 border-b border-edge">
        <h2 className="text-sm font-bold text-fg">Permissions</h2>
      </div>
      <div className="px-4 py-4 space-y-5">{children}</div>
    </div>
  );
}

/** The two-section body A and B share: the canonical section label, the
 *  candidate's presentation under it, then the always-asks section exactly as
 *  the other rounds render it. */
function ModeRefSections({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div>
        <h3 className={SECTION_LABEL}>How much it asks</h3>
        {children}
      </div>
      <AlwaysAsksSection />
    </>
  );
}

// ── Full-auto ask (M5 2b) ────────────────────────────────────────────────────
// The only rule-based prompt full-auto still shows is a destructive-command
// stop (rulesForMode('full-auto') is `*→allow`; only the deny-list outranks
// it), yet PermissionButtons renders the same generic row as Ask mode —
// nothing says WHY the mode that "works without checking with you" stopped.
// Candidates vary two axes: how much the card explains the stop, and which
// actions it offers. Hard constraint from the shipped Permissions screen: the
// four families (deleting, git push/reset, sudo, format) must KEEP asking.

// StatusBar's full-auto chip colors (PERMISSION_DISPLAY['full-auto']) —
// duplicated because that record is a private const of StatusBar.tsx; if a
// candidate wins, export it and delete this.
const FULL_AUTO_CHIP = {
  color: '#F2B33D',
  bg: 'rgba(242,179,61,0.15)',
  border: 'rgba(242,179,61,0.25)',
};

// The button marks, verbatim from PermissionButtons (ToolCard.tsx) — these are
// the app's hardcoded STATUS colors, deliberately outside ui/Button (spec §11
// change 61), so the candidates must draw exactly these.
const ASK_BTN = 'px-3 py-1 text-xs font-medium rounded-lg transition-colors';
const ASK_GREEN = `${ASK_BTN} bg-green-600/60 hover:bg-green-600/80 text-green-100`;
const ASK_BLUE = `${ASK_BTN} bg-blue-600/60 hover:bg-blue-600/80 text-blue-100`;
const ASK_RED = `${ASK_BTN} bg-red-600/60 hover:bg-red-600/80 text-red-100`;

/** The awaiting-approval ToolCard shell, fixture: a deny-listed `git push` in a
 *  full-auto session. Same classes as ToolCard's header row — the candidates
 *  only vary the footer, so the shell must be the production card or the
 *  comparison is against something that doesn't exist. */
function FullAutoAskShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-edge rounded-lg overflow-hidden">
      <div className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left">
        <QuestionIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
        <span className="text-fg-faint text-xs select-none">|</span>
        <span className="text-xs font-medium text-fg-2">Push local commits</span>
        <span className="text-xs text-fg-muted truncate flex-1 min-w-0">· git push origin master</span>
      </div>
      {children}
    </div>
  );
}

/** A — today's three buttons, plus one amber line naming why the mode stopped. */
function FullAutoExplainedRow() {
  return (
    <FullAutoAskShell>
      <div className="px-3 py-2 space-y-2 border-t border-edge bg-inset/30">
        <p className="text-2xs leading-relaxed" style={{ color: FULL_AUTO_CHIP.color }}>
          Full auto paused — pushing code is one of the four things it always checks first.
        </p>
        <div className="flex items-center gap-2">
          <button className={ASK_GREEN}>Yes</button>
          <button className={ASK_BLUE}>Always Allow</button>
          <button className={ASK_RED}>No</button>
        </div>
      </div>
    </FullAutoAskShell>
  );
}

/** B — a safety stop: two verbs, and the rule-making action demoted to a quiet
 *  line that opens the existing are-you-sure step. */
function FullAutoSafetyStop() {
  // The link swaps in the existing consequence confirm so the flow is judgeable,
  // not just describable — same copy PermissionButtons ships today.
  const [confirming, setConfirming] = React.useState(false);
  return (
    <FullAutoAskShell>
      <div
        className="px-3 py-2 space-y-2 border-t"
        style={{ background: FULL_AUTO_CHIP.bg, borderColor: FULL_AUTO_CHIP.border }}
      >
        {confirming ? (
          <>
            <p className="text-xs font-medium text-fg-2">Always allow this exact command in youcoded?</p>
            <p className="text-2xs leading-relaxed text-fg-2 bg-inset/70 px-2 py-1.5 rounded-sm break-all">
              git push origin master
            </p>
            <p className="text-2xs text-fg-dim leading-relaxed">
              It can delete files or change published code, and you won't be asked again.
            </p>
            <div className="flex items-center gap-2">
              <button className={ASK_GREEN} onClick={() => setConfirming(false)}>Nevermind, allow once</button>
              <button className={ASK_RED}>Always allow</button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs font-medium" style={{ color: FULL_AUTO_CHIP.color }}>
              Stopped before pushing code
            </p>
            <p className="text-2xs text-fg-dim leading-relaxed">
              Full auto always checks this first — it changes your published code.
            </p>
            <div className="flex items-center gap-2">
              <button className={ASK_GREEN}>Run it</button>
              <button className={ASK_RED}>Skip it</button>
            </div>
            <button
              className="text-3xs text-fg-muted hover:text-fg underline underline-offset-2 transition-colors"
              onClick={() => setConfirming(true)}
            >
              Stop checking this exact command in youcoded
            </button>
          </>
        )}
      </div>
    </FullAutoAskShell>
  );
}

/** C — a mode-branded checkpoint: the chip carries the why, one primary verb,
 *  and no rule-making from the card at all. */
function FullAutoCheckpoint() {
  return (
    <FullAutoAskShell>
      <div
        className="px-3 py-2 space-y-2 border-t"
        style={{ background: FULL_AUTO_CHIP.bg, borderColor: FULL_AUTO_CHIP.border }}
      >
        <div className="flex items-center gap-2">
          <span
            className="text-3xs font-semibold tracking-wider px-1.5 py-0.5 rounded border"
            style={{
              color: FULL_AUTO_CHIP.color,
              backgroundColor: FULL_AUTO_CHIP.bg,
              borderColor: FULL_AUTO_CHIP.border,
            }}
          >
            FULL AUTO
          </span>
          <span className="text-2xs text-fg-2">checkpoint — pushing code</span>
        </div>
        <p className="text-2xs text-fg-dim leading-relaxed">
          This mode only checks with you before deleting, pushing, sudo, and formatting.
        </p>
        <div className="flex items-center gap-2">
          <button className={ASK_GREEN}>Continue</button>
          <button className="px-3 py-1 text-xs font-medium rounded-lg text-fg-muted hover:text-fg hover:bg-inset transition-colors">
            Don't run
          </button>
        </div>
      </div>
    </FullAutoAskShell>
  );
}

/** R2 — R1·B with the owner's correction: the quiet link becomes a third
 *  button, right of Skip it, behind the header-style `|` divider. The round
 *  varies only the button's orange. Clicking it still opens the same
 *  are-you-sure step — the deny-list consequence confirm is not in question. */
function FullAutoSafetyStopR2({ always }: { always: 'status-orange' | 'mode-amber' | 'ghost' }) {
  const [confirming, setConfirming] = React.useState(false);
  const alwaysClass =
    always === 'status-orange'
      ? `${ASK_BTN} bg-orange-600/60 hover:bg-orange-600/80 text-orange-100`
      : always === 'mode-amber'
        ? ASK_BTN // colors inline below — the chip amber isn't a Tailwind step
        : `${ASK_BTN} border hover:bg-inset`;
  const alwaysStyle =
    always === 'mode-amber'
      ? { backgroundColor: 'rgba(242,179,61,0.35)', color: '#F8D998' }
      : always === 'ghost'
        ? { borderColor: FULL_AUTO_CHIP.border, color: FULL_AUTO_CHIP.color }
        : undefined;
  return (
    <FullAutoAskShell>
      <div
        className="px-3 py-2 space-y-2 border-t"
        style={{ background: FULL_AUTO_CHIP.bg, borderColor: FULL_AUTO_CHIP.border }}
      >
        {confirming ? (
          <>
            <p className="text-xs font-medium text-fg-2">Always allow this exact command in youcoded?</p>
            <p className="text-2xs leading-relaxed text-fg-2 bg-inset/70 px-2 py-1.5 rounded-sm break-all">
              git push origin master
            </p>
            <p className="text-2xs text-fg-dim leading-relaxed">
              It can delete files or change published code, and you won't be asked again.
            </p>
            <div className="flex items-center gap-2">
              <button className={ASK_GREEN} onClick={() => setConfirming(false)}>Nevermind, allow once</button>
              <button className={ASK_RED}>Always allow</button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs font-medium" style={{ color: FULL_AUTO_CHIP.color }}>
              Stopped before pushing code
            </p>
            <p className="text-2xs text-fg-dim leading-relaxed">
              Full auto always checks this first — it changes your published code.
            </p>
            <div className="flex items-center gap-2">
              <button className={ASK_GREEN}>Run it</button>
              <button className={ASK_RED}>Skip it</button>
              <span className="text-fg-faint text-xs select-none">|</span>
              <button className={alwaysClass} style={alwaysStyle} onClick={() => setConfirming(true)}>
                Always Allow
              </button>
            </div>
          </>
        )}
      </div>
    </FullAutoAskShell>
  );
}

/** R3 — R2·A (status orange) with the owner's copy + spacing direction: the
 *  subline tucks under the header as a subheader (2px), the only real gap is
 *  before the buttons (8px). Varies only the subline's verb. */
function FullAutoSafetyStopR3({ copy }: { copy: 'prohibits' | 'stops' | 'limits' }) {
  const [confirming, setConfirming] = React.useState(false);
  const sub =
    copy === 'prohibits'
      // Owner's line, verbatim — punctuation included.
      ? 'YouCoded prohibits this action, even in Full Auto - It changes your published code'
      : copy === 'stops'
        ? 'YouCoded always stops this action, even in Full Auto — it changes your published code.'
        // R4 settled: the owner's third verb, on the normalized punctuation.
        : 'YouCoded limits this action, even in Full Auto — it changes your published code.';
  return (
    <FullAutoAskShell>
      <div
        className="px-3 py-2 space-y-2 border-t"
        style={{ background: FULL_AUTO_CHIP.bg, borderColor: FULL_AUTO_CHIP.border }}
      >
        {confirming ? (
          <>
            <p className="text-xs font-medium text-fg-2">Always allow this exact command in youcoded?</p>
            <p className="text-2xs leading-relaxed text-fg-2 bg-inset/70 px-2 py-1.5 rounded-sm break-all">
              git push origin master
            </p>
            <p className="text-2xs text-fg-dim leading-relaxed">
              It may delete files or change published code, and you won't be asked again during future sessions in this project.
            </p>
            <div className="flex items-center gap-2">
              <button className={ASK_GREEN} onClick={() => setConfirming(false)}>Nevermind, allow once</button>
              <button className={ASK_RED}>Always allow</button>
            </div>
          </>
        ) : (
          <>
            {/* Header + subheader as ONE tight block; the container's space-y-2
                then puts the round's only real gap before the buttons. */}
            <div className="space-y-0.5">
              <p className="text-xs font-medium" style={{ color: FULL_AUTO_CHIP.color }}>
                Stopped before pushing code
              </p>
              <p className="text-2xs text-fg-dim leading-relaxed">{sub}</p>
            </div>
            <div className="flex items-center gap-2">
              <button className={ASK_GREEN}>Run it</button>
              <button className={ASK_RED}>Skip it</button>
              <span className="text-fg-faint text-xs select-none">|</span>
              <button
                className={`${ASK_BTN} bg-orange-600/60 hover:bg-orange-600/80 text-orange-100`}
                onClick={() => setConfirming(true)}
              >
                Always Allow
              </button>
            </div>
          </>
        )}
      </div>
    </FullAutoAskShell>
  );
}

// ── M5 2c: how wide is an "Always allow"? ────────────────────────────────────
//
// Today one button silently stores one rule, and what that rule covers is
// whatever the raw command string happened to glob to. 2c gives the user the
// choice — this exact command, or a wider grant the app derived and NAMED — so
// the card has to present a choice it never presented before.
//
// Every candidate below renders the REAL bashGrantOptions output for its row.
// The number of options, their wording, and their absence are all the shipping
// derivation, not fixture text: where a row shows one option, that is the module
// withholding the other one, and where it shows none, that command may not be
// always-allowed at all.
const ASK_ORANGE = `${ASK_BTN} bg-orange-600/60 hover:bg-orange-600/80 text-orange-100`;

const GRANT_ROWS: ReadonlyArray<{
  command: string; title: string; denyListed: boolean; fullAuto?: boolean; why: string;
}> = [
  {
    command: 'git push origin feat/login', title: 'Push local commits', denyListed: true, fullAuto: true,
    why: 'ONE option — the branch grant. Its exact rung would differ only by options you cannot see, so it is not offered. Full auto, so this sits in 2b’s settled safety-stop band.',
  },
  {
    command: 'git push origin master', title: 'Push local commits', denyListed: true,
    why: 'One option. master is an ordinary branch: it scopes exactly like any other, and gets its own revocable row.',
  },
  {
    command: 'git push', title: 'Push local commits', denyListed: true,
    why: 'NO always-allow at all. The branch is not in the command — it is whatever is checked out when it runs.',
  },
  {
    command: 'npm run build', title: 'Build the project', denyListed: false,
    why: 'TWO options — the only row where the choice is a real difference in trust ("just this" vs "any npm run command"). Also the path that has no confirm step at all today.',
  },
  {
    command: 'rm -rf build', title: 'Delete the build folder', denyListed: true,
    why: 'One option. Nothing about rm can be widened safely, so it is exact-only.',
  },
  {
    command: 'npm run build > log.txt', title: 'Build, saving the output', denyListed: false,
    why: 'One option: a wide rule would not have covered this command, so offering it would just re-ask forever.',
  },
  {
    command: 'git --no-pager log', title: 'Read the commit history', denyListed: false,
    why: 'One option: the wide rule here would be “Any git command”, which also covers pushes and hard resets.',
  },
];

/** The wide option's wording as a BUTTON. bashGrantOptions returns a label built
 *  for a list ("Any npm run command"); a button needs a verb. Both forms are
 *  placeholders until this round settles them. */
function widenLabel(label: string): string {
  return label.startsWith('Always allow')
    ? label
    : `Always allow ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/** The awaiting-approval ToolCard shell for one row. Full auto + deny-listed
 *  wears 2b's amber band; everything else wears the ordinary footer. */
function GrantAskShell({ row, children }: {
  row: (typeof GRANT_ROWS)[number]; children: React.ReactNode;
}) {
  const amber = !!row.fullAuto && row.denyListed;
  return (
    <div className="border border-edge rounded-lg overflow-hidden">
      <div className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left">
        <QuestionIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
        <span className="text-fg-faint text-xs select-none">|</span>
        <span className="text-xs font-medium text-fg-2">{row.title}</span>
        <span className="text-xs text-fg-muted truncate flex-1 min-w-0">· {row.command}</span>
      </div>
      <div
        className={amber ? 'px-3 py-2 space-y-2 border-t' : 'px-3 py-2 space-y-2 border-t border-edge bg-inset/30'}
        style={amber ? { background: FULL_AUTO_CHIP.bg, borderColor: FULL_AUTO_CHIP.border } : undefined}
      >
        {amber && (
          <div className="space-y-0.5">
            <p className="text-xs font-medium" style={{ color: FULL_AUTO_CHIP.color }}>Stopped before pushing code</p>
            <p className="text-2xs text-fg-dim leading-relaxed">
              YouCoded limits this action, even in Full Auto — it changes your published code.
            </p>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/** The consequence confirm, verbatim from the shipped card — every candidate
 *  reuses it so only the CHOICE differs between panes.
 *
 *  `heading` is what R2 varies. The consequence sentence is gated on denyListed
 *  exactly as ToolCard gates it today: an ordinary command never showed a "may
 *  delete files" warning and must not start. */
function GrantConfirmShell({ command, heading, denyListed, children }: {
  command: string; heading: string; denyListed: boolean; children: React.ReactNode;
}) {
  return (
    <>
      <p className="text-xs font-medium text-fg-2">{heading}</p>
      <p className="text-2xs leading-relaxed text-fg-2 bg-inset/70 px-2 py-1.5 rounded-sm break-all">{command}</p>
      {denyListed && (
        <p className="text-2xs text-fg-dim leading-relaxed">
          It may delete files or change published code, and you won't be asked again during future sessions in this project.
        </p>
      )}
      {children}
    </>
  );
}

/** A — every width is its own button on the card. No confirm step to reach the
 *  wider one; the row just gets longer as options appear. */
function GrantCandidateButtons({ row }: { row: (typeof GRANT_ROWS)[number] }) {
  const options = bashGrantOptions(row.command);
  return (
    <GrantAskShell row={row}>
      <div className="flex flex-wrap items-center gap-2">
        <button className={ASK_GREEN}>{row.fullAuto ? 'Run it' : 'Yes'}</button>
        {options.map((o) => (
          <button key={o.scope} className={o.scope === 'exact' ? ASK_BLUE : ASK_ORANGE}>
            {o.scope === 'exact' ? 'Always allow this command' : widenLabel(o.label)}
          </button>
        ))}
        <button className={ASK_RED}>{row.fullAuto ? 'Skip it' : 'No'}</button>
      </div>
    </GrantAskShell>
  );
}

/** R2's axis: how much the confirm EXPLAINS. The shape is settled (R1 · B) —
 *  one Always Allow button on the card, the choice inside the confirm behind it.
 *  Every string below is a candidate, not a decision. */
type GrantCopy = 'minimal' | 'options' | 'spelled';

/** B — one Always Allow button as today; the CHOICE happens in the confirm, as a
 *  two-row radio with the exact option preselected. `copy` selects R2's variant. */
function GrantCandidateRadio({ row, copy = 'minimal' }: {
  row: (typeof GRANT_ROWS)[number]; copy?: GrantCopy;
}) {
  const options = bashGrantOptions(row.command);
  const only = options.length === 1 ? options[0] : undefined;
  const [confirming, setConfirming] = React.useState(false);
  const [pick, setPick] = React.useState<string>('exact');

  // The heading. R1 left the shipped string in place, which is false the moment
  // the thing being granted is a branch rather than a command — this is the
  // question R2 exists to settle.
  const heading = copy === 'options'
    ? 'Remember this for youcoded?'
    : only?.scope === 'wide'
      ? `${only.label} in youcoded?`
      : only
        ? 'Always allow this exact command in youcoded?'
        : 'Always allow this in youcoded?';

  // Per-option sub-lines: 'options' folds the caveat into the row it belongs to.
  const sub = (scope: string) => copy !== 'options' ? null
    : scope === 'exact'
      ? 'Anything else — even one changed word — asks again.'
      : 'Run on its own. A command chained onto another one still asks.';

  // 'spelled' says the limits once, under the choice, in full.
  const limits = copy !== 'spelled' ? null
    : only?.scope === 'wide'
      ? "This won't cover deleting or force-pushing the branch, or this command chained onto another one."
      : "This won't cover the command chained onto another one, or run with options that change what it does.";

  // What the card says when there is nothing to remember at all.
  const noGrantNote = copy === 'minimal' ? null
    : copy === 'options'
      ? "Can't be remembered — this pushes whichever branch you're on at the time."
      : "There's nothing to remember here: this sends whichever branch is checked out when it runs, so next time it could be a different one.";

  return (
    <GrantAskShell row={row}>
      {confirming ? (
        <GrantConfirmShell command={row.command} heading={heading} denyListed={row.denyListed}>
          {options.length > 1 && (
            <RadioGroup
              options={options.map((o) => o.scope)}
              value={pick}
              onChange={setPick}
              aria-label="How much to allow"
              className="flex flex-col gap-1.5 pt-0.5"
            >
              {options.map((o) => (
                <button
                  key={o.scope}
                  type="button"
                  onClick={() => setPick(o.scope)}
                  className="flex items-start gap-2 text-left"
                >
                  <Radio checked={pick === o.scope} onChange={() => setPick(o.scope)} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-2xs text-fg-2 break-all">
                      {o.scope === 'exact' ? 'Only this exact command' : o.label}
                    </span>
                    {sub(o.scope) && <span className="block text-3xs text-fg-muted leading-relaxed">{sub(o.scope)}</span>}
                  </span>
                </button>
              ))}
            </RadioGroup>
          )}
          {limits && <p className="text-3xs text-fg-muted leading-relaxed">{limits}</p>}
          <div className="flex items-center gap-2">
            <button className={ASK_GREEN} onClick={() => setConfirming(false)}>Nevermind, allow once</button>
            <button className={ASK_RED}>Always allow</button>
          </div>
        </GrantConfirmShell>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <button className={ASK_GREEN}>{row.fullAuto ? 'Run it' : 'Yes'}</button>
            {options.length > 0 && (
              <>
                {row.fullAuto && <span className="text-fg-faint text-xs select-none">|</span>}
                <button
                  className={row.fullAuto ? ASK_ORANGE : ASK_BLUE}
                  onClick={() => setConfirming(true)}
                >
                  Always Allow
                </button>
              </>
            )}
            <button className={ASK_RED}>{row.fullAuto ? 'Skip it' : 'No'}</button>
          </div>
          {options.length === 0 && noGrantNote && (
            <p className="text-3xs text-fg-muted leading-relaxed">{noGrantNote}</p>
          )}
        </>
      )}
    </GrantAskShell>
  );
}

/** C — the card is unchanged; the confirm offers the exact grant as the primary
 *  action and the widening as a quieter second one beneath it. */
function GrantCandidateInline({ row }: { row: (typeof GRANT_ROWS)[number] }) {
  const options = bashGrantOptions(row.command);
  const exact = options.find((o) => o.scope === 'exact');
  const wide = options.find((o) => o.scope === 'wide');
  // The narrow option is the primary when there IS one. When the derivation
  // offered only the named grant (every `git push` row), that named grant IS the
  // primary — a secondary line offering the same thing twice is the confusion
  // this round already found once.
  const primary = exact ?? wide;
  const secondary = exact ? wide : undefined;
  const [confirming, setConfirming] = React.useState(false);
  return (
    <GrantAskShell row={row}>
      {confirming && primary ? (
        <GrantConfirmShell
          command={row.command}
          denyListed={row.denyListed}
          heading={primary.scope === 'exact'
            ? 'Always allow this exact command in youcoded?'
            : `${primary.label} in youcoded?`}
        >
          <div className="flex items-center gap-2">
            <button className={ASK_GREEN} onClick={() => setConfirming(false)}>Nevermind, allow once</button>
            <button className={ASK_RED}>
              {primary.scope === 'exact' ? 'Always allow this command' : widenLabel(primary.label)}
            </button>
          </div>
          {secondary && (
            <button className="text-3xs text-fg-muted hover:text-fg underline underline-offset-2 transition-colors text-left">
              Or {widenLabel(secondary.label).replace(/^Always allow /, 'always allow ')}
            </button>
          )}
        </GrantConfirmShell>
      ) : (
        <div className="flex items-center gap-2">
          <button className={ASK_GREEN}>{row.fullAuto ? 'Run it' : 'Yes'}</button>
          {options.length > 0 && (
            <>
              {row.fullAuto && <span className="text-fg-faint text-xs select-none">|</span>}
              <button
                className={row.fullAuto ? ASK_ORANGE : ASK_BLUE}
                onClick={() => setConfirming(true)}
              >
                Always Allow
              </button>
            </>
          )}
          <button className={ASK_RED}>{row.fullAuto ? 'Skip it' : 'No'}</button>
        </div>
      )}
    </GrantAskShell>
  );
}

/** One pane: all seven scenarios in the same candidate shape, each captioned
 *  with what it is meant to prove. Comparing one command across three shapes
 *  hides the cases where the shapes diverge — a row with one option, or none. */
function GrantWidthPane({ variant, copy }: {
  variant: 'buttons' | 'radio' | 'inline'; copy?: GrantCopy;
}) {
  return (
    <div className="flex flex-col gap-4">
      {GRANT_ROWS.map((row) => (
        <div key={row.command} className="flex flex-col gap-1">
          <p className="text-3xs text-fg-muted leading-relaxed">{row.why}</p>
          {variant === 'buttons' ? <GrantCandidateButtons row={row} />
            : variant === 'inline' ? <GrantCandidateInline row={row} />
              : <GrantCandidateRadio row={row} copy={copy} />}
        </div>
      ))}
    </div>
  );
}

// ── Chat search results: three treatments for the rejected find card ────────
// ChatsearchFindCard.tsx shipped and the owner rejected it on sight: it hand-
// rolled its two buttons instead of using Button, printed tags as plain
// "#tag" text instead of TagChip, and nothing on the card said these rows are
// PAST conversations rather than fresh search hits. All three candidates
// below fix all three defects identically — they differ only in how much the
// surrounding chrome does to say "this is a conversation from your history".
// Only the ARRANGEMENT changes; see the file header rule at the top of this
// file for why that's the only thing allowed to.

// Fixture tags are plain strings (e.g. 'perm', 'ui'); the real card will
// resolve each to a full TagRecord (id, color chosen in the Tag Picker) via
// useTagRegistry. This candidate-only helper cycles two of the app's real
// tag-color slots so TagChip has something to render — never invents a color
// system of its own.
const CHATSEARCH_TAG_COLORS = ['tag-blue', 'tag-teal'] as const;
function chatsearchTagChip(label: string, i: number): Pick<TagRecord, 'label' | 'color'> {
  return { label, color: CHATSEARCH_TAG_COLORS[i % CHATSEARCH_TAG_COLORS.length] };
}

// One shared array so all three candidates render the exact same six rows —
// the resumable case, the two disabled-Resume cases, the disabled-Preview
// case, the assistant-lane case, and a row chatsearch never resolved at all —
// and only the visual treatment differs. Explicit lookups (rather than a
// filter over CHATSEARCH_FIXTURE) so this list's order is the spec, not an
// accident of the fixture's authoring order.
const CHATSEARCH_RESULTS: ResolvedConversation[] = [
  CHATSEARCH_FIXTURE.find((c) => c.id === CS_RESUMABLE)!,
  CHATSEARCH_FIXTURE.find((c) => c.id === CS_MISSING_PROJECT)!,
  CHATSEARCH_FIXTURE.find((c) => c.id === CS_NOT_SYNCED)!,
  CHATSEARCH_FIXTURE.find((c) => c.id === CS_TOMBSTONE)!,
  CHATSEARCH_FIXTURE.find((c) => c.id === CS_NATIVE)!,
  { status: 'unknown', query: 'dead' },
];

/** Preview/Resume, built from the real Button — used by all three candidates
 *  below. This is the fix for defect 1 (SessionRefActions hand-rolls its
 *  buttons from raw classes): one shared place, real primitive, real variants.
 *  Inert on purpose — the workbench's fixture ids have no real session or
 *  transcript behind them, so wiring the real
 *  requestPreview/requestResume dispatchers (SessionRefActions.tsx) would
 *  fire events nothing here can honor. Only the visual result is under
 *  comparison. */
function ChatsearchActions({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  const blocked = r.missingProject ? COPY.resumeMissingProject : r.notSyncedYet ? COPY.resumeNotSynced : null;
  const native = r.provider === 'native';
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <Button
        variant="secondary" size="sm"
        disabled={r.tombstone}
        title={r.tombstone ? COPY.previewTombstone : COPY.previewHint}
      >
        {COPY.preview}
      </Button>
      <Button
        variant="primary" size="sm"
        disabled={!!blocked}
        title={blocked ?? (native ? COPY.resumeNativeHint : COPY.resumeHint)}
      >
        {native ? COPY.resumeNative : COPY.resume}
      </Button>
    </div>
  );
}

// ── A · resume-rows — "Resume Browser rows, in the chat" ────────────────────
// Maximum consistency: reproduces ResumeBrowser's own row anatomy (renderSessionRow,
// ResumeBrowser.tsx:867) verbatim, so a search result looks like the resume
// list the owner already uses daily rather than a new invention.
function ChatsearchRowA({ r }: { r: ResolvedConversation }) {
  if (r.status !== 'ok') {
    // Nothing chatsearch could resolve — no session to act on, so this row
    // just states the raw query and why, the same wording ChatsearchFindCard
    // falls back to, carried into a row shape so it still reads as a member
    // of the list rather than an error breaking out of it.
    return (
      <div className="rounded-lg border border-edge-dim bg-inset p-3">
        <div className="text-sm font-mono text-fg-muted truncate">{r.query}</div>
        <div className="text-3xs text-fg-muted mt-1">
          {r.status === 'ambiguous' ? COPY.ambiguousId(r.candidates.length) : COPY.unknownId}
        </div>
      </div>
    );
  }
  const blocked = r.missingProject ? COPY.resumeMissingProject : r.notSyncedYet ? COPY.resumeNotSynced : null;
  return (
    <div className="rounded-lg border border-edge-dim bg-inset hover:border-edge transition-colors p-3 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm truncate">
          {r.title || <span className="italic text-fg-muted">{COPY.untitled}</span>}
        </div>
        {r.tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 mt-1">
            {r.tags.map((t, i) => <TagChip key={t} tag={chatsearchTagChip(t, i)} />)}
          </div>
        )}
        <div className="flex items-center gap-1.5 text-3xs text-fg-muted mt-1">
          {blocked ? (
            // ResumeBrowser's house rule for the two blocked states: plain
            // words replace the whole metadata trail, no glyph.
            <span className="truncate">{blocked}</span>
          ) : (
            <>
              <span className="truncate">{r.projectName || COPY.noProject}</span>
              <span className="shrink-0 ml-auto">{formatRelativeTime(r.lastActive)}</span>
            </>
          )}
        </div>
      </div>
      <ChatsearchActions r={r} />
    </div>
  );
}

function ChatsearchResultsA() {
  return (
    <div className="flex flex-col gap-1.5">
      {/* The quiet header line is defect 3's fix for this candidate: it says
          in words that every row below is a PAST conversation, which nothing
          else on the row does. */}
      <div className="text-3xs text-fg-muted px-0.5">{COPY.headerFind(CHATSEARCH_RESULTS.length)}</div>
      <div className="space-y-1.5">
        {CHATSEARCH_RESULTS.map((r, i) => <ChatsearchRowA key={i} r={r} />)}
      </div>
    </div>
  );
}

// ── B · titled-panel — "One titled panel, compact rows inside" ──────────────
// The container does the explaining: a real header names the group, compact
// rows inside carry a leading ChatIcon so each one reads as a conversation at
// a glance even before the header registers.
function ChatsearchRowB({ r }: { r: ResolvedConversation }) {
  if (r.status !== 'ok') {
    return (
      <div className="rounded-md bg-inset/50 px-2.5 py-2 flex items-center gap-2">
        <ChatIcon className="w-3.5 h-3.5 text-fg-muted shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-mono text-fg-muted truncate">{r.query}</div>
          <div className="text-3xs text-fg-muted">
            {r.status === 'ambiguous' ? COPY.ambiguousId(r.candidates.length) : COPY.unknownId}
          </div>
        </div>
      </div>
    );
  }
  const blocked = r.missingProject ? COPY.resumeMissingProject : r.notSyncedYet ? COPY.resumeNotSynced : null;
  return (
    <div className="rounded-md bg-inset/50 px-2.5 py-2 flex items-center gap-2">
      <ChatIcon className="w-3.5 h-3.5 text-fg-muted shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs truncate">
            {r.title || <span className="italic text-fg-muted">{COPY.untitled}</span>}
          </span>
          {r.tags.map((t, i) => <TagChip key={t} tag={chatsearchTagChip(t, i)} />)}
        </div>
        <div className="text-3xs text-fg-muted truncate mt-0.5">
          {blocked ?? `${r.projectName || COPY.noProject} · ${formatRelativeTime(r.lastActive)}`}
        </div>
      </div>
      <ChatsearchActions r={r} />
    </div>
  );
}

function ChatsearchResultsB() {
  return (
    <div className="rounded-lg border border-edge bg-well overflow-hidden">
      <div className="text-2xs uppercase tracking-wider text-fg-muted px-3 py-2 border-b border-edge">
        {COPY.headerFind(CHATSEARCH_RESULTS.length)}
      </div>
      <div className="p-2 space-y-1">
        {CHATSEARCH_RESULTS.map((r, i) => <ChatsearchRowB key={i} r={r} />)}
      </div>
    </div>
  );
}

// ── C · stacked-cards — "Every result is its own conversation card" ─────────
// Drops the list metaphor entirely: each result gets the exact card
// ChatsearchShowCard already uses for a single opened conversation (same
// classes, same "Past conversation · <provider>" identity header), so a
// search hit and a deliberately-opened conversation are visually the same
// kind of object. That header line is this candidate's fix for defect 3 —
// reused rather than invented, because it's the one identity marker the
// owner has already seen and not rejected.
function ChatsearchCardC({ r }: { r: ResolvedConversation }) {
  if (r.status !== 'ok') {
    // No resolved conversation behind this row, so it does NOT get the "Past
    // conversation" header — claiming that here would be the unverified
    // guess the app's error-message rule forbids. Same fallback wording as
    // ChatsearchShowCard's own unknown-id case.
    return (
      <div className="rounded-lg border border-edge-dim bg-inset px-4 py-3">
        <div className="text-sm font-mono text-fg-muted truncate">{r.query}</div>
        <div className="text-xs text-fg-muted mt-1">
          {r.status === 'ambiguous' ? COPY.ambiguousId(r.candidates.length) : COPY.unknownId}
        </div>
      </div>
    );
  }
  const blocked = r.missingProject ? COPY.resumeMissingProject : r.notSyncedYet ? COPY.resumeNotSynced : null;
  return (
    <div className="rounded-lg border border-edge bg-well px-4 py-3">
      <div className="text-2xs uppercase tracking-wider text-fg-muted mb-1">
        {COPY.headerShow} · {providerLabel(r.provider)}
      </div>
      <h4 className="text-sm font-medium text-fg">
        {r.title || <span className="italic text-fg-muted">{COPY.untitled}</span>}
      </h4>
      <div className="text-xs text-fg-muted mt-0.5">
        {blocked ?? `${r.projectName || COPY.noProject} · ${formatRelativeTime(r.lastActive)}`}
        {r.tombstone && ` · ${COPY.previewTombstone}`}
      </div>
      {r.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 mt-1.5">
          {r.tags.map((t, i) => <TagChip key={t} tag={chatsearchTagChip(t, i)} />)}
        </div>
      )}
      <div className="flex items-center justify-end gap-1.5 mt-2.5">
        <ChatsearchActions r={r} />
      </div>
    </div>
  );
}

function ChatsearchResultsC() {
  // No group header by design — this candidate's whole bet is that the
  // per-card identity line carries defect 3 on its own, at the cost of the
  // most vertical space of the three (see the candidate's note below).
  return (
    <div className="space-y-2">
      {CHATSEARCH_RESULTS.map((r, i) => <ChatsearchCardC key={i} r={r} />)}
    </div>
  );
}

// ── Round 2: B (titled-panel) with the owner's three changes ────────────────
// He picked B and asked for three things: (1) a real open/close control, (2)
// drop the leading ChatIcon mark now that the panel header alone says "these
// are past conversations", (3) move tags off their own line and onto the
// project/date line. Row anatomy below is B's row with only those three
// changes — no other layout decision reopened.
function ChatsearchRowB2({ r }: { r: ResolvedConversation }) {
  if (r.status !== 'ok') {
    // Change 2: no leading ChatIcon — the panel header now carries that signal.
    return (
      <div className="rounded-md bg-inset/50 px-2.5 py-2">
        <div className="text-xs font-mono text-fg-muted truncate">{r.query}</div>
        <div className="text-3xs text-fg-muted">
          {r.status === 'ambiguous' ? COPY.ambiguousId(r.candidates.length) : COPY.unknownId}
        </div>
      </div>
    );
  }
  const blocked = r.missingProject ? COPY.resumeMissingProject : r.notSyncedYet ? COPY.resumeNotSynced : null;
  return (
    <div className="rounded-md bg-inset/50 px-2.5 py-2 flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs truncate">
          {r.title || <span className="italic text-fg-muted">{COPY.untitled}</span>}
        </div>
        {/* Change 3: tags join project/date here instead of sitting under the
            title. Order chosen as tags → project/blocked-reason → date: tags
            are the chips that used to sit immediately right of the title, so
            keeping them FIRST on this line is the smallest visual jump from
            R1; date stays pinned right (ml-auto) exactly as it was. When the
            row is blocked, the blocked sentence still replaces project+date
            (ResumeBrowser's house rule — plain words explain why nothing can
            be resumed), but tags stay visible since they're independent of
            resume eligibility. */}
        <div className="flex flex-wrap items-center gap-1 text-3xs text-fg-muted mt-0.5 min-w-0">
          {r.tags.map((t, i) => <TagChip key={t} tag={chatsearchTagChip(t, i)} />)}
          {blocked ? (
            <span className="truncate">{blocked}</span>
          ) : (
            <>
              <span className="truncate">{r.projectName || COPY.noProject}</span>
              <span className="shrink-0 ml-auto">{formatRelativeTime(r.lastActive)}</span>
            </>
          )}
        </div>
      </div>
      <ChatsearchActions r={r} />
    </div>
  );
}

/** Change 1: the panel header IS the open/close control. Shape copied from
 *  ToolBody's AgentSection / ToolCard's own header (border+rounded shell,
 *  `px-3 py-1.5` button, ChevronIcon pinned right with `expanded`) rather than
 *  invented, so this reads as the SAME disclosure the rest of the app already
 *  uses. `defaultOpen` is the only difference between the two candidates below
 *  — see their `note`s for the open-vs-closed trade-off. */
function ChatsearchPanelB2({ defaultOpen }: { defaultOpen: boolean }) {
  const [expanded, setExpanded] = React.useState(defaultOpen);
  return (
    <div className="rounded-lg border border-edge bg-well overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-1.5 text-2xs uppercase tracking-wider text-fg-muted px-3 py-2 text-left hover:bg-inset/50 transition-colors"
      >
        <span className="flex-1 truncate">{COPY.headerFind(CHATSEARCH_RESULTS.length)}</span>
        <ChevronIcon className="w-3.5 h-3.5 text-fg-muted shrink-0" expanded={expanded} />
      </button>
      {expanded && (
        <div className="p-2 space-y-1 border-t border-edge">
          {CHATSEARCH_RESULTS.map((r, i) => <ChatsearchRowB2 key={i} r={r} />)}
        </div>
      )}
    </div>
  );
}

// ── chatsearch-present — "the assistant puts a conversation in front of you" ──
// Distinct question from chatsearch-results above: that surface is a TOOL CARD
// (a search result the assistant found). This one is the assistant PRESENTING
// one it already has, mid-reply — the same relationship a `plan` segment has to
// its assistant bubble (AssistantTurnBubble.tsx: splitIntoBubbles ~204-282,
// PlanBubbleContent ~487-524). Every candidate below reproduces that bubble's
// own chrome (`assistant-bubble … rounded-2xl rounded-bl-sm bg-inset`,
// AssistantTurnBubble.tsx:421) around a nested box styled like
// PlanBubbleContent's own (`border-accent/40 … bg-accent/5`), so the owner
// judges these as they'd really sit in his chat — a presented conversation is a
// sibling of the plan bubble, not a card floating on the canvas. Reuses
// ChatsearchActions and chatsearchTagChip (declared above, for the search-card
// surface) and the real ChatsearchMetaLine component, so a presented
// conversation and a search-result row read as the same family of object,
// differing only in how much of the conversation shows.

// Always a SERIES of two: the owner asked for "a single conversation or a
// series," and a design that only works for one is not an answer. The
// resumable Claude-lane fixture plus the assistant-lane (native) one, so a
// candidate that only reads right for one lane can't sneak through.
const PRESENT_CONVERSATIONS: Extract<ResolvedConversation, { status: 'ok' }>[] = [
  CHATSEARCH_FIXTURE.find((c) => c.id === CS_RESUMABLE)!,
  CHATSEARCH_FIXTURE.find((c) => c.id === CS_NATIVE)!,
];

// Placeholder copy for the two content-bearing candidates below (present-excerpt,
// present-minitranscript). WHERE a real excerpt/transcript slice would come
// from — the user's last message, an assistant-written summary, a highlighted
// exchange — is NOT decided; this is invented, realistic-looking fixture text
// only, so the owner is judging the LAYOUT, not reading real conversation
// content. Called out again in the round's candidate notes and in the report.
const PRESENT_EXCERPT: Record<string, string> = {
  [CS_RESUMABLE]: '"…turned out to be the permission-ask timeout, not the disk read — bumping it from 3s to 8s should cover the slow-disk case too."',
  [CS_NATIVE]: '"The newsletter draft reads a little formal for this list — can you loosen the second paragraph and drop the opening line?"',
};
const PRESENT_TRANSCRIPT: Record<string, { role: 'user' | 'assistant'; text: string }[]> = {
  [CS_RESUMABLE]: [
    { role: 'user', text: 'Permission ask keeps timing out on the big repo scan — expected?' },
    { role: 'assistant', text: 'Shouldn’t be — that’s the ask timeout, not disk I/O. Checking the default now.' },
    { role: 'user', text: 'Bumping it from 3s to 8s fixed it. Want a PR?' },
    { role: 'assistant', text: 'Yes — note the slow-disk case in the commit message.' },
  ],
  [CS_NATIVE]: [
    { role: 'user', text: 'Draft the August newsletter intro?' },
    { role: 'assistant', text: 'First pass attached — three short paragraphs, casual tone.' },
    { role: 'user', text: 'Good start — loosen the second paragraph a bit.' },
  ],
};

/** The nested box every candidate below puts inside the assistant-bubble
 *  chrome — same shape as PlanBubbleContent's own box (border-accent/40,
 *  bg-accent/5), so a presented conversation reads as a sibling of the plan
 *  bubble rather than a new kind of thing. `children` is the per-candidate
 *  body (compact / excerpt / mini-transcript). */
function PresentedConversationsBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-accent/40 rounded-md bg-accent/5 px-3 py-2 my-0.5">
      <div className="flex items-center gap-2 mb-1.5 text-xs font-medium text-fg-2">
        <ChatIcon className="w-3.5 h-3.5" />
        <span>{COPY.referencedHeading}</span>
      </div>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

/** Title + lane eyebrow, shared by all three candidates. `COPY.paneSubtitle`
 *  already interpolates `providerLabel()` internally, which is how the lane
 *  gets named without any candidate touching the raw `provider` string. */
function PresentedTitle({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  return (
    <>
      <div className="text-4xs uppercase tracking-wider text-fg-muted">{COPY.paneSubtitle(r.provider)}</div>
      <div className="text-sm text-fg truncate mt-0.5">
        {r.title || <span className="italic text-fg-muted">{COPY.untitled}</span>}
      </div>
    </>
  );
}

/** Real Preview/Resume, right-aligned under each entry — same component the
 *  search-card surface above uses, so the button row can never say something
 *  different between the two. */
function PresentedActions({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  return (
    <div className="flex justify-end mt-1.5">
      <ChatsearchActions r={r} />
    </div>
  );
}

/** The metadata line every candidate shares — real ChatsearchMetaLine
 *  component, same tag rendering (chatsearchTagChip → TagChip) the search-card
 *  surface above uses. */
function PresentedMeta({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  return (
    <ChatsearchMetaLine
      tags={r.tags.map((t, i) => chatsearchTagChip(t, i))}
      blocked={r.missingProject ? COPY.resumeMissingProject : r.notSyncedYet ? COPY.resumeNotSynced : null}
      project={r.projectName || COPY.noProject}
      date={formatRelativeTime(r.lastActive)}
      className="mt-1"
    />
  );
}

// A · present-compact — "Just the essentials": title, metadata, actions. No
// message content at all — the baseline the other two candidates have to
// justify their extra height against.
function PresentCompactEntry({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  return (
    <div>
      <PresentedTitle r={r} />
      <PresentedMeta r={r} />
      <PresentedActions r={r} />
    </div>
  );
}
function PresentCompact() {
  return (
    <div className="flex justify-start px-4 py-0.5">
      <div className="assistant-bubble max-w-[85%] break-words rounded-2xl rounded-bl-sm bg-inset text-sm text-fg px-5 py-3.5">
        <PresentedConversationsBox>
          {PRESENT_CONVERSATIONS.map((r) => <PresentCompactEntry key={r.id} r={r} />)}
        </PresentedConversationsBox>
      </div>
    </div>
  );
}

// B · present-excerpt — "With a line or two from it": compact, plus one quoted
// line beneath the metadata, quieter and smaller than the title on purpose —
// it's a taste of the conversation, not a second headline. Clamped to ~2 lines
// so one long placeholder can't push this candidate past the mini-transcript one.
function PresentExcerptEntry({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  return (
    <div>
      <PresentedTitle r={r} />
      <p className="text-3xs text-fg-muted/80 italic leading-snug mt-1 line-clamp-2">
        {PRESENT_EXCERPT[r.id]}
      </p>
      <PresentedMeta r={r} />
      <PresentedActions r={r} />
    </div>
  );
}
function PresentExcerpt() {
  return (
    <div className="flex justify-start px-4 py-0.5">
      <div className="assistant-bubble max-w-[85%] break-words rounded-2xl rounded-bl-sm bg-inset text-sm text-fg px-5 py-3.5">
        <PresentedConversationsBox>
          {PRESENT_CONVERSATIONS.map((r) => <PresentExcerptEntry key={r.id} r={r} />)}
        </PresentedConversationsBox>
      </div>
    </div>
  );
}

// C · present-minitranscript — "A glimpse of the actual conversation": compact,
// plus a few real-looking chat bubbles — user right (bg-accent), assistant left
// (bg-canvas, so it reads against the box's own bg-accent/5 tint) — matching
// how the app draws chat bubbles elsewhere (project-view/ConversationPreview.tsx
// uses the same accent/inset split at full size). Fixed max-height +
// overflow-hidden means a long real conversation gets clipped, never grows the
// block; the fade at the bottom signals "there's more" instead of cutting a
// bubble off mid-sentence with a hard edge.
function PresentMiniTranscriptEntry({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  return (
    <div>
      <PresentedTitle r={r} />
      <div className="relative max-h-28 overflow-hidden mt-1.5">
        <div className="space-y-1">
          {PRESENT_TRANSCRIPT[r.id].map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[80%] break-words rounded-lg px-2 py-1 text-3xs ${
                  m.role === 'user'
                    ? 'rounded-br-sm bg-accent text-on-accent'
                    : 'rounded-bl-sm bg-canvas text-fg'
                }`}
              >
                {m.text}
              </div>
            </div>
          ))}
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-accent/5 to-transparent" />
      </div>
      <PresentedMeta r={r} />
      <PresentedActions r={r} />
    </div>
  );
}
function PresentMiniTranscript() {
  return (
    <div className="flex justify-start px-4 py-0.5">
      <div className="assistant-bubble max-w-[85%] break-words rounded-2xl rounded-bl-sm bg-inset text-sm text-fg px-5 py-3.5">
        <PresentedConversationsBox>
          {PRESENT_CONVERSATIONS.map((r) => <PresentMiniTranscriptEntry key={r.id} r={r} />)}
        </PresentedConversationsBox>
      </div>
    </div>
  );
}

// ── Round 2: reset ────────────────────────────────────────────────────────
// The owner rejected all three Round 1 candidates outright: "all way too busy
// with unclear visual hierarchy and structure." That fault wasn't in any one
// candidate's styling — it was the SHAPE every candidate copied:
// PresentedConversationsBox (an accent-tinted border + fill) nested inside the
// assistant bubble, with a second box per conversation inside that. Three
// containers deep before a single word of real content rendered. R2 throws
// that shape away rather than tweaking it.
//
// Every candidate below draws AT MOST one container of its own (a rule, a
// hover fill, or nothing) inside the assistant bubble — never a bordered
// accent box, never a per-row box — and cuts content to a title plus one
// quiet line. What differs between the three is genuinely the structure
// around that content, not how much got stuffed into a box, per the brief.
//
// Two more R1 faults, fixed identically here: (1) title, tags, project, date,
// and the lane label all rendered at near-identical weight, so nothing was
// the eye's first stop — every candidate below sets the title to
// text-sm font-medium and drops everything else to text-3xs text-fg-muted,
// including dropping R1's PresentedTitle eyebrow line entirely (that eyebrow
// doubled as the lane/provider label the R2 brief says to cut, and at
// text-4xs directly above the title it also crowded it). (2) two buttons per
// conversation — R2 has none. The whole row is the click target that opens
// the conversation: a real <button>, a visible hover state, and a focus
// ring, the same contract ResumeBrowser.tsx's own rows use
// (renderSessionRow, ResumeBrowser.tsx:917-927). Resume is not on this block
// at all — it moves to the preview panel's header per the brief. Tag chips
// are gone too; the brief named them explicitly as filling the box without
// helping recognition.
//
// Every row stays INERT like R1's ChatsearchActions buttons were: no real
// session backs a workbench fixture, so the buttons below are real,
// focusable, and keyboard-operable, but fire nothing on click.

/** Title only, no eyebrow line. R1's PresentedTitle rendered a "Past
 *  conversation · read-only · Claude Code" line above the title — the lane
 *  label the R2 brief says to cut, and it also visually competed with the
 *  title it sat above. The title alone, at font-medium, is the only text in
 *  this block at that weight — that's the entire hierarchy fix. */
function PresentedTitleOnly({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  return (
    <span className="block text-sm font-medium text-fg truncate">
      {r.title || <span className="italic font-normal text-fg-muted">{COPY.untitled}</span>}
    </span>
  );
}

/** The one quiet supporting line every candidate is allowed. Real
 *  ChatsearchMetaLine with an empty tag list — project/date/blocked read
 *  exactly as they do on the search-card surface above, just without the
 *  chips the R2 brief says to drop, and without redrawing the layout by
 *  hand. */
function PresentedMetaQuiet({ r, className }: {
  r: Extract<ResolvedConversation, { status: 'ok' }>; className?: string;
}) {
  const blocked = r.missingProject ? COPY.resumeMissingProject : r.notSyncedYet ? COPY.resumeNotSynced : null;
  return (
    <ChatsearchMetaLine
      tags={[]}
      blocked={blocked}
      project={r.projectName || COPY.noProject}
      date={formatRelativeTime(r.lastActive)}
      className={className}
    />
  );
}

/** Plain-text section label, shared by all three — NOT a box, so it does not
 *  count against the one-container budget each candidate is held to. Kept so
 *  the block still says "these are past conversations" without spending a
 *  container to say it. */
function PresentedHeading() {
  return (
    <div className="text-4xs uppercase tracking-wider text-fg-muted mb-2">
      {COPY.referencedHeading}
    </div>
  );
}

// A · present-plain-list — "No container at all". Whitespace alone groups the
// two entries — no border, no fill, no rule ever drawn at rest. The only
// visual feedback is a soft hover fill that appears and disappears; nothing
// is drawn when the pointer is elsewhere. The most restrained possible
// answer, and the baseline the other two have to beat.
function PresentPlainListEntry({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  return (
    <button
      type="button"
      disabled={r.tombstone}
      title={r.tombstone ? COPY.previewTombstone : COPY.previewHint}
      className="group block w-full text-left rounded-md -mx-2 px-2 py-1.5 transition-colors hover:bg-well disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <PresentedTitleOnly r={r} />
      <PresentedMetaQuiet r={r} className="mt-0.5" />
    </button>
  );
}
function PresentPlainList() {
  return (
    <div className="flex justify-start px-4 py-0.5">
      <div className="assistant-bubble max-w-[85%] break-words rounded-2xl rounded-bl-sm bg-inset text-sm text-fg px-5 py-3.5">
        <PresentedHeading />
        <div className="flex flex-col gap-3">
          {PRESENT_CONVERSATIONS.map((r) => <PresentPlainListEntry key={r.id} r={r} />)}
        </div>
      </div>
    </div>
  );
}

// B · present-quoted — "Quoted, like a reference". One left accent rule spans
// the WHOLE group; both entries stack against it. The rule is the entire
// container — nothing else is drawn around either row — which is what makes
// this a line rather than a box that happens to wear a border. Says "these
// are things I'm referring to" the way a blockquote does.
function PresentQuotedEntry({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  return (
    <button
      type="button"
      disabled={r.tombstone}
      title={r.tombstone ? COPY.previewTombstone : COPY.previewHint}
      className="group block w-full rounded-sm px-1.5 py-1 text-left transition-colors hover:bg-well/60 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <PresentedTitleOnly r={r} />
      <PresentedMetaQuiet r={r} className="mt-0.5" />
    </button>
  );
}
function PresentQuoted() {
  return (
    <div className="flex justify-start px-4 py-0.5">
      <div className="assistant-bubble max-w-[85%] break-words rounded-2xl rounded-bl-sm bg-inset text-sm text-fg px-5 py-3.5">
        <PresentedHeading />
        <div className="flex flex-col gap-2 border-l-2 border-accent/40 pl-3">
          {PRESENT_CONVERSATIONS.map((r) => <PresentQuotedEntry key={r.id} r={r} />)}
        </div>
      </div>
    </div>
  );
}

// C · present-attachments — "Attached items". Each conversation collapses to
// ONE row: a small leading mark (AttachIcon, the app's real paperclip glyph),
// the title, and the time right-aligned on the SAME line — no second
// metadata line at all. That is the structural difference from the other
// two, not just a density choice: time alone is the whole supporting line, so
// project name is dropped from this candidate specifically as the trade-off
// for reading like a list of attached items rather than a list of summaries.
function PresentAttachmentEntry({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  return (
    <button
      type="button"
      disabled={r.tombstone}
      title={r.tombstone ? COPY.previewTombstone : COPY.previewHint}
      className="group flex w-full items-center gap-2 rounded-md -mx-2 px-2 py-2 transition-colors hover:bg-well disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <AttachIcon className="w-3.5 h-3.5 shrink-0 text-fg-muted" />
      <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-fg">
        {r.title || <span className="italic font-normal text-fg-muted">{COPY.untitled}</span>}
      </span>
      <span className="shrink-0 text-3xs text-fg-muted">{formatRelativeTime(r.lastActive)}</span>
    </button>
  );
}
function PresentAttachments() {
  return (
    <div className="flex justify-start px-4 py-0.5">
      <div className="assistant-bubble max-w-[85%] break-words rounded-2xl rounded-bl-sm bg-inset text-sm text-fg px-5 py-3.5">
        <PresentedHeading />
        <div className="divide-y divide-edge-dim/60">
          {PRESENT_CONVERSATIONS.map((r) => <PresentAttachmentEntry key={r.id} r={r} />)}
        </div>
      </div>
    </div>
  );
}

// ── Round 3: reset, again — stop inventing treatments ────────────────────────
// R2 was rejected harder than R1: "that's worse. it def still needs the
// preview/resume buttons and it needs to be consistent with other ui
// elements." Two separate faults, fixed by two separate rules this round:
//
// 1. Preview/Resume come back as REAL Button primitives (ChatsearchActions,
//    declared above — same variant="secondary"/"primary" size="sm" pair
//    SessionRefActions.tsx uses on the shipped search card). R2's click-the-
//    row design had no buttons at all.
// 2. Every candidate below is a literal, verbatim reuse of ONE already-shipped
//    app element — not a new arrangement inspired by one. That is the fix for
//    "needs to be consistent with other ui elements": consistency isn't a
//    style note anymore, it's the entire content of each candidate. If a
//    className below isn't copied from the file it credits, that's a bug in
//    the candidate.
//
// The three elements borrowed, one each: the search-results row
// (ChatsearchFindCard.tsx's ChatsearchRow, the surface the owner already
// approved one comparison up), the plan bubble (AssistantTurnBubble.tsx's
// PlanBubbleContent, the app's only other mid-message element — reuses
// PresentedConversationsBox from R1 verbatim, since that box was already
// built to match PlanBubbleContent's own classes), and the Resume Browser
// card (ResumeBrowser.tsx's renderSessionRow card shell). All three render
// the title → tagged metadata line (project, date pinned right) exactly as
// ChatsearchMetaLine already renders it on the approved search row — no
// candidate re-types that composition by hand.

/** Title line, verbatim from ChatsearchFindCard.tsx's ChatsearchRow (`text-xs
 *  truncate text-fg`) — NOT R1/R2's text-sm title, which was never the
 *  approved row's actual class. Shared by all three R3 candidates so the
 *  title reads identically regardless of which container it sits in. */
function PresentRowTitle({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  return (
    <div className="text-xs truncate text-fg">
      {r.title || <span className="italic text-fg-muted">{COPY.untitled}</span>}
    </div>
  );
}

/** The real ChatsearchMetaLine, fed the same three things every other surface
 *  in this file feeds it — never rebuilt by hand, so tag/project/date order
 *  can't drift between "found" and "presented". */
function PresentRowMeta({ r, className }: {
  r: Extract<ResolvedConversation, { status: 'ok' }>; className?: string;
}) {
  const blocked = r.missingProject ? COPY.resumeMissingProject : r.notSyncedYet ? COPY.resumeNotSynced : null;
  return (
    <ChatsearchMetaLine
      tags={r.tags.map((t, i) => chatsearchTagChip(t, i))}
      blocked={blocked}
      project={r.projectName || COPY.noProject}
      date={formatRelativeTime(r.lastActive)}
      className={className}
    />
  );
}

// A · present-as-search-row — borrows ChatsearchFindCard.tsx's ChatsearchRow
// (lines 17-46) unchanged: the same `<li className="rounded-md bg-inset/50
// px-2.5 py-2 flex items-center gap-2">`, the same title/meta stack on the
// left, the same actions on the right — inside a bare `<ul className=
// "space-y-1">`, no extra box around the group. This is the row the owner
// already signed off on for search results; here it sits in the assistant's
// own bubble instead of a tool card, which is the ONLY thing distinguishing
// "presented" from "found" — everything else is identical on purpose.
function PresentSearchRowEntry({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  return (
    <li className="rounded-md bg-inset/50 px-2.5 py-2 flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <PresentRowTitle r={r} />
        <PresentRowMeta r={r} className="mt-0.5" />
      </div>
      <ChatsearchActions r={r} />
    </li>
  );
}
function PresentSearchRow() {
  return (
    <div className="flex justify-start px-4 py-0.5">
      <div className="assistant-bubble max-w-[85%] break-words rounded-2xl rounded-bl-sm bg-inset text-sm text-fg px-5 py-3.5">
        <ul className="space-y-1">
          {PRESENT_CONVERSATIONS.map((r) => <PresentSearchRowEntry key={r.id} r={r} />)}
        </ul>
      </div>
    </div>
  );
}

// B · present-as-plan-box — borrows PresentedConversationsBox from R1 above
// UNCHANGED (that box was already built, before R1 shipped, to reproduce
// PlanBubbleContent's own `border-accent/40 rounded-md bg-accent/5 px-3 py-2`
// shell and its `text-xs font-medium text-fg-2` header line — see the box's
// own comment). Reusing the function rather than re-authoring it is the
// point: candidate B is not "styled like the plan bubble", it is drawn by
// the exact box that already mimics it. Each entry inside is the row content
// (title, meta line, actions right-aligned below) — no per-entry box, since
// the plan bubble itself never nests a second box per line of its body.
function PresentPlanBoxEntry({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  return (
    <div>
      <PresentRowTitle r={r} />
      <PresentRowMeta r={r} className="mt-0.5" />
      <div className="flex justify-end mt-1.5">
        <ChatsearchActions r={r} />
      </div>
    </div>
  );
}
function PresentPlanBox() {
  return (
    <div className="flex justify-start px-4 py-0.5">
      <div className="assistant-bubble max-w-[85%] break-words rounded-2xl rounded-bl-sm bg-inset text-sm text-fg px-5 py-3.5">
        <PresentedConversationsBox>
          {PRESENT_CONVERSATIONS.map((r) => <PresentPlanBoxEntry key={r.id} r={r} />)}
        </PresentedConversationsBox>
      </div>
    </div>
  );
}

// C · present-as-resume-card — borrows the Resume Browser's own card shell
// (ResumeBrowser.tsx renderSessionRow, ~line 908): `rounded-lg border bg-inset
// overflow-hidden transition-colors`, with the row's own at-rest/hover pair
// (`border-edge-dim hover:border-edge`) rather than the expanded/inert
// variants, since a presented conversation is never expanded or unresumable
// by construction. One card per conversation, stacked — not the single
// multi-row card ResumeBrowser groups by project, since this block only ever
// shows the two conversations being presented, not a whole list.
function PresentResumeCardEntry({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  return (
    <div className="rounded-lg border border-edge-dim hover:border-edge bg-inset overflow-hidden transition-colors p-3">
      <PresentRowTitle r={r} />
      <PresentRowMeta r={r} className="mt-0.5" />
      <div className="flex justify-end mt-2">
        <ChatsearchActions r={r} />
      </div>
    </div>
  );
}
function PresentResumeCard() {
  return (
    <div className="flex justify-start px-4 py-0.5">
      <div className="assistant-bubble max-w-[85%] break-words rounded-2xl rounded-bl-sm bg-inset text-sm text-fg px-5 py-3.5">
        <div className="flex flex-col gap-2">
          {PRESENT_CONVERSATIONS.map((r) => <PresentResumeCardEntry key={r.id} r={r} />)}
        </div>
      </div>
    </div>
  );
}

// ── Round 4: mimic the Deliverables card ─────────────────────────────────
// R3's three literal-reuse candidates were never rejected on their own
// merits — the owner instead named the target himself: "you should try to
// mimic the design of the new 'deliverables' card somewhat." The reference is
// DeliverablesCard.tsx (src/renderer/components/DeliverablesCard.tsx on
// branch feat/send-user-file-card) — an ALREADY-APPROVED card (workbench
// compare rounds, pick "D + scroll-aware fades + collapsible") that renders
// mid-message inside the assistant's own bubble, exactly like this surface:
// a collapsible bg-well card, open by default, holding a horizontal filmstrip
// of preview tiles under a header row that is itself the collapse button.
//
// WHY every piece below is redrawn rather than imported: feat/send-user-file-
// card has not merged into this branch, so DeliverablesCard and its private
// helpers (SentFileTile, its edge-overflow hook) are not reachable from here.
// Classes, hook usage, and structure are copied verbatim from that file so
// the comparison is against the real approved design, not a guess at it. WHEN
// feat/send-user-file-card merges, the shared shell — card chrome, the
// header-button anatomy, the filmstrip + edge-fade mechanism, the tile frame
// — should be extracted into ONE component both features import, rather than
// kept as two hand-synced copies. Flagged again in the round-4 report.
//
// A deliverable tile previews a FILE (ArtifactThumbnail: image / first lines
// of text / scaled HTML / letter glyph). A conversation has no file to
// preview, so its stand-in is the conversation's OPENING MESSAGE, shown small
// and clipped the same way ArtifactThumbnail clips text — see
// OpeningMessagePreview below. Where that opening-message text would really
// come from (the session's first user message, verbatim? summarized?) is not
// decided — invented fixture text only, flagged again in the report, same
// caveat as Round 1's PRESENT_EXCERPT above.
//
// Tag chips are omitted here on purpose: "too busy" was the very first
// rejection (R1), and the deliverables tile this round mimics shows only a
// name and a path — no chips at all. Reuses PresentedMetaQuiet (declared for
// R2 above), which already renders project + date with an empty tag list.
// This is a deliberate, reversible call — flagged again in the report.
const PRESENT_OPENING_MESSAGE: Record<string, string> = {
  [CS_RESUMABLE]: 'Permission ask keeps timing out on the big repo scan — is that expected, or did something regress?',
  [CS_NATIVE]: 'Can you draft the August newsletter intro? Keep it short — three short paragraphs, casual tone.',
};

/** Stand-in for ArtifactThumbnail's "first lines of a text file" preview —
 *  see the round header comment for why a conversation needs one at all.
 *  Sans-serif and quoted rather than ArtifactThumbnail's font-mono: that
 *  choice is for source CODE, and this is conversational speech, so it
 *  borrows Round 1's present-excerpt treatment (italic, quoted) instead. */
function OpeningMessagePreview({ text }: { text: string }) {
  return (
    <div className="absolute inset-0 p-2 overflow-hidden">
      <p className="text-3xs leading-snug text-fg-2 italic line-clamp-5">“{text}”</p>
    </div>
  );
}

/** Same edge-overflow tracker DeliverablesCard.tsx's filmstrip uses for its
 *  fades (useEdgeOverflow there — private to that file, so redrawn here per
 *  the round header WHY comment). Fades appear only while something is
 *  actually hidden past that edge. */
function usePresentEdgeOverflow(ref: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const [edges, setEdges] = React.useState({ left: false, right: false });
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const left = el.scrollLeft > 2;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', measure); ro.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return edges;
}
const presentFade = (side: 'left' | 'right') => ({
  background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, var(--well), transparent)`,
});

/** The header row IS the collapse button, same anatomy as DeliverablesCard's
 *  own header: leading glyph, label, count, a right-aligned truncating
 *  caption, trailing chevron. ChatIcon substitutes for DeliverablesCard's
 *  FilesGlyph — the app's own "this is a conversation" mark (see this file's
 *  ChatIcon import comment). The caption slot is reproduced for structural
 *  fidelity but always empty: a presented conversation has no equivalent yet
 *  of the SendUserFile tool's optional caption argument. */
function PresentCardHeader({ open, onToggle, count }: { open: boolean; onToggle: () => void; count: number }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-inset/50 transition-colors"
    >
      <ChatIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
      <span className="text-xs font-semibold text-fg-2">{COPY.referencedHeading}</span>
      <span className="text-2xs font-mono text-fg-muted">{count}</span>
      <span className="flex-1 min-w-0 text-2xs text-fg-muted truncate text-right" />
      <ChevronIcon className="w-3.5 h-3.5 shrink-0 text-fg-muted" expanded={open} />
    </button>
  );
}

/** The deliverables-style card shell: `mt-2 rounded-lg border border-edge
 *  bg-well overflow-hidden`, open by default (`getInitialExpanded(true)`),
 *  Ctrl+O expand/collapse-all aware. `children` is the round-4-candidate-
 *  specific body — a filmstrip or a stacked-rows list. */
function PresentCard({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(() => getInitialExpanded(true));
  useExpandAllToggle(() => setOpen(true), () => setOpen(false));
  return (
    <div className="mt-2 rounded-lg border border-edge bg-well overflow-hidden" data-testid="present-card">
      <PresentCardHeader open={open} onToggle={() => setOpen(!open)} count={PRESENT_CONVERSATIONS.length} />
      {open && children}
    </div>
  );
}

function PresentInBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-start px-4 py-0.5">
      <div className="assistant-bubble max-w-[85%] break-words rounded-2xl rounded-bl-sm bg-inset text-sm text-fg px-5 py-3.5">
        {children}
      </div>
    </div>
  );
}

/** Name line shared by all three Round 4 tile layouts — verbatim
 *  DeliverablesCard SentFileTile classes (`text-sm-tight font-semibold
 *  text-fg truncate`), not R2/R3's `text-sm`. */
function PresentTileName({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  return (
    <span className="block text-sm-tight font-semibold text-fg truncate">
      {r.title || <span className="italic font-normal text-fg-muted">{COPY.untitled}</span>}
    </span>
  );
}

/** DeliverablesCard's own compact "Open" arrow badge (SentFileTile,
 *  `compact` prop), redrawn here per the round header WHY comment. Present-
 *  filmstrip-arrow's Preview affordance. */
function CompactArrowBadge({ onClick, disabled, title }: {
  onClick: (e: React.MouseEvent) => void; disabled?: boolean; title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={COPY.preview}
      className="shrink-0 inline-flex items-center p-1 text-fg-2 border border-edge hover:border-fg-muted rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 7h10v10" />
        <path d="M7 17 17 7" />
      </svg>
    </button>
  );
}

/** A second compact affordance beside the arrow — present-filmstrip-arrow's
 *  Resume action. No shared "resume" glyph exists on this branch (the Resume
 *  Browser spells the word out on a full-size button), so this is a small
 *  play-triangle, drawn inline the same way SentFileTile draws its own arrow
 *  inline rather than as a shared Icons.tsx export. */
function CompactResumeBadge({ onClick, disabled, title, label }: {
  onClick: (e: React.MouseEvent) => void; disabled?: boolean; title: string; label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      className="shrink-0 inline-flex items-center p-1 text-fg-2 border border-edge hover:border-fg-muted rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5v14l11-7z" />
      </svg>
    </button>
  );
}

// A · present-filmstrip-arrow — closest to the reference. The WHOLE tile is
// one <button> that opens the preview, exactly the way SentFileTile's whole
// tile opens its file — the footer just carries the same compact bordered
// arrow (restating that action) plus a second, equally small affordance for
// Resume beside it. Two real <button>s nested inside the tile's own <button>,
// each stopping propagation — the same nested-button-plus-stopPropagation
// shape SkillCard.tsx already ships (PluginBadge inside the card's own
// button), not a new pattern invented for this candidate.
function FilmstripArrowTile({ r, narrow }: { r: Extract<ResolvedConversation, { status: 'ok' }>; narrow: boolean }) {
  const blocked = r.missingProject ? COPY.resumeMissingProject : r.notSyncedYet ? COPY.resumeNotSynced : null;
  const native = r.provider === 'native';
  return (
    <button
      type="button"
      disabled={r.tombstone}
      title={r.tombstone ? COPY.previewTombstone : COPY.previewHint}
      className="group flex flex-col w-full min-w-0 text-left rounded-lg bg-inset border border-edge hover:border-fg-muted overflow-hidden transition-colors disabled:opacity-70"
    >
      <div className={`relative w-full ${narrow ? 'h-16' : 'h-28'} border-b border-edge`}>
        <OpeningMessagePreview text={PRESENT_OPENING_MESSAGE[r.id]} />
      </div>
      <div className="flex items-start gap-2 px-2.5 py-2 min-w-0">
        <span className="flex-1 min-w-0">
          <PresentTileName r={r} />
          <PresentedMetaQuiet r={r} className="mt-0.5" />
        </span>
        <div className="flex items-center gap-1 shrink-0 pt-0.5">
          <CompactArrowBadge
            onClick={(e) => e.stopPropagation()}
            disabled={r.tombstone}
            title={r.tombstone ? COPY.previewTombstone : COPY.previewHint}
          />
          <CompactResumeBadge
            onClick={(e) => e.stopPropagation()}
            disabled={!!blocked}
            title={blocked ?? (native ? COPY.resumeNativeHint : COPY.resumeHint)}
            label={native ? COPY.resumeNative : COPY.resume}
          />
        </div>
      </div>
    </button>
  );
}
function PresentFilmstripArrow() {
  const narrow = useNarrowViewport();
  const stripRef = React.useRef<HTMLDivElement>(null);
  const edges = usePresentEdgeOverflow(stripRef, [narrow]);
  return (
    <PresentInBubble>
      <PresentCard>
        <div className="relative">
          <div ref={stripRef} className="flex gap-2 overflow-x-auto px-2 pb-2" data-testid="present-strip-arrow">
            {PRESENT_CONVERSATIONS.map((r) => (
              <div key={r.id} className={`${narrow ? 'w-44' : 'w-56'} shrink-0`}>
                <FilmstripArrowTile r={r} narrow={narrow} />
              </div>
            ))}
          </div>
          {edges.left && <div className="pointer-events-none absolute top-0 bottom-2 left-0 w-10" style={presentFade('left')} />}
          {edges.right && <div className="pointer-events-none absolute top-0 bottom-2 right-0 w-10" style={presentFade('right')} />}
        </div>
      </PresentCard>
    </PresentInBubble>
  );
}

// B · present-filmstrip-buttons — same filmstrip, same tiles, but the footer
// swaps the two glyph affordances for the real ChatsearchActions pair (the
// same variant="secondary"/"primary" size="sm" Preview/Resume Buttons every
// other round already uses) — explicit at the cost of crowding a `w-44`
// narrow tile, which is the trade-off this candidate exists to show.
function FilmstripButtonsTile({ r, narrow }: { r: Extract<ResolvedConversation, { status: 'ok' }>; narrow: boolean }) {
  return (
    <button
      type="button"
      disabled={r.tombstone}
      title={r.tombstone ? COPY.previewTombstone : COPY.previewHint}
      className="group flex flex-col w-full min-w-0 text-left rounded-lg bg-inset border border-edge hover:border-fg-muted overflow-hidden transition-colors disabled:opacity-70"
    >
      <div className={`relative w-full ${narrow ? 'h-16' : 'h-28'} border-b border-edge`}>
        <OpeningMessagePreview text={PRESENT_OPENING_MESSAGE[r.id]} />
      </div>
      <div className="px-2.5 pt-2 pb-2 min-w-0">
        <PresentTileName r={r} />
        <PresentedMetaQuiet r={r} className="mt-0.5" />
        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
          <ChatsearchActions r={r} />
        </div>
      </div>
    </button>
  );
}
function PresentFilmstripButtons() {
  const narrow = useNarrowViewport();
  const stripRef = React.useRef<HTMLDivElement>(null);
  const edges = usePresentEdgeOverflow(stripRef, [narrow]);
  return (
    <PresentInBubble>
      <PresentCard>
        <div className="relative">
          <div ref={stripRef} className="flex gap-2 overflow-x-auto px-2 pb-2" data-testid="present-strip-buttons">
            {PRESENT_CONVERSATIONS.map((r) => (
              <div key={r.id} className={`${narrow ? 'w-44' : 'w-56'} shrink-0`}>
                <FilmstripButtonsTile r={r} narrow={narrow} />
              </div>
            ))}
          </div>
          {edges.left && <div className="pointer-events-none absolute top-0 bottom-2 left-0 w-10" style={presentFade('left')} />}
          {edges.right && <div className="pointer-events-none absolute top-0 bottom-2 right-0 w-10" style={presentFade('right')} />}
        </div>
      </PresentCard>
    </PresentInBubble>
  );
}

// C · present-stacked-rows — same card shell and header, but the body is a
// VERTICAL stack of full-width rows instead of a sideways filmstrip: a small
// square preview thumbnail on the left, title + the quiet metadata line in
// the middle, the two explicit Buttons on the right. No sideways scrolling,
// nothing hidden off an edge — reads better for the one-or-two-conversation
// case this surface's own fixture always shows.
function StackedRow({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  return (
    <button
      type="button"
      disabled={r.tombstone}
      title={r.tombstone ? COPY.previewTombstone : COPY.previewHint}
      className="group flex items-center gap-3 w-full min-w-0 text-left rounded-lg bg-inset border border-edge hover:border-fg-muted overflow-hidden transition-colors p-2 disabled:opacity-70"
    >
      <div className="relative w-16 h-16 shrink-0 rounded-md overflow-hidden border border-edge">
        <OpeningMessagePreview text={PRESENT_OPENING_MESSAGE[r.id]} />
      </div>
      <span className="flex-1 min-w-0">
        <PresentTileName r={r} />
        <PresentedMetaQuiet r={r} className="mt-0.5" />
      </span>
      <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
        <ChatsearchActions r={r} />
      </div>
    </button>
  );
}
function PresentStackedRows() {
  return (
    <PresentInBubble>
      <PresentCard>
        <div className="flex flex-col gap-2 px-2 pb-2">
          {PRESENT_CONVERSATIONS.map((r) => <StackedRow key={r.id} r={r} />)}
        </div>
      </PresentCard>
    </PresentInBubble>
  );
}

// ── Round 5: drop the quote, tighten the row ─────────────────────────────
// The owner picked R4's C (present-stacked-rows): "i like c (stacked) but we
// should drop the full quote and try to improve space efficiency/layout a
// bit." Two instructions, two changes: the OpeningMessagePreview quote/
// thumbnail is gone from every candidate below — there is no file to preview
// a stand-in for any more, so nothing replaces the square it sat in, the
// whole row just gets narrower — and padding drops from R4's `p-2` (sized
// around a 64px-tall thumbnail) to what a one- or two-line text row actually
// needs.
//
// Card shell and header are UNCHANGED from R4's PresentCard/PresentCardHeader
// (deliverables-card chrome), except for open state: this round starts
// CLOSED (getInitialExpanded(), the plain tool-card default) rather than R4's
// getInitialExpanded(true). Two independent decisions already point the same
// way — the owner chose closed-by-default for this feature's own search card
// (chatsearch-results R2, `b-closed`), and DeliverablesCard.tsx, the very
// card this shell copies, flipped from open to closed on its own branch
// after Destin saw it open on a real screen (see that file's header comment,
// 2026-08-25). PresentCard itself is left untouched (never edit an earlier
// round) — PresentCardClosed below is a new sibling, not an edit.
//
// With the thumbnail gone, a presented-conversation row is now built from
// exactly the same three things a search-result row is (ChatsearchFindCard.tsx):
// title, a project/date line, and the Preview/Resume buttons. So every
// candidate below is built from PresentRowTitle and PresentedMetaQuiet — both
// already declared above, for R3 and R2 respectively — never re-typed, so the
// two surfaces can't drift on what a "title" or a "date" looks like even
// though this round rearranges them three different ways. Tags stay dropped,
// same reversible call R4 made (flagged again here): none of the three
// layouts the owner asked for name a tag chip.
//
// Rows are plain, non-interactive containers (`rounded-md bg-inset/50`, the
// search row's own fill) rather than R4's whole-row `<button>` — R4's button
// existed so the thumbnail was clickable; with no thumbnail, Preview/Resume
// are the only affordance (per the brief), so a second, redundant click
// target on the row itself would just be a lie about what clicking it does.

function PresentCardClosed({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(() => getInitialExpanded());
  useExpandAllToggle(() => setOpen(true), () => setOpen(false));
  return (
    <div className="mt-2 rounded-lg border border-edge bg-well overflow-hidden" data-testid="present-card-r5">
      <PresentCardHeader open={open} onToggle={() => setOpen(!open)} count={PRESENT_CONVERSATIONS.length} />
      {open && children}
    </div>
  );
}

// A · present-row-single — one line per conversation: title, then project ·
// date as one quiet clause, then the buttons. NOT ChatsearchMetaLine here —
// that component's own `ml-auto` date assumes it owns the full row width; in
// a single line shared with a title and two buttons it has none, so project
// and date are joined into one clause and given a max-width instead. The
// blocked sentence (missingProject/notSyncedYet) still replaces that clause
// wholesale, same house rule ChatsearchMetaLine documents for the two-line
// candidates below.
function PresentRowSingleEntry({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  const blocked = r.missingProject ? COPY.resumeMissingProject : r.notSyncedYet ? COPY.resumeNotSynced : null;
  const meta = blocked ?? `${r.projectName || COPY.noProject} · ${formatRelativeTime(r.lastActive)}`;
  return (
    <div className="flex items-center gap-2 rounded-md bg-inset/50 px-2.5 py-1.5">
      <div className="min-w-0 flex-1"><PresentRowTitle r={r} /></div>
      <span className="shrink-0 max-w-[9rem] truncate text-3xs text-fg-muted" title={meta}>{meta}</span>
      <ChatsearchActions r={r} />
    </div>
  );
}
function PresentRowSingle() {
  return (
    <PresentInBubble>
      <PresentCardClosed>
        <div className="flex flex-col gap-1 px-2 pb-2">
          {PRESENT_CONVERSATIONS.map((r) => <PresentRowSingleEntry key={r.id} r={r} />)}
        </div>
      </PresentCardClosed>
    </PresentInBubble>
  );
}

// B · present-row-two-line — title on its own line, PresentedMetaQuiet
// (project/date or blocked, verbatim from R2) on a second line beneath it,
// buttons at the right and vertically centred across both by the row's own
// `items-center`. The most conventional list row of the three.
function PresentRowTwoLineEntry({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  return (
    <div className="flex items-center gap-3 rounded-md bg-inset/50 px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <PresentRowTitle r={r} />
        <PresentedMetaQuiet r={r} className="mt-0.5" />
      </div>
      <ChatsearchActions r={r} />
    </div>
  );
}
function PresentRowTwoLine() {
  return (
    <PresentInBubble>
      <PresentCardClosed>
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          {PRESENT_CONVERSATIONS.map((r) => <PresentRowTwoLineEntry key={r.id} r={r} />)}
        </div>
      </PresentCardClosed>
    </PresentInBubble>
  );
}

// C · present-row-split — two lines that each use the full row width: title
// left / date pinned right (`shrink-0 ml-auto`, the same date-pinning class
// ChatsearchMetaLine itself uses) on line one, project left / buttons right
// on line two. When blocked, the date on line one is withheld and the
// blocked sentence takes project's place on line two — the same "blocked
// replaces project+date as a pair" house rule ChatsearchMetaLine documents,
// just spread across two lines instead of composited into one span.
function PresentRowSplitEntry({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  const blocked = r.missingProject ? COPY.resumeMissingProject : r.notSyncedYet ? COPY.resumeNotSynced : null;
  return (
    <div className="rounded-md bg-inset/50 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1"><PresentRowTitle r={r} /></div>
        {!blocked && (
          <span className="shrink-0 ml-auto text-3xs text-fg-muted">{formatRelativeTime(r.lastActive)}</span>
        )}
      </div>
      <div className="flex items-center gap-2 mt-1">
        <span className="min-w-0 flex-1 truncate text-3xs text-fg-muted">{blocked ?? (r.projectName || COPY.noProject)}</span>
        <ChatsearchActions r={r} />
      </div>
    </div>
  );
}
function PresentRowSplit() {
  return (
    <PresentInBubble>
      <PresentCardClosed>
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          {PRESENT_CONVERSATIONS.map((r) => <PresentRowSplitEntry key={r.id} r={r} />)}
        </div>
      </PresentCardClosed>
    </PresentInBubble>
  );
}

// ── Round 6: the owner's pick, plus tags ──────────────────────────────────────
// "more like c, try to keep tags." The skeleton is UNCHANGED from R5's C
// (present-row-split): line 1 is title left / date pinned right, line 2 is
// project left / Preview+Resume right. All three candidates below share that
// exact skeleton — PresentRowTitle, ChatsearchActions, and the same two-line
// division — and answer only one question: where do the tags go.
//
// Round 5's pair of fixture conversations (CS_RESUMABLE, CS_NATIVE) carry at
// most two tags between them, which would let every placement look tidy no
// matter how bad it actually is under load. This round's own fixture set
// exists so the comparison can't flatter itself: a normal two-tag case, a
// heavy four-tag case with a long multi-word label (real tags in this app
// read like "Follow-Up Needed", never "perf"), and a bare no-tags case, so
// the empty state is visible too. Built as fresh literals rather than
// mutating CHATSEARCH_FIXTURE, so Rounds 1-5 (which read CS_RESUMABLE/
// CS_NATIVE straight from that shared table via PRESENT_CONVERSATIONS) keep
// rendering exactly what they always have.
type PresentOk = Extract<ResolvedConversation, { status: 'ok' }>;
const R6_TWO_TAGS: PresentOk = {
  status: 'ok', id: 'r6-two-tags', provider: 'claude', title: 'Permission ask timeout',
  projectName: 'youcoded', originalPath: '/home/destin/youcoded-dev/youcoded',
  lastActive: '2026-07-26T03:14:09.000Z', createdAt: '2026-07-25T18:02:11.000Z',
  tags: ['work', 'bug'], complete: true, tombstone: false,
  projectSlug: '-home-destin-youcoded-dev-youcoded', projectPath: '/home/destin/youcoded-dev/youcoded',
  missingProject: false, notSyncedYet: false,
};
// Four tags, two of which ('Follow-Up Needed', 'Launch Blocker') are the long
// multi-word labels the brief calls for; 'idea' is a label the fixture tag
// registry (dev/workbench/fixtures/tags.ts) actually resolves, and 'UI Copy'
// is not — so this one row exercises a resolved chip, an unresolved
// (neutral-color) chip, AND the two-then-overflow cap in a single case.
const R6_FOUR_TAGS: PresentOk = {
  status: 'ok', id: 'r6-four-tags', provider: 'native', title: 'Draft the newsletter',
  projectName: 'writing', originalPath: '/home/destin/writing',
  lastActive: '2026-08-01T10:00:00.000Z', createdAt: '2026-07-30T09:00:00.000Z',
  tags: ['Follow-Up Needed', 'idea', 'UI Copy', 'Launch Blocker'], complete: false, tombstone: false,
  projectSlug: '-home-destin-writing', projectPath: '/home/destin/writing',
  missingProject: false, notSyncedYet: false,
};
const R6_NO_TAGS: PresentOk = {
  status: 'ok', id: 'r6-no-tags', provider: 'claude', title: 'Quarterly budget notes',
  projectName: 'finance', originalPath: '/home/destin/youcoded-dev/finance',
  lastActive: '2026-07-14T15:40:00.000Z', createdAt: '2026-07-14T15:00:00.000Z',
  tags: [], complete: false, tombstone: false,
  projectSlug: '-home-destin-youcoded-dev-finance', projectPath: '/home/destin/youcoded-dev/finance',
  missingProject: false, notSyncedYet: false,
};
const R6_CONVERSATIONS: PresentOk[] = [R6_TWO_TAGS, R6_FOUR_TAGS, R6_NO_TAGS];

// Caps a resolved tag-chip list at two, folding the rest into a single "+N"
// chip in the neutral fallback color (never a fabricated tag) — the row's own
// bound on how much width tags can claim, so a heavily-tagged conversation
// can never push the project name or the buttons off the row. Used by the two
// candidates below that share a line with something else; present-tags-row
// gives tags their own line and never calls this.
function capTagChips(tags: ChipTag[]): ChipTag[] {
  if (tags.length <= 2) return tags;
  const rest = tags.length - 2;
  return [...tags.slice(0, 2), { label: COPY.presentTagsMore(rest), color: DEFAULT_TAG_COLOR }];
}

// The R5 card shell (PresentCardHeader + closed-by-default + Ctrl+O aware),
// reproduced as a new sibling rather than editing PresentCardClosed in place
// — same rule R5 itself followed against R4's PresentCard. The only reason a
// new component is needed at all: PresentCardClosed's header count is wired
// to PRESENT_CONVERSATIONS.length (R4/R5's two-conversation array), and this
// round's own fixture set has three rows — reusing it unedited would print
// the wrong count in the card header.
function PresentCardR6({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(() => getInitialExpanded());
  useExpandAllToggle(() => setOpen(true), () => setOpen(false));
  return (
    <div className="mt-2 rounded-lg border border-edge bg-well overflow-hidden" data-testid="present-card-r6">
      <PresentCardHeader open={open} onToggle={() => setOpen(!open)} count={R6_CONVERSATIONS.length} />
      {open && children}
    </div>
  );
}

// A · present-tags-meta — tags join line 2, in front of the project, the same
// left-to-right order ChatsearchMetaLine already uses on the approved search
// row (tags → project → date). Composed by hand rather than through
// ChatsearchMetaLine itself: that component always ends with a date, and this
// row's date already lives on line 1, so reusing it here would print the date
// twice. Buttons stay pinned to the right, same as R5.
function PresentTagsMetaEntry({ r, tagIndex }: { r: PresentOk; tagIndex: Map<string, TagRecord> }) {
  const blocked = r.missingProject ? COPY.resumeMissingProject : r.notSyncedYet ? COPY.resumeNotSynced : null;
  const chips = capTagChips(resolveChatsearchTags(r.tags, tagIndex));
  return (
    <div className="rounded-md bg-inset/50 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1"><PresentRowTitle r={r} /></div>
        {!blocked && (
          <span className="shrink-0 ml-auto text-3xs text-fg-muted">{formatRelativeTime(r.lastActive)}</span>
        )}
      </div>
      <div className="flex items-center gap-2 mt-1">
        {chips.length > 0 && (
          <span className="flex items-center gap-1 shrink-0">
            {chips.map((t, i) => <TagChip key={`${t.label}-${i}`} tag={t} />)}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-3xs text-fg-muted">{blocked ?? (r.projectName || COPY.noProject)}</span>
        <ChatsearchActions r={r} />
      </div>
    </div>
  );
}
function PresentTagsMeta() {
  const tagIndex = useTagLabelIndex();
  return (
    <PresentInBubble>
      <PresentCardR6>
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          {R6_CONVERSATIONS.map((r) => <PresentTagsMetaEntry key={r.id} r={r} tagIndex={tagIndex} />)}
        </div>
      </PresentCardR6>
    </PresentInBubble>
  );
}

// B · present-tags-title — tags join line 1, sitting between the title and
// the right-pinned date; line 2 stays project + buttons, untouched from R5.
// Same two-then-overflow cap as A. Puts tags at the eye's first stop, but now
// THREE things (title, tags, date) compete for line 1's width instead of two.
function PresentTagsTitleEntry({ r, tagIndex }: { r: PresentOk; tagIndex: Map<string, TagRecord> }) {
  const blocked = r.missingProject ? COPY.resumeMissingProject : r.notSyncedYet ? COPY.resumeNotSynced : null;
  const chips = capTagChips(resolveChatsearchTags(r.tags, tagIndex));
  return (
    <div className="rounded-md bg-inset/50 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1"><PresentRowTitle r={r} /></div>
        {chips.length > 0 && (
          <span className="flex items-center gap-1 shrink-0">
            {chips.map((t, i) => <TagChip key={`${t.label}-${i}`} tag={t} />)}
          </span>
        )}
        {!blocked && (
          <span className="shrink-0 ml-auto text-3xs text-fg-muted">{formatRelativeTime(r.lastActive)}</span>
        )}
      </div>
      <div className="flex items-center gap-2 mt-1">
        <span className="min-w-0 flex-1 truncate text-3xs text-fg-muted">{blocked ?? (r.projectName || COPY.noProject)}</span>
        <ChatsearchActions r={r} />
      </div>
    </div>
  );
}
function PresentTagsTitle() {
  const tagIndex = useTagLabelIndex();
  return (
    <PresentInBubble>
      <PresentCardR6>
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          {R6_CONVERSATIONS.map((r) => <PresentTagsTitleEntry key={r.id} r={r} tagIndex={tagIndex} />)}
        </div>
      </PresentCardR6>
    </PresentInBubble>
  );
}

// C · present-tags-row — tags get a third line of their own, beneath the
// unmodified R5 skeleton (line 1 title+date, line 2 project+buttons). No cap
// here: `flex-wrap` lets every tag show, wrapping to more lines instead of
// being cut, at the cost of a line of height per conversation. Omitted
// entirely when there are no tags, so the no-tags row stays two lines.
function PresentTagsRowEntry({ r, tagIndex }: { r: PresentOk; tagIndex: Map<string, TagRecord> }) {
  const blocked = r.missingProject ? COPY.resumeMissingProject : r.notSyncedYet ? COPY.resumeNotSynced : null;
  const chips = resolveChatsearchTags(r.tags, tagIndex);
  return (
    <div className="rounded-md bg-inset/50 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1"><PresentRowTitle r={r} /></div>
        {!blocked && (
          <span className="shrink-0 ml-auto text-3xs text-fg-muted">{formatRelativeTime(r.lastActive)}</span>
        )}
      </div>
      <div className="flex items-center gap-2 mt-1">
        <span className="min-w-0 flex-1 truncate text-3xs text-fg-muted">{blocked ?? (r.projectName || COPY.noProject)}</span>
        <ChatsearchActions r={r} />
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 mt-1.5">
          {chips.map((t, i) => <TagChip key={`${t.label}-${i}`} tag={t} />)}
        </div>
      )}
    </div>
  );
}
function PresentTagsRow() {
  const tagIndex = useTagLabelIndex();
  return (
    <PresentInBubble>
      <PresentCardR6>
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          {R6_CONVERSATIONS.map((r) => <PresentTagsRowEntry key={r.id} r={r} tagIndex={tagIndex} />)}
        </div>
      </PresentCardR6>
    </PresentInBubble>
  );
}

// ── Round 7: stop arranging the same five facts — four different ideas ──────
// Six rounds in, the last three were all the same shape: a stacked list of
// rows carrying title/date/project/tags/two-buttons, differing only in
// density and where the tags sat. Rejected outright: "not a fan of any of
// these. a few more creative options please." This round does not produce a
// seventh row arrangement. Every conversation needs the same five facts and
// two actions — the thing that has read as "busy" every time is showing all
// of it, for every conversation, at once. Each candidate below escapes that
// by deferring something and giving a specific way to get it back — stated
// in the candidate's `note` below, and restated as the WHY comment on its
// component.
//
// Fixture: R6_CONVERSATIONS (R6_TWO_TAGS / R6_FOUR_TAGS / R6_NO_TAGS, declared
// above for Round 6) reused unmodified — a resumable two-tag case, a
// four-tag case carrying a long multi-word label, and a no-tags case is
// exactly the spread this round's brief asks for, so Round 6's set already
// matches it rather than needing a new one. The first three candidates below
// also reuse PresentCardR6 verbatim for their outer shell (deliverables-style
// card, closed by default, Ctrl+O aware, "Referenced conversations" header) —
// the brief keeps that part unchanged; only what sits inside is new. The
// fourth candidate has no card, per the brief.

// A · present-expand-in-place — DEFERS date, project, tags, and both buttons
// for every conversation but one. GETS THEM BACK by making the title itself
// the control: a real <button aria-expanded>, not a hover trick, that
// expands that ONE row in place. Opening a second row collapses the first
// (single `openId`, not a per-row boolean) — only ever one row is "busy" at
// once, so N conversations cost N one-line rows at rest.
function PresentExpandRowEntry({ r, tagIndex, open, onToggle }: {
  r: PresentOk; tagIndex: Map<string, TagRecord>; open: boolean; onToggle: () => void;
}) {
  const blocked = r.missingProject ? COPY.resumeMissingProject : r.notSyncedYet ? COPY.resumeNotSynced : null;
  const chips = resolveChatsearchTags(r.tags, tagIndex);
  return (
    <div className="rounded-md bg-inset/50 overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        title={open ? COPY.presentHideDetails : COPY.presentShowDetails}
        className="group flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-inset transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ChevronIcon className="w-3 h-3 shrink-0 text-fg-muted" expanded={open} />
        <span className="min-w-0 flex-1"><PresentRowTitle r={r} /></span>
      </button>
      {open && (
        <div className="px-2.5 pb-2 pl-7">
          <ChatsearchMetaLine
            tags={chips}
            blocked={blocked}
            project={r.projectName || COPY.noProject}
            date={formatRelativeTime(r.lastActive)}
          />
          <div className="flex justify-end mt-1.5">
            <ChatsearchActions r={r} />
          </div>
        </div>
      )}
    </div>
  );
}
function PresentExpandInPlace() {
  const tagIndex = useTagLabelIndex();
  const [openId, setOpenId] = React.useState<string | null>(null);
  return (
    <PresentInBubble>
      <PresentCardR6>
        <div className="flex flex-col gap-1 px-2 pb-2">
          {R6_CONVERSATIONS.map((r) => (
            <PresentExpandRowEntry
              key={r.id} r={r} tagIndex={tagIndex}
              open={openId === r.id}
              onToggle={() => setOpenId(openId === r.id ? null : r.id)}
            />
          ))}
        </div>
      </PresentCardR6>
    </PresentInBubble>
  );
}

// B · present-hover-actions — DEFERS the two buttons entirely: they claim no
// layout width at rest, so the row is just a color stripe, a title, and a
// date. GETS THEM BACK on hover or keyboard focus (group-hover /
// group-focus-within, the same reveal MarketplaceCard.tsx's own info bubble
// already uses), as an overlay over the row's right end rather than a
// reserved slot. Tags are deferred too, down to a stripe of their own colors
// with the real names in the row's `title` attribute. Hover doesn't exist on
// a phone, so on narrow viewports (useNarrowViewport(), not asserted) the
// buttons move back into the normal layout as a second line instead of
// hiding — the one place this candidate does NOT defer them.
function TagStripe({ chips }: { chips: ChipTag[] }) {
  if (chips.length === 0) {
    return <span className="w-1 h-8 rounded-full shrink-0 bg-edge-dim" aria-hidden="true" />;
  }
  return (
    <span className="w-1 h-8 rounded-full shrink-0 overflow-hidden flex flex-col" aria-hidden="true">
      {chips.map((t, i) => (
        <span key={`${t.label}-${i}`} className="flex-1" style={{ background: `var(--${t.color})` }} />
      ))}
    </span>
  );
}
// Fades the overlay's leading edge into the row's own fill instead of cutting
// a hard edge across the date it covers — same technique as Round 4's
// filmstrip scroll fades (presentFade above), pointed at one fixed edge.
const HOVER_ACTIONS_FADE: React.CSSProperties = {
  background: 'linear-gradient(to left, var(--inset) 65%, transparent)',
};
function PresentHoverActionsEntry({ r, tagIndex, narrow }: {
  r: PresentOk; tagIndex: Map<string, TagRecord>; narrow: boolean;
}) {
  const chips = resolveChatsearchTags(r.tags, tagIndex);
  const tagNames = chips.map((t) => t.label).join(', ');
  return (
    <div
      className={`group relative rounded-md bg-inset/50 hover:bg-inset transition-colors ${narrow ? 'px-2.5 py-2' : 'px-2.5 py-1.5'}`}
      title={tagNames || undefined}
    >
      <div className="flex items-center gap-2">
        <TagStripe chips={chips} />
        <div className="min-w-0 flex-1"><PresentRowTitle r={r} /></div>
        <span className="shrink-0 text-3xs text-fg-muted">{formatRelativeTime(r.lastActive)}</span>
      </div>
      {narrow ? (
        <div className="flex justify-end mt-1.5">
          <ChatsearchActions r={r} />
        </div>
      ) : (
        <div
          className="absolute inset-y-0 right-0 flex items-center gap-1.5 pl-8 pr-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
          style={HOVER_ACTIONS_FADE}
        >
          <ChatsearchActions r={r} />
        </div>
      )}
    </div>
  );
}
function PresentHoverActions() {
  const tagIndex = useTagLabelIndex();
  const narrow = useNarrowViewport();
  return (
    <PresentInBubble>
      <PresentCardR6>
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          {R6_CONVERSATIONS.map((r) => (
            <PresentHoverActionsEntry key={r.id} r={r} tagIndex={tagIndex} narrow={narrow} />
          ))}
        </div>
      </PresentCardR6>
    </PresentInBubble>
  );
}

// C · present-one-at-a-time — DEFERS every conversation except the one on
// screen: no title, tags, or actions render for the other two at all. GETS
// THEM BACK with a pager (dots + prev/next + "n / total") that steps
// through them one at a time; the conversation showing gets a full-size
// title, the complete tag/project/date line with no two-tag cap (there's
// finally room), and full-size Preview/Resume buttons. The cost is exactly
// what the brief asked to see: the other conversations are invisible until
// you page to them.
function PresentOneAtATime() {
  const tagIndex = useTagLabelIndex();
  const [index, setIndex] = React.useState(0);
  const count = R6_CONVERSATIONS.length;
  const r = R6_CONVERSATIONS[index];
  const blocked = r.missingProject ? COPY.resumeMissingProject : r.notSyncedYet ? COPY.resumeNotSynced : null;
  const chips = resolveChatsearchTags(r.tags, tagIndex);
  const native = r.provider === 'native';
  const go = (delta: number) => setIndex((i) => (i + delta + count) % count);
  return (
    <PresentInBubble>
      <PresentCardR6>
        <div className="px-3 pb-3 pt-1">
          <div className="text-sm font-semibold text-fg truncate">
            {r.title || <span className="italic font-normal text-fg-muted">{COPY.untitled}</span>}
          </div>
          <ChatsearchMetaLine
            tags={chips}
            blocked={blocked}
            project={r.projectName || COPY.noProject}
            date={formatRelativeTime(r.lastActive)}
            className="mt-1.5"
          />
          <div className="flex items-center gap-2 mt-3">
            <Button
              variant="secondary"
              disabled={r.tombstone}
              title={r.tombstone ? COPY.previewTombstone : COPY.previewHint}
            >
              {COPY.preview}
            </Button>
            <Button
              variant="primary"
              disabled={!!blocked}
              title={blocked ?? (native ? COPY.resumeNativeHint : COPY.resumeHint)}
            >
              {native ? COPY.resumeNative : COPY.resume}
            </Button>
          </div>
          <div className="flex items-center justify-center gap-3 mt-3 pt-2 border-t border-edge-dim/60">
            <button
              type="button" onClick={() => go(-1)} aria-label={COPY.presentPagerPrev}
              className="p-1 text-fg-muted hover:text-fg rounded-md hover:bg-inset transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {/* ChevronIcon points down at rest; rotate-90 (clockwise) turns it to
                  point left, the "previous" direction — no separate arrow glyph
                  exists on this branch, so this reuses the one disclosure mark the
                  app already has rather than adding a new SVG. */}
              <ChevronIcon className="w-4 h-4 rotate-90" />
            </button>
            <div className="flex items-center gap-1.5" role="group" aria-label={COPY.presentPagerLabel}>
              {R6_CONVERSATIONS.map((c, i) => (
                <button
                  key={c.id} type="button" onClick={() => setIndex(i)}
                  aria-label={COPY.presentPagerGoTo(i + 1, count)} aria-current={i === index}
                  className={`w-1.5 h-1.5 rounded-full transition-colors ${i === index ? 'bg-accent' : 'bg-edge-dim hover:bg-fg-muted'}`}
                />
              ))}
            </div>
            <span className="text-3xs font-mono text-fg-muted min-w-[2.5rem] text-center">
              {COPY.presentPagerPosition(index + 1, count)}
            </span>
            <button
              type="button" onClick={() => go(1)} aria-label={COPY.presentPagerNext}
              className="p-1 text-fg-muted hover:text-fg rounded-md hover:bg-inset transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {/* -rotate-90 (counter-clockwise) turns the same down chevron to
                  point right, the "next" direction — see the prev button above. */}
              <ChevronIcon className="w-4 h-4 -rotate-90" />
            </button>
          </div>
        </div>
      </PresentCardR6>
    </PresentInBubble>
  );
}

// D · present-inline-mentions — DEFERS the entire block: there is no card and
// no list. A past conversation becomes a small chip the assistant's own
// sentence refers to mid-thought, styled like the app's inline filepath pill
// (FilepathToken.tsx's `pill` variant classes, reused verbatim) with ChatIcon
// standing in for the file glyph — the file pill's own glyph swap between
// image/document types has no equivalent here, so one glyph covers every
// chip. GETS EVERYTHING BACK behind a click: a popover anchored beneath the
// chip, built from OverlayPanel (the same .layer-surface shell AnchorTip and
// FileFilterPopover already float their own content from), holds the date,
// project, tags, and both buttons — everything the other three candidates
// keep in the row, deferred here down to a single word in a sentence. Two
// chips only, on purpose — the brief's own example sentence names two; a
// sentence mentioning three past conversations stops reading like a sentence.
const PRESENT_INLINE_LEAD = 'We settled this in';
const PRESENT_INLINE_MID = 'and again in';
const PRESENT_INLINE_TAIL = '.';

function InlineMentionChip({ r, open, onToggle }: { r: PresentOk; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      title={r.title || COPY.untitled}
      className="group inline-flex max-w-[11rem] items-center gap-1.5 align-middle px-2 py-0.5 rounded-md bg-well border border-edge hover:border-fg-muted transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <ChatIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
      <span className="truncate text-[0.85em] text-fg group-hover:underline underline-offset-2 decoration-fg-muted">
        {r.title || <span className="italic text-fg-muted">{COPY.untitled}</span>}
      </span>
    </button>
  );
}

function InlineMentionPopover({ r, tagIndex }: { r: PresentOk; tagIndex: Map<string, TagRecord> }) {
  const blocked = r.missingProject ? COPY.resumeMissingProject : r.notSyncedYet ? COPY.resumeNotSynced : null;
  const chips = resolveChatsearchTags(r.tags, tagIndex);
  return (
    <OverlayPanel layer={4} className="mt-2 w-64 max-w-full p-3">
      <div className="text-4xs uppercase tracking-wider text-fg-muted">{COPY.paneSubtitle(r.provider)}</div>
      <div className="text-sm font-medium text-fg truncate mt-0.5">
        {r.title || <span className="italic font-normal text-fg-muted">{COPY.untitled}</span>}
      </div>
      <ChatsearchMetaLine
        tags={chips} blocked={blocked} project={r.projectName || COPY.noProject}
        date={formatRelativeTime(r.lastActive)} className="mt-1.5"
      />
      <div className="flex justify-end mt-2.5">
        <ChatsearchActions r={r} />
      </div>
    </OverlayPanel>
  );
}

function PresentInlineMentions() {
  const tagIndex = useTagLabelIndex();
  const mentioned = [R6_TWO_TAGS, R6_FOUR_TAGS];
  // Opened by default on the first mention — the round's own report asks for
  // the popover rendered in its open state so its contents can be judged
  // without hovering or clicking first. Still real toggle state underneath:
  // clicking either chip moves which one (if any) is open.
  const [openId, setOpenId] = React.useState<string | null>(mentioned[0].id);
  const open = mentioned.find((m) => m.id === openId) ?? null;
  return (
    <div className="flex justify-start px-4 py-0.5">
      <div className="assistant-bubble max-w-[85%] break-words rounded-2xl rounded-bl-sm bg-inset text-sm text-fg px-5 py-3.5">
        <p className="leading-relaxed">
          {PRESENT_INLINE_LEAD}{' '}
          <InlineMentionChip
            r={mentioned[0]} open={openId === mentioned[0].id}
            onToggle={() => setOpenId(openId === mentioned[0].id ? null : mentioned[0].id)}
          />
          {' '}{PRESENT_INLINE_MID}{' '}
          <InlineMentionChip
            r={mentioned[1]} open={openId === mentioned[1].id}
            onToggle={() => setOpenId(openId === mentioned[1].id ? null : mentioned[1].id)}
          />
          {PRESENT_INLINE_TAIL}
        </p>
        {open && <InlineMentionPopover r={open} tagIndex={tagIndex} />}
      </div>
    </div>
  );
}


// ── Round 8: a reference block inside the assistant's own message ─────────────
// Destin, 2026-08-27 gate (M-show / D4): "display" stops being a tool and
// becomes a renderer trick. The assistant writes the references into its own
// sentence in a set format; the renderer parses the bubble and draws them.
// His sketch: "This project is blah blah, working on blah blah, see: [convo 1]
// [convo 2] [convo 3]. This other project is blah, working on blah: convo 4."
//
// So the question this round asks is NOT density — R4–R6 were rejected as a
// family for re-asking that ("not a fan of any of these"). Every candidate here
// uses the SAME settled row (R5's present-row-split: title/date on line one,
// project/buttons on line two) and answers only: how does a group of references
// attach to the prose around it? Each candidate therefore shows TWO groups
// separated by a sentence, because one group in isolation cannot show it.
const REF_GROUP_A: Extract<ResolvedConversation, { status: 'ok' }>[] = [
  CHATSEARCH_FIXTURE.find((c) => c.id === CS_RESUMABLE)!,
  CHATSEARCH_FIXTURE.find((c) => c.id === CS_NOT_SYNCED)!,
];
const REF_GROUP_B: Extract<ResolvedConversation, { status: 'ok' }>[] = [
  CHATSEARCH_FIXTURE.find((c) => c.id === CS_NATIVE)!,
  CHATSEARCH_FIXTURE.find((c) => c.id === CS_MISSING_PROJECT)!,
];
const REF_LEAD_A = 'The permission work is mostly settled — the ask timeout and the sync gap both trace back to these:';
const REF_LEAD_B = 'The newsletter is a separate thread, and the older one\u2019s project folder isn\u2019t on this machine:';

/** The message shell every candidate below shares: real assistant bubble, two
 *  leads, two groups. Only `group` differs between candidates. */
function PresentRefMessage({ group }: { group: (rows: Extract<ResolvedConversation, { status: 'ok' }>[]) => React.ReactNode }) {
  return (
    <PresentInBubble>
      <p className="m-0">{REF_LEAD_A}</p>
      {group(REF_GROUP_A)}
      <p className="m-0">{REF_LEAD_B}</p>
      {group(REF_GROUP_B)}
    </PresentInBubble>
  );
}

/** A — the group is a bordered card between the paragraphs. Closest to what the
 *  app already draws; the block is unmistakably a separate object. */
function PresentRefBoxed() {
  return (
    <PresentRefMessage
      group={(rows) => (
        <div className="my-2 rounded-lg border border-edge bg-well overflow-hidden">
          <div className="flex flex-col gap-1.5 p-2">
            {rows.map((r) => <PresentRowSplitEntry key={r.id} r={r} />)}
          </div>
        </div>
      )}
    />
  );
}

/** B — no box. A rule down the left and an indent, the way a quotation hangs off
 *  the sentence that introduced it; the rows read as part of the message. */
function PresentRefHanging() {
  return (
    <PresentRefMessage
      group={(rows) => (
        <div className="my-2 border-l-2 border-edge pl-3 flex flex-col gap-1.5">
          {rows.map((r) => <PresentRowSplitEntry key={r.id} r={r} />)}
        </div>
      )}
    />
  );
}

/** C — a real table: one line per conversation, columns that line up ACROSS both
 *  groups. Nothing wraps the block at all; only spacing separates it from the
 *  prose. The trade-off is width — at a narrow bubble the title column is the
 *  first thing squeezed, which is exactly what this candidate is here to show. */
function PresentRefTableRow({ r }: { r: Extract<ResolvedConversation, { status: 'ok' }> }) {
  const blocked = r.missingProject ? COPY.resumeMissingProject : r.notSyncedYet ? COPY.resumeNotSynced : null;
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className="min-w-0 flex-[3] truncate text-xs text-fg">{r.title || COPY.untitled}</span>
      <span className="min-w-0 flex-[2] truncate text-3xs text-fg-muted">{blocked ?? (r.projectName || COPY.noProject)}</span>
      {!blocked && <span className="shrink-0 text-3xs text-fg-muted">{formatRelativeTime(r.lastActive)}</span>}
      <ChatsearchActions r={r} />
    </div>
  );
}
function PresentRefTable() {
  return (
    <PresentRefMessage
      group={(rows) => (
        <div className="my-2 divide-y divide-edge-dim border-y border-edge-dim">
          {rows.map((r) => <PresentRefTableRow key={r.id} r={r} />)}
        </div>
      )}
    />
  );
}

const ALL_SURFACES: CompareSurface[] = [
  {
    id: 'buddy-sleep',
    label: 'Buddy — falling asleep',
    question: 'After a few quiet minutes the buddy goes to sleep. Which way of going under reads best at his real size? — SETTLED 2026-09-05: R1 loaf, then R2 docked arms.',
    frame: 'canvas',
    // BOTH ROUNDS NOW RENDER WHAT SHIPPED. Destin picked the loaf in R1 and the
    // docked arms in R2, and the losing poses were deleted rather than left in
    // the shipped table — but the rounds stay, because the breadcrumb IS the
    // record of how the design got here (same as session-strip-motion below).
    // FIXED at his real window width plus a little air. A sleep pose that only
    // reads when the pane is stretched has not been judged at all — he is 112px
    // in the corner of a screen, always.
    paneWidth: 150,
    rounds: [
      {
        n: 1,
        basis: "Destin, 2026-09-04: \"i didn't entirely love the shut down pose as written.\" A is that pose, ported as faithfully as this rig allows, so the other three are judged against the thing he is reacting to rather than against nothing. The ten candidates drawn during the promo (docs/archive/prototypes/promo-2026-09/storyboard-v3/power-down-poses{,-2}.png) were judged for the END OF A FILM at large size beside the wordmark; these are judged for 112px in a screen corner, where he may also be docked half-off an edge. Every pane loops settle → breathe → wake by itself and has a Wake him button, because the wake is half of whether a sleep reads as sleep or as a glitch.",
        candidates: [
          {
            id: 'loaf',
            label: 'Loaf',
            note: "The film's own pose: he squats down and his arms swing under to the bottom corners.",
            render: () => <BuddySleepDemo pose="sleep" />,
          },
          {
            id: 'slump',
            label: 'Slump',
            note: 'Dozed off where he stood — he leans, sinks a little, arms go slack. Barely changes his outline.',
            render: () => <BuddySleepDemo pose="sleep" />,
          },
          {
            id: 'deflate',
            label: 'Deflate + dim',
            note: 'Shrinks a touch and fades. Says "powered down" with brightness instead of posture.',
            render: () => <BuddySleepDemo pose="sleep" />,
          },
        ],
      },
      {
        n: 2,
        basis: 'R1 · A (loaf), picked 2026-09-05: "i quite like loaf. the animation to transition between states can be improved though. also wanna see a few more variants with the arms in different positions (tucked just a bit, fully docked, wildcard)." The body is the loaf\'s and is NOT under review here — only the arms move, so the choice is about one thing. The transition complaint was fixed rather than offered as an option: limb translation now rides the same springs the rotations do (it used to teleport while the body eased), and the body\'s settle is directional — 620ms heavy going under, 300ms with a little overshoot coming back.',
        candidates: [
          {
            id: 'tuck',
            label: 'Tuck',
            note: 'Barely moved — arms stay where you last saw them, just relaxed and dropped a little.',
            render: () => <BuddySleepDemo pose="sleep" />,
          },
          {
            id: 'dock',
            label: 'Dock',
            note: 'All the way down and pulled into the body, so his outline becomes one clean shape.',
            render: () => <BuddySleepDemo pose="sleep" />,
          },
          {
            id: 'flop',
            label: 'Flop',
            note: 'The wildcard: arms swung out flat, flumped. Funny rather than tidy.',
            render: () => <BuddySleepDemo pose="sleep" />,
          },
        ],
      },
    ],
  },
  {
    id: 'session-strip-motion',
    label: 'Session strip — motion',
    question: 'How fast, and on what curve, should a click open a name, a hover peek it, and a drag move a pill?',
    frame: 'canvas',
    // FLUID: the strip is a wide, short thing that lives across the whole
    // header. Judged at the width the page can give it, panes stacked.
    paneWidth: { min: 460, max: 1400 },
    rounds: [
      {
        n: 1,
        basis: 'Rebuilt 2026-09-01 after Destin rejected the first cut as "much too bouncy/aggressive". No candidate overshoots; they differ only in speed and curve. The mechanics (peek stays open through a click, the pill rides under the cursor, release glides) are the same in all three.',
        candidates: [
          {
            id: 'settled',
            label: 'Settled',
            note: 'Decelerates fast and stops dead: 150ms hover, 200ms name reveal. NOT PICKED (2026-09-02); the treatment is gone and this renders what shipped.',
            render: () => <SessionStripMotionDemo />,
          },
          {
            id: 'crisp',
            label: 'Crisp',
            note: 'Same curve, a third quicker: 100ms hover, 140ms reveal. NOT PICKED (2026-09-02); the treatment is gone and this renders what shipped.',
            render: () => <SessionStripMotionDemo />,
          },
          {
            id: 'soft',
            label: 'Soft',
            note: 'A plain ease and a little longer: 180ms hover, 260ms reveal. PICKED 2026-09-02 ("i like soft, but it will need to be tuned/repaired a bit") — now the :root values.',
            render: () => <SessionStripMotionDemo />,
          },
        ],
      },
      {
        n: 2,
        basis: 'Destin, 2026-09-01, on R1: "I want this to work a little more like chrome, where the new session is selected right when I click the new session pill and begin to drag … the old session would collapse to status dot and new session would expand right as drag begins." Three answers to WHEN the switch happens; the pill in hand now floats over the row so the row can reshape underneath it in all three.',
        candidates: [
          {
            id: 'press',
            label: 'Switch on press',
            note: 'The session switches the instant you press, like a Chrome tab: the old name collapses, the pressed one opens, the conversation changes underneath. PICKED 2026-09-02 — now the only behaviour.',
            render: () => <SessionStripMotionDemo />,
          },
          {
            id: 'press-dot',
            label: 'Switch on press, name on drop',
            note: 'Switches on press too, but the pill in hand stays a dot while you drag; its name opens where you let go. NOT PICKED (2026-09-02); removed, renders what shipped.',
            render: () => <SessionStripMotionDemo />,
          },
          {
            id: 'release',
            label: 'Switch on release',
            note: 'Nothing changes until you let go: the row keeps its shape through the drag, then the dropped pill becomes the active one. NOT PICKED (2026-09-02); removed, renders what shipped.',
            render: () => <SessionStripMotionDemo />,
          },
        ],
      },
      {
        n: 3,
        basis: 'Destin picked Soft (R1) and Press (R2) on 2026-09-02, both with "it\'s jank / needs tuning". The merge, tuned: reveals and hovers on Soft\'s plain ease; the dots stepping aside for a dragged pill still LEAD on the fast-deceleration curve (a gentle start there left the pill over a dot); and the window that arms the label transitions now reads the durations off the stylesheet — fixed at 360ms it closed before Soft\'s badge (260 + 180ms) had finished opening, so the badge popped.',
        candidates: [
          {
            id: 'soft-press',
            label: 'Soft + press, tuned',
            note: 'Switch on press, 180ms hover, 260ms reveal, a "YouCoded · Coder" badge opening after the name, drag with dots sliding aside early. Superseded by R4 (2026-09-02); renders what shipped.',
            render: () => <SessionStripMotionDemo />,
          },
        ],
      },
      {
        n: 4,
        basis: 'Destin, 2026-09-02, on R3: "eliminate the \'youcoded - coder\' tags in session names entirely. they still cause a bit of visual jank. we should instead have labels next to the project folder label in the session switcher dropdown … keep the model/brand icons used on other model surfaces. also dots still keep sliding under the selected pill." Two changes: the pill is its dot and its name, nothing else — the runtime and model moved under the name in the All Sessions menu ("Claude Code · Sonnet", "YouCoded Coder · Qwen3 Coder") with the brand mark the status bar chip uses; and a dot no longer slides aside for a dragged pill, it hops — fades out where it is, moves while invisible, fades in where it now belongs.',
        candidates: [
          {
            id: 'soft-press-hop',
            label: 'Soft + press, no tag, dots hop',
            note: 'The open name stayed in hand and each dot hopped the whole pill\'s width. Destin, 2026-09-02: "this is better, but the interaction between the selected moving pill and the other dots/sessions still feels janky." Superseded by R5; renders what ships.',
            render: () => <SessionStripMotionDemo />,
          },
        ],
      },
      {
        n: 5,
        basis: 'Destin, 2026-09-02, on R4: "i want to keep the fully expanded name. the problem is that the dragged session kept visibly overlapping dots before they appeared to begin to move. it would be fine if they teleport or fade in/fade out as long as they dont visually touch the dragged pill." (A round with a dot in hand was built and withdrawn.) A first cut hid any dot within a few px of the pill; Destin, 2026-09-03: "too much empty space on either side of the dragged chip" — and it was measurable: a hidden dot is a hole the width of a dot, on one side or the other, whenever the pill is over it. So the dot FLOWS: as the pill covers a dot\'s space the dot shrinks towards its far edge, keeping the row gap clear of the leading edge, while a ghost of it grows behind the pill at the spot it will land; once covered whole it takes over from the ghost at full size. Measured: 2–4px mean gap on both sides, 0px contact in every frame.',
        candidates: [
          {
            id: 'name-flow',
            label: 'Name in hand · dots flow around it',
            note: 'Drag a name along the row: the dot ahead squeezes down as the pill reaches it and swells up behind it as it passes; a wide neighbour still slides aside. Superseded by R6 (2026-09-03); renders what ships.',
            render: () => <SessionStripMotionDemo />,
          },
        ],
      },
      {
        n: 6,
        basis: 'Destin, 2026-09-03, on R5: "this is MUCH better … however, it still bugs out a bit when the chip is released, and i cant seem to drag it to be the leftmost or rightmost session. it should also stop moving at the left/right boundaries of the outer container rather than sliding past." Three fixes: the pill in hand is clamped to the row of pills (the clamp had stopped reaching the screen); a dot at either end now counts as passed 1px before its far edge, which the clamped pill can reach; and a drop no longer disturbs the row — the flow keeps running while the dropped pill glides home, the row keeps the drag\'s layout until the cursor leaves the strip, and no hover preview opens until the hand has moved 8px.',
        candidates: [
          {
            id: 'name-flow-2',
            label: 'Flow · clean release · reaches both ends',
            note: 'Superseded by R7 (2026-09-03); renders what ships. Two more bugs at R6: the row was packed wider than the strip and the active name squeezed, so a drag parked every dot 25px off; and reaching for the first slot past the pane\'s edge tore the pill off.',
            render: () => <SessionStripMotionDemo />,
          },
        ],
      },
      {
        n: 7,
        basis: 'Destin, 2026-09-03, on R6: "i still cant drag a session into the leftmost position, and they still bug out a little on release." Both measured, neither in the motion. (1) The packer was handed the wrapper\'s full width — the strip\'s own padding included — and never knew about the "+N" chip, so a full row was packed ~37px too wide; the active pill, the one flex item allowed to shrink, rendered 25px narrower than the width the drag froze, every dot yielded 25px too far, and all of them snapped back on release. A second, smaller version of the same thing: the packer reserved ceil(text)+slack, 2-3px more than a pill ever renders at. The packer now packs into the room the strip really has and a pill\'s reserved width IS its rendered width — a dot lands exactly one gap from the dropped pill, and nothing else moves at the drop (measured 0px). (2) The tear-off fired on the cursor leaving the window SIDEWAYS; reaching for the first slot overshoots past the edge, which spawned a window and snapped the pill home. Sideways never tears off now, as in Chrome — only above or below.',
        candidates: [
          {
            id: 'name-flow-3',
            label: 'Flow · real widths · sideways never tears off',
            note: 'Superseded by R8 (2026-09-03); renders what ships. The drop still travelled up to a whole dot: a dot counted as passed only 1px before its far edge.',
            render: () => <SessionStripMotionDemo />,
          },
        ],
      },
      {
        n: 8,
        basis: 'Destin, 2026-09-03, on R7: "still janky on release, still doesn\'t always work when i release at the leftmost edge (it moves back rightward a bit …)". The final position comes from where the PILL is, never the cursor; the grab point was not it. The cause was the yield line: a dot counted as passed only when the pill had covered all but 1px of it (−27), so a release with the pill over 26 of a dot\'s 28px was not a pass and the pill glided back a whole pitch — and at the row\'s end, where the clamped pill can reach the far edge by exactly 1px, a hand letting go a few px short landed second and "moved back rightward". Now a dot is passed at its CENTRE, as in Chrome (−14): the drop travels at most half a dot, and the end slot has 13px of margin instead of 1. To make that swap invisible, a crossed dot always has two images — at its old spot and its new one — whose sizes sum to one, on both sides of the swap. Two things the probe found on the way: the row-as-drawn was read from scaled rects, which fired the yield a dot late (now read from layout positions); and in a full strip a hover peek pushed the row past its box, squeezing the active name and popping it back on press (a peek now opens only into the room the strip has free).',
        candidates: [
          {
            id: 'name-flow-4',
            label: 'Flow · swap at the centre · drop travels half a dot',
            note: 'Superseded by R9 (2026-09-03); renders what ships. The row still shifted and came back after a drop: the hand, still moving, drifted onto the next dot and its peek opened and closed.',
            render: () => <SessionStripMotionDemo />,
          },
        ],
      },
      {
        n: 9,
        basis: 'Destin, 2026-09-03, on R8: "its still jumping/glitching back and forth on release before settling in the final position". Never reproduced with a cursor that holds still after release; reproduced at once with one that keeps moving like a hand (the probe\'s AFTER=hand): the hand drifts onto the next dot, its name peeks open, the centred row widens and shifts 5px, then the peek closes as the hand leaves and the row comes back — all inside the drop\'s own settle. A peek now opens only after the cursor has RESTED on a dot for 150ms (an open peek still follows the cursor at once), so a hand passing over dots never widens the row.',
        candidates: [
          {
            id: 'name-flow-5',
            label: 'Flow · a peek waits for the hand to rest',
            note: 'Superseded by R10 (2026-09-03); renders what ships. A hand rocking across a swap point still flickered the dot: its box moved a frame before the flow resized it.',
            render: () => <SessionStripMotionDemo />,
          },
        ],
      },
      {
        n: 10,
        basis: 'Destin, 2026-09-03, on R9: "stilll janky". Reproduced with a cursor that ROCKS ±7px at the swap point (the probe\'s WOBBLE), which no earlier probe did and every hand does: a yield is a React commit that moves the dot\'s box one pill-width across, and the flow that sizes its two images ran a frame later in the rAF loop — so every crossing painted one frame with the dot doubled on one side of the pill and absent on the other, several times a second while the hand hunted for the spot. And at the drop the dots kept their flow scale but lost the transform that applied it, so a half-shrunk dot popped to full size under the gliding pill (10px of contact) while its ghost was still shrinking. The flow now also runs as a layout effect on every commit that moves a box or lands the pill — after the DOM changes, before paint — and the dots keep the flow\'s scale through the settle. Probed with wobble and a moving hand at three spots: no dot\'s visible size changes by more than 2px between frames, 0px contact.',
        candidates: [
          {
            id: 'name-flow-6',
            label: 'Flow · the swap and the sizing land in one frame',
            note: 'Superseded by R11 (2026-09-03); renders what ships. The drag visuals hung on a ref that pointerup flipped before the drop was committed: a hand that lifts while moving saw the pill snap home and then jump to its slot.',
            render: () => <SessionStripMotionDemo />,
          },
        ],
      },
      {
        n: 11,
        basis: 'Destin, 2026-09-03, on R10: "its STILL jumping around the switcher on release. you\'re missing something here. try harder and evaluate more thoroughly until it\'s a smooth release under all conditions." So: a randomised sweep (scripts/ui-review/drag-fuzz.mjs) — 20-24 drags in a row on one page, mouse and touch, at his screen\'s 1.5x scale with the frame-rate cap lifted, hand-like paths, grabs anywhere, wobble, releases mid-motion, drags begun inside the press reflow, hands that keep moving — scored per release on contact, size continuity, reversal, anything-else-moving and blink. It found what no probe had: the twin and the step-aside were rendered off the isDragging REF, which pointerup flips at once while the drop is committed after an IPC round trip — the last pointermove\'s own render landed in that gap whenever the hand lifted while still moving (a touchpad, a finger always does), unmounted the twin and snapped the pill to its ORIGIN, and the commit then jumped everything to the new order (116px on touch). Five more behind it: dots were given a FLIP glide at the drop (a covered dot popped to full size under the settling pill and slid 128px); yields were judged from a centre placed with the settled width while the twin was still opening (dots yielded 60px early); the post-drop peek lock lifted after 8px, so a resting hand still opened a peek half a second later; the old active pill, still closing, was flowed as a dot (a 77px ghost of its name); a tap leaves a sticky hover under the finger, so a dot opened its peek and stayed 56px wide through the next drag. All fixed; the deck pane now runs with the workbench\'s fake IPC latency at 0, as the app does. After: 96 of 96 randomised releases clean on every check.',
        candidates: [
          {
            id: 'name-flow-7',
            label: 'Flow · release holds until the drop lands',
            note: 'What ships. Let go the way you actually do — mid-motion, on the touchpad, on the screen with a finger. The pill goes only where it is: no snap home, no second jump.',
            render: () => <SessionStripMotionDemo />,
          },
        ],
      },
    ],
  },
  {
    id: 'session-switch-arrival',
    label: 'Session switch — the conversation arrives',
    question: 'When you switch sessions, how does the incoming conversation appear?',
    frame: 'canvas',
    paneWidth: { min: 460, max: 1400 },
    rounds: [
      {
        n: 1,
        basis: 'Spec §4.2: one animated element, never per-bubble; the outgoing conversation is never animated. Three arrivals on the Settled strip.',
        candidates: [
          {
            id: 'lift',
            label: 'Fade and lift',
            note: 'The conversation fades in while rising 6px. Kept as the baseline; fade-only and cut were removed after R1 ("i want to try a few slightly more interesting/bouncy options", 2026-09-02).',
            render: () => <SessionStripMotionDemo />,
          },
          {
            id: 'fade',
            label: 'Fade only',
            note: 'The same fade with no movement. NOT PICKED (2026-09-02); removed, renders the baseline.',
            render: () => <SessionStripMotionDemo />,
          },
          {
            id: 'cut',
            label: 'Cut',
            note: 'No animation — the conversation is simply there. NOT PICKED (2026-09-02); removed, renders the baseline.',
            render: () => <SessionStripMotionDemo />,
          },
        ],
      },
      {
        n: 2,
        basis: 'Destin, 2026-09-02, on R1: "i want to try a few slightly more interesting/bouncy options." Overshoot is fine here — it is on the transform of ONE element, which moves nothing but itself; the strip\'s no-overshoot rule is about width-like properties. Same 300ms-ish length; they differ in what moves.',
        candidates: [
          {
            id: 'lift',
            label: 'Fade and lift',
            note: 'Fades in while rising 6px on the plain ease, 300ms. NOT PICKED (2026-09-02); removed, renders what shipped.',
            render: () => <SessionStripMotionDemo />,
          },
          {
            id: 'spring',
            label: 'Spring up',
            note: 'Rises 14px and overshoots a touch before settling, while fading in. 380ms. PICKED 2026-09-02 — now the only arrival.',
            render: () => <SessionStripMotionDemo />,
          },
          {
            id: 'grow',
            label: 'Grow in',
            note: 'Starts a hair smaller (96%) and springs to size while fading in. NOT PICKED (2026-09-02); removed, renders what shipped.',
            render: () => <SessionStripMotionDemo />,
          },
          {
            id: 'slide',
            label: 'Slide in',
            note: 'Comes in from the right by 32px with a soft overshoot. NOT PICKED (2026-09-02); removed, renders what shipped.',
            render: () => <SessionStripMotionDemo />,
          },
        ],
      },
    ],
  },
  {
    id: 'close-prompt-body',
    label: 'Close session — body',
    question: 'How should the collapsed tags/note summary and Mark complete sit together?',
    frame: 'panel',
    paneWidth: 380,
    rounds: [
      {
        n: 1,
        candidates: [
          {
            id: 'card',
            label: 'Card + row',
            note: 'Shipped today. Two bordered boxes stacked; the summary is a card, Mark complete is its own row.',
            render: () => <InDialog><SummaryCard /></InDialog>,
          },
          {
            id: 'labelled',
            label: 'Labelled, no card',
            note: 'Summary loses its box — chips sit directly on the dialog under a section label, like the Resume Browser card does.',
            render: () => <InDialog><SummaryLabelled /></InDialog>,
          },
          {
            id: 'merged',
            label: 'One grouped box',
            note: 'Both jobs share one bordered group split by a divider, so the dialog body reads as a single object.',
            render: () => <InDialog><SummaryMerged /></InDialog>,
          },
        ],
      },
      {
        n: 2,
        basis: 'R1 · A (Card + row). Structure settled — a summary card with Mark complete separate beneath it. Open: how the card organises what it holds.',
        candidates: [
          {
            id: 'icon-rows',
            label: 'Icon-led rows',
            note: 'A tag glyph and a note glyph stand in for labels — the same language the Resume Browser card\'s bottom line already uses. Compact, no repeated words.',
            render: () => <InDialog><CardIconRows /></InDialog>,
          },
          {
            id: 'labelled',
            label: 'Labelled sections',
            note: 'Uppercase micro-labels inside the card, matching the rest of the app\'s forms. Most scannable, also the tallest, and it names what the chips already say.',
            render: () => <InDialog><CardLabelled /></InDialog>,
          },
          {
            id: 'note-led',
            label: 'Note first',
            note: 'Inverts the emphasis: the note you actually wrote takes the top line at full text colour, chips demote to metadata under it, and Edit moves inline with them.',
            render: () => <InDialog><CardNoteLed /></InDialog>,
          },
        ],
      },
      {
        n: 3,
        basis: 'R2 · A (Icon-led rows). Glyphs-instead-of-labels settled. Open: density, where the text hangs, and how the way in is drawn.',
        candidates: [
          {
            id: 'one-line',
            label: 'One line',
            note: 'Chips and note share a single truncating row, making the card the same height as Mark complete below it — two equal bands. Costs the note its space.',
            render: () => <InDialog><CardOneLine /></InDialog>,
          },
          {
            id: 'gutter',
            label: 'Gutter + pencil',
            note: 'Glyphs in a fixed left column so chips and note text share one left edge. Edit becomes a pencil in the corner — the whole card is already the target.',
            render: () => <InDialog><CardGutter /></InDialog>,
          },
          {
            id: 'quote',
            label: 'Note as quotation',
            note: 'The note gets a left rule and the muted colour, so "labels I applied" and "a sentence I wrote" separate at a glance. Tallest of the three.',
            render: () => <InDialog><CardQuote /></InDialog>,
          },
        ],
      },
      {
        n: 4,
        basis: 'R3 · B (Gutter + pencil). Layout settled. Note glyph swapped to a lined PAGE in all three (an instruction, not a question — the old notebook-and-pencil read as "edit" and collided with the corner pencil). Compared: the note text treatment.',
        candidates: [
          {
            id: 'boxed',
            label: 'Note in a container',
            note: 'The note sits in its own bg-well box, one step deeper than the card, so it reads as content the card holds rather than another metadata line. Most structure.',
            render: () => <InDialog><CardNoteBoxed /></InDialog>,
          },
          {
            id: 'quoted',
            label: 'Italic in quotes',
            note: 'Italic, muted, typographic quotes, no box — says "your words" through typography instead of a container, keeping the card as light as R3.',
            render: () => <InDialog><CardNoteQuoted /></InDialog>,
          },
          {
            id: 'plain',
            label: 'Plain, promoted',
            note: 'No box, no quotes — the note is simply the most prominent thing in the card, at full text colour and the chip row\'s size, with the page glyph as the only context.',
            render: () => <InDialog><CardNotePlain /></InDialog>,
          },
        ],
      },
      {
        n: 5,
        basis: 'R4 · B (Italic in quotes). Typography over a container, settled. Open: what a LONG note does — all three use a realistic two-line note, which is what a short fixture could never show.',
        candidates: [
          {
            id: 'one-line',
            label: 'One line (as picked)',
            note: 'Round 4\'s winner, unchanged, against a long note. The card never changes height whatever was written — and about four words get through.',
            render: () => <InDialog><CardQuoteOneLine /></InDialog>,
          },
          {
            id: 'two-lines',
            label: 'Two lines, then ellipsis',
            note: 'Roughly a full sentence lands, and the card still has a ceiling: it can grow by one line and no further. Italic kept.',
            render: () => <InDialog><CardQuoteTwoLines /></InDialog>,
          },
          {
            id: 'full',
            label: 'Unclamped, roman',
            note: 'Nothing you wrote is hidden, at the cost of a card that pushes "Close session" down the dialog. Drops italic — two full lines of it at this size stops being comfortable, and the quotes carry the signal alone.',
            render: () => <InDialog><CardQuoteFull /></InDialog>,
          },
        ],
      },
      {
        n: 6,
        basis: 'R5 · B (two lines, then ellipsis). The card is settled. Open: the EDIT flow — how you get in, whether you can see what you are changing, and how you get out. All three run the real TagPicker and NoteEditor, so they can actually be used.',
        candidates: [
          {
            id: 'replace',
            label: 'Replace in place',
            note: 'What ships today. The card swaps to the editor, a "Done" link swaps it back. Least chrome — but you lose sight of the summary you are editing, and "Done" is a small target for the only way out.',
            render: () => <InDialog><FlowReplace /></InDialog>,
          },
          {
            id: 'expand',
            label: 'Expand beneath',
            note: 'The summary stays as a header and the editor opens under it in the same card, so what you are changing stays visible. Pencil becomes a chevron. Costs height — both are on screen at once.',
            render: () => <InDialog><FlowExpand /></InDialog>,
          },
          {
            id: 'inline',
            label: 'No mode at all',
            note: 'Chips carry an ×, a dashed "+ tag" drops the picker in, the note becomes a field on click. Fewest clicks for a small change; busier at rest, and there is no single "I am done" moment.',
            render: () => <InDialog><FlowInline /></InDialog>,
          },
        ],
      },
      {
        n: 7,
        basis: 'R6 · A (replace in place), with B\'s containment. A dropped the card on the way in — the editor became a bare section on the dialog, so the body changed shape when you clicked. All three keep the SAME card element and swap only its contents. Open: how you get out, since the pencil is gone while editing.',
        candidates: [
          {
            id: 'link',
            label: 'Done link in the corner',
            note: 'The exit sits exactly where the way in was, so the corner is consistently "this card\'s control". Quietest, and the smallest target.',
            render: () => <InDialog><FlowCardLink /></InDialog>,
          },
          {
            id: 'check',
            label: 'Checkmark, swaps the pencil',
            note: 'The corner always holds one control and the glyph says which mode you are in — pencil to edit, check to finish. No words, same target as the pencil.',
            render: () => <InDialog><FlowCardCheck /></InDialog>,
          },
          {
            id: 'button',
            label: 'Full-width Done button',
            note: 'Unmissable and impossible to fumble — but it reads as "commit this section", which is a small lie: nothing commits until the dialog\'s own button. Tallest by a row.',
            render: () => <InDialog><FlowCardButton /></InDialog>,
          },
        ],
      },
      {
        n: 8,
        basis: 'R7 · C (full-width button), with Done → Save on a darker neutral pill (settled, not compared — accent belongs to the dialog\'s own confirm). Compared: tightening the editor, which was 9 stacked bands. All three open in edit mode, since that is what is being judged.',
        candidates: [
          {
            id: 'headers',
            label: 'Merged headers',
            note: 'Labels stop owning their own lines — "Tags" shares its row with "Manage tags…", the note loses its label since the placeholder says it. Same structure, three bands less. Least disruptive.',
            render: () => <InDialog><EditFlowCard render={(d, save) => <EditTightHeaders d={d} onSave={save} />} /></InDialog>,
          },
          {
            id: 'applied-first',
            label: 'Applied first, rest as chips',
            note: 'What is already on sits as removable chips up top; below are only the tags that are NOT applied. With three tags on, the list you scan is three rows shorter, and "what does this have" stops being a hunt through checkboxes.',
            render: () => <InDialog><EditFlowCard render={(d, save) => <EditAppliedFirst d={d} onSave={save} />} /></InDialog>,
          },
          {
            id: 'one-well',
            label: 'One well, no labels',
            note: 'Tags and note share a single inset container split by a divider, so the editor is one object rather than two sections. Most compact; furthest from the app\'s existing form language.',
            render: () => <InDialog><EditFlowCard render={(d, save) => <EditOneWell d={d} onSave={save} />} /></InDialog>,
          },
        ],
      },
      {
        n: 9,
        basis: 'R8 · B (applied first, rest as chips) on CONCEPT — what is on sits apart from what is available, as chips rather than checkbox rows. Compared: the mechanic — how a tag is added, removed, and where the available set lives at rest. Note field and Save pill identical throughout.',
        candidates: [
          {
            id: 'token',
            label: 'Token field',
            note: 'Applied chips live inside the input, like an email To: field. Type to filter, Enter adds or creates, Backspace peels the last chip. One control instead of two rows — and it gets the search back that R8·B gave up.',
            render: () => <InDialog><EditFlowCard render={(d, save) => <EditTokenField d={d} onSave={save} />} /></InDialog>,
          },
          {
            id: 'plus',
            label: 'Chips + "+" disclosure',
            note: 'At rest you see only what is applied, plus a "+". The available set costs nothing until asked for — tightest resting state, at one extra click per add and a list that appears under your cursor.',
            render: () => <InDialog><EditFlowCard render={(d, save) => <EditPlusDisclosure d={d} onSave={save} />} /></InDialog>,
          },
          {
            id: 'columns',
            label: 'On | Available',
            note: 'Both sets always visible side by side; click a chip to move it across. Nothing hidden, nothing toggles, state never in doubt — but it spends horizontal space a 380px dialog does not have, so each column wraps sooner.',
            render: () => <InDialog><EditFlowCard render={(d, save) => <EditTwoColumns d={d} onSave={save} />} /></InDialog>,
          },
        ],
      },
      {
        n: 10,
        basis: 'Back to R8·B, which was right. Round 9 was the wrong axis — it answered "tighten this" by making the INTERACTION cleverer. These keep R8·B\'s mechanic exactly (click a chip, that is all) and vary only how the chips are ORGANISED.',
        candidates: [
          {
            id: 'one-flow',
            label: 'One flow, dot divider',
            note: 'No two blocks and no rule — applied first, one dot, then the available dimmed, all in a single wrapped run you read left to right. Fewest bands; the boundary is one character, which is either elegant or invisible.',
            render: () => <InDialog><EditFlowCard render={(d, save) => <EditFlowOne d={d} onSave={save} />} /></InDialog>,
          },
          {
            id: 'outline',
            label: 'Filled on, outlined off',
            note: 'Two groups still, but the difference is DRAWN rather than faded: applied keep their fill, available are dashed outlines. No divider needed, and a dashed outline reads as "not yet" the way opacity never quite does.',
            render: () => <InDialog><EditFlowCard render={(d, save) => <EditOutline d={d} onSave={save} />} /></InDialog>,
          },
          {
            id: 'strip',
            label: 'Fixed-height strip',
            note: 'Applied wraps freely; available is ONE sideways-scrolling row, so the editor\'s height never changes as the tag registry grows — the thing that makes every wrapped cloud worse the longer you use the app. Costs discoverability past the right edge.',
            render: () => <InDialog><EditFlowCard render={(d, save) => <EditFixedStrip d={d} onSave={save} />} /></InDialog>,
          },
        ],
      },
    ],
  },
  {
    id: 'permissions-mode-control',
    label: 'Permissions — mode control',
    question:
      'Three modes with one safe default and two riskier ones — how should the control present them so the default reads as the default rather than as one of three equals?',
    frame: 'panel',
    // The real width. Settings → Permissions is <Dialog size="panel">, and
    // DIALOG_WIDTHS.panel is min(420px, 88vw) — these definitions wrap here.
    paneWidth: 420,
    rounds: [
      {
        n: 1,
        candidates: [
          {
            id: 'radio-list',
            label: 'Radio list',
            note: 'VariantC\'s ?mc=1 and its recommendation. A RadioGroup of SettingRow "item" tiles — the radio sits in the icon slot and the whole tile is the hit target, which is what survives a phone. Tallest, and the definitions get the least width.',
            render: () => <ModePane control={ModeRadioList} />,
          },
          {
            id: 'segmented-key',
            label: 'Segmented + full key',
            note: 'VariantC\'s ?mc=2. The picker is one compact SegmentedTabs row and all three definitions print below it as a fixed, unemphasised key — so the control is small but the reading matter is detached from the thing it describes.',
            render: () => <ModePane control={ModeSegmentedWithKey} />,
          },
          {
            id: 'trailing-radios',
            label: 'Rows, radio on the right',
            note: 'VariantC\'s ?mc=3. Same rows as A with the Radio moved into SettingRow\'s control slot, so each title and its definition get the row\'s full left edge — the difference that only shows up at 420px, where these lines wrap.',
            render: () => <ModePane control={ModeTrailingRadios} />,
          },
        ],
      },
      {
        n: 2,
        basis:
          'R1 — all three, not one of them. They differ on geometry and share the problem: three options of equal weight, equally drawn, in a control where one is the obviously-safe default and the other two are escalations away from it. R2 keeps every mode definition verbatim and varies only the SHAPE of the choice, so a pick names a presentation rather than a sentence. (The inertness the owner objected to is being fixed in the main process — every candidate here takes value/onChange and really owns its value.)',
        candidates: [
          {
            id: 'state-first',
            label: 'State first, Change is a step',
            note: 'At rest this is not a picker: one row states how the assistant behaves now, with a ghost "Change" beside it; that opens the three-option list and choosing closes it again. Reads as a setting with a value. Costs the at-rest comparison of all three definitions — the exact thing VariantC\'s owner review bought back.',
            render: () => <ModePane control={ModeStateFirst} />,
          },
          {
            id: 'step-ups',
            label: 'Default, then the step-ups',
            note: 'All three still visible and readable, but no longer a flat stack: Ask first stands alone, and the two that trade oversight for fewer interruptions are held in one bordered card labelled with what they have in common. Containment, not indent — the same fix that settled the folder cards.',
            render: () => <ModePane control={ModeStepUps} />,
          },
          {
            id: 'scale',
            label: 'A scale, not a row of tabs',
            note: 'Keeps the compact segmented picker — much the smallest form — but reframes it as an axis: the ends are named beneath it, and the key steps one indent further right per mode, so left-to-right and top-to-bottom both mean "less checking". Least chrome; the escalation is carried entirely by layout.',
            render: () => <ModePane control={ModeScale} />,
          },
        ],
      },
      {
        n: 3,
        basis:
          'R1 and R2 BOTH discarded — not one over the other, the whole category. All six candidates were controls (radio lists, segmented tabs, a row with a Change button): "this IS NOT AND SHOULD NOT BE A REAL PERMISSIONS SELECTOR. it still looks like a live selector that changes a setting". Permission mode is per-CONVERSATION state, owned by NativeSessionHost and set from the status-bar chip, so this screen has no app-wide value to write — a control here either does nothing or invents a setting that does not exist. R3 compares PRESENTATIONS OF REFERENCE CONTENT instead: three terms and their definitions as facts, no selected state, nothing clickable, and each one says where the mode is really changed. The axis is containment — its own card, no container, or one shared with the always-asks list.',
        candidates: [
          {
            id: 'quiet-card',
            label: 'Quiet informational card',
            note: 'What the component does today, as the baseline. Three run-in definitions on the same bg-inset/50 card the always-asks list uses — this screen\'s established "fact, not control" surface. The card groups them, so the terms only need weight.',
            render: () => (
              <ReferencePane>
                <ModeRefSections><ModeRefCard /></ModeRefSections>
              </ReferencePane>
            ),
          },
          {
            id: 'definition-list',
            label: 'Definition list, no card',
            note: 'A real <dl>: nothing drawn at all, so there is no box to mistake for a group of options, and a screen reader announces terms and definitions rather than three paragraphs. Without the card the labels have to be the structure, so they take their own line — which also puts the three names in a scannable column.',
            render: () => (
              <ReferencePane>
                <ModeRefSections><ModeRefDefinitions /></ModeRefSections>
              </ReferencePane>
            ),
          },
          {
            id: 'coupled',
            label: 'One explanation, both bands',
            note: 'Modes and the always-asks list share ONE card split by rules. Full auto ends "The list below is the exception" — here that list is inside the same box rather than a section away, so the sentence points at something the eye already reads as part of it. Both headings survive as band headers. Tallest object on the screen, and it breaks the one-section-per-idea rhythm.',
            render: () => (
              <ReferencePane>
                <ModeRefCoupled />
              </ReferencePane>
            ),
          },
        ],
      },
    ],
  },
  {
    id: 'full-auto-ask',
    label: 'Full auto — the destructive-command stop',
    question:
      'The only prompt full auto still shows is the stop before a destructive command — how should that card explain the stop, and which actions belong on it?',
    frame: 'canvas',
    // Chat-column width — the card lives in the timeline, not a dialog.
    paneWidth: 560,
    rounds: [
      {
        n: 1,
        candidates: [
          {
            id: 'explained-row',
            label: 'Explain, keep the buttons',
            note: 'Smallest change: today\'s Yes / Always Allow / No survives untouched (muscle memory, arrow-key row, the confirm behind Always Allow), and one amber line above it names why the mode stopped. Cost: three buttons still read as an ordinary "may I?" question, which is the complaint.',
            render: () => <FullAutoExplainedRow />,
          },
          {
            id: 'safety-stop',
            label: 'Safety stop — run it / skip it',
            note: 'The footer becomes the mode\'s own amber surface with two verbs, so it reads as "your agent stopped itself", not a permission quiz. "Always allow" demotes to a quiet line that opens the SAME are-you-sure step as today (click it — it works here). Cost: the rule-making action is easy to miss, on the one mode where it matters most.',
            render: () => <FullAutoSafetyStop />,
          },
          {
            id: 'checkpoint',
            label: 'Checkpoint — chip carries the why',
            note: 'The StatusBar\'s FULL AUTO chip re-appears on the card, the copy restates the mode\'s whole contract, one primary Continue. No way to create an always-allow rule from the card at all — that would move to Settings, which today can only revoke, and the shipped Permissions copy ("an entry switches off the last check") would need rewriting. The honest version of "auto-approve plus acknowledge".',
            render: () => <FullAutoCheckpoint />,
          },
        ],
      },
      {
        n: 2,
        basis:
          'R1 · B (safety stop). Owner correction: the underlined "stop checking this" line is out — the rule-making action returns as a real third button, an orange Always Allow to the right of Skip it with a | between (the header-row pipe). Framing, verbs, and the are-you-sure step behind Always Allow are settled; the round varies only which orange the button wears.',
        candidates: [
          {
            id: 'status-orange',
            label: 'Status orange',
            note: 'bg-orange-600/60, the exact grammar of the green/red/blue buttons one shade-family over — reads as a fourth member of the app\'s permission-button set. Distinct from both the amber band behind it and the blue Always Allow that Ask mode uses.',
            render: () => <FullAutoSafetyStopR2 always="status-orange" />,
          },
          {
            id: 'mode-amber',
            label: 'Mode amber',
            note: 'The FULL AUTO chip\'s own #F2B33D, saturated to button weight — ties the button to the mode identity, at the cost of sitting on an amber band of the same hue (least separation of the three).',
            render: () => <FullAutoSafetyStopR2 always="mode-amber" />,
          },
          {
            id: 'ghost-orange',
            label: 'Outlined orange',
            note: 'Same slot and color family but outlined, no fill — a half-step quieter than Run/Skip, keeping a whisper of R1·B\'s demotion while still being a visible button. Included as the conservative reading; skip if the solid buttons already look right.',
            render: () => <FullAutoSafetyStopR2 always="ghost" />,
          },
        ],
      },
      {
        n: 3,
        basis:
          'R2 · A (status orange). Layout, verbs, and the orange are settled. Owner direction: subline copy becomes "YouCoded prohibits this action…" and tightens under the header as a subheader — the only real space sits before the buttons. Compared: the VERB. "Prohibits" claims the app forbids what the green button one line down will run — the same shape of claim the Permissions screen walked back ("cannot be turned off" was false). A is the direction verbatim; B keeps the sentence but says what actually happens.',
        candidates: [
          {
            id: 'prohibits',
            label: '"Prohibits" (verbatim)',
            note: 'The owner\'s line untouched. Strongest wording — but the card itself offers Run it and Always Allow, so "prohibits" is contradicted two centimetres below the word.',
            render: () => <FullAutoSafetyStopR3 copy="prohibits" />,
          },
          {
            id: 'always-stops',
            label: '"Always stops"',
            note: 'Same sentence shape, accurate verb: the app always STOPS the action for your say-so, which is exactly what the card is doing. Punctuation normalized to the app\'s em-dash style.',
            render: () => <FullAutoSafetyStopR3 copy="stops" />,
          },
        ],
      },
      {
        n: 4,
        basis:
          'R3 — neither pane verbatim; the owner supplied a third verb, "limits". Settled line: "YouCoded limits this action, even in Full Auto — it changes your published code." on the normalized punctuation. Nothing left to compare — this round IS the record of the settled card.',
        candidates: [
          {
            id: 'settled',
            label: 'Settled',
            note: 'R2·A layout (Run it / Skip it | Always Allow in status orange), R3 subheader spacing, the "limits" line. The card that goes to spec.',
            render: () => <FullAutoSafetyStopR3 copy="limits" />,
          },
        ],
      },
    ],
  },
  {
    id: 'bash-grant-width',
    label: 'Always allow — how wide?',
    question:
      '"Always allow" can now mean this exact command OR a wider grant the app derived and named — where does that choice live, and how is it worded?',
    frame: 'canvas',
    // Chat-column width — the card lives in the timeline, not a dialog.
    paneWidth: 560,
    rounds: [
      {
        n: 1,
        candidates: [
          {
            id: 'buttons',
            label: 'A · Every width is a button',
            note: 'No new step: each option the app derived becomes its own button, so the wider grant is one click and is named on the card itself. Cost: the row grows to four buttons on the commands that matter most, the arrow-key order changes, and the widest grant is now reachable WITHOUT the consequence confirm that today guards a deny-listed always-allow.',
            render: () => <GrantWidthPane variant="buttons" />,
          },
          {
            id: 'radio',
            label: 'B · Choose inside the confirm',
            note: 'The card keeps exactly one Always Allow button; the confirm behind it gains a two-row choice with the exact option preselected. Every widening still passes the consequence step, and the button row never changes shape. Cost: the wider grant is invisible until you commit to the confirm, so most people will never learn it exists.',
            render: () => <GrantWidthPane variant="radio" />,
          },
          {
            id: 'inline',
            label: 'C · Widening is the second action',
            note: 'The confirm stays a yes/no about THIS command, and the widening sits under it as a quieter line. Preserves today\'s flow almost exactly and makes the narrow answer the obvious one. Cost: the least discoverable of the three, and an underlined text action is what R2 of the safety-stop round already rejected once.',
            render: () => <GrantWidthPane variant="inline" />,
          },
        ],
      },
      {
        n: 2,
        basis:
          'R1 · B (choose inside the confirm) — the SHAPE is settled: one Always Allow button on the card, the choice behind it. Two corrections landed with the pick. (1) Every git push row now offers ONE option, not two: the owner saw the two-option push card and said they were "just offering the same thing", which they were — a named grant and its exact rung differ only by options whose effect is invisible. (2) The consequence sentence is now gated on deny-listed, as ToolCard already gates it; R1 showed "may delete files" over `npm run build`, which the shipped card never would. R2 varies only HOW MUCH THE CONFIRM EXPLAINS, which is where the five open copy questions live: the heading (the shipped one says "this exact command", false for a branch grant), the option wording, whether the limits are stated before the grant is made rather than after it surprises someone, and what the bare `git push` card says when there is nothing to offer.',
        candidates: [
          {
            id: 'minimal',
            label: 'A · Say the least',
            note: 'The heading names whatever is being granted and nothing else changes. No limits stated anywhere, and the bare `git push` card just quietly has no Always Allow button. Smallest reading load, and the closest to today. Cost: the two places this design knowingly re-asks — a chained command, a force-push — arrive with no warning, and the missing button on row 3 looks like a bug.',
            render: () => <GrantWidthPane variant="radio" copy="minimal" />,
          },
          {
            id: 'options',
            label: 'B · Let the options explain themselves',
            note: 'One neutral heading ("Remember this for youcoded?"), and each choice carries its own one-line consequence underneath — including the chained-command limit, which sits on the wide option because that is the only option it applies to. Row 3 gets one quiet line saying why nothing can be remembered. Cost: the tallest confirm, and a heading that no longer names the thing being granted.',
            render: () => <GrantWidthPane variant="radio" copy="options" />,
          },
          {
            id: 'spelled',
            label: 'C · State the limits once, in full',
            note: 'Heading names the grant as in A, and one sentence under the choice says what it will NOT cover — for a branch, that it excludes deleting and force-pushing. Everything the user is not getting is in one place instead of split across two rows. Cost: the sentence has to cover both options at once, so it is the vaguest of the three, and it reads as fine print.',
            render: () => <GrantWidthPane variant="radio" copy="spelled" />,
          },
        ],
      },
      {
        n: 3,
        basis:
          'R2 · C (state the limits once, in full). Nothing left to compare — this round IS the record of the settled confirm, and every string in it is what Task 8 implements. Settled: the heading names what is being granted (the command, or the branch); one limits sentence under the choice, worded per grant type; the bare `git push` card carries its own line explaining why nothing can be remembered. The limits sentence is this item\'s ONLY warning about the two cases that will re-ask anyway — the after-the-fact explanation was dropped by amendment A5 — so it is load-bearing, not decoration.',
        candidates: [
          {
            id: 'settled',
            label: 'Settled',
            note: 'R1·B shape, R2·C copy. The card that goes to ToolCard.',
            render: () => <GrantWidthPane variant="radio" copy="spelled" />,
          },
        ],
      },
    ],
  },
  {
    id: 'chatsearch-results',
    label: 'Chat search results',
    question: 'How should past-conversation search results look in the chat?',
    frame: 'canvas',
    // Chat-column width — these cards render inline in the timeline, same as
    // every other tool-result card, not a dialog or panel.
    paneWidth: 420,
    rounds: [
      {
        n: 1,
        candidates: [
          {
            id: 'resume-rows',
            label: 'Resume Browser rows, in the chat',
            note: 'Maximum consistency: copies the row the owner already knows from the resume list, so nothing here has to be learned twice. Cost: that row was built for a full-width panel, so the metadata trail (project · date) feels tight at chat-column width, and six rows plus a header run tall.',
            render: () => <ChatsearchResultsA />,
          },
          {
            id: 'titled-panel',
            label: 'One titled panel, compact rows inside',
            note: 'A single labeled panel explains the whole group at a glance and the rows inside are dense enough to show all six without scrolling — the most compact of the three. Cost: two nested surfaces (the panel and the row tint) is more visual machinery than the chat column usually carries for one tool result.',
            render: () => <ChatsearchResultsB />,
          },
          {
            id: 'stacked-cards',
            label: 'Every result is its own conversation card',
            note: 'Reuses the exact card the single-conversation card already shows, so a search hit and a conversation you opened on purpose look like the same kind of thing — including its "Past conversation" label, which is the most explicit of the three about what these rows are. Cost: the most vertical space by far; six results pushes everything else in the chat well down the page.',
            render: () => <ChatsearchResultsC />,
          },
        ],
      },
      {
        n: 2,
        basis: 'R1 · B (titled-panel), with the owner\'s three changes applied: the panel header is now the open/close control, each row drops its leading ChatIcon (the header already says "past conversations"), and tags moved off their own line onto the project/date line. Open: only whether the panel should start open or closed — everything else about B is settled.',
        candidates: [
          {
            id: 'b-open',
            label: 'Open by default',
            note: 'Starts expanded, showing all six rows. The card\'s whole purpose is the Preview/Resume buttons, and a closed card hides them until clicked.',
            render: () => <ChatsearchPanelB2 defaultOpen />,
          },
          {
            id: 'b-closed',
            label: 'Closed by default',
            note: 'Starts collapsed to a single header line. Search results are often skimmed once and scrolled past, and a closed card keeps the conversation compact until you ask to see them.',
            render: () => <ChatsearchPanelB2 defaultOpen={false} />,
          },
        ],
      },
    ],
  },
  {
    id: 'chatsearch-present',
    label: 'Presented conversation',
    question: 'When the assistant puts a past conversation in front of you, how much of it should you see?',
    frame: 'canvas',
    // Was 420 (the chat-column width) through Round 6, three panes at a time.
    // Round 7 compares FOUR candidates — at 420 they don't fit side by side on
    // a normal window, so this narrowed to ~380 for the whole surface (there is
    // no per-round override in CompareSurface) so four panes have a better
    // chance of sitting in one row. Every candidate above still renders at its
    // real chat-bubble width regardless of this value — panes never stretch
    // wider than it, but nothing stops a candidate from being narrower.
    //
    // Raised to 500 for Round 8 (back to three panes). At 380 the bubble came
    // out ~320 wide, which is NARROWER than any real chat column — and the
    // table candidate, the only one whose columns compete for width, was the
    // one that suffered: it truncated titles to two characters. Judging a
    // layout at a width it never actually gets is how a candidate loses on a
    // problem it does not have. The earlier rounds re-render wider; their
    // recorded picks stand, since none of them turned on width.
    paneWidth: 500,
    rounds: [
      {
        n: 1,
        candidates: [
          {
            id: 'present-compact',
            label: 'Just the essentials',
            note: 'Title, tags, project, date, and the two buttons — nothing about what was actually said. The tightest of the three; the other two have to earn their extra height against this one.',
            render: () => <PresentCompact />,
          },
          {
            id: 'present-excerpt',
            label: 'With a line or two from it',
            note: 'Adds one quoted, quieter line under the title so you can recognise the conversation without opening it. Costs one more line per conversation than the compact version — and where that quoted line would really come from is not decided yet, see the report.',
            render: () => <PresentExcerpt />,
          },
          {
            id: 'present-minitranscript',
            label: 'A glimpse of the actual conversation',
            note: 'Shows a few real chat bubbles from the conversation, clipped to a fixed height so it can never grow past that no matter how long the real exchange was. The most recognisable of the three, and by far the tallest — with two conversations shown, this candidate is roughly triple the compact version\'s height.',
            render: () => <PresentMiniTranscript />,
          },
        ],
      },
      {
        n: 2,
        basis: 'R1 — all three rejected outright: "all way too busy with unclear visual hierarchy and structure." A reset, not a tweak — every candidate below drops the nested accent box, the tag chips, the lane label, and the second button, leaving one container at most (the bubble itself), a title that is clearly the heaviest thing in the block, and a single click target that opens the conversation. Resume is not on this block; it moves to the preview panel\'s header.',
        candidates: [
          {
            id: 'present-plain-list',
            label: 'No container at all',
            note: 'Whitespace alone groups the conversations — no border, no fill, no rule, ever, at rest. The plainest possible answer; if a heavier candidate doesn\'t clearly earn its extra ink over this one, this is the one to ship.',
            render: () => <PresentPlainList />,
          },
          {
            id: 'present-quoted',
            label: 'Quoted, like a reference',
            note: 'One left accent line runs down the side of the whole group, the way a quoted reference does elsewhere — a line, not a box, so it says "these are things I\'m referring to" without adding a fourth kind of container to the app.',
            render: () => <PresentQuoted />,
          },
          {
            id: 'present-attachments',
            label: 'Attached items',
            note: 'Each conversation is one tight row — a small paperclip mark, the title, the time — closer to a list of attached files than to a card. Densest of the three, and it drops the project name entirely to keep each row to one line.',
            render: () => <PresentAttachments />,
          },
        ],
      },
      {
        n: 3,
        basis: 'R2 rejected, harder than R1: "that\'s worse. it def still needs the preview/resume buttons and it needs to be consistent with other ui elements." Two fixes, not one tweak: Preview/Resume are real buttons again on every entry, and every candidate below stops being a NEW arrangement — each one is a literal, verbatim copy of ONE thing that already ships elsewhere in the app, so "consistent with other ui elements" is the candidate, not a note about it.',
        candidates: [
          {
            id: 'present-as-search-row',
            label: 'Looks like search results',
            note: 'The exact same row you already approved for search results (ChatsearchFindCard.tsx) — same title, same tag/project/date line, same Preview/Resume buttons — just sitting directly in the message instead of inside a results card. The only thing different is where it sits.',
            render: () => <PresentSearchRow />,
          },
          {
            id: 'present-as-plan-box',
            label: 'Looks like the assistant\'s plan box',
            note: 'The same tinted, bordered box the assistant already uses when it shows you a step-by-step plan mid-message, with a small heading on top the same way that box has one. A presented conversation reads as the same kind of thing as a plan.',
            render: () => <PresentPlanBox />,
          },
          {
            id: 'present-as-resume-card',
            label: 'Looks like the Resume screen\'s cards',
            note: 'Each conversation gets its own bordered card, the same shape as the cards on the "reopen a past conversation" screen you already use, stacked one after another. Consistent with the screen built for exactly this job.',
            render: () => <PresentResumeCard />,
          },
        ],
      },
      {
        n: 4,
        basis: 'R3 not rejected on its own merits — the owner named the target himself: "you should try to mimic the design of the new \'deliverables\' card somewhat." All three candidates below share ONE card shell and header, copied from that already-approved card (DeliverablesCard.tsx, branch feat/send-user-file-card — unmerged, so redrawn rather than imported, see the code comment above this round). What differs between them is only the body: how the tiles lay out, and how explicitly Preview/Resume are offered.',
        candidates: [
          {
            id: 'present-filmstrip-arrow',
            label: 'Filmstrip, glyph actions',
            note: 'Closest to the deliverables card: a sideways-scrolling row of tiles, and clicking a tile opens it, the same way a deliverable file opens. Preview and Resume are both there, just as two small icon buttons in the corner — the least spelled-out of the three.',
            render: () => <PresentFilmstripArrow />,
          },
          {
            id: 'present-filmstrip-buttons',
            label: 'Filmstrip, text buttons',
            note: 'Same sideways tiles, but Preview and Resume are full "Preview" / "Resume" buttons instead of icons — unmistakable, but two buttons is a tight fit on a tile this narrow, especially on a phone.',
            render: () => <PresentFilmstripButtons />,
          },
          {
            id: 'present-stacked-rows',
            label: 'Stacked rows, text buttons',
            note: 'Drops the sideways scrolling entirely — each conversation is a full-width row with a small square preview, the title and details in the middle, and the two buttons on the right. Nothing is ever hidden off the edge of the screen, but it takes more vertical space than a filmstrip once there are more than two or three.',
            render: () => <PresentStackedRows />,
          },
        ],
      },
      {
        n: 5,
        basis: 'R4 · C (Stacked rows, text buttons) — the owner\'s pick: "i like c (stacked) but we should drop the full quote and try to improve space efficiency/layout a bit." Same card shell and header; the preview square is gone from every row below (there is no file to stand in for any more) and each candidate reclaims that width a different way. Also switched to closed-by-default, matching both this feature\'s own search card and the Deliverables card this shell is copied from.',
        candidates: [
          {
            id: 'present-row-single',
            label: 'One line',
            note: 'Title, project · date, and the two buttons all share one line per conversation — the tightest of the three. The trade-off: once the buttons and the date claim their share, the title has the least room left to stay readable.',
            render: () => <PresentRowSingle />,
          },
          {
            id: 'present-row-two-line',
            label: 'Two lines, stacked',
            note: 'Title on its own line, project and date quietly beneath it, buttons centred at the right. The most ordinary list row — a little taller than the single-line version, but nothing has to fight for space.',
            render: () => <PresentRowTwoLine />,
          },
          {
            id: 'present-row-split',
            label: 'Two lines, full width',
            note: 'Title and date share the top line, project and the buttons share the bottom one — nothing is squeezed into a leftover sliver, but your eye has to travel corner to corner to read one conversation.',
            render: () => <PresentRowSplit />,
          },
        ],
      },
      {
        n: 6,
        basis: 'R5 · C (present-row-split) — the owner\'s pick: "more like c, try to keep tags." Skeleton unchanged (title/date on line 1, project/buttons on line 2); every candidate below adds tags back to it and answers only where they go. Fixture set replaced for this round alone — a two-tag row, a four-tag row carrying a long multi-word label, and a no-tag row — so the comparison can\'t look tidy just because R5\'s own two fixtures were lightly tagged.',
        candidates: [
          {
            id: 'present-tags-meta',
            label: 'Tags on the project line',
            note: 'Tags sit on line 2, right before the project name — the same tags-then-project order the search-result row already uses. Caps at two tags plus a "+N" chip so a heavily-tagged conversation can never push the project name or the buttons off the row, but that same cap means the project name and buttons are the ones fighting tags for space.',
            render: () => <PresentTagsMeta />,
          },
          {
            id: 'present-tags-title',
            label: 'Tags on the title line',
            note: 'Tags sit on line 1, between the title and the date — the first thing your eye reaches. Same two-then-"+N" cap as the other option, but now three things (title, tags, date) share the top line instead of two, so a long title has the least room of any candidate here.',
            render: () => <PresentTagsTitle />,
          },
          {
            id: 'present-tags-row',
            label: 'Tags on their own line',
            note: 'Tags drop to a full third line beneath project and buttons, wrapping instead of being capped — every tag is always visible, however many there are. Costs real height: a heavily-tagged conversation in a list of several makes the whole block taller, and a conversation with no tags stays two lines so this cost is only paid when there is something to show.',
            render: () => <PresentTagsRow />,
          },
        ],
      },
      {
        n: 7,
        basis: 'R4–R6 rejected as a family: "not a fan of any of these. a few more creative options please." The last three rounds were all one shape — a stacked list of rows carrying title/date/project/tags/two-buttons, differing only in density and where the tags sat. This round does not add a fourth density; each candidate below shows LESS at once and gives a specific way to get the rest back, stated in its note.',
        candidates: [
          {
            id: 'present-expand-in-place',
            label: 'Click a title to expand it',
            note: 'Defers everything but the title — date, project, tags, both buttons — for every conversation. Gets it back by making the title a real button: click it and that one row expands in place; click another and the first collapses, so only ever one row is "busy". At rest, N conversations cost N one-line rows.',
            render: () => <PresentExpandInPlace />,
          },
          {
            id: 'present-hover-actions',
            label: 'Buttons appear on hover',
            note: 'Defers the two buttons out of the layout entirely — they claim no row width at rest — and tags down to a color stripe on the left, with their names only in the row\'s tooltip. Gets the buttons back on hover or keyboard focus, floating over the row\'s right edge. Since a phone has no hover, narrow viewports put them back in the layout permanently instead — the one thing this candidate does not defer there.',
            render: () => <PresentHoverActions />,
          },
          {
            id: 'present-one-at-a-time',
            label: 'One conversation, full size',
            note: 'Defers every conversation except one — the other two render nothing at all. Gets them back via a pager (dots, prev/next, "n / total") that steps through the set; the one showing gets a full-size title, the full tag/project/date line with no cap, and full-size buttons. The trade-off the brief asked to see: the others are invisible until you page to them.',
            render: () => <PresentOneAtATime />,
          },
          {
            id: 'present-inline-mentions',
            label: 'Chips inside the sentence',
            note: 'Defers the entire block — no card, no list. A conversation becomes a small chip inside the assistant\'s own sentence, styled like the app\'s inline filepath pill. Gets everything back — date, project, tags, both buttons — in a popover that opens beneath the chip on click. The most radical option: it removes the block and makes a past conversation something the assistant can refer to mid-sentence, at the cost of being far less scannable than any list.',
            render: () => <PresentInlineMentions />,
          },
        ],
      },
      {
        n: 8,
        basis: 'Destin, 2026-08-27 gate (M-show / D4): "display" is no longer a tool — the assistant writes references into its own message in a set format and the renderer draws them. Every candidate reuses R5/R6\'s settled row unchanged and answers ONE new question: how does a group of references attach to the prose around it? Each shows TWO groups split by a sentence, because a single group in isolation cannot show it.',
        candidates: [
          {
            id: 'present-ref-boxed',
            label: 'Boxed group',
            note: 'Each group sits in its own bordered card between the paragraphs — the same border and background the app\'s other blocks use. Unmistakably a separate object you can act on, at the cost of two hard-edged boxes inside one message.',
            render: () => <PresentRefBoxed />,
          },
          {
            id: 'present-ref-hanging',
            label: 'Hanging off the sentence',
            note: 'No box. A rule down the left and an indent, the way a quotation hangs off the line that introduced it. The references read as part of what the assistant is saying rather than an attachment to it — but they are also less obviously a thing you can click.',
            render: () => <PresentRefHanging />,
          },
          {
            id: 'present-ref-table',
            label: 'Table, columns lined up',
            note: 'One line per conversation with columns that line up across BOTH groups, hairlines above and below, nothing wrapping the block. The most scannable when several conversations are named at once. The trade-off it is here to show: the title column is the first thing squeezed as the bubble narrows.',
            render: () => <PresentRefTable />,
          },
        ],
      },
    ],
  },
  // ── Session context panel (Step 3, 2026-08-17, broadened) ──────────────────
  // Destin: "look at various other UI elements and think through how we can
  // make this more closely match existing UI styling with card/pills/chips and
  // improved visual intuitiveness and hierarchy. use compare view to give me 2
  // alternatives." Round 1 = two restyle directions off the shipped panel.
  {
    id: 'session-context',
    label: 'Session context',
    question: 'How should the session-start context accounting be styled? Card-led (A) vs tabbed (B) — both match existing card/pill/chip language.',
    frame: 'panel',
    paneWidth: 420,
    rounds: [
      {
        n: 1,
        candidates: [
          {
            id: 'cards',
            label: 'A — Card stack',
            note: 'Every context surface becomes a real card (the border/inset recipe used across the app). One idea per card, status pills up top, tools as chips, skills as outlink rows, dropped-MCP as an amber card. Longest, most scannable hierarchy.',
            render: () => (
              <SfxPanel>
                <SfxCardAltA ctx={SFX_CTX} trimmed />
              </SfxPanel>
            ),
          },
          {
            id: 'tabs',
            label: 'B — Tabbed',
            note: 'SegmentedTabs at the top (Overview / Prompt / Instructions / Skills / Tools); one pane at a time so the dialog stays short. Rows use SettingRow-density. Fewest scroll, groups the read-most views; the "everything at once" accounting becomes per-view.',
            render: () => <SfxTabbed ctx={SFX_CTX} trimmed />,
          },
        ],
      },
      {
        // WHY a second round with no new design: the work sat unmerged for three weeks and was
        // rebuilt on top of ~1,000 master commits on 2026-09-09. This round is the rebase check —
        // the approved B, unchanged, in BOTH states it has (a small local model that was trimmed,
        // and a cloud model that got everything), so the review deck can show each as its own
        // live pane. The cloud state uses SFX_CTX_FULL, which round 1 defined but never rendered.
        n: 2,
        basis: 'R1 · B (Tabbed) approved 2026-08-17. Rebased onto master 2026-09-09 with no design change; shown in both of its states for the rebase check.',
        candidates: [
          {
            id: 'tabs-trimmed',
            label: 'B — small local model, trimmed',
            note: 'qwen2.5-coder:14b with a 16k window: the project instructions were read as an outline, one skill body was cut, and one MCP server was left unattached. Amber status pill and the Not attached callout.',
            render: () => <SfxTabbed ctx={SFX_CTX} trimmed />,
          },
          {
            id: 'tabs-full',
            label: 'B — cloud model, everything loaded',
            note: 'claude-sonnet-4-6 with a 200k window: nothing was cut, so the same layout reads green — Full context pill, no callout, no Full-vs-supplied toggle anywhere.',
            render: () => <SfxTabbed ctx={SFX_CTX_FULL} trimmed={false} />,
          },
        ],
      },
      {
        // Round 3 (2026-09-09): Destin — "review this yourself for a moment and clean it up
        // visually and try to make it clearer to users what the panel actually does/means."
        // Before = R2's approved B untouched; after = the same layout reworded and reordered
        // (SfxTabbedClear, numbered changes in its header comment).
        n: 3,
        basis: 'R2 · B rebased. Same tabbed layout; the words and the first tab are reworked so a non-developer can tell what the panel is and what a trim costs them.',
        candidates: [
          {
            id: 'before-trimmed',
            label: 'Before — small model, trimmed',
            note: 'The approved panel as it was: "Session context", a "16,384 ctx" chip, a Trimmed pill, and the cuts scattered across three tabs behind amber glyphs.',
            render: () => <SfxTabbed ctx={SFX_CTX} trimmed />,
          },
          {
            id: 'clear-trimmed',
            label: 'After — small model, trimmed',
            note: '"What the assistant was given"; the first tab says what was cut and what that costs, with one tappable row per cut; tabs are Overview / YouCoded / Project / Skills / Tools.',
            render: () => <SfxTabbedClear ctx={SFX_CTX} trimmed />,
          },
          {
            id: 'before-full',
            label: 'Before — cloud model, everything fit',
            note: 'The approved panel, green state.',
            render: () => <SfxTabbed ctx={SFX_CTX_FULL} trimmed={false} />,
          },
          {
            id: 'clear-full',
            label: 'After — cloud model, everything fit',
            note: 'Same rewording in the green state: "Everything fit" pill, one plain sentence, one summary row, no list.',
            render: () => <SfxTabbedClear ctx={SFX_CTX_FULL} trimmed={false} />,
          },
        ],
      },
      {
        // Round 4 (2026-09-09): "still aesthetically troubled and doesn't match styling used
        // in other popup modals and app surfaces." R3's words kept; the look rebuilt from the
        // real dialogs' vocabulary (SfxTabbedStyled's header comment lists each source).
        n: 4,
        basis: 'R3 words approved ("content is fine"). Same words, restyled to match the app’s dialogs: Dialog header, eyebrow sections, SettingRow stacks, well code blocks, no pill, no footer.',
        candidates: [
          {
            id: 'r3-trimmed',
            label: 'Before — R3, small model',
            note: 'The R3 panel: hand-drawn header, model line with a pill, cards with their own headings, a footer button.',
            render: () => <SfxTabbedClear ctx={SFX_CTX} trimmed />,
          },
          {
            id: 'styled-trimmed',
            label: 'After — small model, trimmed',
            note: 'Built like Preferences or Permissions: the dialog header, a warning callout, tabs, then eyebrow sections of SettingRow cards. Assistant settings is a navigating row, not a footer.',
            render: () => <SfxTabbedStyled ctx={SFX_CTX} trimmed />,
          },
          {
            id: 'styled-full',
            label: 'After — cloud model, everything fit',
            note: 'The green state: a dot-and-sentence card instead of the callout, then the same This chat rows.',
            render: () => <SfxTabbedStyled ctx={SFX_CTX_FULL} trimmed={false} />,
          },
          {
            // UX review 1 (U16): a context-free tester read the two-colour comparison as a
            // developer artefact and could not say what the assistant ended up with. This
            // candidate shows ONLY the cut text under "What was cut". Same panel otherwise.
            id: 'styled-trimmed-plain',
            label: 'After — small model, cut text shown plainly',
            note: 'Identical to styled-trimmed except the "What was cut" tab: just the text that was cut, no line numbers and no red/green comparison.',
            render: () => <SfxTabbedStyled ctx={SFX_CTX} trimmed cutStyle="plain" />,
          },
        ],
      },
      {
        // Round 5 (2026-09-10): Destin approved the words on review-4 G-1 and
        // asked for seven changes in the note. See SfxTabbedR5's header.
        n: 5,
        basis: 'Words approved (review-4 G-1 = yes). His note: one-line expandable warning, moved below the tabs and Overview-only; markdown for "what it got"; full-width switch; a rough size; tools as expandable rows.',
        candidates: [
          {
            id: 'r4-trimmed',
            label: 'Before — round 4, small model',
            note: 'What you answered yes to: warning pinned above the tabs on every tab, raw text in a code block, a small got/cut switch, tools as chips.',
            render: () => <SfxTabbedStyled ctx={SFX_CTX} trimmed />,
          },
          {
            id: 'r5-trimmed',
            label: 'After — small model, changes 21 to 27',
            note: 'Tabs first; the warning is one line on Overview only, opening to the full sentence with "(see details below)" back; markdown; a full-width switch with a line count; tools open in place.',
            render: () => <SfxTabbedR5 ctx={SFX_CTX} trimmed />,
          },
          {
            id: 'r5-full',
            label: 'After — cloud model, everything fit',
            note: 'The green state under the same changes: tabs first, the everything-fit card below them, tools that open.',
            render: () => <SfxTabbedR5 ctx={SFX_CTX_FULL} trimmed={false} />,
          },
          {
            id: 'r5-trimmed-plain',
            label: 'After — cut text shown plainly',
            note: 'Changes 21 to 27, with the "What was cut" tab showing only the text that was cut instead of the red/green comparison.',
            render: () => <SfxTabbedR5 ctx={SFX_CTX} trimmed cutStyle="plain" />,
          },
        ],
      },
    ],
  },
];

// ── Session context — Alternative A: card stack ──────────────────────────────
// The panel body rebuilt from the app's card vocabulary: border border-edge-dim
// bg-inset rounded-lg, one surface per card, StatusPill for state, ToolChip for
// tools, FilepathToken for outlinks. This is the RESTYLE of the shipping panel
// (SessionContextPopup.tsx) — same data, same sections, new visual grammar.

function SfxCard({ title, meta, children, warn = false }: {
  title: string; meta?: string; children: React.ReactNode; warn?: boolean;
}) {
  return (
    <div className={`rounded-lg border bg-inset px-3 py-2.5 ${warn ? 'border-[#FF9800]/40' : 'border-edge-dim'}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-2xs font-medium text-fg-muted tracking-wider uppercase">{title}</span>
        {meta && <span className="text-3xs text-fg-faint ml-auto">{meta}</span>}
      </div>
      {children}
    </div>
  );
}

function SfxCardAltA({ ctx, trimmed }: { ctx: CompleteSessionContext; trimmed: boolean }) {
  const c = ctx;
  return (
    <div className="flex flex-col gap-3">
      {/* Header card — model + status */}
      <div className="rounded-lg border border-edge-dim bg-inset px-3 py-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-fg">{c.modelLabel}</span>
          <span className="text-3xs text-fg-muted bg-panel rounded px-1.5 py-0.5 border border-edge-dim">
            {c.contextWindowTokens.toLocaleString()} token window
          </span>
          <span className="ml-auto">
            <StatusPill tone={trimmed ? 'warn' : 'ok'}>{trimmed ? 'Trimmed' : 'Full context'}</StatusPill>
          </span>
        </div>
        <div className="mt-2"><SfxStatusLine ctx={ctx} trimmed={trimmed} /></div>
      </div>

      {/* System prompt */}
      <SfxCard title="System prompt" meta={`${c.systemPrompt.length.toLocaleString()} chars`}>
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-2xs text-fg-2 leading-relaxed">
          {c.systemPrompt}
        </pre>
      </SfxCard>

      {/* Project instructions — truncated state with outlink */}
      <SfxCard
        title="Project instructions"
        meta={c.projectInstructions.truncated ? (c.projectInstructions.note ?? 'truncated') : 'full'}
      >
        <div className="flex items-center gap-2 text-xs text-fg-2 mb-1.5">
          <FilepathToken path={c.projectInstructions.path} sessionId="sfx" variant="inline" label={c.projectInstructions.path.split('/').slice(-1)[0]} />
          {c.projectInstructions.truncated && <span className="text-[#FF9800]">— read as outline</span>}
        </div>
        <pre className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words font-mono text-2xs text-fg-2 leading-relaxed">
          {c.projectInstructions.truncated ? c.projectInstructions.text + '\n\n… (outlined to fit the window — open the full file above)' : c.projectInstructions.text}
        </pre>
      </SfxCard>

      {/* Skills — rows with outlinks */}
      <SfxCard title={`Skills loaded (${c.skills.length})`}>
        <ul className="flex flex-col gap-1.5">
          {c.skills.map((s) => (
            <li key={s.id} className="flex items-center gap-2 text-xs min-w-0">
              <span className={`shrink-0 ${s.truncated ? 'text-[#FF9800]' : 'text-[#4CAF50]'}`}>
                {s.truncated ? '⚠' : '✓'}
              </span>
              <FilepathToken path={s.path ?? s.id} sessionId="sfx" variant="inline" label={s.label} />
              {s.truncated && <span className="text-3xs text-[#FF9800] ml-auto shrink-0">({s.note ?? 'body cut'})</span>}
            </li>
          ))}
        </ul>
      </SfxCard>

      {/* Tools — chips */}
      <SfxCard title={`Tools (${c.tools.length})`}>
        <div className="flex flex-wrap gap-1.5">
          {c.tools.map((t) => <ToolChip key={t} label={t} />)}
        </div>
      </SfxCard>

      {/* Dropped MCP — amber card, the one "never fine" surface */}
      {c.droppedMcpServers.length > 0 && (
        <SfxCard title="Not attached" warn>
          <ul className="space-y-1">
            {c.droppedMcpServers.map((s) => (
              <li key={s} className="text-xs text-fg-2 flex items-center gap-2">
                <span className="text-[#FF9800]">⛔</span> {s}
                <span className="text-3xs text-fg-muted ml-auto shrink-0">dropped to fit the tools budget</span>
              </li>
            ))}
          </ul>
        </SfxCard>
      )}
    </div>
  );
}

// ── Session context — Alternative B: tabbed ──────────────────────────────────
// SegmentedTabs over per-view panes. Each pane spaced with the panel's native
// `space-y-5`, rows at SettingRow density. The tab bar is the app's real
// SegmentedTabs (variant="contained").

function SfxTabbed({ ctx, trimmed }: { ctx: CompleteSessionContext; trimmed: boolean }) {
  const [tab, setTab] = React.useState('overview');
  const c = ctx;
  return (
    <SfxPanel>
      {/* Header — model + window, status pill pinned right, always visible above
          the tabs so the context row reads as one unit and the panes swap below. */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-fg truncate">{c.modelLabel}</span>
        <span className="text-3xs text-fg-muted bg-panel rounded px-1.5 py-0.5 border border-edge-dim shrink-0">
          {c.contextWindowTokens.toLocaleString()} ctx
        </span>
        <span className="ml-auto shrink-0">
          <StatusPill tone={trimmed ? 'warn' : 'ok'}>{trimmed ? 'Trimmed' : 'Full context'}</StatusPill>
        </span>
      </div>

      <SegmentedTabs
        variant="contained"
        aria-label="Session context views"
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'prompt', label: 'Prompt' },
          { id: 'instructions', label: 'Instructions' },
          { id: 'skills', label: 'Skills' },
          { id: 'tools', label: 'Tools' },
        ]}
        value={tab}
        onChange={setTab}
      />

      <div className="flex flex-col gap-3">
        {tab === 'overview' && (
          <>
            <div className="rounded-lg border border-edge-dim bg-inset px-3 py-2.5">
              <SfxStatusLine ctx={ctx} trimmed={trimmed} />
            </div>
            <div className="flex flex-col divide-y divide-edge-dim border border-edge-dim rounded-lg overflow-hidden">
              <SettingRow variant="item" title="Model" value={c.modelLabel} />
              <SettingRow variant="item" title="Context window" value={`${c.contextWindowTokens.toLocaleString()} tokens`} />
              <SettingRow
                variant="item"
                title="Loaded"
                value={`${c.skills.length} skills · ${c.tools.length} tools · instructions`}
              />
            </div>
            {c.droppedMcpServers.length > 0 && (
              <Callout tone="warning" title="Not attached">
                {c.droppedMcpServers.join(', ')} — dropped to fit the tools budget.
              </Callout>
            )}
          </>
        )}

        {tab === 'prompt' && (
          <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-fg-2 bg-inset/50 rounded-lg p-3 border border-edge-dim">
            {c.systemPrompt}
          </pre>
        )}

        {tab === 'instructions' && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-xs text-fg-2">
              <FilepathToken path={c.projectInstructions.path} sessionId="sfx" variant="inline" label={c.projectInstructions.path.split('/').slice(-1)[0]} />
              {c.projectInstructions.truncated && <span className="text-[#FF9800]">— read as outline</span>}
            </div>
            {c.projectInstructions.truncated ? (
              <TruncationDiff
                fullText={c.projectInstructions.fullText}
                supplied={c.projectInstructions.text}
                label="project-instruction"
              />
            ) : (
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-fg-2 bg-inset/50 rounded-lg p-3 border border-edge-dim">
                {c.projectInstructions.text}
              </pre>
            )}
          </div>
        )}

        {tab === 'skills' && (
          <ul className="flex flex-col gap-2">
            {c.skills.map((s) => (
              <li key={s.id} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 text-xs min-w-0">
                  <span className={`shrink-0 ${s.truncated ? 'text-[#FF9800]' : 'text-[#4CAF50]'}`}>
                    {s.truncated ? '⚠' : '✓'}
                  </span>
                  <FilepathToken path={s.path ?? s.id} sessionId="sfx" variant="inline" label={s.label} />
                  {s.truncated && <span className="text-3xs text-[#FF9800] ml-auto shrink-0">({s.note ?? 'body cut'})</span>}
                </div>
                {s.truncated && (
                  <TruncationDiff
                    fullText={s.fullText}
                    supplied={s.fullText ? s.fullText.split('\n').slice(0, 5).join('\n') + '\n… (body cut to fit the window)' : `… (${s.note ?? 'body cut'})`}
                    label="skill"
                  />
                )}
              </li>
            ))}
          </ul>
        )}

        {tab === 'tools' && (
          <div className="flex flex-wrap gap-1.5">
            {c.tools.map((t) => <ToolChip key={t} label={t} />)}
          </div>
        )}
      </div>
    </SfxPanel>
  );
}


// ── Session context — Round 3: the approved tabs, made legible ───────────────
// Destin, 2026-09-09: "clean it up visually and try to make it clearer to users
// what the panel actually does/means." Same layout as SfxTabbed (B, approved
// 2026-08-17); what changes is the WORDS and what the first tab leads with.
// WHY each move (numbered as on the review deck):
//  1 title says what the panel IS in plain words — "context" is the app's word for
//    how full the window is (ContextPopup), so reusing it here meant two different
//    things wore one name;
//  2 the status pill is a dot + neutral text (design guide §2.3), not coloured text;
//  3 the first tab leads with the CONSEQUENCE ("it may miss rules") not the mechanism;
//  4 what was left out is a list the user can tap, one row per cut, instead of being
//    scattered across three tabs behind amber glyphs;
//  5 model and window rows left the first tab — the header already shows both;
//  6 tab names are short nouns a non-developer can place ("YouCoded", "Project"),
//    which also stops the fifth tab clipping at 420px (measured 406px in 386px);
//  7 every tab opens with one line saying what that thing is;
//  8 the diff toggle says "What it got | What was cut", and the caption says who
//    missed what;
//  9 per-item notes are two words ("shortened", "cut short"), not mechanism;
// 10 the Tools tab carries the not-attached add-on, since that is where its tools
//    would have been;
// 11 the footer explains the button in one clause.

function SfxPill({ tone, children }: { tone: 'ok' | 'warn'; children: React.ReactNode }) {
  const c = tone === 'ok' ? '#4CAF50' : '#FF9800';
  return (
    <span className="inline-flex items-center gap-1.5 pl-1.5 pr-2 py-0.5 rounded-full text-3xs font-medium border border-edge-dim bg-inset/60 text-fg-2 shrink-0">
      <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: c }} aria-hidden />
      {children}
    </span>
  );
}

/** "16k" for 16,384; "200k" for 200,000; "1M" for a million. Users compare sizes, not digits. */
function sfxWindowLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return `${Math.round(tokens / 1000)}k`;
}

/** One line telling the user what a pane holds, above its content. */
function SfxPaneNote({ children }: { children: React.ReactNode }) {
  return <p className="text-2xs text-fg-muted leading-snug">{children}</p>;
}

/** The trimmed-copy viewer with the diff toggle, reworded (change 8). */
function SfxCutDiff({ fullText, supplied, what }: { fullText?: string | null; supplied: string; what: string }) {
  const [showDiff, setShowDiff] = React.useState(false);
  const diffable = !!fullText && fullText !== supplied;
  const pre = (
    <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-fg-2 bg-inset/50 rounded-lg p-3 border border-edge-dim">
      {supplied}
    </pre>
  );
  if (!diffable) return pre;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1 self-start bg-inset/50 rounded-lg p-0.5" role="tablist" aria-label={`${what}: what the assistant got, or what was cut`}>
        {([false, true] as const).map((diff) => (
          <button
            key={String(diff)}
            type="button"
            role="tab"
            aria-selected={showDiff === diff}
            onClick={() => setShowDiff(diff)}
            className={`px-2 py-0.5 rounded-md text-3xs font-medium transition-colors ${
              showDiff === diff ? 'bg-accent text-on-accent' : 'text-fg-2 hover:bg-inset'
            }`}
          >
            {diff ? 'What was cut' : 'What it got'}
          </button>
        ))}
      </div>
      {showDiff ? <UnifiedDiff oldStr={fullText} newStr={supplied} /> : pre}
      {showDiff && (
        <p className="text-3xs text-fg-muted leading-snug">
          Red lines were cut to fit this model’s context window — the assistant never saw them. Green lines are the shorter version it got instead.
        </p>
      )}
    </div>
  );
}

function SfxTabbedClear({ ctx, trimmed }: { ctx: CompleteSessionContext; trimmed: boolean }) {
  const [tab, setTab] = React.useState('overview');
  const c = ctx;
  const cutSkills = c.skills.filter((s) => s.truncated);
  const dropped = c.droppedMcpServers;
  const skillsWord = `${c.skills.length} skill${c.skills.length === 1 ? '' : 's'}`;
  const toolsWord = `${c.tools.length} tool${c.tools.length === 1 ? '' : 's'}`;

  // Change 3: the consequence sentence is built from what was actually cut.
  const cuts: string[] = [];
  if (c.projectInstructions.truncated) cuts.push('this project’s rules were shortened to headings');
  if (cutSkills.length) cuts.push(`${cutSkills.length} skill${cutSkills.length === 1 ? ' was' : 's were'} cut short`);
  if (dropped.length) cuts.push(`${dropped.length} add-on${dropped.length === 1 ? ' was' : 's were'} left out`);
  const cutSentence = cuts.length
    ? cuts.length === 1 ? cuts[0] : `${cuts.slice(0, -1).join(', ')} and ${cuts[cuts.length - 1]}`
    : '';

  return (
    <div className="flex flex-col">
      {/* Change 1: the title says what this is. */}
      <div className="px-4 pt-4 pb-3 border-b border-edge">
        <h2 className="text-sm font-bold text-fg">What the assistant was given</h2>
        <p className="text-2xs text-fg-muted mt-0.5">The instructions, skills and tools it started this chat with. They don’t change mid-chat.</p>
      </div>

      <div className="px-4 py-4 space-y-4">
        {/* WHY two lines, no tooltip: at 420px the model name truncated behind the chip and
            the pill, and the chip explained itself only on hover — Destin reviews on a
            touchscreen, where hover never happens. The explanation is now plain text. */}
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-fg truncate">{c.modelLabel}</span>
            <span className="ml-auto shrink-0">
              {/* Change 2 */}
              <SfxPill tone={trimmed ? 'warn' : 'ok'}>{trimmed ? 'Some left out' : 'Everything fit'}</SfxPill>
            </span>
          </div>
          <p className="text-3xs text-fg-muted leading-snug">
            {sfxWindowLabel(c.contextWindowTokens)} context window — how much it can hold at once
            {trimmed ? ', which is small' : ''}.
          </p>
        </div>

        {/* Change 6 */}
        <SegmentedTabs
          variant="contained"
          aria-label="What the assistant was given"
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'builtin', label: 'YouCoded' },
            { id: 'project', label: 'Project' },
            { id: 'skills', label: 'Skills' },
            { id: 'tools', label: 'Tools' },
          ]}
          value={tab}
          onChange={setTab}
        />

        <div className="flex flex-col gap-3">
          {tab === 'overview' && (
            <>
              {trimmed ? (
                <Callout tone="warning" title="Not everything fit">
                  This model’s context window is small ({sfxWindowLabel(c.contextWindowTokens)}), so {cutSentence}.
                  It may miss rules or skip steps it would normally follow.
                </Callout>
              ) : (
                <div className="rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex items-start gap-2">
                  <span className="inline-block w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" style={{ backgroundColor: '#4CAF50' }} aria-hidden />
                  <p className="text-xs text-fg-2 leading-snug">
                    <span className="font-medium text-fg">Everything fit.</span> The assistant has this project’s full rules, all {skillsWord} and all {toolsWord}.
                  </p>
                </div>
              )}

              {/* Change 4: one tappable row per cut, leading to the tab that shows it. */}
              {trimmed && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-3xs font-medium text-fg-muted tracking-wider uppercase">What was left out</p>
                  <div className="flex flex-col divide-y divide-edge-dim border border-edge-dim rounded-lg overflow-hidden">
                    {c.projectInstructions.truncated && (
                      <SettingRow variant="item" title="This project’s rules" description="Shortened to headings only" onClick={() => setTab('project')} />
                    )}
                    {cutSkills.map((sk) => (
                      <SettingRow key={sk.id} variant="item" title={`${sk.label} skill`} description="Cut short" onClick={() => setTab('skills')} />
                    ))}
                    {dropped.map((d) => (
                      <SettingRow key={d} variant="item" title={`${d} add-on`} description="Not attached — its tools can’t be used in this chat" onClick={() => setTab('tools')} />
                    ))}
                  </div>
                </div>
              )}

              {/* Change 5: one summary row instead of three. */}
              <div className="flex flex-col border border-edge-dim rounded-lg overflow-hidden">
                <SettingRow variant="item" title="Given" value={`this project’s rules · ${skillsWord} · ${toolsWord}`} />
              </div>
            </>
          )}

          {tab === 'builtin' && (
            <>
              <SfxPaneNote>YouCoded’s standing instructions. The same in every chat, whatever the project.</SfxPaneNote>
              <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-fg-2 bg-inset/50 rounded-lg p-3 border border-edge-dim">
                {c.systemPrompt}
              </pre>
            </>
          )}

          {tab === 'project' && (
            <>
              <SfxPaneNote>Rules written for this project, read once when the chat started.</SfxPaneNote>
              <div className="flex items-center gap-2 text-xs text-fg-2 min-w-0">
                <FilepathToken path={c.projectInstructions.path} sessionId="sfx" variant="inline" label={c.projectInstructions.path.split('/').slice(-1)[0]} />
                {c.projectInstructions.truncated && <span className="text-3xs text-fg-muted ml-auto shrink-0">shortened to headings</span>}
              </div>
              {c.projectInstructions.truncated ? (
                <SfxCutDiff fullText={c.projectInstructions.fullText} supplied={c.projectInstructions.text} what="Project rules" />
              ) : (
                <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-fg-2 bg-inset/50 rounded-lg p-3 border border-edge-dim">
                  {c.projectInstructions.text}
                </pre>
              )}
            </>
          )}

          {tab === 'skills' && (
            <>
              <SfxPaneNote>Step-by-step guides the assistant follows when a task matches one.</SfxPaneNote>
              <ul className="flex flex-col gap-2">
                {c.skills.map((sk) => (
                  <li key={sk.id} className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2 text-xs min-w-0">
                      <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: sk.truncated ? '#FF9800' : '#4CAF50' }} aria-hidden />
                      <FilepathToken path={sk.path ?? sk.id} sessionId="sfx" variant="inline" label={sk.label} />
                      {sk.truncated && <span className="text-3xs text-fg-muted ml-auto shrink-0">cut short</span>}
                    </div>
                    {sk.truncated && (
                      <SfxCutDiff
                        fullText={sk.fullText}
                        supplied={sk.fullText ? sk.fullText.split('\n').slice(0, 5).join('\n') + '\n… (cut here)' : '… (cut short)'}
                        what={`${sk.label} skill`}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          {tab === 'tools' && (
            <>
              <SfxPaneNote>Actions the assistant can take in this chat, like reading a file or running a command.</SfxPaneNote>
              <div className="flex flex-wrap gap-1.5">
                {c.tools.map((t) => <ToolChip key={t} label={t} />)}
              </div>
              {/* Change 10 */}
              {dropped.length > 0 && (
                <Callout tone="warning" title="Not attached">
                  {dropped.join(', ')} — there was no room for {dropped.length === 1 ? 'its' : 'their'} tools, so the assistant can’t use them in this chat.
                </Callout>
              )}
            </>
          )}
        </div>
      </div>

      {/* Change 11 */}
      <div className="mt-auto border-t border-edge px-4 pt-4 pb-4">
        <Button variant="secondary" size="md" className="w-full">Manage Assistant Settings</Button>
        <p className="text-2xs text-fg-muted mt-1.5 leading-snug">Coming soon: change the model, or what the assistant is given.</p>
      </div>
    </div>
  );
}


// ── Session context — Round 4: built from the dialog vocabulary ──────────────
// Destin, 2026-09-09, on R3: "content is fine, but this is still aesthetically
// troubled and doesn't match styling used in other popup modals and app surfaces."
// R3's words stay; every visual decision now comes from what the real dialogs do:
//  · header = Dialog.tsx's own geometry (px-4 py-3, hairline, text-sm font-bold
//    title, text-3xs subtitle, CloseButton) — not a hand-drawn band;
//  · body = Dialog's scroll track (px-4 py-4 space-y-5) with eyebrow sections
//    (G-7: the h3 recipe PreferencesPopup / SettingsExplainer use) — not cards
//    with their own headings;
//  · rows = SettingRow as PreferencesPopup stacks them (space-y-1.5, each its own
//    rounded bg-inset/50 card) — not a bordered divide-y group;
//  · the model / window / given facts are rows under "This chat", the same shape
//    every settings dialog uses for facts with a value;
//  · no pill: status is the Callout (warning) or the dot + fg-2 line the app uses
//    for "signed in" — G-14 says badges are dot + neutral text anyway;
//  · code blocks sit in `well` (the deepest surface, §2.1) at text-2xs (G-5 floor);
//  · no footer: settings-style dialogs have none (§4.3); "Assistant settings" is a
//    navigating SettingRow with the chevron every drawer row has;
//  · the cut toggle is the SegmentedTabs primitive (bare), not hand-rolled buttons.

const SFX_EYEBROW = 'block text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2';
const SFX_CODE = 'max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-fg-2 bg-well rounded-lg p-3 border border-edge-dim';

function SfxDot({ ok }: { ok: boolean }) {
  return <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${ok ? 'bg-green-500' : 'bg-amber-500'}`} aria-hidden />;
}

/** The lines present in the full file but absent from what the model was given.
 *  WHY a set difference rather than a real diff: this is mockup data, and the
 *  question the "plain" candidate exists to answer is whether a plain list READS
 *  better than a code diff — not how the cut is computed. The shipped version
 *  gets the removed lines from the same diff UnifiedDiff already runs. */
function sfxCutLines(fullText: string, supplied: string): string {
  const kept = new Set(supplied.split('\n').map((l) => l.trim()));
  return fullText.split('\n').filter((l) => l.trim() && !kept.has(l.trim())).join('\n');
}

/** Trimmed text with the got/cut switch — the SegmentedTabs primitive, bare.
 *
 *  `cutStyle` is the open question from UX review 1 (U16): "diff" is the app's
 *  own two-colour comparison, which a context-free tester read as a developer
 *  artefact — repeating line numbers, +/- markers, and green lines that are
 *  additions rather than cuts under a tab labelled "What was cut". "plain" shows
 *  only the text that was cut. Destin picks on the deck. */
function SfxCutBlock({ fullText, supplied, what, cutStyle = 'diff' }: { fullText?: string | null; supplied: string; what: string; cutStyle?: 'diff' | 'plain' }) {
  const [view, setView] = React.useState<'got' | 'cut'>('got');
  const diffable = !!fullText && fullText !== supplied;
  if (!diffable) return <pre className={SFX_CODE}>{supplied}</pre>;
  return (
    <div className="space-y-2">
      <SegmentedTabs
        variant="bare"
        aria-label={`${what}: what the assistant got, or what was cut`}
        tabs={[{ id: 'got', label: 'What it got' }, { id: 'cut', label: 'What was cut' }]}
        value={view}
        onChange={(v) => setView(v as 'got' | 'cut')}
      />
      {/* WHY the caption sits ABOVE the text (UX review 1, U17): underneath, it was
          below the fold of the box and read only after the reader had already been
          confused by the colours it explains. */}
      {view === 'cut' && (
        <p className="text-2xs text-fg-muted leading-snug">
          {cutStyle === 'plain'
            ? 'The assistant never saw this — it was cut to fit.'
            : 'Red was cut — the assistant never saw it. Green is the shorter version it got instead.'}
        </p>
      )}
      {view === 'cut'
        ? (cutStyle === 'plain'
          ? <pre className={SFX_CODE}>{sfxCutLines(fullText, supplied)}</pre>
          : <UnifiedDiff oldStr={fullText} newStr={supplied} />)
        : <pre className={SFX_CODE}>{supplied}</pre>}
    </div>
  );
}

function SfxTabbedStyled({ ctx, trimmed, cutStyle = 'diff' }: { ctx: CompleteSessionContext; trimmed: boolean; cutStyle?: 'diff' | 'plain' }) {
  const [tab, setTab] = React.useState('overview');
  const c = ctx;
  const cutSkills = c.skills.filter((s) => s.truncated);
  const dropped = c.droppedMcpServers;
  const skillsWord = `${c.skills.length} skill${c.skills.length === 1 ? '' : 's'}`;
  const toolsWord = `${c.tools.length} tool${c.tools.length === 1 ? '' : 's'}`;
  const basename = (p: string) => p.split('/').slice(-1)[0];

  return (
    <div className="flex flex-col">
      {/* Dialog.tsx header geometry — see the round comment. */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-fg truncate">What the assistant was given</h2>
          <p className="text-3xs text-fg-muted mt-0.5">Its instructions, skills and tools for this chat.</p>
        </div>
        <CloseButton onClick={() => {}} label="Close What the assistant was given" />
      </div>

      {/* Dialog.tsx scroll track. WHY a fixed height rather than hugging the content
          (UX review 1, U1 + U8): the panel is vertically centred, so a body that grew
          with its tab moved the tab strip ~120px between tabs — you re-aimed for every
          tab — and expanding the cut text pushed Collapse off the bottom of a window
          that had no scrollbar at all. One height, one scroller, nothing escapes. */}
      <div className="px-4 py-4 space-y-5 h-[460px] overflow-y-auto">
        {/* Destin, deck 3 (2026-09-09): "shrink the top banner to 1 sentence with (See details
            below)". The itemised cuts moved out — the list under WHAT WAS LEFT OUT already
            carries them — and the one sentence keeps the consequence, which is the point.
            "(see details below)" is GONE pending Destin's answer (UX review 1, U4). The
            banner is pinned above the tabs, so on four of the five tabs the phrase pointed
            at nothing; and showing it only on Overview made the sentence one line shorter
            elsewhere, moving the whole tab strip 16px — the jumping U8 is about. The phrase
            is his, from deck 3, so it is not deleted quietly: review-4 step G-1 asks whether
            he wants it back on the Overview tab. */}
        {trimmed ? (
          <Callout tone="warning" title="Not everything fit">
            This model’s context window is small ({sfxWindowLabel(c.contextWindowTokens)}), so some rules and skills were cut and it may miss steps it would normally follow.
          </Callout>
        ) : (
          <div className="rounded-lg bg-inset/50 px-3 py-2.5 flex items-start gap-2">
            <span className="mt-1.5"><SfxDot ok /></span>
            {/* WHY not "all 2 skills" (UX review 1, U11): the word "all" reads wrong
                against a small number — a tester stopped on it. The count alone says it. */}
            <p className="text-2xs text-fg-2 leading-relaxed">
              <span className="font-medium text-fg">Everything fit.</span> The assistant has this project’s full rules, {skillsWord} and {toolsWord}.
            </p>
          </div>
        )}

        <SegmentedTabs
          variant="contained"
          aria-label="What the assistant was given"
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'builtin', label: 'YouCoded' },
            { id: 'project', label: 'Project' },
            { id: 'skills', label: 'Skills' },
            { id: 'tools', label: 'Tools' },
          ]}
          value={tab}
          onChange={setTab}
        />

        {tab === 'overview' && (
          <>
            {trimmed && (
              <section>
                <h3 className={SFX_EYEBROW}>What was left out</h3>
                <div className="space-y-1.5">
                  {c.projectInstructions.truncated && (
                    <SettingRow variant="item" icon={<SfxDot ok={false} />} title="This project’s rules" description={`Shortened to headings only · ${basename(c.projectInstructions.path)}`} onClick={() => setTab('project')} />
                  )}
                  {cutSkills.map((sk) => (
                    <SettingRow key={sk.id} variant="item" icon={<SfxDot ok={false} />} title={`${sk.label} skill`} description="Cut short" onClick={() => setTab('skills')} />
                  ))}
                  {dropped.map((d) => (
                    <SettingRow key={d} variant="item" icon={<SfxDot ok={false} />} title={`${d} add-on`} description="Not attached — its tools can’t be used in this chat" onClick={() => setTab('tools')} />
                  ))}
                </div>
              </section>
            )}
            <section>
              <h3 className={SFX_EYEBROW}>This chat</h3>
              <div className="space-y-1.5">
                <SettingRow variant="item" title="Model" value={c.modelLabel} />
                <SettingRow
                  variant="item"
                  title="Context window"
                  description={trimmed ? 'How much it can hold at once — small' : 'How much it can hold at once'}
                  value={`${sfxWindowLabel(c.contextWindowTokens)} tokens`}
                />
                {/* WHY the rules file is counted too (UX review 1, U12): "rules · 3 skills ·
                    7 tools" read like a number had been dropped from the first item. */}
                <SettingRow variant="item" title="Given" value={`1 rules file · ${skillsWord} · ${toolsWord}`} />
              </div>
            </section>
            <section>
              <h3 className={SFX_EYEBROW}>More</h3>
              <SettingRow
                variant="item"
                title="Assistant settings"
                description="Change the model, or what the assistant is given"
                onClick={() => {}}
              />
            </section>
          </>
        )}

        {tab === 'builtin' && (
          <section>
            <h3 className={SFX_EYEBROW}>Built-in instructions</h3>
            {/* WHY shorter (UX review 1, U30): "standing instructions" is stiff, and the
                two halves said the same thing twice. */}
            <p className="text-2xs text-fg-muted leading-snug mb-2">The same in every chat, whatever the project.</p>
            <pre className={SFX_CODE}>{c.systemPrompt}</pre>
          </section>
        )}

        {tab === 'project' && (
          <section>
            <h3 className={SFX_EYEBROW}>This project’s rules</h3>
            <p className="text-2xs text-fg-muted leading-snug mb-2">Written for this project and read once when the chat started.</p>
            <div className="space-y-1.5 mb-2">
              {/* WHY the filename is still the row's title (UX review 1, U15): a tester
                  clicked "This project's rules" on Overview and landed on a row called
                  CLAUDE.md, which meant nothing to them. The eyebrow above already
                  repeats the friendly name, so the fix is on the Overview row — it now
                  names the file it will take you to — rather than saying the same four
                  words twice on this tab. */}
              <SettingRow
                variant="item"
                icon={<SfxDot ok={!c.projectInstructions.truncated} />}
                title={basename(c.projectInstructions.path)}
                description={c.projectInstructions.truncated ? 'Shortened to headings only' : 'Read in full'}
                accessory={<Button variant="secondary" size="sm">Open</Button>}
              />
            </div>
            {c.projectInstructions.truncated
              ? <SfxCutBlock fullText={c.projectInstructions.fullText} supplied={c.projectInstructions.text} what="Project rules" cutStyle={cutStyle} />
              : <pre className={SFX_CODE}>{c.projectInstructions.text}</pre>}
          </section>
        )}

        {tab === 'skills' && (
          <section>
            <h3 className={SFX_EYEBROW}>Skills</h3>
            <p className="text-2xs text-fg-muted leading-snug mb-2">Step-by-step guides the assistant follows when a task matches one.</p>
            <div className="space-y-1.5">
              {c.skills.map((sk) => (
                <div key={sk.id} className="space-y-2">
                  <SettingRow
                    variant="item"
                    icon={<SfxDot ok={!sk.truncated} />}
                    title={sk.label}
                    description={sk.truncated ? 'Cut short' : 'Loaded in full'}
                    accessory={<Button variant="secondary" size="sm">Open</Button>}
                  />
                  {/* WHY a skill that fit shows its text too (UX review 1, U9): a tester
                      found skills readable only when they had been CUT, while the Project
                      tab showed its file either way — so in a chat where nothing was cut
                      the Skills tab was two rows and nothing to read. */}
                  {sk.truncated ? (
                    <SfxCutBlock
                      fullText={sk.fullText}
                      supplied={sk.fullText ? sk.fullText.split('\n').slice(0, 5).join('\n') + '\n… (cut here)' : '… (cut short)'}
                      what={`${sk.label} skill`}
                      cutStyle={cutStyle}
                    />
                  ) : (
                    sk.fullText && <pre className={SFX_CODE}>{sk.fullText}</pre>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {tab === 'tools' && (
          <section className="space-y-3">
            <div>
              <h3 className={SFX_EYEBROW}>Tools</h3>
              <p className="text-2xs text-fg-muted leading-snug mb-2">Actions the assistant can take in this chat, like reading a file or running a command.</p>
              <div className="flex flex-wrap gap-1.5">
                {c.tools.map((t) => <ToolChip key={t} label={t} />)}
              </div>
            </div>
            {dropped.length > 0 && (
              <Callout tone="warning" title="Not attached">
                {dropped.join(', ')} — there was no room for {dropped.length === 1 ? 'its' : 'their'} tools, so the assistant can’t use them in this chat.
              </Callout>
            )}
          </section>
        )}
      </div>
    </div>
  );
}


// ── Round 5 (2026-09-10) — Destin's notes on his G-1 answer ──────────────────
// He approved the words ("yes"), then asked for seven changes. Numbered from 21
// so nothing already approved is renumbered:
//   21 the warning is ONE line, expandable;
//   22 it sits BELOW the tab strip, and only on Overview;
//   23 "(see details below)" comes back — round 4 removed it because a banner
//      pinned above the tabs pointed at nothing on four of the five tabs, and 22
//      makes it true again: the card now sits directly above the list it names;
//   24 "What it got" renders through the app's own markdown renderer;
//   25 the got/cut switch spans the width of the panel;
//   26 each side carries a rough size;
//   27 tools are full-width expandable rows carrying a description.

/** Plain-English blurbs for the app's own tools. WHY they live here rather than
 *  arriving with the session: a tool's description is a constant of the tool, not
 *  a fact about this chat, so shipping it per session would be paying on every
 *  connection for something that never changes. And the descriptions in the tool
 *  registry are written FOR THE MODEL — "Load a named skill's instructions and
 *  follow them" is not what a non-developer needs to read. An MCP tool has no
 *  entry here and falls back to naming the add-on it came from. */
const SFX_TOOL_BLURBS: Record<string, string> = {
  Read: 'Opens a file and reads what is in it.',
  Write: 'Creates a new file, or replaces one that already exists.',
  Edit: 'Changes part of a file and leaves the rest alone.',
  Bash: 'Runs a command on your computer, the way a terminal does.',
  Glob: 'Finds files by name — every file ending in .md, say.',
  Grep: 'Searches inside files for a word or phrase.',
  TodoWrite: 'Keeps a checklist of what it is working on.',
  WebFetch: 'Opens a web page and reads it.',
  WebSearch: 'Searches the web.',
  Task: 'Hands a piece of work to a helper that works on its own.',
  Skill: 'Loads a set of step-by-step instructions you have installed.',
  AskUserQuestion: 'Stops and asks you a question when it needs a decision.',
};

function sfxToolBlurb(name: string): string {
  const known = SFX_TOOL_BLURBS[name];
  if (known) return known;
  const parts = name.split('__');
  return parts.length >= 3 && parts[0] === 'mcp'
    ? `Part of the ${parts[1]} add-on. Only that add-on knows what it does.`
    : 'An action the assistant can take in this chat.';
}

/** Change 27. SettingRow's own `expanded` mode — the shape Destin picked on
 *  2026-09-05 ("I HATE the bare dropdowns with a chevron"): the same right-hand
 *  chevron every navigating row has, turned down while open. */
function SfxToolRow({ name }: { name: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <SettingRow variant="item" title={name} expanded={open} onClick={() => setOpen((o) => !o)} />
      {open && <p className="text-2xs text-fg-2 leading-relaxed px-3 pt-1.5">{sfxToolBlurb(name)}</p>}
    </div>
  );
}

/** Change 21 + 23. Collapsed it is one line; opened it is the sentence approved
 *  in round 3, with Destin's "(see details below)" restored now that 22 puts the
 *  card directly above the list that phrase points at. */
function SfxWarnCard({ windowLabel }: { windowLabel: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Callout tone="warning">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 text-left cursor-pointer"
      >
        {/* Collapsed it is Destin's own four words, which fit the panel at every
            width — an explanatory clause here clipped at 420px, and a warning you
            cannot finish reading is not a warning. */}
        <span className={`flex-1 min-w-0 font-medium ${open ? '' : 'truncate'}`}>
          {open
            ? `This model’s context window is small (${windowLabel}), so some rules and skills were cut and it may miss steps it would normally follow (see details below).`
            : 'Not everything fit'}
        </span>
        <svg
          className={`w-4 h-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </Callout>
  );
}

/** Change 24. The app's own markdown renderer, inside the well the code blocks
 *  used. A SKILL.md and a CLAUDE.md ARE markdown, so showing them as raw source
 *  made the panel look like a developer tool for no gain. */
function SfxMd({ text }: { text: string }) {
  // WHY the heading overrides: MarkdownContent is sized for a chat bubble, where a
  // level-1 heading is a real heading. Dropped unchanged into a 420px panel it
  // dwarfs everything around it and the quote stops reading as a detail of the
  // row above it. Sizes only — the renderer still owns lists, code and links.
  return (
    <div className="max-h-64 overflow-y-auto rounded-lg bg-well p-3 border border-edge-dim text-2xs text-fg-2
      [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-2xs [&_h4]:text-2xs
      [&_h1]:mt-0 [&_h2]:mt-2 [&_h3]:mt-2
      [&_p]:text-2xs [&_li]:text-2xs [&_code]:text-2xs [&_pre]:text-2xs">
      <MarkdownContent content={text} />
    </div>
  );
}

const sfxLines = (s: string) => s.split('\n').filter((l) => l.trim() !== '').length;

/** Changes 24, 25, 26 applied to the got/cut switch. */
function SfxCutBlockR5({ fullText, supplied, what, cutStyle = 'diff' }: { fullText?: string | null; supplied: string; what: string; cutStyle?: 'diff' | 'plain' }) {
  const [view, setView] = React.useState<'got' | 'cut'>('got');
  const diffable = !!fullText && fullText !== supplied;
  if (!diffable) return <SfxMd text={supplied} />;
  const cutCount = Math.max(0, sfxLines(fullText) - sfxLines(supplied));
  return (
    <div className="space-y-2">
      <SegmentedTabs
        variant="contained"
        aria-label={`${what}: what the assistant got, or what was cut`}
        tabs={[{ id: 'got', label: 'What it got' }, { id: 'cut', label: 'What was cut' }]}
        value={view}
        onChange={(v) => setView(v as 'got' | 'cut')}
      />
      {/* Change 26: a rough size, so "some was cut" has a scale attached. Lines
          rather than a count of characters — it is the unit a person can picture. */}
      <p className="text-3xs text-fg-muted">
        {view === 'got'
          ? `${sfxLines(supplied)} lines the assistant read`
          : `${cutCount} lines it never saw`}
      </p>
      {view === 'cut' && (
        <p className="text-2xs text-fg-muted leading-snug">
          {cutStyle === 'plain'
            ? 'The assistant never saw this — it was cut to fit.'
            : 'Red was cut — the assistant never saw it. Green is the shorter version it got instead.'}
        </p>
      )}
      {view === 'cut'
        ? (cutStyle === 'plain'
          ? <pre className={SFX_CODE}>{sfxCutLines(fullText, supplied)}</pre>
          : <UnifiedDiff oldStr={fullText} newStr={supplied} />)
        : <SfxMd text={supplied} />}
    </div>
  );
}

function SfxTabbedR5({ ctx, trimmed, cutStyle = 'diff' }: { ctx: CompleteSessionContext; trimmed: boolean; cutStyle?: 'diff' | 'plain' }) {
  const [tab, setTab] = React.useState('overview');
  const c = ctx;
  const cutSkills = c.skills.filter((s) => s.truncated);
  const dropped = c.droppedMcpServers;
  const skillsWord = `${c.skills.length} skill${c.skills.length === 1 ? '' : 's'}`;
  const toolsWord = `${c.tools.length} tool${c.tools.length === 1 ? '' : 's'}`;
  const basename = (p: string) => p.split('/').slice(-1)[0];

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-fg truncate">What the assistant was given</h2>
          <p className="text-3xs text-fg-muted mt-0.5">Its instructions, skills and tools for this chat.</p>
        </div>
        <CloseButton onClick={() => {}} label="Close What the assistant was given" />
      </div>

      <div className="px-4 py-4 space-y-5 h-[460px] overflow-y-auto">
        {/* Change 22: the tabs come FIRST now. The status card belongs to the
            Overview tab rather than standing over all five. */}
        <SegmentedTabs
          variant="contained"
          aria-label="What the assistant was given"
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'builtin', label: 'YouCoded' },
            { id: 'project', label: 'Project' },
            { id: 'skills', label: 'Skills' },
            { id: 'tools', label: 'Tools' },
          ]}
          value={tab}
          onChange={setTab}
        />

        {tab === 'overview' && (
          <>
            {trimmed ? (
              <SfxWarnCard windowLabel={sfxWindowLabel(c.contextWindowTokens)} />
            ) : (
              <div className="rounded-lg bg-inset/50 px-3 py-2.5 flex items-start gap-2">
                <span className="mt-1.5"><SfxDot ok /></span>
                <p className="text-2xs text-fg-2 leading-relaxed">
                  <span className="font-medium text-fg">Everything fit.</span> The assistant has this project’s full rules, {skillsWord} and {toolsWord}.
                </p>
              </div>
            )}
            {trimmed && (
              <section>
                <h3 className={SFX_EYEBROW}>What was left out</h3>
                <div className="space-y-1.5">
                  {c.projectInstructions.truncated && (
                    <SettingRow variant="item" icon={<SfxDot ok={false} />} title="This project’s rules" description={`Shortened to headings only · ${basename(c.projectInstructions.path)}`} onClick={() => setTab('project')} />
                  )}
                  {cutSkills.map((sk) => (
                    <SettingRow key={sk.id} variant="item" icon={<SfxDot ok={false} />} title={`${sk.label} skill`} description="Cut short" onClick={() => setTab('skills')} />
                  ))}
                  {dropped.map((d) => (
                    <SettingRow key={d} variant="item" icon={<SfxDot ok={false} />} title={`${d} add-on`} description="Not attached — its tools can’t be used in this chat" onClick={() => setTab('tools')} />
                  ))}
                </div>
              </section>
            )}
            <section>
              <h3 className={SFX_EYEBROW}>This chat</h3>
              <div className="space-y-1.5">
                <SettingRow variant="item" title="Model" value={c.modelLabel} />
                <SettingRow
                  variant="item"
                  title="Context window"
                  description={trimmed ? 'How much it can hold at once — small' : 'How much it can hold at once'}
                  value={`${sfxWindowLabel(c.contextWindowTokens)} tokens`}
                />
                <SettingRow variant="item" title="Given" value={`1 rules file · ${skillsWord} · ${toolsWord}`} />
              </div>
            </section>
            <section>
              <h3 className={SFX_EYEBROW}>More</h3>
              <SettingRow
                variant="item"
                title="Assistant settings"
                description="Change the model, or what the assistant is given"
                onClick={() => {}}
              />
            </section>
          </>
        )}

        {tab === 'builtin' && (
          <section>
            <h3 className={SFX_EYEBROW}>Built-in instructions</h3>
            <p className="text-2xs text-fg-muted leading-snug mb-2">The same in every chat, whatever the project.</p>
            <SfxMd text={c.systemPrompt} />
          </section>
        )}

        {tab === 'project' && (
          <section>
            <h3 className={SFX_EYEBROW}>This project’s rules</h3>
            <p className="text-2xs text-fg-muted leading-snug mb-2">Written for this project and read once when the chat started.</p>
            <div className="space-y-1.5 mb-2">
              <SettingRow
                variant="item"
                icon={<SfxDot ok={!c.projectInstructions.truncated} />}
                title={basename(c.projectInstructions.path)}
                description={c.projectInstructions.truncated ? 'Shortened to headings only' : 'Read in full'}
                accessory={<Button variant="secondary" size="sm">Open</Button>}
              />
            </div>
            {c.projectInstructions.truncated
              ? <SfxCutBlockR5 fullText={c.projectInstructions.fullText} supplied={c.projectInstructions.text} what="Project rules" cutStyle={cutStyle} />
              : <SfxMd text={c.projectInstructions.text} />}
          </section>
        )}

        {tab === 'skills' && (
          <section>
            <h3 className={SFX_EYEBROW}>Skills</h3>
            <p className="text-2xs text-fg-muted leading-snug mb-2">Step-by-step guides the assistant follows when a task matches one.</p>
            <div className="space-y-1.5">
              {c.skills.map((sk) => (
                <div key={sk.id} className="space-y-2">
                  <SettingRow
                    variant="item"
                    icon={<SfxDot ok={!sk.truncated} />}
                    title={sk.label}
                    description={sk.truncated ? 'Cut short' : 'Loaded in full'}
                    accessory={<Button variant="secondary" size="sm">Open</Button>}
                  />
                  {sk.truncated ? (
                    <SfxCutBlockR5
                      fullText={sk.fullText}
                      supplied={sk.fullText ? sk.fullText.split('\n').slice(0, 5).join('\n') + '\n… (cut here)' : '… (cut short)'}
                      what={`${sk.label} skill`}
                      cutStyle={cutStyle}
                    />
                  ) : (
                    sk.fullText && <SfxMd text={sk.fullText} />
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {tab === 'tools' && (
          <section className="space-y-3">
            <div>
              <h3 className={SFX_EYEBROW}>Tools</h3>
              <p className="text-2xs text-fg-muted leading-snug mb-2">Actions the assistant can take in this chat. Open one to see what it does.</p>
              {/* Change 27: full-width rows that expand, not chips. */}
              <div className="space-y-1.5">
                {c.tools.map((t) => <SfxToolRow key={t} name={t} />)}
              </div>
            </div>
            {dropped.length > 0 && (
              <Callout tone="warning" title="Not attached">
                {dropped.join(', ')} — there was no room for {dropped.length === 1 ? 'its' : 'their'} tools, so the assistant can’t use them in this chat.
              </Callout>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

// CompareView opens on COMPARE_SURFACES[0] and has no URL param for the surface,
// so whichever entry is first is the one a plain ?view=compare lands on. Order by
// what is under active design rather than by authoring order — otherwise every
// visit starts with a dropdown hunt for the round actually being worked on.
const ACTIVE_FIRST = 'session-context';

// ── voice-mic ────────────────────────────────────────────────────────────────
// The real InputBar, compact (no quick chips), each pane born against its own
// voice fake. WHY the swap happens in THIS component's render body: React walks
// the tree depth-first, so the InputBar below mounts (and its useVoiceInput
// captures window.claude.voice ONCE, via a useState initializer) before the
// next sibling pane's demo renders and swaps the next fake in. Dev-only; the
// workbench page's own fake is restored by the last pane that mounts. A short
// assistant turn sits above the composer so the mic is judged in its context.
function VoiceComposerDemo({ state, style, loop }: { state: 'ready' | 'needs-download' | 'unavailable'; style?: Partial<VoiceStyle>; loop?: boolean }) {
  const mockRef = React.useRef<ReturnType<typeof createVoiceMock> | null>(null);
  if (!mockRef.current) mockRef.current = createVoiceMock(state, { loopReset: !!loop });
  window.claude.voice = mockRef.current;
  const boxRef = React.useRef<HTMLDivElement>(null);
  // Round 2 judges the LISTENING state, so a looping pane keeps the mic open:
  // whenever the fake has closed it, tap it again. Dev harness only — it drives
  // the real button through a click, the way a finger would.
  React.useEffect(() => {
    if (!loop) return;
    const id = window.setInterval(() => {
      const btn = boxRef.current?.querySelector<HTMLButtonElement>('[aria-label="Speak your message"]');
      btn?.click();
    }, 900);
    return () => window.clearInterval(id);
  }, [loop]);
  return (
    <ChatProvider>
      <SkillProvider>
      <VoiceStyleContext.Provider value={{ ...DEFAULT_VOICE_STYLE, ...style }}>
        <div ref={boxRef} className="flex flex-col gap-3">
          <div className="px-3">
            <div className="bg-inset rounded-xl px-3 py-2 text-sm text-fg max-w-[85%]">
              Sure — which spreadsheet, and what should I change?
            </div>
          </div>
          <InputBar sessionId="voice-demo" compact />
        </div>
      </VoiceStyleContext.Provider>
      </SkillProvider>
    </ChatProvider>
  );
}

export const COMPARE_SURFACES: CompareSurface[] = [
  {
    id: 'friendly-mascots', label: 'Default buddy palette',
    question: 'Does the lighter body and dark face feel friendlier?',
    frame: 'canvas', paneWidth: 752,
    rounds: [{ n: 1, candidates: [
      { id: 'before', label: 'Before', render: () => <FriendlyMascots after={false} /> },
      { id: 'after', label: 'After', render: () => <FriendlyMascots after /> },
    ] }],
  },
  {
    id: 'voice-listening-feedback',
    label: 'Message box — listening feedback',
    question: 'While the mic listens, where should the loudness meter and the clock live?',
    frame: 'canvas',
    paneWidth: { min: 440, max: 700 },
    rounds: [
      {
        n: 1,
        basis: 'Round 1 of the voice deck (V-1, 2026-09-05): Destin approved the mic and asked for "a few alternatives for the counter/feedback location and styling". Every pane loops the listening state; the mic motion is the round-1 breathing ring in all three.',
        candidates: [
          { id: 'beside', label: 'A · Beside the mic', note: 'Round 1: bars and m:ss left of the glowing mic, inside the box. NOT PICKED (2026-09-05).', render: () => <VoiceComposerDemo state="ready" loop style={{ feedback: 'beside' }} /> },
          { id: 'strip', label: 'B · Strip above the box', note: 'The model-loading band, reused: dot, "Listening", bars and clock above the box. Pushes the chat up one row while listening. PICKED 2026-09-05 — now the default.', render: () => <VoiceComposerDemo state="ready" loop style={{ feedback: 'strip' }} /> },
          { id: 'placeholder', label: 'C · In the empty line', note: 'Bars and clock where the placeholder was; they step aside as the first words arrive, leaving only the glowing mic. NOT PICKED (2026-09-05).', render: () => <VoiceComposerDemo state="ready" loop style={{ feedback: 'placeholder' }} /> },
        ],
      },
    ],
  },
  {
    id: 'voice-mic-motion',
    label: 'Message box — mic motion',
    question: 'How should the mic button move while it listens?',
    frame: 'canvas',
    paneWidth: { min: 440, max: 700 },
    rounds: [
      {
        n: 1,
        basis: 'Round 1 of the voice deck (V-1, 2026-09-05): "…and the animation on the mic icon". Every pane loops the listening state; the feedback is the round-1 beside-the-mic meter in all three.',
        candidates: [
          { id: 'breathe', label: 'A · Breathing ring', note: 'Round 1: a stepped ring grows out of the filled mic every 1.4 s, regardless of loudness. NOT PICKED (2026-09-05).', render: () => <VoiceComposerDemo state="ready" loop style={{ motion: 'breathe' }} /> },
          { id: 'level', label: 'B · Ring follows your voice', note: 'No timer: the ring\'s size is the loudness, 2 to 12 px. Reacts the instant you speak, still when you pause. PICKED 2026-09-05 ("make the max size a tad smaller tho") — now 2 to 9 px and the default.', render: () => <VoiceComposerDemo state="ready" loop style={{ motion: 'level' }} /> },
          { id: 'dot', label: 'C · Recording dot', note: 'The mic sits still; a red dot on its corner blinks every 1.2 s, the way a recorder does. NOT PICKED (2026-09-05).', render: () => <VoiceComposerDemo state="ready" loop style={{ motion: 'dot' }} /> },
        ],
      },
    ],
  },
  {
    id: 'voice-mic',
    label: 'Message box — the mic',
    question: 'Tap the mic (or hold Space in the empty box), watch the words land, open the first-run card: does the composer with a mic feel right?',
    frame: 'canvas',
    // The composer is wide and short: judged at the width the page can give it.
    paneWidth: { min: 440, max: 760 },
    rounds: [
      {
        n: 1,
        candidates: [
          {
            id: 'ready',
            label: 'Ready',
            note: 'The engine is installed. Tap the mic, or hold Space in the empty box: a scripted sentence lands live, the last two words grey until they settle, then the mic closes itself after two quiet seconds and the text waits for Send.',
            render: () => <VoiceComposerDemo state="ready" />,
          },
          {
            id: 'first-run',
            label: 'First tap',
            note: 'Nothing downloaded yet. The first tap opens the card: what the mic does, that your voice stays on this computer, the 650 MB one-time download. Download runs a fake progress and the mic wakes up with a toast.',
            render: () => <VoiceComposerDemo state="needs-download" />,
          },
          {
            id: 'no-mic',
            label: 'No microphone',
            note: 'What the tap shows on a computer with no microphone: the specific reason and a Check again.',
            render: () => <VoiceComposerDemo state="unavailable" />,
          },
        ],
      },
    ],
  },
  ...ALL_SURFACES.filter((s) => s.id === ACTIVE_FIRST),
  ...ALL_SURFACES.filter((s) => s.id !== ACTIVE_FIRST),
];
