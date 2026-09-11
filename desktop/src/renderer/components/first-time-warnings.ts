// First-time warnings — the data half of <FirstTimeWarning>.
//
// Spec: docs/active/specs/2026-09-10-first-run-guide-design.md §1 item 7, §4
// (`youcoded-warned-<kind>`), §5 "Warnings". Three gates, each shown ONCE per
// install: turning on Skip Permissions, picking Full auto, and starting a
// session on a small model. The dialog lives in FirstTimeWarning.tsx; this
// module holds the copy, the acknowledgement flag and the small-model test so
// they can be unit-tested without a DOM.
//
// Copy stance (Destin's note on Q-4): honest, not scary, in words a college
// student knows. Nothing here promises a safety net the app does not have —
// SkipPermissionsCaption's own fact is "executes tools without asking for
// approval", and these paragraphs say the same thing at greater length.

import { ALWAYS_ASKS } from './PermissionsSection';

export type WarningKind = 'skip-permissions' | 'full-auto' | 'small-model';

export interface WarningCopy {
  title: string;
  /** One paragraph per entry. */
  body: string[];
  /** Bullet list rendered after the FIRST paragraph (Full auto's always-asks). */
  bullets?: readonly string[];
  /** When present, Continue stays disabled until this box is ticked. */
  checkbox?: string;
  continueLabel: string;
}

// The two dangerous kinds share one checkbox sentence on purpose: it is the
// exact consequence the person is agreeing to, and it should read the same
// wherever they meet it.
const I_UNDERSTAND = 'I understand the assistant can change or delete files without asking';

export const WARNING_COPY: Record<WarningKind, WarningCopy> = {
  'skip-permissions': {
    title: 'Before you turn on Skip Permissions',
    body: [
      'Skip Permissions lets the assistant run commands and change files without asking you first.',
      'That is faster. It also means a mistake reaches your files before you see it.',
      'Keep your own backups of anything you cannot replace.',
    ],
    checkbox: I_UNDERSTAND,
    continueLabel: 'Turn it on',
  },
  'full-auto': {
    title: 'Before you pick Full auto',
    body: [
      'Full auto lets the assistant work without checking with you, except for the few things it always asks about.',
      'Anything else it can do on its own, including changing and deleting files, and a mistake reaches your files before you see it.',
      'Keep your own backups of anything you cannot replace.',
    ],
    // Verbatim from the Permissions page so the two never disagree about what
    // Full auto still stops for.
    bullets: ALWAYS_ASKS,
    checkbox: I_UNDERSTAND,
    continueLabel: 'Use Full auto',
  },
  'small-model': {
    title: 'About smaller models',
    body: [
      'This is a smaller model. Smaller models cost less and can run on your own computer.',
      'They also make more mistakes: they misread instructions more often and can damage files they were only meant to read.',
      'Start with work you can undo, and keep Ask mode on until you trust it.',
    ],
    continueLabel: 'Got it',
  },
};

// ── Acknowledgement flag ─────────────────────────────────────────────────────
//
// localStorage, like every other renderer UI preference (spec §4). try/catch on
// every access: the renderer also runs inside the Android WebView and remote
// browsers, where storage can be disabled or throw on access, and a warning
// that cannot record itself must still show rather than crash the form.

export function warnedKey(kind: WarningKind): string {
  return `youcoded-warned-${kind}`;
}

export function hasAcknowledged(kind: WarningKind): boolean {
  try {
    return localStorage.getItem(warnedKey(kind)) === '1';
  } catch {
    return false;
  }
}

export function markAcknowledged(kind: WarningKind): void {
  try {
    localStorage.setItem(warnedKey(kind), '1');
  } catch {
    // Storage unavailable: the warning will show again next time, which is the
    // safe direction to fail in.
  }
}

// ── Small-model test ─────────────────────────────────────────────────────────
//
// "Small" = 40 billion parameters or fewer (spec §5). The parameter count is
// read out of the model's id or label first, because names are the one thing
// every provider gives us; the local file size is the fallback for a local
// model whose name carries no count.

export const SMALL_MODEL_MAX_PARAMS_B = 40;
export const SMALL_MODEL_MAX_LOCAL_BYTES = 30e9;

// A parameter count looks like "9b", "12B", "32b", "235b" — digits (with an
// optional decimal) directly followed by a b/B, and NOT preceded by another
// digit or letter (so "a3b" in "30b-a3b" and "3b" in "llama3b-vision" do not
// match on their own). Examples that must parse: "qwen3-32b" → 32,
// "gemma-3-27b-it" → 27, "qwen3-235b-a22b" → 235, "qwen3-30b-a3b" → 30.
//
// A MoE name ("30b-a3b") lists total then active parameters; the FIRST count is
// the total, which is what decides whether the model is small. Taking the first
// match handles it without knowing anything about MoE.
const PARAM_COUNT = /(?<![a-z0-9])(\d+(?:\.\d+)?)b(?![a-z])/i;

/** The parameter count in billions named by an id or label, or null. */
export function parseParamCountB(name: string | undefined): number | null {
  if (!name) return null;
  const m = PARAM_COUNT.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function isSmallModel({
  modelId,
  modelLabel,
  localSizeBytes,
}: {
  modelId?: string;
  modelLabel?: string;
  localSizeBytes?: number;
}): boolean {
  // The id is the more reliable of the two names (labels are sometimes just
  // "Qwen 3"), so it is asked first; the label only speaks when the id is silent.
  const fromName = parseParamCountB(modelId) ?? parseParamCountB(modelLabel);
  if (fromName !== null) return fromName <= SMALL_MODEL_MAX_PARAMS_B;
  if (typeof localSizeBytes === 'number' && Number.isFinite(localSizeBytes)) {
    return localSizeBytes < SMALL_MODEL_MAX_LOCAL_BYTES;
  }
  return false;
}
