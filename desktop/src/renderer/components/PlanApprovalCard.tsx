import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, TextInput } from './ui';
import { isAndroid } from '../platform';
import { usePlanMenu, nextTerminalUpdate } from '../hooks/usePlanMenu';
import { getVisibleScreenText } from '../hooks/terminal-registry';
import { feedbackOption, type PlanMenu } from '../parser/plan-menu-parser';
import { answerPlanMenu, sanitizeFeedback, PLAN_TIMING, type PlanAnswer, type PlanAnswerFailure } from '../state/plan-menu-driver';

// --- ExitPlanMode approval card ---
//
// WHY this replaced the old four fixed buttons (2026-09-23): Claude Code's plan
// menu is not fixed. Its rows change with settings and session modes ("Yes,
// clear context …" first when that setting is on; "Yes, and switch to BYPASS
// PERMISSIONS …" when bypass is available; an Ultraplan row), and its last row
// is a TEXT BOX, not a button. The old card sent "down-arrow × position, then
// Enter" for four assumed rows, so "No, refine plan" could land on "Yes,
// manually approve edits" and approve the plan.
//
// Now every button is one of the rows Claude Code is actually showing, in its
// own words (plan-menu-parser.ts), and answering types that row's printed
// number after re-checking the screen (plan-menu-driver.ts). If the menu can't
// be read with certainty the card shows NO buttons and says to answer in the
// terminal view — it never guesses and never falls back to a default.

/** How long the options may stay unreadable before the card stops waiting and
 *  says so. Covers Claude Code's first paint and brief redraws. */
const READ_GRACE_MS = 1500;

const FAILURE_COPY: Record<PlanAnswerFailure, string> = {
  'menu-changed': "Claude Code's options changed before that went through, so nothing was sent. Check the options and try again.",
  'menu-gone': 'This plan is no longer waiting in Claude Code, so nothing was sent.',
  'draft-in-terminal': "There's already text in Claude Code's feedback box in terminal view. Finish or clear it there first.",
  'not-taken': "Claude Code didn't react to that in time. Check terminal view to see where it stands.",
  'text-mismatch': "YouCoded couldn't confirm your feedback reached Claude Code, so it wasn't sent. Check terminal view — your text may be waiting in the feedback box there.",
};

// Status colours, the same carve-out the permission buttons use (ToolCard.tsx,
// spec §11 change 61): approve reads green, a "No" row red, anything else blue.
// The colour follows Claude Code's own wording, since the rows are not fixed.
const CHOICE_STYLES = {
  accept: 'bg-green-600/60 hover:bg-green-600/80 text-green-100',
  reject: 'bg-red-600/60 hover:bg-red-600/80 text-red-100',
  neutral: 'bg-blue-600/60 hover:bg-blue-600/80 text-blue-100',
};
function styleFor(label: string): string {
  if (/^yes\b/i.test(label)) return CHOICE_STYLES.accept;
  if (/^no\b/i.test(label)) return CHOICE_STYLES.reject;
  return CHOICE_STYLES.neutral;
}

export function PlanApprovalCard({ sessionId, onAnswered }: {
  sessionId: string;
  /** Called once Claude Code has taken the answer (its menu left the screen). */
  onAnswered: () => void;
}) {
  const read = usePlanMenu(sessionId);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');

  // Keep showing the last good menu through brief unreadable frames (redraws),
  // and only give up after READ_GRACE_MS of no good read.
  const [menu, setMenu] = useState<PlanMenu | null>(read.status === 'ready' ? read.menu : null);
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (read.status === 'ready') {
      setMenu(read.menu);
      setGaveUp(false);
      return;
    }
    const t = setTimeout(() => { setGaveUp(true); setMenu(null); }, READ_GRACE_MS);
    return () => clearTimeout(t);
  }, [read]);

  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const answer = useCallback(async (shown: PlanMenu, a: PlanAnswer) => {
    setSending(true);
    setError(null);
    const res = await answerPlanMenu(shown.signature, a, {
      read: () => getVisibleScreenText(sessionId),
      // A deliberate menu-driving write: it must NOT go through pty-input-gate
      // (driving this menu is its whole purpose — see that module's header).
      write: (d) => window.claude.session.sendInput(sessionId, d),
      settle: (ms) => nextTerminalUpdate(sessionId, ms),
      now: () => Date.now(),
    });
    if (!mounted.current) return;
    if (res.ok) {
      onAnswered();
      return; // the card is about to be replaced by the running tool
    }
    setSending(false);
    setError(FAILURE_COPY[res.reason]);
  }, [sessionId, onAnswered]);

  const pad = isAndroid() ? 'py-2' : 'py-1';
  const wrap = 'px-3 py-2 border-t border-edge bg-inset/30 space-y-2';

  if (!menu) {
    return (
      <div className={wrap} data-testid="plan-approval-card">
        <p className="text-xs text-fg-dim leading-relaxed">
          {gaveUp
            ? "YouCoded can't read Claude Code's plan options right now, so there are no buttons here. Switch to terminal view to answer the plan there."
            : "Reading Claude Code's options…"}
        </p>
      </div>
    );
  }

  const fb = feedbackOption(menu);
  const choices = menu.options.filter((o) => o.kind === 'choice');
  const draftInTerminal = !!menu.feedbackDraft;
  const text = sanitizeFeedback(feedback);
  const canSend = !sending && !draftInTerminal && text.length > 0;
  const sendFeedback = () => { if (canSend) void answer(menu, { kind: 'feedback', text }); };

  return (
    <div className={wrap} data-testid="plan-approval-card">
      {choices.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {choices.map((o) => (
            <button
              key={`${o.number}:${o.label}`}
              disabled={sending}
              onClick={() => void answer(menu, { kind: 'choice', number: o.number, label: o.label })}
              className={`px-3 ${pad} text-xs font-medium rounded-lg text-left transition-colors disabled:opacity-50 ${styleFor(o.label)}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      {/* Claude Code's free-text row: its placeholder is the box's placeholder,
          and sending types the text into that row and presses Enter there. */}
      <div className="flex items-center gap-2">
        <TextInput
          size="sm"
          className="flex-1 min-w-0 text-xs"
          value={feedback}
          maxLength={PLAN_TIMING.maxFeedback}
          disabled={sending || draftInTerminal}
          placeholder={draftInTerminal ? 'Feedback is being typed in terminal view' : fb.label}
          aria-label={draftInTerminal ? 'Feedback is being typed in terminal view' : fb.label}
          onChange={(e) => setFeedback(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFeedback(); } }}
        />
        <Button size="sm" disabled={!canSend} onClick={sendFeedback} className={pad}>
          Send
        </Button>
      </div>
      <div className="flex items-center gap-2">
        {/* Esc: Claude Code's own cancel. It has no row in the menu, so the label
            borrows Claude Code's words for the result ("The user doesn't want to
            proceed…" is what Claude is told). */}
        <Button variant="ghost" size="sm" disabled={sending} onClick={() => void answer(menu, { kind: 'reject' })} className={pad}>
          Don&apos;t proceed
        </Button>
        {sending && <span className="text-3xs text-fg-muted">Sending to Claude Code…</span>}
      </div>
      {draftInTerminal && (
        <p className="text-3xs text-fg-muted leading-relaxed">
          There&apos;s already text in Claude Code&apos;s feedback box in terminal view. Finish or clear it there to send feedback from here.
        </p>
      )}
      {error && (
        <p role="alert" className="text-3xs text-fg-muted leading-relaxed">{error}</p>
      )}
    </div>
  );
}
