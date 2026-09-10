import React, { useState } from 'react';
import { Dialog, SettingRow, SegmentedTabs, Callout, Button } from './ui';
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

const EYEBROW = 'block text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2';

/** Dot + neutral text is the app's badge shape (design guide G-14): the colour
 *  never carries meaning on its own, the words beside it do. */
function Dot({ ok }: { ok: boolean }) {
  return <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${ok ? 'bg-green-500' : 'bg-amber-500'}`} aria-hidden />;
}

function windowLabel(tokens?: number | null): string {
  if (!tokens) return 'unknown';
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

const basename = (p: string) => p.split('/').slice(-1)[0];
const countLines = (s: string) => s.split('\n').filter((l) => l.trim() !== '').length;
/** "1 lines" is the kind of small wrongness that makes a panel look unfinished. */
const linesLabel = (n: number) => `${n} line${n === 1 ? '' : 's'}`;

/** Plain-English blurbs for the app's own tools. WHY they are here rather than on
 *  the wire: a tool's description is a constant of the tool, not a fact about
 *  this chat, and the descriptions in the tool registry are written FOR THE MODEL
 *  ("Load a named skill's instructions and follow them") rather than for someone
 *  deciding whether their assistant can do what they need. An MCP tool has no
 *  entry and falls back to naming the add-on it came from. */
const TOOL_BLURBS: Record<string, string> = {
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

function toolBlurb(name: string): string {
  const known = TOOL_BLURBS[name];
  if (known) return known;
  const parts = name.split('__');
  return parts.length >= 3 && parts[0] === 'mcp'
    ? `Part of the ${parts[1]} add-on. Only that add-on knows what it does.`
    : 'An action the assistant can take in this chat.';
}

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
    <div className={`max-h-64 overflow-y-auto bg-well p-3 ${flush ? '' : 'rounded-lg border border-edge-dim'} ${MD_SCALE}`}>
      <MarkdownContent content={text} />
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
      <div className="border-t border-edge-dim">{children}</div>
    </div>
  );
}

/** An expand-in-place row: SettingRow's own `expanded` mode, the shape Destin
 *  picked on 2026-09-05 ("I HATE the bare dropdowns with a chevron"). */
function ExpandRow({ title, description, body }: { title: string; description?: string; body: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <SettingRow variant="item" title={title} description={description} expanded={open} onClick={() => setOpen((o) => !o)} />
      {open && <div className="pt-1.5">{body}</div>}
    </div>
  );
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
      <div className="border-t border-edge-dim">
        {view === 'cut'
          ? <div className="max-h-64 overflow-y-auto bg-well"><UnifiedDiff oldStr={fullText} newStr={supplied} /></div>
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
 *  `assembledByClaudeCode` changes what "not shortened" is allowed to mean. For
 *  the native harness it is a record: we read the file, we did not cut it. For a
 *  Claude Code chat it means only that WE did not cut it — Claude Code manages
 *  its own window and we cannot see what it did. Saying "read in full" there
 *  would be a claim about someone else's work. */
function RulesCard({ file, kind, label, sessionId, openFile, assembledByClaudeCode }: {
  file: { path: string; truncated: boolean };
  kind: 'project' | 'user';
  label: string;
  sessionId?: string;
  openFile: (p: string) => void | Promise<void>;
  assembledByClaudeCode: boolean;
}) {
  const description = file.truncated
    ? 'Shortened to headings only'
    : assembledByClaudeCode
      ? 'YouCoded didn’t shorten it'
      : 'Read in full';
  return (
    <DetailCard
      header={(
        <SettingRow
          variant="item"
          className="rounded-none bg-transparent"
          icon={<Dot ok={!file.truncated} />}
          title={basename(file.path)}
          description={`${label} · ${description}`}
          accessory={<Button variant="secondary" size="sm" onClick={() => { void openFile(file.path); }}>Open</Button>}
        />
      )}
    >
      <FileText sessionId={sessionId} kind={kind} what={label} />
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
    <DetailCardCollapsible
      open={open}
      header={(
        <SettingRow
          variant="item"
          className="rounded-none bg-transparent"
          title={skill.label}
          description={skill.description}
          expanded={open}
          onClick={() => setOpen((o) => !o)}
        />
      )}
    >
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
    </DetailCardCollapsible>
  );
}

/** DetailCard whose body is hidden until its header is pressed. Same container,
 *  same hairline — the divider goes with the body so a closed card is one row. */
function DetailCardCollapsible({ open, header, children }: { open: boolean; header: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-edge-dim bg-inset/50 overflow-hidden">
      {header}
      {open && <div className="border-t border-edge-dim">{children}</div>}
    </div>
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
        className="w-full flex items-center gap-2 text-left cursor-pointer"
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

function SessionContextPanel({ open, onClose, context, sessionId }: Props & { context: SessionContext }) {
  const [tab, setTab] = useState('overview');
  const openFile = useOpenFilepath(sessionId);

  const rules = context.projectInstructions ?? null;
  const skills = context.skills ?? [];
  const tools = context.tools ?? [];
  const dropped = context.droppedMcpServers ?? [];
  // Shared with the strip, so an amber line can never open a panel saying
  // everything fit — see session-context-facts.ts for what counts.
  const trimmed = wasTrimmed(context);
  // A Claude Code chat is run by the Claude Code CLI, which builds its own
  // instructions. Everything below that YouCoded cannot see is worded as Claude
  // Code's own rather than as nothing — an empty tab reads as "you have no
  // tools", which would be a lie in the more alarming direction.
  const cc = context.assembledBy === 'claude-code';
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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="panel"
      fill
      title="What the assistant was given"
      subtitle="Its instructions, skills and tools for this chat."
    >
      <div className="space-y-5">
        {/* The tab strip scrolls sideways rather than squeezing, so no label is
            ever cut in half on a phone (review-5 S-3). */}
        <div className="-mx-1 px-1 overflow-x-auto">
          <SegmentedTabs
            variant="contained"
            aria-label="What the assistant was given"
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'system', label: 'System' },
              { id: 'project', label: 'Project' },
              { id: 'skills', label: 'Skills' },
              { id: 'tools', label: 'Tools' },
            ]}
            value={tab}
            onChange={setTab}
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
                      <span className="font-medium text-fg">Claude Code manages this chat.</span>{' '}
                      It builds its own instructions, so YouCoded didn’t shorten anything. Below is
                      what it can see from here.
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
                <h3 className={EYEBROW}>What was left out</h3>
                <div className="space-y-1.5">
                  {rules?.truncated && (
                    <SettingRow
                      variant="item"
                      icon={<Dot ok={false} />}
                      title="This project’s rules"
                      description={`Shortened to headings only · ${basename(rules.path)}`}
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
                      onClick={() => setTab('skills')}
                    />
                  )}
                  {dropped.map((d) => (
                    <SettingRow key={d} variant="item" icon={<Dot ok={false} />} title={`${d} add-on`} description="Not attached — its tools can’t be used in this chat" onClick={() => setTab('tools')} />
                  ))}
                </div>
              </section>
            )}

            <section>
              <h3 className={EYEBROW}>This chat</h3>
              <div className="space-y-1.5">
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
                <SettingRow
                  variant="item"
                  title="Given"
                  value={[rules ? '1 rules file' : null, skillsWord, tools.length > 0 ? toolsWord : null].filter(Boolean).join(' · ')}
                />
              </div>
            </section>
          </>
        )}

        {tab === 'system' && (
          <section>
            <h3 className={EYEBROW}>System instructions</h3>
            {/* Destin, review-5 G-2: this tab carries BOTH the preset and the
                general instructions, so what a model "loads in with" is all in
                one place. Project rules keep their own tab because they are
                yours to edit, not the app's. */}
            <p className="text-2xs text-fg-muted leading-snug mb-2">
              What every chat starts with, before your project’s rules. Open any part to read it.
            </p>
            {sections.length === 0 ? (
              <p className="text-2xs text-fg-2 leading-relaxed">
                {cc
                  ? 'Claude Code writes its own system instructions for this chat, and doesn’t share them with YouCoded — so there is nothing here that would be true. Your own rules are on the Project tab, and they are read.'
                  : 'Nothing was reported for this chat.'}
              </p>
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
          </section>
        )}

        {tab === 'project' && (
          <section>
            <h3 className={EYEBROW}>This project’s rules</h3>
            <p className="text-2xs text-fg-muted leading-snug mb-2">Written for this project and read once when the chat started.</p>
            {!rules && !userRules ? (
              <p className="text-2xs text-fg-muted">There is no rules file for this project, and none of your own.</p>
            ) : (
              <div className="space-y-2">
                {rules && (
                  <RulesCard
                    file={rules}
                    kind="project"
                    label="This project"
                    sessionId={sessionId}
                    openFile={openFile}
                    assembledByClaudeCode={cc}
                  />
                )}
                {/* Your own rules, the ones that apply everywhere. Claude Code
                    reads this file; the native harness does not, so this card
                    appears on a Claude Code chat and not on a native one — the
                    difference is real and worth seeing. */}
                {userRules && (
                  <RulesCard
                    file={userRules}
                    kind="user"
                    label="You, in every project"
                    sessionId={sessionId}
                    openFile={openFile}
                    assembledByClaudeCode={cc}
                  />
                )}
              </div>
            )}
          </section>
        )}

        {tab === 'skills' && (
          <section>
            <h3 className={EYEBROW}>Skills</h3>
            <p className="text-2xs text-fg-muted leading-snug mb-2">Step-by-step guides the assistant follows when a task matches one.</p>
            {skillsHidden && (
              <Callout tone="warning" title="The assistant wasn’t told about these">
                This model’s window is too small to carry the list, so it won’t reach for one
                on its own. Typing / and picking one still works.
              </Callout>
            )}
            {skills.length === 0 ? (
              <p className="text-2xs text-fg-muted">No skills are installed.</p>
            ) : (
              <div className="space-y-2 mt-2">
                {skills.map((sk) => (
                  <SkillCard key={sk.id} skill={sk} sessionId={sessionId} openFile={openFile} />
                ))}
              </div>
            )}
          </section>
        )}

        {tab === 'tools' && (
          <section className="space-y-3">
            <div>
              <h3 className={EYEBROW}>Tools</h3>
              <p className="text-2xs text-fg-muted leading-snug mb-2">Actions the assistant can take in this chat. Open one to see what it does.</p>
              {tools.length === 0 ? (
                <p className="text-2xs text-fg-2 leading-relaxed">
                  {cc
                    ? 'Claude Code chooses its own tools for this chat. YouCoded isn’t told which, so listing them here would be a guess.'
                    : 'This chat has no tools — the assistant can only talk.'}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {tools.map((t) => (
                    <ExpandRow key={t} title={t} body={<p className="text-2xs text-fg-2 leading-relaxed px-3">{toolBlurb(t)}</p>} />
                  ))}
                </div>
              )}
            </div>
            {dropped.length > 0 && (
              <Callout tone="warning" title="Not attached">
                {dropped.join(', ')} — there was no room for {dropped.length === 1 ? 'its' : 'their'} tools, so the assistant can’t use them in this chat.
              </Callout>
            )}
          </section>
        )}
      </div>
    </Dialog>
  );
}
