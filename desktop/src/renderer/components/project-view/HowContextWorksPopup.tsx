// HowContextWorksPopup — the shared "How context works" teaching popup (Task 4.3).
// Opened from each Context-tab group's (i) info button; ProjectView maps the
// clicked ContextScope to an initial tab. A centered L2 popup with a left nav
// column (5 tabs) and a scrollable content column.
//
// Copy is ported (near-verbatim) from the prototype's INFO_TABS / INFO /
// overviewContent / infoContent at
// docs/superpowers/prototypes/2026-06-14-project-view-redesign.html.
//
// ICON SAFETY: the prototype had a render-crash bug from referencing an icon
// name that wasn't in its shared lookup table. Here every icon is an inline SVG
// component — there is NO shared name→path lookup that can throw on a missing
// key. Each page header / nav row / overview row references a local component
// directly, so an unknown tab id can never crash the render.
//
// NO ●◐○ status glyphs — timing is spelled out in plain words, the same
// vocabulary ContextTab uses (Always / Always · everywhere / When editing… /
// On recall / Index).
import React, { useState } from 'react';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { useEscClose } from '../../hooks/use-esc-close';
import { CloseButton } from '../ui';

// The five teaching topics. `overview` is the broad→specific stack; the other
// four are per-kind deep dives.
type InfoTabId = 'overview' | 'claude' | 'agents' | 'rules' | 'memory';

interface HowContextWorksPopupProps {
  initialTab: InfoTabId;
  onClose: () => void;
}

// ── Inline icons (no shared lookup table — see ICON SAFETY note above) ──────
// Every icon is a standalone component; referencing one is a compile-time check,
// not a runtime string lookup, so a missing icon can never throw at render.
type IconProps = { size?: number };

function LayoutIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3h18v18H3z" />
      <path d="M3 9h18" />
      <path d="M9 21V9" />
    </svg>
  );
}

function DocIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function ListIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </svg>
  );
}

function BrainIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5a3 3 0 0 0-3 3 3 3 0 0 0-3 3 3 3 0 0 0 1 5 3 3 0 0 0 5 1 3 3 0 0 0 5-1 3 3 0 0 0 1-5 3 3 0 0 0-3-3 3 3 0 0 0-3-3Z" />
    </svg>
  );
}

function GlobeIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z" />
      <path d="M2 12h20" />
      <path d="M12 2a15 15 0 0 1 0 20" />
      <path d="M12 2a15 15 0 0 0 0 20" />
    </svg>
  );
}

function InfoIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

// (local CloseIcon removed — the header ✕ is now the shared <CloseButton /> primitive.)

// Per-tab nav metadata. The `icon` is a component (not a string), so the nav can
// never reference an undefined icon.
const INFO_TABS: { id: InfoTabId; label: string; Icon: React.ComponentType<IconProps> }[] = [
  { id: 'overview', label: 'Overview', Icon: LayoutIcon },
  { id: 'claude', label: 'CLAUDE.md', Icon: DocIcon },
  { id: 'agents', label: 'AGENTS.md', Icon: DocIcon },
  { id: 'rules', label: 'Rules', Icon: ListIcon },
  { id: 'memory', label: 'Memory', Icon: BrainIcon },
];

// ── Reusable sub-components for the topic pages ─────────────────────────────

// Small uppercase micro-label (the prototype's `.lbl`).
function MicroLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-3xs font-medium text-fg-muted tracking-wider uppercase">
      {children}
    </div>
  );
}

// Topic page: icon header + facts strip + What/When sections + example block.
interface TopicPageData {
  Icon: React.ComponentType<IconProps>;
  heading: string;        // mono header (e.g. "CLAUDE.md")
  tag: string;            // one-line subtitle
  facts: [string, string][];   // [label, value] pairs in the facts strip
  secs: [string, string][];    // [heading, body] What/When sections
  example: string;             // fenced code block content
}

