import React, { useState } from 'react';
import { Button, Textarea, Tooltip } from './ui';
import { OTHER, OTHER_LABEL, OTHER_DESCRIPTION, textPlaceholder, type AskQuestion } from './ask-question-normalize';

/**
 * The question card drawn for the buddy's small window (buddy rebuild, 2026-10-25): buddy-rebuild-review#N-2 "i
 * shouldnt have to scroll through a single perm prompt", approved as review2#R-1. The state and the answer it sends are
 * the full card's own (ToolCard's AskUserQuestionCard owns them and passes them in) — only the drawing differs, so the
 * buddy and the main window can never send different answers to the same question.
 */
export function AskQuestionCompact({
  questions, keyFor, answers, text, setText, textRefs, responding, unconfirmed, focusedOption, allAnswered,
  onSelect, onSubmit, onDeny,
}: {
  questions: AskQuestion[];
  keyFor: (question: string, index: number) => string;
  answers: Record<string, Set<string>>;
  text: Record<string, string>;
  setText: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  textRefs: React.MutableRefObject<Record<string, HTMLTextAreaElement | null>>;
  responding: boolean;
  unconfirmed: boolean;
  focusedOption: number;
  allAnswered: boolean;
  onSelect: (key: string, label: string, multiSelect: boolean) => void;
  onSubmit: () => void;
  onDeny: () => void;
}) {
  // Which question shows, and which notes were opened.
  const [step, setStep] = useState(0);
  const [noteOpen, setNoteOpen] = useState<Record<string, boolean>>({});
  // The buddy's small window (buddy-rebuild-review#N-2: "i shouldnt have to scroll through a single perm prompt"): ONE
  // question at a time, its choices as small chips that wrap (the explanation moves into the chip's tooltip), the note
  // box hidden behind "+ Note" until wanted (Other opens it, since there the text IS the answer). Same answers, same
  // Submit and Dismiss as the full card above — only the drawing differs.
  const q = questions[step] ?? questions[0];
  const qi = Math.min(step, questions.length - 1);
  const key = keyFor(q.question, qi);
  const sel = answers[key];
  const last = qi === questions.length - 1;
  const thisAnswered = !!sel && sel.size > 0 && !(sel.has(OTHER) && !(text[key] ?? '').trim());
  const showNote = !!noteOpen[key] || !!sel?.has(OTHER);
  // The flat keyboard index of this question's first choice, so the focus ring lands on the chip it means.
  const firstIdx = questions.slice(0, qi).reduce((n, qq) => n + qq.options.length + 1, 0);
  return (
    <div className="question-compact border-t border-edge px-2.5 py-1.5 space-y-1.5">
      <div className="text-xs font-medium text-fg-2">
        {questions.length > 1 && <span className="text-fg-muted mr-1">{qi + 1}/{questions.length}</span>}
        {q.question}
      </div>
      <div className="flex flex-wrap gap-1">
        {[...q.options, { label: OTHER, description: OTHER_DESCRIPTION }].map((opt, oi) => {
          const selected = sel?.has(opt.label) ?? false;
          const isOther = opt.label === OTHER;
          const chip = (
              <button
                disabled={responding}
                aria-label={isOther ? `${OTHER_LABEL} — ${OTHER_DESCRIPTION}` : undefined}
                onClick={() => {
                  onSelect(key, opt.label, q.multiSelect);
                  // A single answer picked on a question that is not the last moves on by itself.
                  if (!q.multiSelect && !isOther && !last) setTimeout(() => setStep(qi + 1), 160);
                }}
                className={`px-2 py-0.5 rounded-full border text-xs transition-colors
                  ${selected ? 'bg-accent/15 border-accent text-fg' : 'bg-inset/40 border-edge-dim hover:bg-inset/70 text-fg-dim'}
                  ${firstIdx + oi === focusedOption ? 'ring-1 ring-white/30' : ''} disabled:opacity-50`}
              >
                {isOther ? OTHER_LABEL : opt.label}
              </button>
          );
          return opt.description
            ? <Tooltip key={oi} text={opt.description}>{chip}</Tooltip>
            : <React.Fragment key={oi}>{chip}</React.Fragment>;
        })}
      </div>
      {showNote ? (
        <Textarea
          ref={(el) => { textRefs.current[key] = el; }}
          size="sm"
          rows={1}
          disabled={responding}
          value={text[key] ?? ''}
          placeholder={textPlaceholder(sel)}
          aria-label={textPlaceholder(sel)}
          onChange={(e) => {
            const value = e.target.value;
            setText(prev => ({ ...prev, [key]: value }));
            e.target.style.height = 'auto';
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSubmit(); } }}
          className="w-full text-xs"
        />
      ) : (
        <button
          type="button"
          className="text-2xs text-fg-muted hover:text-fg-2"
          onClick={() => { setNoteOpen(prev => ({ ...prev, [key]: true })); requestAnimationFrame(() => textRefs.current[key]?.focus()); }}
        >
          + Note
        </button>
      )}
      <div className="flex items-center gap-1.5">
        {qi > 0 && <Button size="sm" variant="ghost" disabled={responding} onClick={() => setStep(qi - 1)}>Back</Button>}
        {last
          ? <Button size="sm" disabled={!allAnswered || responding} onClick={onSubmit}>Submit</Button>
          : <Button size="sm" disabled={!thisAnswered || responding} onClick={() => setStep(qi + 1)}>Next</Button>}
        <Button size="sm" variant="ghost" disabled={responding} onClick={onDeny}>Dismiss</Button>
      </div>
      {unconfirmed && (
        <p role="alert" className="text-3xs text-fg-muted leading-relaxed">
          YouCoded couldn&apos;t confirm your answer reached the session. If this is still waiting for you, answer again.
        </p>
      )}
    </div>
  );
}
