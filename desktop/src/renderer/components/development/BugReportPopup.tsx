// desktop/src/renderer/components/development/BugReportPopup.tsx
// Three-screen state machine for the bug/feature report flow.
// Screen 1 (describe): user picks bug/feature, writes description, clicks Continue.
// Screen 2 (review): shows AI summary, editable log tail, Submit or Let Claude Try buttons.
// Screen 3 (result): shows submission outcome or Claude session progress.
// Uses the shared <Dialog> shell — no hardcoded colors, blur, or z-indexes
// (PITFALLS overlay invariant).
import { useEffect, useState } from 'react';
import { ReportDesign } from './ReportDesign';
import { useEscClose } from '../../hooks/use-esc-close';
import { Button, Dialog, SegmentedTabs, Textarea } from '../ui';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Kind = 'bug' | 'feature';
type Screen = 'describe' | 'review' | 'result';

const PROMPT_BUG = (description: string) =>
  `I just filed (or am about to file) a bug against YouCoded. Here's what I described: «${description}». ` +
  `Investigate the codebase in this workspace and propose a fix. Read \`docs/PITFALLS.md\` first, ` +
  `and check both desktop and Android touchpoints if the bug could affect either.`;

const PROMPT_FEATURE = (description: string) =>
  `I want to add a new feature to YouCoded. Here's what I'm asking for: «${description}». ` +
  `Read \`docs/PITFALLS.md\`, then use the brainstorming skill to design it before writing code. ` +
  `Both desktop and Android share the React UI — keep that in mind.`;

// WHY: review-only design is deliberately disconnected from AI, reports and installation.
export function BugReportPopup(props: Props) {
  return new URLSearchParams(window.location.search).get('mode') === 'workbench'
    ? <ReportDesign {...props} /> : <LegacyBugReportPopup {...props} />;
}

