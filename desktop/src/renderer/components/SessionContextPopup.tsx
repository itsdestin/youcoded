import React, { useState } from 'react';
import { Dialog, SettingRow, SegmentedTabs, Callout, Button, SectionLabel, FoldRow } from './ui';
import { UnifiedDiff } from './diff/UnifiedDiff';
import MarkdownContent from './MarkdownContent';
import { useOpenFilepath } from '../hooks/useOpenFilepath';
import type { SessionContext, SessionContextSkill } from '../state/chat-types';
import { wasTrimmed, useSessionContextText } from './session-context-facts';

// SessionContextPopup — "What the assistant was given": what this chat started
// with, and what did not fit.
//
// Design decided over five review rounds with Destin (2026-08-17 to 2026-09-10),
// the answers in docs/active/design/2026-09-09-session-context-panel/. The parts
// that look arbitrary but are not:
//
//  · The title never says "context". The app's OTHER popup called Context means
//    how full the window is right now; this one is what the assistant was handed
//    at the start. Two things, two names (round 3).
//  · It NEVER opens by itself (review-5 Q-1 "never"). The strip above the
//    conversation is the only way in, and the strip carries the warning colour
//    when something was cut. An interruption nobody asked for is the fastest way
//    to teach someone to dismiss a warning unread.
//  · THREE tabs, sorted by where a thing applies (Destin, 2026-11-12, work item
//    #251: "overview, global context, project context"): Overview is the summary
//    and the engine running the chat; Global is what every project gets (yours
//    first, then the engine's own system instructions and tools); Project is
//    what only this folder adds. The five tabs before this sorted by KIND
//    (System / Project / Skills / Tools), which put your every-project file on
//    the Project tab and gave no way to tell a project's skill from a global one.
//  · The tabs come FIRST and the status card belongs to Overview (change 22).
//    A warning pinned above the tabs pointed at nothing on four of five tabs,
//    which is why "(see details below)" had to be removed and then, once the
//    card moved, could come back (changes 21-23).
//  · Every row is a SettingRow and every section an eyebrow, because the whole
//    point of round 4 was that this panel must look like Preferences, not like
//    its own invention.
//  · There is NO footer and no Assistant settings row (review-5 S-2, "drop for
//    now").
//
// The data arrives via the SESSION_CONTEXT reducer action. The host channel that
// supplies it for real is still to be built — see mock-only.ts.

interface Props {
  open: boolean;
  onClose: () => void;
  /** The session's starting context (from SessionChatState.sessionContext). */
  context: SessionContext | null;
  /** Session id — Open resolves paths against this session's cwd. */
  sessionId: string;
}

// WHY SectionLabel, not a hand-typed eyebrow class (labels batch, guide: no
// spaced capitals — decisions H-3/L-1…L-4). Every heading below used to share
// this constant; SectionLabel is now the shared spelling instead.

/** Dot + neutral text is the app's badge shape (design guide G-14): the colour
 *  never carries meaning on its own, the words beside it do. */