function TopicPage({ data }: { data: TopicPageData }) {
  const { Icon } = data;
  return (
    <div>
      {/* Icon header */}
      <div className="flex items-start gap-3 mb-4">
        <span className="w-10 h-10 rounded-lg bg-inset border border-edge-dim inline-flex items-center justify-center text-fg-dim shrink-0">
          <Icon size={20} />
        </span>
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-fg leading-tight font-mono">{data.heading}</h3>
          <p className="text-[12.5px] text-fg-muted mt-0.5">{data.tag}</p>
        </div>
      </div>

      {/* Facts strip: Scope · When it loads · Lives at */}
      <div className="flex flex-wrap gap-x-6 gap-y-2 mb-4 pb-4 border-b border-edge-dim">
        {data.facts.map(([label, value]) => (
          <div key={label}>
            <MicroLabel>{label}</MicroLabel>
            <div className="text-[12.5px] text-fg-2 mt-0.5">{value}</div>
          </div>
        ))}
      </div>

      {/* What / When sections */}
      {data.secs.map(([heading, body]) => (
        <div key={heading} className="mb-3.5">
          <MicroLabel>{heading}</MicroLabel>
          <p className="text-sm-tight text-fg-2 leading-relaxed mt-1">{body}</p>
        </div>
      ))}

      {/* Example code block */}
      {data.example && (
        <>
          <MicroLabel>Example</MicroLabel>
          <pre className="bg-inset border border-edge-dim rounded-lg p-3 text-[11.5px] font-mono text-fg-2 overflow-x-auto whitespace-pre leading-relaxed mt-1.5 mb-0">
            {data.example}
          </pre>
        </>
      )}
    </div>
  );
}

// ── Topic page data (copy ported from the prototype's INFO map) ─────────────
const CLAUDE_PAGE: TopicPageData = {
  Icon: DocIcon,
  heading: 'CLAUDE.md',
  tag: 'Your standing instructions for a project.',
  facts: [
    ['Scope', 'Project or global'],
    ['When it loads', 'Every conversation'],
    ['Lives at', 'CLAUDE.md'],
  ],
  secs: [
    ['What it is', 'Your main instructions for a project. Claude treats CLAUDE.md like standing orders — coding style, things to avoid, and how you like work done.'],
    ['When Claude reads it', 'At the start of every conversation in that folder. A global ~/.claude/CLAUDE.md applies everywhere. It’s always loaded, so keep it focused.'],
  ],
  example: [
    '# CLAUDE.md',
    '',
    '## Working rules',
    '- Never touch the live built app — test via run-dev.sh',
    '- Use worktrees for non-trivial work',
    '- Add a WHY comment on non-trivial edits',
  ].join('\n'),
};

const AGENTS_PAGE: TopicPageData = {
  Icon: DocIcon,
  heading: 'AGENTS.md',
  tag: 'The cross-tool instruction standard.',
  facts: [
    ['Scope', 'Project'],
    ['When it loads', 'Every conversation'],
    ['Read by', 'Claude, opencode, Codex…'],
  ],
  secs: [
    ['What it is', 'The same idea as CLAUDE.md, but the shared open standard other AI coding tools read too — opencode, Codex, Cursor, and more.'],
    ['When to use it', 'Put cross-tool instructions here so every tool behaves consistently. Claude reads it alongside CLAUDE.md.'],
  ],
  example: [
    '# AGENTS.md',
    '',
    'Build:  npm run build',
    'Test:   npm test',
    'Style:  2-space indent',
    '',
    '# Read by Claude, opencode, Codex, Cursor…',
  ].join('\n'),
};

const RULES_PAGE: TopicPageData = {
  Icon: ListIcon,
  heading: 'Rules',
  tag: 'Instructions that load only when they’re relevant.',
  facts: [
    ['Scope', 'Project or global'],
    ['When it loads', 'Only for matching files'],
    ['Lives at', '.claude/rules/'],
  ],
  secs: [
    ['What it is', 'Focused instruction files that apply conditionally. Each can target a path — for example, “only when editing files under app/**”.'],
    ['Why they help', 'They keep your always-on instructions short while deep guidance stays on tap exactly when it’s needed.'],
  ],
  // The globs: frontmatter is what makes a rule conditional — load-bearing copy.
  example: [
    '---',
    'description: Android runtime constraints',
    'globs: app/**',
    'alwaysApply: false',
    '---',
    '',
    'LD_LIBRARY_PATH is mandatory. All binaries',
    'route through /system/bin/linker64…',
  ].join('\n'),
};

