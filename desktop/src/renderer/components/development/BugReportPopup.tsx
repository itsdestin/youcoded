// desktop/src/renderer/components/development/BugReportPopup.tsx
// Three-screen state machine for the bug/feature report flow.
// Screen 1 (describe): user picks bug/feature, writes description, clicks Continue.
// Screen 2 (review): shows AI summary, editable log tail, Submit or Let Claude Try buttons.
// Screen 3 (result): shows submission outcome or Claude session progress.
// Uses <Scrim> / <OverlayPanel> primitives — no hardcoded colors, blur, or z-indexes
// (PITFALLS overlay invariant).
import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { useEscClose } from '../../hooks/use-esc-close';

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

export function BugReportPopup({ open, onClose }: Props) {
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
      const log = kind === 'bug' ? await window.claude.dev.logTail(200) : '';
      setLogTail(log);
      const s = await window.claude.dev.summarizeIssue({ kind, description, log: kind === 'bug' ? log : undefined });
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

  return createPortal(
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 p-4 w-[400px] max-w-[calc(100%-2rem)] max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
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
      </OverlayPanel>
    </>,
    document.body,
  );
}

function DescribeScreen({ kind, setKind, description, setDescription, onContinue, busy }: any) {
  return (
    <>
      <div className="flex gap-1 mb-3 p-1 bg-inset/50 rounded-lg">
        {(['bug', 'feature'] as Kind[]).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`flex-1 text-xs py-1.5 rounded-md transition-colors ${kind === k ? 'bg-accent text-on-accent' : 'text-fg-2 hover:bg-inset'}`}
          >
            {k === 'bug' ? 'Bug' : 'Feature'}
          </button>
        ))}
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What's happening? (Or what would you like to see?)"
        className="w-full h-32 p-2 text-xs bg-inset/50 border border-edge-dim rounded-lg resize-none focus:outline-none focus:border-accent"
      />
      <button
        disabled={description.trim().length < 10 || busy}
        onClick={onContinue}
        className="w-full mt-3 py-2.5 text-xs font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? 'Summarizing…' : 'Continue'}
      </button>
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
          <summary className="text-[10px] text-fg-muted cursor-pointer">Logs to include (editable)</summary>
          {summary.flagged_strings.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {summary.flagged_strings.map((s: string) => (
                <span key={s} className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">⚠ {s.slice(0, 30)}</span>
              ))}
            </div>
          )}
          <textarea
            value={logTail}
            onChange={(e) => setLogTail(e.target.value)}
            className="w-full h-32 mt-2 p-2 text-[10px] font-mono bg-inset/50 border border-edge-dim rounded-lg resize-none focus:outline-none focus:border-accent"
          />
        </details>
      )}
      <div className="flex flex-col gap-2">
        <button
          disabled={busy}
          onClick={onSubmit}
          className="w-full py-2.5 text-xs font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 disabled:opacity-40"
        >
          Submit as GitHub Issue
        </button>
        <button
          disabled={busy}
          onClick={onLetClaudeTry}
          className="w-full py-2.5 text-xs font-medium rounded-lg border border-edge-dim text-fg-2 hover:bg-inset disabled:opacity-40"
        >
          {ctaLabel}
        </button>
        <p className="text-[10px] text-amber-400/80 text-center">⚠ High Claude usage — not recommended for Pro plans</p>
        <button onClick={onEdit} className="text-[10px] text-fg-muted hover:text-fg underline">Edit description</button>
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
      <button
        onClick={onDone}
        className="w-full py-2.5 text-xs font-medium rounded-lg bg-accent text-on-accent hover:brightness-110"
      >
        Done
      </button>
    </>
  );
}

