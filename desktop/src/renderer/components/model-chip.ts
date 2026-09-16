// src/renderer/components/model-chip.ts
//
// Pure derivation of the StatusBar model chip + the "may this session cycle CC
// aliases?" predicate. Extracted from AppInner so both are testable without
// rendering App, and so the native/Claude Code split lives in ONE place rather
// than being re-derived at each consumer.
import type { ModelAlias, ModelChip } from './StatusBar';
import { nativeModelLabel } from './native-model-label';

/** Minimal shape needed off SessionInfo — keeps this module free of IPC types. */
export interface ModelChipSession {
  provider?: string;
  /** Native runtime: the bound provider model id. CC: the alias-ish model str. */
  model?: string;
}

/**
 * What the model chip should render for the active session.
 *
 * Native sessions read their bound model id straight off SessionInfo.model
 * (authoritative, and kept live on every swap) instead of going through the
 * Claude Code alias matcher — an OpenRouter slug or a local GGUF filename
 * matches none of the four aliases, which is why every native session used to
 * render the red "Model Unknown" error chip.
 *
 * Returns undefined when there is nothing honest to show: no session, or a
 * native session whose binding hasn't landed yet (create in flight). A missing
 * chip beats an error chip for a session that is merely new.
 */
export function modelChipFor(
  session: ModelChipSession | undefined,
  currentModel: ModelAlias | 'unknown',
): ModelChip | undefined {
  // A shell session runs no model at all. Falling through would hand it the
  // Claude Code alias matcher and render the red "Model Unknown" error chip for
  // a session that is not missing a model — it is a terminal.
  if (session?.provider === 'shell') return undefined;
  if (session?.provider === 'native') {
    if (!session.model) return undefined;
    return { kind: 'native', label: nativeModelLabel(session.model), modelId: session.model };
  }
  return currentModel === 'unknown' ? { kind: 'unknown' } : { kind: 'alias', alias: currentModel };
}

/**
 * Whether Shift+Space / the alias cycle may act on this session.
 *
 * False for shell sessions too, for the opposite reason: they DO have a PTY, so
 * `/model sonnet` plus its Enter would be typed into — and run by — the user's
 * own shell.
 *
 * False for native sessions: they have no PTY, so `/model <alias>\r` goes
 * nowhere (SessionManager.sendInput returns false for a worker-less session, and
 * guardedPtySend discards that return value). Without this gate the cycle fell
 * through to its optimistic writes and relabeled the chip with an alias the
 * session is not running, while also writing that alias to the GLOBAL model
 * preference. Native model changes go through native.setBinding in the picker.
 */
export function supportsAliasCycling(session: ModelChipSession | undefined): boolean {
  return session?.provider !== 'native' && session?.provider !== 'shell';
}