const MEMORY_PAGE: TopicPageData = {
  Icon: BrainIcon,
  heading: 'Memory',
  tag: 'What Claude remembers — and recalls when it helps.',
  facts: [
    ['Scope', 'This project only'],
    ['When it loads', 'Recalled when relevant'],
    ['Index', 'MEMORY.md'],
  ],
  // Bakes in the verified memory behavior: project-scoped (no global memory),
  // agent-decided storage of durable/non-obvious facts, automatic recall via the
  // MEMORY.md index loaded each conversation — NOT a user-driven search.
  secs: [
    ['What it is', 'Short notes Claude saves so it doesn’t re-learn things each time — your preferences, decisions you’ve made, and recurring gotchas. One fact per file.'],
    ['How Claude saves them', 'Claude decides what’s worth keeping — usually something durable it couldn’t just re-read from your code or history. You don’t have to ask; it writes the note and lists it in an index (MEMORY.md).'],
    ['How Claude recalls them', 'It doesn’t search on demand. The index loads at the start of every conversation, and the notes that look relevant to what you’re doing are pulled into context automatically.'],
    ['Where they live', 'Saved with this project — not shared globally. What Claude learns here stays here.'],
  ],
  example: [
    '---',
    'type: feedback',
    '---',
    '',
    'All runtime testing goes through run-dev.sh —',
    'never touch the live built app.',
  ].join('\n'),
};

// ── Overview page: the broad→specific load stack + "more specific wins" ──────
// Each row: icon + label + mono path + plain-text load timing. Connected
// top-to-bottom with ↓ separators.
interface OverviewLayer {
  Icon: React.ComponentType<IconProps>;
  label: string;
  path: string;
  timing: string;
}
// WHY the labels: renamed with the tab ("Instructions & Memories") so the
// overview's vocabulary matches what the user just clicked.
const OVERVIEW_LAYERS: OverviewLayer[] = [
  { Icon: GlobeIcon, label: 'Global instructions', path: '~/.claude/CLAUDE.md', timing: 'Always · every project' },
  { Icon: DocIcon, label: 'Project instructions', path: 'CLAUDE.md · AGENTS.md', timing: 'Always · this folder · overrides global' },
  { Icon: ListIcon, label: 'Rules', path: '.claude/rules/', timing: 'Only when you touch matching files' },
  { Icon: BrainIcon, label: 'Memory', path: 'MEMORY.md + saved facts', timing: 'Recalled when relevant to your message' },
];