function Dot({ ok }: { ok: boolean }) {
  return <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${ok ? 'bg-green-400' : 'bg-amber-700'}`} aria-hidden />;
}

/** A context window as its NAMEPLATE — "1M", "200k", "16k".
 *
 *  Same thresholds as StatusBar's formatTokens, deliberately, so one window is
 *  one number wherever it appears. Two differences, both because this is a size
 *  rather than a measurement: thousands round to whole (a window is advertised as
 *  "200k", never "200.0k"), and a millions value drops a trailing ".0".
 *
 *  WHY the millions branch exists at all (Destin, 2026-09-10, on seeing
 *  "1049k tokens"): without it a million-token window renders as a four-digit
 *  count of thousands, which nobody reads as a million — the largest window the
 *  app supports came out looking like a glitch. */
function windowLabel(tokens?: number | null): string {
  if (!tokens) return 'unknown';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

// Both separators: a native chat on Windows reports `C:\\Users\\…` paths.
const basename = (p: string) => p.split(/[\\/]/).slice(-1)[0];
/** WHY a folder name, not the full path: ancestor instruction files have long
 *  absolute paths that overflow the card on a phone. The nearest file is "This
 *  project"; each broader one is named by the folder it lives in. */
function instructionLabel(filePath: string, isNearest: boolean): string {
  if (isNearest) return 'Read before every chat in this project';
  const folder = filePath.split(/[\\/]/).slice(-2, -1)[0];
  return folder && !/^[A-Za-z]:$/.test(folder) ? `From the “${folder}” folder` : 'From the top-level folder';
}
/** "Shortened · CLAUDE.md" for one file; "2 files shortened · AGENTS.md, CLAUDE.md" for more. */
function shortenedSummary(files: ReadonlyArray<{ path: string; truncated: boolean }>): string {
  const cut = files.filter(f => f.truncated).map(f => basename(f.path));
  return cut.length === 1 ? `Shortened · ${cut[0]}` : `${cut.length} files shortened · ${cut.join(', ')}`;
}
const countLines = (s: string) => s.split('\n').filter((l) => l.trim() !== '').length;
/** "1 lines" is the kind of small wrongness that makes a panel look unfinished. */
const linesLabel = (n: number) => `${n} line${n === 1 ? '' : 's'}`;

/** Plain-English blurbs for the app's own tools. WHY they are here rather than on
 *  the wire: a tool's description is a constant of the tool, not a fact about
 *  this chat, and the descriptions in the tool registry are written FOR THE MODEL
 *  ("Load a named skill's instructions and follow them") rather than for someone
 *  deciding whether their assistant can do what they need. */
const TOOL_BLURBS: Record<string, string> = {
  Read: 'Opens a file and reads what is in it.',
  Write: 'Creates a new file, or replaces one that already exists.',
  Edit: 'Changes part of a file and leaves the rest alone.',
  Bash: 'Runs a command on your device, the way a terminal does.',
  Glob: 'Finds files by name — every file ending in .md, say.',
  Grep: 'Searches inside files for a word or phrase.',
  TodoWrite: 'Keeps a checklist of what it is working on.',
  WebFetch: 'Opens a web page and reads it.',
  WebSearch: 'Searches the web.',
  Task: 'Hands a piece of work to a helper that works on its own.',
  Skill: 'Loads a set of step-by-step instructions you have installed.',
  AskUserQuestion: 'Stops and asks you a question when it needs a decision.',
};

// Built-in tools only: an add-on's tools are listed by name under the add-on's own row.
const toolBlurb = (name: string): string => TOOL_BLURBS[name] ?? 'An action the assistant can take in this chat.';

const MD_SCALE = `text-2xs text-fg-2
  [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-2xs [&_h4]:text-2xs
  [&_h1]:mt-0 [&_h2]:mt-2 [&_h3]:mt-2
  [&_p]:text-2xs [&_li]:text-2xs [&_code]:text-2xs [&_pre]:text-2xs`;

/** `flush` drops the box's own edges when it sits INSIDE a card that already has
 *  them (change 28) — two frames around one thing reads as a mistake.
 *  The heading overrides exist because MarkdownContent is sized for a chat
 *  bubble; unchanged in a 420px panel a level-1 heading dwarfs everything and the
 *  quote stops reading as a detail of the row above it. */
function Md({ text, flush = false }: { text: string; flush?: boolean }) {
  return (
    // WHY the fill and border on an outer box (2026-10-15, the one scroll fade): the fade is a
    // mask, so on the filled box itself it would fade the fill and border too; only the text fades.
    <div className={`bg-well overflow-hidden ${flush ? '' : 'rounded-lg border border-edge-dim'}`}>
    <div className={`scroll-mask max-h-64 overflow-y-auto p-3 ${MD_SCALE}`}>
      <MarkdownContent content={text} />
    </div>
    </div>
  );
}

/** One card per file or skill (change 28, Destin: "the what it got/what got cut
 *  stuff should share a container with the skill it's attached to"). Before this
 *  each skill was four floating slabs with nothing marking where one ended and
 *  the next began. */
function DetailCard({ header, children }: { header: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-edge-dim bg-inset/50 overflow-hidden">
      {header}
      {/* WHY no border-t (final review F17; decisions "Card levels": no full-width line inside
          a card) — the header's own padding separates it from the body. */}
      <div>{children}</div>
    </div>
  );
}

/** An expand-in-place row: SettingRow's own `expanded` mode, the shape Destin
 *  picked on 2026-09-05 ("I HATE the bare dropdowns with a chevron"). */
function ExpandRow({ title, description, body }: { title: string; description?: string; body: React.ReactNode }) {
  // WHY the shared FoldRow (submit-ticket-5, proposal 1; guide "A folded box opens inside itself"): this was a hand-built fold whose content opened below its row and whose row tint ended in a hard line.
  return <FoldRow title={title} description={description} flush>{body}</FoldRow>;
}

/** The got/cut switch. Destin kept the red/green comparison over a plain list of
 *  cut text (review-5 G-4: "i like the diff view"). Renders as bands inside a
 *  DetailCard, so it owns no margins of its own. */
function CutBlock({ fullText, supplied, what }: { fullText?: string | null; supplied: string; what: string }) {
  const [view, setView] = useState<'got' | 'cut'>('got');
  const diffable = !!fullText && fullText !== supplied;
  if (!diffable) return <Md text={supplied} flush />;
  const cutCount = Math.max(0, countLines(fullText) - countLines(supplied));
  return (
    <>
      <div className="p-2.5 space-y-2">
        <SegmentedTabs
          variant="contained"
          aria-label={`${what}: what the assistant got, or what was cut`}
          tabs={[{ id: 'got', label: 'What it got' }, { id: 'cut', label: 'What was cut' }]}
          value={view}
          onChange={(v) => setView(v as 'got' | 'cut')}
        />
        {/* A rough size, so "some was cut" has a scale attached. Lines rather than
            characters — it is the unit a person can picture (change 26). */}
        <p className="text-3xs text-fg-muted">
          {view === 'got' ? `${linesLabel(countLines(supplied))} the assistant read` : `${linesLabel(cutCount)} it never saw`}
        </p>
        {view === 'cut' && (
          <p className="text-2xs text-fg-muted leading-snug">
            Red was cut — the assistant never saw it. Green is the shorter version it got instead.
          </p>
        )}
      </div>
      {/* WHY no border-t (final review F17): no full-width line inside a card. */}
      <div>
        {view === 'cut'
          // fill: this wrapper is already the scroll surface (max-h-64
          // overflow-y-auto) — without fill, UnifiedDiff stacked its own
          // 15-line cap + button inside it, a second scrollbar hiding the
          // rest of the cut text (review round 1, 2026-09-18).
          ? <div className="bg-well overflow-hidden"><div className="scroll-mask max-h-64 overflow-y-auto"><UnifiedDiff oldStr={fullText} newStr={supplied} fill /></div></div>
          : <Md text={supplied} flush />}
      </div>
    </>
  );
}

/** A file's text, read when this block is on screen.
 *
 *  The text does not ride with the rest of the context — see
 *  session-context-facts.ts for the measurement behind that. Local disk, so the
 *  wait is about a millisecond; the placeholder exists for a phone reading over
 *  the network, not for the usual case.
 *
 *  A failure says only that the file could not be read: the reasons are several
 *  (deleted since the chat started, permissions, an unreadable encoding) and
 *  naming the wrong one is worse than naming none — error-message-standards.md. */
function FileText({ sessionId, kind, id, what }: { sessionId?: string; kind: 'project' | 'user' | 'skill'; id?: string; what: string }) {
  const fetched = useSessionContextText(sessionId, kind, id, true);
  if (!fetched || fetched.state === 'loading') return <p className="p-3 text-2xs text-fg-muted">Reading…</p>;
  if (fetched.state === 'error') return <p className="p-3 text-2xs text-fg-muted">This file couldn’t be read.</p>;
  const { text, full, truncated } = fetched.value;
  return truncated
    ? <CutBlock fullText={full} supplied={text} what={what} />
    : <Md text={text} flush />;
}

/** One instruction file, with its text open — there is at most one of each, so
 *  unlike a skill card this does not wait to be asked.
 *
 *  WHY the line under the name says WHEN the file is read and nothing else
 *  (Destin, deck round 1, T-5: remove "You, in every project" and "YouCoded
 *  didn't shorten it"; say what the section pulls in — "instructions injected
 *  before every chat … in every project"): the explanation lives inside the
 *  card, so no grey sentence has to sit loose above it. A file that WAS
 *  shortened still says so — that is a warning, not decoration. */
function RulesCard({ file, kind, label, sessionId, openFile, id }: {
  file: { path: string; truncated: boolean; note?: string | null; notUsed?: string | null };
  kind: 'project' | 'user';
  id?: string;
  label: string;
  sessionId?: string;
  openFile: (p: string) => void | Promise<void>;
}) {
  // WHY the engine's own note is not shown (Destin, deck round 2, R2-6: "still dont
  // like the '3 of 13 sections ....' just confusing"): that note is written FOR THE
  // MODEL ("3 of 12 sections above are shown as heading + first line(s)"). A person
  // needs one fact — it was shortened — and the "What was cut" switch right below
  // shows exactly what. A shortened file's line says only that, plus which folder
  // it came from when it is not the project's own.
  const description = [
    file.truncated && label.startsWith('Read before') ? null : label,
    file.truncated ? 'Shortened to fit this model' : null,
    // Only one file per folder is used; name the one that was not.
    file.notUsed ? `${file.notUsed} here not used` : null,
  ].filter(Boolean).join(' · ');
  return (
    <DetailCard
      header={(
        <SettingRow
          variant="item"
          className="rounded-none bg-transparent"
          icon={<Dot ok={!file.truncated} />}
          title={basename(file.path)}
          description={description}
          accessory={<Button variant="secondary" size="sm" onClick={() => { void openFile(file.path); }}>Open</Button>}
        />
      )}
    >
      <FileText sessionId={sessionId} kind={kind} id={id} what={label} />
    </DetailCard>
  );
}

/** One skill, its text behind its own row.
 *
 *  WHY the text is not open by default, unlike the project rules card: there is
 *  exactly one rules file, and 47 installed skills on this machine. Forty-seven
 *  cards of open markdown is a page nobody can use, and it would read every one
 *  of those files to build. The card still owns its text (contract R19); it just
 *  waits to be asked.
 *
 *  Whether a skill would be shortened is only knowable by reading it, so the row
 *  says what the skill DOES until it is opened — which is the more useful line
 *  anyway. */
function SkillCard({ skill, sessionId, openFile }: { skill: SessionContextSkill; sessionId?: string; openFile: (p: string) => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const fetched = useSessionContextText(sessionId, 'skill', skill.id, open);
  const path = fetched?.state === 'ready' ? fetched.value.path : null;
  return (
    // WHY the shared FoldRow (submit-ticket-5, proposal 1; guide "A folded box opens inside itself"): this was a hand-built fold whose content opened below its row and whose row tint ended in a hard line.
    <FoldRow title={skill.label} description={skill.description} open={open} onToggle={setOpen} flush>
      {!fetched || fetched.state === 'loading' ? <p className="p-3 text-2xs text-fg-muted">Reading…</p>
        : fetched.state === 'error' ? <p className="p-3 text-2xs text-fg-muted">This skill couldn’t be read.</p>
          : (
            <>
              <div className="flex items-center gap-2 px-3 pt-2.5">
                <Dot ok={!fetched.value.truncated} />
                <span className="flex-1 min-w-0 text-2xs text-fg-muted truncate">
                  {fetched.value.truncated ? 'Would be shortened when used' : 'Fits in full'}
                </span>
                {path && <Button variant="secondary" size="sm" onClick={() => { void openFile(path); }}>Open</Button>}
              </div>
              {fetched.value.truncated
                ? <CutBlock fullText={fetched.value.full} supplied={fetched.value.text} what={`${skill.label} skill`} />
                : <Md text={fetched.value.text} flush />}
            </>
          )}
    </FoldRow>
  );
}

/** Collapsed it is four words; opened it is the sentence approved in round 3,
 *  ending in Destin's "(see details below)" — true again now the card sits
 *  directly above the list it names (changes 21-23). An explanatory clause on the
 *  collapsed line clipped at panel width, and a warning you cannot finish reading
 *  is not a warning. */
function WarnCard({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Callout tone="warning">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        // state-layer: it said cursor-pointer and never changed under the pointer.
        className="w-full flex items-center gap-2 text-left cursor-pointer rounded-md px-1 -mx-1 state-layer"
      >
        <span className={`flex-1 min-w-0 font-medium ${open ? '' : 'truncate'}`}>
          {open
            ? `This model’s context window is small (${label}), so some rules and skills were cut and it may miss steps it would normally follow (see details below).`
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

/** WHY the split: this component is mounted by ChatView on EVERY render, and
 *  hooks cannot be conditional — so a `useOpenFilepath` at the top of the panel
 *  would reach into artifact context on every keystroke of every chat, open or
 *  not. Eight ChatView test files failed on exactly that. The outer component
 *  holds no hooks at all and returns before the inner one exists. */
export default function SessionContextPopup({ open, onClose, context, sessionId }: Props) {
  if (!open || !context) return null;
  return <SessionContextPanel open={open} onClose={onClose} context={context} sessionId={sessionId} />;
}

/** Rows shown before "Show all N" — the app's existing tail (PermissionsSection
 *  ROWS_PER_KIND, LocalModelsSection). WHY here (#251): Global now holds your
 *  skills AND the engine's instructions AND its tools on one tab, and 47 skill
 *  rows ahead of them would bury everything below. Skills only: each skill row
 *  opens its own text, so they cannot fold into one row the way tools do. Hiding one row behind a click
 *  does not pay for the click, so the cut only applies above CAP + 1. */
const ROWS_BEFORE_SHOW_ALL = 5;

function CappedRows<T>({ items, render }: { items: readonly T[]; render: (item: T) => React.ReactNode }) {
  const [all, setAll] = useState(false);
  const visible = all || items.length <= ROWS_BEFORE_SHOW_ALL + 1 ? items : items.slice(0, ROWS_BEFORE_SHOW_ALL);
  return (
    <div className="space-y-1.5">
      {visible.map(render)}
      {visible.length < items.length && (
        <div>
          <Button variant="secondary" size="sm" onClick={() => setAll(true)}>Show all {items.length}</Button>
        </div>
      )}
    </div>
  );
}

/** One labelled group on a tab: the small label (with its count, the guide's
 *  "word then a smaller number"), then cards.
 *  WHY no sentence under the label, and why `Note` below exists (Destin, deck
 *  round 1, T-3: "wayyyyyy too much copy and too many letters before we see any
 *  card styling … i really hate bare text on the popup modal"): every word on
 *  these tabs now sits inside a card, and a group with nothing in it says so as
 *  a row, not as a loose paragraph. */
function Group({ label, count, children }: { label: string; count?: number; children: React.ReactNode }) {
  return (
    <section>
      <SectionLabel className="mb-2">
        {label}{count !== undefined && count > 0 && <span className="ml-1.5 text-2xs font-normal">{count}</span>}
      </SectionLabel>
      {children}
    </section>
  );
}

/** A group's "nothing here" or "not ours to show", as a row like its neighbours. */
function Note({ title, description }: { title: string; description?: string }) {
  return <SettingRow variant="item" title={title} description={description} />;
}

/** "3 skills", "1 tool" — and nothing at all for zero, so a summary line never
 *  reads "0 tools" about a list the app was simply not told. */
const countWord = (n: number, one: string, many = `${one}s`) => (n > 0 ? `${n} ${n === 1 ? one : many}` : null);

/** Tools that came from a connected add-on are named `mcp__<add-on>__<tool>`.
 *  Grouped by add-on so twenty tools from one add-on are one row, not twenty. */
function splitTools(tools: readonly string[]): { builtIn: string[]; addOns: Array<{ name: string; tools: string[] }> } {
  const builtIn: string[] = [];
  const byAddOn = new Map<string, string[]>();
  for (const t of tools) {
    const parts = t.split('__');
    if (parts.length >= 3 && parts[0] === 'mcp') {
      const list = byAddOn.get(parts[1]) ?? [];
      list.push(parts.slice(2).join('__'));
      byAddOn.set(parts[1], list);
    } else builtIn.push(t);
  }
  return { builtIn, addOns: [...byAddOn].map(([name, list]) => ({ name, tools: list })) };
}

type TabId = 'overview' | 'global' | 'project';

function SessionContextPanel({ open, onClose, context, sessionId }: Props & { context: SessionContext }) {
  const [tab, setTab] = useState<TabId>('overview');
  const openFile = useOpenFilepath(sessionId);

  // WHY: older native/Claude Code records still have one file; captured native
  // sessions list the actual broad-to-narrow chain without a second selection.
  const projectFiles = context.projectInstructionFiles ?? (context.projectInstructions ? [context.projectInstructions] : []);
  const rules = projectFiles[projectFiles.length - 1] ?? null;
  const skills = context.skills ?? [];
  // A record from before `scope` existed has none; every skill sat in one list
  // then, and Global is the honest home for "installed, not known to be this
  // project's".
  const projectSkills = skills.filter((s) => s.scope === 'project');
  const globalSkills = skills.filter((s) => s.scope !== 'project');
  const tools = context.tools ?? [];
  const { builtIn, addOns } = splitTools(tools);
  const dropped = context.droppedMcpServers ?? [];
  // Shared with the strip, so an amber line can never open a panel saying
  // everything fit — see session-context-facts.ts for what counts.
  const trimmed = wasTrimmed(context);
  // A Claude Code chat is run by the Claude Code CLI, which builds its own
  // instructions. Everything below that YouCoded cannot see is worded as Claude
  // Code's own rather than as nothing — an empty group reads as "you have no
  // tools", which would be a lie in the more alarming direction.
  const cc = context.assembledBy === 'claude-code';
  const engine = cc ? 'Claude Code' : 'YouCoded';
  const userRules = context.userInstructions ?? null;
  const skillsHidden = context.skillsOffered === false && skills.length > 0;
  const skillsWord = `${skills.length} skill${skills.length === 1 ? '' : 's'}`;
  const toolsWord = `${tools.length} tool${tools.length === 1 ? '' : 's'}`;

  // WHY the sections list falls back to one blob: a host that cannot split the
  // prompt still sends `systemPrompt`, and showing it whole beats showing nothing
  // (Destin, review-5 G-2: "i want to be fully transparent about what models load
  // in with").
  const sections = context.systemPromptSections
    ?? (context.systemPrompt ? [{ id: 'all', label: 'System instructions', text: context.systemPrompt }] : []);

  // The two summary lines on Overview. Each names only what the app can count.
  const globalGiven = [
    userRules ? '1 rules file' : null,
    countWord(globalSkills.length, 'skill'),
    countWord(tools.length, 'tool'),
  ].filter(Boolean).join(' · ');
  const projectGiven = [
    countWord(projectFiles.length, 'rules file'),
    countWord(projectSkills.length, 'skill'),
  ].filter(Boolean).join(' · ');

  const skillsWarning = skillsHidden && (
    <Callout tone="warning" title="The assistant wasn’t told about these">
      This model’s window is too small to carry the list, so it won’t reach for one
      on its own. Typing / and picking one still works.
    </Callout>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="panel"
      fill
      title="What the assistant was given"
      subtitle="Its instructions, skills and tools for this chat."
      screen="chat/session-context"
    >
      {/* WHY space-y-4: 16px between groups (decisions "Popup spacing", SP-4; guide "Spacing") — was 20px. */}
      <div className="space-y-4">
        {/* The tab strip scrolls sideways rather than squeezing, so no label is
            ever cut in half on a phone (review-5 S-3). */}
        <div className="scroll-mask scroll-mask--chips -mx-1 px-1 overflow-x-auto">
          <SegmentedTabs
            variant="contained"
            aria-label="What the assistant was given"
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'global', label: 'Global context' },
              { id: 'project', label: 'Project context' },
            ]}
            value={tab}
            onChange={(v) => setTab(v as TabId)}
          />
        </div>

        {tab === 'overview' && (
          <>
            {trimmed ? (
              <WarnCard label={windowLabel(context.contextWindowTokens)} />
            ) : (
              <div className="rounded-lg bg-inset/50 px-3 py-2.5 flex items-start gap-2">
                <span className="mt-1.5"><Dot ok /></span>
                <p className="text-2xs text-fg-2 leading-relaxed">
                  {cc ? (
                    <>
                      {/* Destin's wording (deck round 1, T-2), tidied only for grammar. */}
                      <span className="font-medium text-fg">This chat is running on Claude Code,</span>{' '}
                      which uses its own settings and instructions. This menu may not be 100% accurate:
                      your assistant may have loaded tools, instructions or settings not listed here.
                    </>
                  ) : (
                    <>
                      <span className="font-medium text-fg">Everything fit.</span>{' '}
                      {rules
                        ? `The assistant has this project’s full rules, ${skillsWord} and ${toolsWord}.`
                        : `The assistant has ${skillsWord} and ${toolsWord}.`}
                    </>
                  )}
                </p>
              </div>
            )}

            {trimmed && (
              <section>
                <SectionLabel className="mb-2">What was left out</SectionLabel>
                <div className="space-y-1.5">
                  {projectFiles.some(f => f.truncated) && (
                    <SettingRow
                      variant="item"
                      icon={<Dot ok={false} />}
                      title="This project’s rules"
                      description={shortenedSummary(projectFiles)}
                      onClick={() => setTab('project')}
                    />
                  )}
                  {/* The big one on a small model, and the thing nothing on
                      screen used to say: below the catalog threshold the
                      assistant is never told a single skill exists. */}
                  {skillsHidden && (
                    <SettingRow
                      variant="item"
                      icon={<Dot ok={false} />}
                      title="Your skills"
                      description={`The assistant wasn’t told about ${skillsWord} — you can still start one by typing /`}
                      // Most skills are global; a project with only its own goes to its own tab.
                      onClick={() => setTab(globalSkills.length > 0 ? 'global' : 'project')}
                    />
                  )}
                  {dropped.map((d) => (
                    <SettingRow key={d} variant="item" icon={<Dot ok={false} />} title={`${d} add-on`} description="Not attached — its tools can’t be used in this chat" onClick={() => setTab('global')} />
                  ))}
                </div>
              </section>
            )}

            {/* WHY an Engine group (Destin, 2026-11-12, #251: Overview should carry
                "additional harness detail", because people will switch between
                Claude Code, YouCoded's own engine and others). It names who runs
                the chat; what Claude Code hides from this panel is said once, in the
                box at the top (deck round 1, T-2). */}
            <section>
              <SectionLabel className="mb-2">Engine</SectionLabel>
              <div className="space-y-1.5">
                <SettingRow
                  variant="item"
                  title="Runs this chat"
                  description={cc
                    ? 'Writes its own system instructions and picks its own tools'
                    : 'Writes the system instructions and attaches the tools'}
                  value={engine}
                />
                <SettingRow variant="item" title="Model" value={context.modelLabel ?? 'Unknown'} />
                <SettingRow
                  variant="item"
                  title="Context window"
                  description={trimmed ? 'How much it can hold at once — small' : 'How much it can hold at once'}
                  // Never a number we cannot check. For a Claude Code chat the
                  // window depends on the plan it runs under as well as the
                  // model, so naming one would be a guess in a panel whose whole
                  // job is to be trusted.
                  value={context.contextWindowTokens ? `${windowLabel(context.contextWindowTokens)} tokens` : cc ? 'Set by Claude Code' : 'Unknown'}
                />
              </div>
            </section>

            {/* One row per tab, so a count is also the way to the thing counted. */}
            <section>
              <SectionLabel className="mb-2">Given</SectionLabel>
              <div className="space-y-1.5">
                <SettingRow
                  variant="item"
                  title="Global context"
                  description={globalGiven ? `The same in every project · ${globalGiven}` : 'The same in every project'}
                  onClick={() => setTab('global')}
                />
                <SettingRow
                  variant="item"
                  title="Project context"
                  description={projectGiven ? `Only in this project · ${projectGiven}` : 'Nothing is specific to this project'}
                  onClick={() => setTab('project')}
                />
              </div>
            </section>
          </>
        )}

        {tab === 'global' && (
          <>
            {/* Yours first, the engine's after (deck round 1, Q-1: one list). */}
            <Group label="Your rules">
              {userRules ? (
                <RulesCard
                  file={userRules}
                  kind="user"
                  label="Read before every chat, in every project"
                  sessionId={sessionId}
                  openFile={openFile}
                />
              ) : cc ? (
                <Note title="No every-project rules file" />
              ) : (
                // True of the native engine today: it reads rules files from the
                // project's folder up to the top of its repository, and nothing else.
                <Note title="No every-project rules" description="YouCoded’s engine reads rules from the project’s folders only" />
              )}
            </Group>

            <Group label="Your skills" count={globalSkills.length}>
              {globalSkills.length > 0 && skillsWarning}
              {globalSkills.length === 0 ? (
                <Note title="No skills installed" />
              ) : (
                <div className={skillsHidden ? 'mt-2' : ''}>
                  <CappedRows items={globalSkills} render={(sk) => <SkillCard key={sk.id} skill={sk} sessionId={sessionId} openFile={openFile} />} />
                </div>
              )}
            </Group>

            {/* Destin, review-5 G-2: BOTH the preset and the general instructions,
                so what a model "loads in with" is all in one place. */}
            <Group label="System instructions" count={sections.length}>
              {sections.length === 0 ? (
                cc
                  ? <Note title="Written by Claude Code" description="It doesn’t share them with YouCoded" />
                  : <Note title="Nothing was reported for this chat" />
              ) : (
                <div className="space-y-1.5">
                  {sections.map((s) => (
                    <ExpandRow
                      key={s.id}
                      title={s.label}
                      description={linesLabel(countLines(s.text))}
                      body={<Md text={s.text} />}
                    />
                  ))}
                </div>
              )}
            </Group>

            {/* WHY one row for all built-in tools (Destin, deck round 1, T-4:
                "a single collapsible row that defaults to listing all tools when
                expanded, instead of … the separate show all 7 button"), and one
                row per add-on beside it: the whole group is as many rows as there
                are sources of tools, however many tools each brings. */}
            <Group label="Tools" count={tools.length}>
              {tools.length === 0 ? (
                cc
                  ? <Note title="Chosen by Claude Code" description="YouCoded isn’t told which tools it picked" />
                  : <Note title="No tools" description="The assistant can only talk in this chat" />
              ) : (
                <div className="space-y-1.5">
                  {builtIn.length > 0 && (
                    <FoldRow title={`Built into ${engine}`} description={countWord(builtIn.length, 'tool') ?? undefined}>
                      <ul className="space-y-2">
                        {builtIn.map((t) => (
                          <li key={t}>
                            <span className="block text-2xs font-medium text-fg">{t}</span>
                            <span className="block text-2xs text-fg-muted leading-snug">{toolBlurb(t)}</span>
                          </li>
                        ))}
                      </ul>
                    </FoldRow>
                  )}
                  {addOns.map((a) => (
                    <FoldRow key={a.name} title={`${a.name} add-on`} description={countWord(a.tools.length, 'tool') ?? undefined}>
                      <ul className="space-y-1">
                        {a.tools.map((t) => <li key={t} className="text-2xs text-fg-2 break-words">{t}</li>)}
                      </ul>
                    </FoldRow>
                  ))}
                </div>
              )}
              {dropped.length > 0 && (
                <div className="mt-1.5">
                  <Callout tone="warning" title="Not attached">
                    {dropped.join(', ')} — there was no room for {dropped.length === 1 ? 'its' : 'their'} tools, so the assistant can’t use them in this chat.
                  </Callout>
                </div>
              )}
            </Group>
          </>
        )}

        {tab === 'project' && (
          <>
            <Group label="Project rules" count={projectFiles.length}>
              {projectFiles.length === 0 ? (
                <Note title="No rules file for this project" />
              ) : (
                <div className="space-y-2">
                  {projectFiles.map((file, i) => (
                    <RulesCard
                      key={file.path}
                      file={file}
                      kind="project"
                      id={context.projectInstructionFiles ? file.path : undefined}
                      label={instructionLabel(file.path, i === projectFiles.length - 1)}
                      sessionId={sessionId}
                      openFile={openFile}
                    />
                  ))}
                </div>
              )}
            </Group>

            <Group label="Project skills" count={projectSkills.length}>
              {projectSkills.length > 0 && skillsWarning}
              {projectSkills.length === 0 ? (
                <Note title="No skills of its own" description="Skills kept in this project’s folder would show here" />
              ) : (
                <div className={skillsHidden ? 'mt-2' : ''}>
                  <CappedRows items={projectSkills} render={(sk) => <SkillCard key={sk.id} skill={sk} sessionId={sessionId} openFile={openFile} />} />
                </div>
              )}
            </Group>
          </>
        )}
      </div>
    </Dialog>
  );
}