export function LegacyBugReportPopup({ open, onClose }: Props) {
  useEscClose(open, onClose);
  const [screen, setScreen] = useState<Screen>('describe');
  const [kind, setKind] = useState<Kind>('bug');
  const [description, setDescription] = useState('');
  const [summary, setSummary] = useState<{ title: string; summary: string; flagged_strings: string[] } | null>(null);
  const [logTail, setLogTail] = useState('');
  const [busy, setBusy] = useState(false);
  const [resultMessage, setResultMessage] = useState<{ kind: 'submit' | 'claude'; message: string; url?: string } | null>(null);
  const [installLines, setInstallLines] = useState<string[]>([]);

  // WHY: Reset all state on close so the next open always starts fresh on Screen 1.
  useEffect(() => {
    if (!open) {
      setScreen('describe');
      setKind('bug');
      setDescription('');
      setSummary(null);
      setLogTail('');
      setBusy(false);
      setResultMessage(null);
      setInstallLines([]);
    }
  }, [open]);

  if (!open) return null;

  const onContinue = async () => {
    setBusy(true);
    try {
      // For bugs, prepend a diagnostics block (env snapshot — git/claude
      // paths, ~/.claude perms, marketplace cache state, network reach) to
      // the log tail. The most common Mac install failures don't leave a
      // trace in the app log; the snapshot covers them. Both pieces are
      // editable in the review screen before submit.
      let combined = '';
      if (kind === 'bug') {
        // Run in parallel — diagnostics and log read are independent.
        // diagnostics() probes are individually 5s-bounded so this stays cheap.
        const [diag, log] = await Promise.all([
          window.claude.dev.diagnostics().catch(() => ''),
          window.claude.dev.logTail(200),
        ]);
        combined = diag ? `${diag}\n\n${log}` : log;
      }
      setLogTail(combined);
      const s = await window.claude.dev.summarizeIssue({ kind, description, log: kind === 'bug' ? combined : undefined });
      setSummary(s);
      setScreen('review');
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = async () => {
    if (!summary) return;
    setBusy(true);
    try {
      // WHY: body is now assembled in the main process by buildIssueBody,
      // which has access to app.getVersion() and os info. The renderer passes
      // raw fields so the Environment line is accurate (Fix 2).
      const result = await window.claude.dev.submitIssue({
        kind,
        title: summary.title,
        summary: summary.summary,
        description,
        log: kind === 'bug' ? logTail : undefined,
        label: kind === 'bug' ? 'bug' : 'enhancement',
      });
      if (result.ok) {
        setResultMessage({ kind: 'submit', message: 'Issue created', url: result.url });
      } else {
        window.open(result.fallbackUrl, '_blank');
        setResultMessage({ kind: 'submit', message: 'Opening GitHub in your browser…' });
      }
      setScreen('result');
    } finally {
      setBusy(false);
    }
  };

  const onLetClaudeTry = async () => {
    setBusy(true);
    setScreen('result');
    setInstallLines([]);
    const off = window.claude.dev.onInstallProgress((line) =>
      setInstallLines((prev) => [...prev.slice(-9), line]),
    );
    try {
      const r = await window.claude.dev.installWorkspace();
      // WHY: discriminated-union narrowing instead of (r as any) casts (Fix 4).
      if ('error' in r) {
        setResultMessage({ kind: 'claude', message: r.error });
        return;
      }
      const prompt = kind === 'bug' ? PROMPT_BUG(description) : PROMPT_FEATURE(description);
      await window.claude.dev.openSessionIn({ cwd: r.path, initialInput: prompt });
      setResultMessage({ kind: 'claude', message: `New session opened in ${r.path}.` });
    } catch (e: any) {
      setResultMessage({ kind: 'claude', message: String(e?.message || e) });
    } finally {
      off();
      setBusy(false);
    }
  };

  // P-15: every dialog carries the shared header so it has a visible title and
  // a ✕ — this one had neither, so Escape was the only way out. The title
  // follows the Bug/Feature switch. The old createPortal wrapper is gone too:
  // Dialog already portals itself, so it was portaling a portal.
  return (
    <Dialog
      open
      onClose={onClose}
      size="panel"
      title={kind === 'bug' ? 'Report a bug' : 'Request a feature'}
      scrollBody={false}
      className="overflow-y-auto"
    >
      <div className="p-4">
        {screen === 'describe' && (
          <DescribeScreen
            kind={kind}
            setKind={setKind}
            description={description}
            setDescription={setDescription}
            onContinue={onContinue}
            busy={busy}
          />
        )}
        {screen === 'review' && summary && (
          <ReviewScreen
            kind={kind}
            summary={summary}
            logTail={logTail}
            setLogTail={setLogTail}
            onEdit={() => setScreen('describe')}
            onSubmit={onSubmit}
            onLetClaudeTry={onLetClaudeTry}
            busy={busy}
          />
        )}
        {screen === 'result' && (
          <ResultScreen
            resultMessage={resultMessage}
            installLines={installLines}
            onDone={onClose}
          />
        )}
      </div>
    </Dialog>
  );
}

function DescribeScreen({ kind, setKind, description, setDescription, onContinue, busy }: any) {
  return (
    <>
      {/* Change 45: this row already used the approved inactive style (transparent
          + hover tint), so the primitive is a de-duplication here rather than a
          restyle. It also gains role="tablist" and arrow-key navigation, which a
          pair of plain <button>s never had. */}
      <SegmentedTabs
        variant="contained"
        aria-label="Report type"
        className="mb-3"
        value={kind}
        onChange={(id) => setKind(id as Kind)}
        tabs={[{ id: 'bug', label: 'Bug' }, { id: 'feature', label: 'Feature' }]}
      />
      {/* Change 42: this was already the target recipe (border-edge-dim, rounded-lg,
          focus:border-accent), so migrating it is mostly a de-duplication —
          bg-inset/50 becomes the shared bg-inset and the padding picks up the one
          field scale. Continue stays BELOW the field, so no InputGroup here. */}
      <Textarea
        size="md"
        className="w-full h-32"
        aria-label="Describe the bug or feature"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What's happening? (Or what would you like to see?)"
      />
      <Button
        disabled={description.trim().length < 10 || busy}
        onClick={onContinue}
        className="w-full mt-3 py-2.5"
      >
        {busy ? 'Summarizing…' : 'Continue'}
      </Button>
    </>
  );
}

function ReviewScreen({ kind, summary, logTail, setLogTail, onEdit, onSubmit, onLetClaudeTry, busy }: any) {
  const ctaLabel = kind === 'bug' ? 'Let Claude Try to Fix It' : 'Let Claude Try to Build It';
  return (
    <>
      <div className="text-xs text-fg mb-3">{summary.summary}</div>
      {kind === 'bug' && (
        <details className="mb-3">
          <summary className="text-3xs text-fg-muted cursor-pointer">Logs to include (editable)</summary>
          {summary.flagged_strings.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {summary.flagged_strings.map((s: string) => (
                <span key={s} className="text-4xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">⚠ {s.slice(0, 30)}</span>
              ))}
            </div>
          )}
          {/* Change 42: same migration as the describe screen. `sm` (11px) is the
              nearest field size to the old raw 10px — the scale has no 10px
              field step, and arbitrary text-[Npx] is retired (see globals.css).
              font-mono is kept: this is a log tail and column alignment matters. */}
          <Textarea
            size="sm"
            className="w-full h-32 mt-2 font-mono"
            aria-label="Logs to include"
            value={logTail}
            onChange={(e) => setLogTail(e.target.value)}
          />
        </details>
      )}
      <div className="flex flex-col gap-2">
        <Button
          disabled={busy}
          onClick={onSubmit}
          className="w-full py-2.5"
        >
          Submit as GitHub Issue
        </Button>
        {/* secondary, not primary: "Let Claude try to fix it" burns a lot of Claude
            usage (see the warning below it), so it stays the quieter of the two. */}
        <Button
          variant="secondary"
          disabled={busy}
          onClick={onLetClaudeTry}
          className="w-full py-2.5"
        >
          {ctaLabel}
        </Button>
        <p className="text-3xs text-amber-400/80 text-center">⚠ High Claude usage — not recommended for Pro plans</p>
        <button onClick={onEdit} className="text-3xs text-fg-muted hover:text-fg underline">Edit description</button>
      </div>
    </>
  );
}

function ResultScreen({ resultMessage, installLines, onDone }: any) {
  return (
    <>
      {resultMessage ? (
        <div className="text-xs text-fg mb-3">
          {resultMessage.message}
          {resultMessage.url && (
            <>
              {': '}
              <a className="underline text-accent" href={resultMessage.url} target="_blank" rel="noreferrer">{resultMessage.url}</a>
            </>
          )}
        </div>
      ) : (
        <div className="text-xs text-fg-muted mb-3 font-mono">
          {installLines.map((l: string, i: number) => <div key={i}>{l}</div>)}
        </div>
      )}
      <Button onClick={onDone} className="w-full py-2.5">
        Done
      </Button>
    </>
  );
}

