// What runs a session, and on which model — the line under a session's name in
// the All Sessions menu: "Claude Code · Sonnet", "YouCoded Coder · DeepSeek R1",
// "YouCoded Assistant · Grok 3".
//
// WHY it lives here and not on the pill: the pill used to carry a
// "YouCoded · Coder" badge beside the name. It cost ~96px of a strip that has
// none to spare, and it opened AFTER the name on every switch — a second
// motion the eye had to wait for. Destin, 2026-09-02: "eliminate the
// 'youcoded - coder' tags in session names entirely. they still cause a bit of
// visual jank." The menu row has room and is read at rest, so the runtime and
// the model both go there, with the same brand icon the status bar's model
// chip uses — one vocabulary for "which model" across the app.
import { resolveModelBrand, type ProviderIconKey } from '../provider-brand';
import { nativeModelLabel } from '../native-model-label';
import { claudeAliasForModelId, type ClaudeAlias } from '../../../shared/model-ids';

export interface SessionRuntimeLabel {
  /** "Claude Code" | "YouCoded Coder" | "YouCoded Assistant" | "Terminal". */
  runtime: string;
  /** Short model name, or null when the session has no model to show. For a
   *  shell session this slot carries the SHELL's name instead ('fish') — the
   *  session has no model, and the shell is the equivalent "what is running". */
  model: string | null;
  /** `runtime · model`, or just the runtime when there is no model. */
  text: string;
  /** The brand mark the status bar's model chip shows for the same model. */
  icon?: ProviderIconKey;
  /** The chip's brand colour — a CSS value, usually a `var(--brand-*)`. */
  color: string;
}

/** Claude Code's alias → the class name the status bar chip shows. Labels are
 *  model-class only (no version), matching StatusBar's MODEL_DISPLAY. */
const CLAUDE_LABEL: Record<ClaudeAlias, string> = {
  sonnet: 'Sonnet',
  'opus[1m]': 'Opus',
  haiku: 'Haiku',
  fable: 'Fable',
};

/** Same fallback as the status bar's native chip for a model no brand rule knows. */
const UNBRANDED = 'var(--tag-blue)';

export function sessionRuntimeLabel(s: {
  provider?: string;
  harnessId?: string;
  model?: string;
  shellName?: string;
}): SessionRuntimeLabel {
  // A shell session is the user's own terminal — no AI, no model. It is named
  // after the shell it actually spawned ("Terminal · fish"), because "Claude
  // Code" here would be plainly wrong: nothing in this session is Claude.
  if (s.provider === 'shell') {
    const shell = s.shellName || null;
    return {
      runtime: 'Terminal',
      model: shell,
      text: shell ? `Terminal · ${shell}` : 'Terminal',
      color: UNBRANDED,
    };
  }
  if (s.provider === 'native') {
    const runtime = `YouCoded ${s.harnessId === 'coder' ? 'Coder' : 'Assistant'}`;
    const model = s.model ? nativeModelLabel(s.model) || null : null;
    const brand = s.model ? resolveModelBrand(s.model) : null;
    return {
      runtime,
      model,
      text: model ? `${runtime} · ${model}` : runtime,
      icon: brand?.icon,
      color: brand?.color ?? UNBRANDED,
    };
  }
  // Claude Code. The model is an alias ('sonnet', 'claude-opus-5', …); an id
  // no alias matches shows nothing rather than a guess — the status bar's
  // "Model Unknown" is its own affordance and does not belong in a list row.
  const alias = s.model ? claudeAliasForModelId(s.model) : null;
  const model = alias ? CLAUDE_LABEL[alias] : null;
  return {
    runtime: 'Claude Code',
    model,
    text: model ? `Claude Code · ${model}` : 'Claude Code',
    icon: 'claudecode',
    color: 'var(--brand-claude)',
  };
}
