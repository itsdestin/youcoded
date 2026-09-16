import type { SessionProvider } from '../../shared/types';

/**
 * User-facing name for the assistant.
 *
 * Destin, 2026-09-10: *"we should replace any direct references to 'claude' with
 * 'the assistant' or something similar, and make sure they work with native
 * sessions."*
 *
 * It used to answer "Claude" for a Claude-Code session and "your assistant" only
 * for a native one. That still put a vendor's name in ordinary product copy —
 * "Message Claude…", "Still waiting on Claude" — and it meant every sentence had
 * to be threaded with a provider to be correct. One name for the thing that does
 * the work removes both problems, and it is the app's own voice: YouCoded is the
 * product, and which model is behind it is a setting, not an identity.
 *
 * `provider` is kept so call sites do not churn and a future per-provider name
 * (a user-chosen one, say) has somewhere to live.
 *
 * NOT for product names. "Claude Code", "Claude Pro/Max", "Sign in with your
 * Claude account" and model names are genuinely about Anthropic's product and
 * MUST stay — renaming those would tell the user something false about what they
 * are signing into or paying for.
 */
export function assistantName(
  _provider?: SessionProvider | undefined,
  opts?: { capitalized?: boolean },
): string {
  return opts?.capitalized ? 'Your assistant' : 'your assistant';
}