function OverviewPage() {
  return (
    <div>
      <h3 className="text-lg font-semibold text-fg leading-tight">How context works</h3>
      <p className="text-[12.5px] text-fg-muted mt-0.5 mb-4">
        Everything Claude reads before it starts — and which wins when they disagree.
      </p>
      <p className="text-sm-tight text-fg-2 leading-relaxed mb-3.5">
        Claude builds its understanding of your project from several sources, all loaded
        automatically. They stack from broad to specific:
      </p>

      {/* Broad → specific stack, connected top-to-bottom */}
      <div className="flex flex-col gap-2">
        {OVERVIEW_LAYERS.map((l, i) => {
          const { Icon } = l;
          return (
            <React.Fragment key={l.label}>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-panel border border-edge-dim">
                <span className="w-9 h-9 rounded-md bg-inset border border-edge-dim inline-flex items-center justify-center text-fg-dim shrink-0">
                  <Icon size={17} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium text-fg">{l.label}</div>
                  <div className="font-mono text-2xs text-fg-muted truncate">{l.path}</div>
                </div>
                <div className="text-[11.5px] text-fg-dim text-right shrink-0 max-w-[210px]">
                  {l.timing}
                </div>
              </div>
              {i < OVERVIEW_LAYERS.length - 1 && (
                <div className="pl-[30px] text-fg-faint text-xs leading-none py-0.5">↓</div>
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* "More specific wins" precedence callout */}
      <div className="mt-4 flex gap-2.5 p-3 rounded-lg bg-inset border border-edge-dim text-[12.5px] text-fg-2 leading-relaxed">
        <span className="text-fg-dim shrink-0 mt-px">
          <InfoIcon size={16} />
        </span>
        <div>
          <strong className="text-fg">When two files disagree, the more specific one wins.</strong>{' '}
          A project’s CLAUDE.md overrides the global one; always-on instructions take priority
          over conditional rules and recalled memory.
        </div>
      </div>
    </div>
  );
}

// Render the page for a given tab. A switch with a default fallback so EVERY tab
// id resolves to a real page — no undefined-icon path can throw.
function renderPage(tab: InfoTabId): React.ReactNode {
  switch (tab) {
    case 'overview':
      return <OverviewPage />;
    case 'claude':
      return <TopicPage data={CLAUDE_PAGE} />;
    case 'agents':
      return <TopicPage data={AGENTS_PAGE} />;
    case 'rules':
      return <TopicPage data={RULES_PAGE} />;
    case 'memory':
      return <TopicPage data={MEMORY_PAGE} />;
    default:
      // Defensive fallback — an unexpected id renders the Overview rather than
      // crashing. (Reachable only if a future caller passes a bad id.)
      return <OverviewPage />;
  }
}

export function HowContextWorksPopup({ initialTab, onClose }: HowContextWorksPopupProps) {
  const [activeTab, setActiveTab] = useState<InfoTabId>(initialTab);

  // ESC closes via the centralized LIFO stack (same approach as
  // ProjectDetailOverlay / the other project-view overlays).
  useEscClose(true, onClose);

  return (
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal
        aria-label="How context works"
        className="fixed left-1/2 top-[8%] -translate-x-1/2 w-[min(820px,94vw)] max-h-[84vh] flex flex-col"
      >
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
          <span className="text-base font-semibold text-fg">How context works</span>
          <CloseButton onClick={onClose} title="Close" />
        </header>

        {/* Body: left nav + scrollable content */}
        {/* Stacks below 640px: a shrink-0 190px nav beside content in a 367px
            panel left ~176px for the column, ~136px after its own padding.
            Narrow turns the nav into a horizontal scroll strip on top. */}
        <div className="flex-1 flex flex-col sm:flex-row min-h-0">
          {/* Left nav column */}
          <aside className="w-full sm:w-[190px] shrink-0 border-b sm:border-b-0 sm:border-r border-edge-dim p-2 flex flex-row sm:flex-col gap-1 overflow-x-auto sm:overflow-x-visible overflow-y-auto no-scrollbar sm:[scrollbar-width:auto]">
            {INFO_TABS.map((t) => {
              const active = t.id === activeTab;
              const { Icon } = t;
              return (
                <button
                  key={t.id}
                  type="button"
                  // shrink-0 + whitespace-nowrap so the tabs scroll horizontally
                  // as a strip on narrow instead of squashing.
                  className={`w-auto sm:w-full shrink-0 whitespace-nowrap text-left flex items-center gap-2.5 px-3 py-2 rounded-md text-sm-tight transition-colors ${
                    active
                      ? 'bg-inset text-fg font-medium'
                      : 'text-fg-2 hover:bg-inset hover:text-fg'
                  }`}
                  onClick={() => setActiveTab(t.id)}
                >
                  <span className={active ? 'text-fg' : 'text-fg-muted'}>
                    <Icon size={15} />
                  </span>
                  {t.label}
                </button>
              );
            })}
          </aside>

          {/* Scrollable content column */}
          <div className="flex-1 overflow-y-auto px-3 py-4 sm:px-5 sm:py-5 min-w-0">
            {renderPage(activeTab)}
          </div>
        </div>
      </OverlayPanel>
    </>
  );
}
