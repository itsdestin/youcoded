import { asString } from '../utils/tool-input';

export interface AskQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

// WHY: normalize every rendered field before passing untrusted provider input
// to React. A malformed later option must not crash the whole chat pane.
export function normalizeQuestions(input: Record<string, unknown>): AskQuestion[] {
  const raw = input.questions;
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const q of raw as Array<Record<string, unknown> | null | undefined>) {
    const question = asString(q?.question);
    if (!question) continue;
    const rawOptions = Array.isArray(q?.options) ? (q.options as Array<Record<string, unknown> | null | undefined>) : [];
    const options: AskQuestion['options'] = [];
    for (const o of rawOptions) {
      const label = asString(o?.label);
      if (!label) continue;
      options.push({ label, description: asString(o?.description) || undefined });
    }
    if (options.length === 0) continue;
    out.push({ question, header: asString(q?.header), multiSelect: q?.multiSelect === true, options });
  }
  return out;
}

export function isValidQuestions(input: Record<string, unknown>): boolean {
  return normalizeQuestions(input).length > 0;
}

// The question card's "Other" row and its note box — shared by the full card (ToolCard) and the buddy's small one
// (AskQuestionCompact). Moved here unchanged from ToolCard.tsx (buddy rebuild, 2026-10-25).
export const OTHER = '__other__';
export const OTHER_LABEL = 'Other';
export const OTHER_DESCRIPTION = 'Type your own answer';

/** What the text box is FOR depends on what is selected — say so in the placeholder. */
export function textPlaceholder(sel: Set<string> | undefined): string {
  return sel?.has(OTHER) ? 'Explain…' : 'Add a note…';
}
