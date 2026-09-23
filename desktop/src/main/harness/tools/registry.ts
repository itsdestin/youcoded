// defineTool(): the ONE pipeline every tool runs through (spec §2.3) —
// validation and permission gating happen in the DRIVER (it owns pause/resume);
// this wrapper owns execution + uniform truncation + actionable errors.
import { truncateOutput, composeNotice, type TruncateOpts } from './truncate';
import type { NativeTool, ToolContext, ToolResultPayload } from './types';

const DEFAULT_CAPS: TruncateOpts = { maxChars: 30_000 };

/** Grep's and Glob's deadline. 180 s is the search-scope spec's number
 *  (docs/active/specs/2026-08-17-search-scope-and-timeout-design.md): long
 *  enough for any real project search, short enough that a runaway walk of a
 *  home folder or network drive ends in minutes instead of hours. */
export const SEARCH_TIMEOUT_MS = 180_000;

/** A derived signal that aborts when EITHER input aborts, and is never able to
 *  abort an input itself.
 *
 *  WHY (search-scope plan, review defect D1): `ctx.signal` is the TURN's signal —
 *  the same one the model stream runs on — and the driver reads an aborted turn
 *  signal as a user interrupt. A tool timeout must therefore abort only its OWN
 *  controller; this listener-based combination can never propagate back. */
function combineSignals(turn: AbortSignal, own: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const c = new AbortController();
  const onAbort = () => { dispose(); c.abort(); };
  // dispose() matters: without it every finished search would leave a listener
  // on the turn's signal for the rest of the turn.
  const dispose = () => {
    turn.removeEventListener('abort', onAbort);
    own.removeEventListener('abort', onAbort);
  };
  if (turn.aborted || own.aborted) c.abort();
  else {
    turn.addEventListener('abort', onAbort, { once: true });
    own.addEventListener('abort', onAbort, { once: true });
  }
  return { signal: c.signal, dispose };
}

export function defineTool<A>(
  def: NativeTool<A> & { caps?: TruncateOpts & { timeoutMs?: number } },
): NativeTool<A> {
  const caps: TruncateOpts & { timeoutMs?: number } = def.caps ?? DEFAULT_CAPS;
  // The pre-deadline pipeline, unchanged: execution + uniform truncation +
  // actionable errors. A closure (not a method) so the deadline below can race it.
  const runOnce = async (args: A, ctx: ToolContext): Promise<ToolResultPayload> => {
    try {
      const raw = await def.execute(args, ctx);
      const t = truncateOutput(raw.text, caps);
      // Untrusted-content framing (types.ts `untrusted`): applied AFTER the
      // pipeline cap, so the cap measures the content and the tag always
      // closes; the notice composeNotice appends is harness prose and sits
      // OUTSIDE the tag. Errors are the harness's own words, never wrapped.
      const framed = def.untrusted && !raw.isError
        ? `<untrusted-content source="${def.untrusted}">\n${t.text}\n</untrusted-content>`
        : t.text;
      // The tool's own bound and the pipeline cap are independent; composeNotice
      // folds both into one line and uses the TOOL's widening advice, never a
      // default of ours. `def.moreHint` is that tool's STATIC vocabulary — the
      // fallback for when the pipeline cap fires alone and `raw.bounds` is
      // undefined (Task 19: three reviews found this is the COMMON case for
      // content-mode Grep, not an edge one). See the WHY block in truncate.ts.
      const notice = composeNotice(
        raw.bounds,
        t.truncated ? { shown: t.text.length, total: t.totalChars } : null,
        def.moreHint,
      );
      return { ...raw, text: framed + notice };
    } catch (err: any) {
      // Abort is only surfaced here when the tool THREW — the driver (Task 9)
      // owns interrupt semantics (it aborts the signal and stops the turn);
      // this branch just labels an in-flight throw as a cancellation, not a bug.
      if (ctx.signal.aborted) return { text: 'Canceled: the user interrupted this operation.', isError: true };
      // Actionable error string, never a bare code (research R§3).
      return { text: `${def.name} failed: ${err?.message ?? String(err)}`, isError: true };
    }
  };
  return {
    ...def,
    async execute(args: A, ctx: ToolContext): Promise<ToolResultPayload> {
      // WHY a per-tool deadline (roadmap urgent item, 2026-08-26 incident): Grep
      // and Glob awaited their walk with no limit, and one Grep from a home-folder
      // conversation sat 4 hours inside a network-mounted Google Drive until Stop.
      // A tool that declares `caps.timeoutMs` now gets a derived signal (so its
      // own abort wiring — Grep's SIGKILL, Glob's walk check — fires) and, on
      // expiry, a normal error result the model can act on. The TURN keeps going.
      // `ctx.toolTimeoutMs` is a test-only override and only shortens a deadline
      // the tool already declares; it never puts one on a tool that has none.
      const timeoutMs = caps.timeoutMs ? (ctx.toolTimeoutMs ?? caps.timeoutMs) : 0;
      if (timeoutMs > 0) {
        const own = new AbortController();
        const combined = combineSignals(ctx.signal, own.signal);
        const execCtx: ToolContext = { ...ctx, signal: combined.signal };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const TIMED_OUT = Symbol('timed-out');
        const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
          // Abort and settle in the SAME tick, so the race below resolves with the
          // timeout before the tool's own late "Canceled"/partial answer can win.
          timer = setTimeout(() => { own.abort(); resolve(TIMED_OUT); }, timeoutMs);
        });
        try {
          const raced = await Promise.race([runOnce(args, execCtx), deadline]);
          if (raced === TIMED_OUT) {
            return {
              text: `${def.name} timed out after ${Math.round(timeoutMs / 1000)}s and was stopped — the search covered too much (a very large folder, or a slow network drive). Narrow it: pass a more specific \`path\` or a tighter pattern.`,
              isError: true,
            };
          }
          return raced;
        } finally {
          if (timer) clearTimeout(timer);
          combined.dispose();
        }
      }
      return runOnce(args, ctx);
    },
  };
}
