// ONE shape for "start a conversation", built in one place.
//
// WHY THIS FILE EXISTS (2026-09-10). Four surfaces call `session.create`: the
// welcome form, SessionStrip's form, the Resume Browser (via App's
// handleResumeSession) and the buddy floater's own form. Each hand-built the
// argument object, and each had to remember the same four conditionals:
//
//   · a native session must NOT carry a Claude alias (the harness uses
//     binding.modelId; session-manager's native branch ignores `model`), so
//     sending one makes the payload lie about what will run;
//   · `skipPermissions` is Claude-Code-only — a native session has no PTY and
//     no permission flow, so a true here is silently meaningless;
//   · `binding` is required for a fresh native session and meaningless for a
//     Claude one;
//   · `preset` (Assistant | Coder) is stamped at create, native only.
//
// The buddy form remembered NONE of them: it hardcoded `provider: 'claude'`,
// so ChatGPT and local models were unreachable from the floater and a saved
// non-Claude default was silently replaced with Claude Sonnet. That is the
// drift this module exists to make impossible — a caller now answers "which
// runtime, which model" and the conditionals are applied for it.
//
// Pinned by tests/session-create-args.test.ts.

/** Which engine runs the conversation. Mirrors RuntimeBinding's `Runtime`,
 *  restated here because this module is shared code and must not import from
 *  the renderer's component tree. */
export type SessionRuntime = 'claude' | 'native';

/** A native provider/model pair. Mirrors RuntimeBinding's `Binding`. */
export interface SessionBinding {
  providerId: string;
  modelId: string;
}

export interface SessionCreateRequest {
  /** Placeholder title. Fresh creates use 'New Session'; resumes MUST use the
   *  RESUMING_* constants from shared/session-title.ts so main's title feeder
   *  can recognise them as placeholders and still auto-title the session. */
  name: string;
  cwd: string;
  runtime: SessionRuntime;
  /** Claude alias ('sonnet', 'opus[1m]', …). Dropped for a native session. */
  model?: string;
  /** Claude Code only. Forced false for a native session. */
  skipPermissions?: boolean;
  /** Native only. The provider/model pair the harness launches on. */
  binding?: SessionBinding | null;
  /** Native only. Harness preset id ('assistant' | 'coder'). */
  preset?: string;
  /** Set to resume a past conversation instead of starting a fresh one. */
  resumeSessionId?: string;
}

/** The exact object `window.claude.session.create` expects. */
export interface SessionCreateArgs {
  name: string;
  cwd: string;
  skipPermissions: boolean;
  provider: SessionRuntime;
  model?: string;
  binding?: SessionBinding;
  preset?: string;
  resumeSessionId?: string;
}

export function buildSessionCreateArgs(req: SessionCreateRequest): SessionCreateArgs {
  const native = req.runtime === 'native';
  return {
    name: req.name,
    cwd: req.cwd,
    // Native has no PTY permission flow — never send a true it cannot honour.
    skipPermissions: native ? false : (req.skipPermissions ?? false),
    provider: req.runtime,
    // A Claude alias is meaningless for a native session; omit it rather than
    // letting a value left over from an earlier Claude pick ride along.
    model: native ? undefined : req.model,
    binding: native ? (req.binding ?? undefined) : undefined,
    preset: native ? req.preset : undefined,
    resumeSessionId: req.resumeSessionId,
  };
}
