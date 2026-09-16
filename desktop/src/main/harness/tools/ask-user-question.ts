// AskUserQuestion (spec §3.3): CC's exact name + input shape so the existing
// AskUserQuestionCard renders it unchanged. INTERACTIVE — the driver routes it
// straight to askUser() (the permission-ask rail: pause, cancel-on-interrupt,
// PermissionExpired on teardown all come free); execute() never runs. NOT wrapped
// by defineTool(): it needs no truncation and the driver short-circuits it before
// execute — the plain NativeTool shape (name/description/inputSchema/
// permissionSubject + interactive) is all the driver reads.
import { z } from 'zod';
import type { NativeTool, ToolResultPayload } from './types';

const optionSchema = z.object({ label: z.string().min(1), description: z.string().optional() });
const questionSchema = z.object({
  question: z.string().min(1),
  header: z.string().min(1).max(12),
  options: z.array(optionSchema).min(2).max(4),
  multiSelect: z.boolean(),
});
const inputSchema = z.object({ questions: z.array(questionSchema).min(1).max(4) }).strict(); // .strict(): an unknown parameter is an error the model can fix, never silently dropped (ledger D-2)
export type AskUserQuestionInput = z.infer<typeof inputSchema>;

const NO_SELECTION = '(no selection — the user did not answer this one)';

/** Coerce ONE untrusted answer value into display text. updatedInput is UNTRUSTED
 *  (renderer AND remote WS clients) and typed Record<string, unknown> — the broker
 *  only checks it's an object, never the value types inside `answers`. This MUST
 *  NOT throw on any shape (a throw would skip the role:'tool' history push →
 *  dangling tool_call → bricked session). A multi-select answer may arrive as an
 *  array; join its string elements. Everything else that isn't a non-empty string
 *  falls back to "no selection". */
function renderAnswer(value: unknown): string {
  if (typeof value === 'string') { const t = value.trim(); return t ? t : NO_SELECTION; }
  if (Array.isArray(value)) {
    const joined = value.filter((v) => typeof v === 'string' && v.trim()).map((v) => (v as string).trim()).join(', ');
    return joined || NO_SELECTION;
  }
  return NO_SELECTION;   // number / boolean / object / null / undefined → not a real selection
}

/** Turn the card's updatedInput ({questions, answers: Record<question, labels>})
 *  into the tool-result text the model reads. TOTAL — returns a string for ANY
 *  input, never throws (see runOneTool's "NEVER throws" contract). */
export function formatAnswers(args: AskUserQuestionInput, updatedInput: Record<string, unknown> | undefined): string {
  const raw = updatedInput?.answers;
  // Guard `answers` itself: a client could send an array, null, or a scalar.
  const answers = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  // Ledger G-2: the card can now send a free-text note per question
  // (`notes[question]`) when a listed option was chosen. Same untrusted-shape
  // rules as `answers` — anything that isn't a non-empty string is no note.
  const rawNotes = updatedInput?.notes;
  const notes = (rawNotes && typeof rawNotes === 'object' && !Array.isArray(rawNotes) ? rawNotes : {}) as Record<string, unknown>;
  const lines = args.questions.map((qq) => {
    const answer = renderAnswer(answers[qq.question]);
    // A typed "Other" answer arrives as plain text in the answer slot. Tell the
    // model when what came back was NOT one of its options, so it reads the
    // text as the user's own answer instead of hunting for a matching label.
    const labels = new Set(qq.options.map((o) => o.label));
    const parts = answer === NO_SELECTION ? [] : answer.split(', ');
    const ownAnswer = parts.length > 0 && parts.some((p) => !labels.has(p));
    const note = typeof notes[qq.question] === 'string' ? (notes[qq.question] as string).trim() : '';
    let out = `Q: ${qq.question}\nA${ownAnswer ? ' (the user typed their own answer)' : ''}: ${answer}`;
    if (note) out += `\nNote from the user: ${note}`;
    return out;
  });
  return `The user answered:\n\n${lines.join('\n\n')}`;
}

export const AskUserQuestionTool: NativeTool<AskUserQuestionInput> = {
  name: 'AskUserQuestion',
  // Pause handoff §1 (WHY): may reach outside this computer, so a plan never repeats it by itself.
  effect: 'external',
  description:
    'Ask the user 1-4 multiple-choice questions when you genuinely need their input to proceed (preferences, ambiguous requirements, a decision only they can make). Each question needs a short header (max 12 chars) and 2-4 options. Do not use it for questions you can answer yourself.',
  // Compact form for small local models (simplified presentation).
  shortDescription: 'Ask the user 1-4 multiple-choice questions when you need their input to proceed.',
  inputSchema,
  // interactive:true bypasses ALL permission gating (guards + decide + execute) —
  // safe ONLY because asking a question has no side effect. NEVER set it on a tool
  // that touches the filesystem/network/etc.
  interactive: true,
  permissionSubject: () => undefined,
  // Defensive only — the driver intercepts interactive tools before execute.
  async execute(): Promise<ToolResultPayload> {
    return { text: 'AskUserQuestion must be routed through the interactive ask rail; this is a configuration error.', isError: true };
  },
};
