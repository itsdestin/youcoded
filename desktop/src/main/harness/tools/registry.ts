// defineTool(): the ONE pipeline every tool runs through (spec §2.3) —
// validation and permission gating happen in the DRIVER (it owns pause/resume);
// this wrapper owns execution + uniform truncation + actionable errors.
import { truncateOutput, composeNotice, type TruncateOpts } from './truncate';
import type { NativeTool, ToolContext, ToolResultPayload } from './types';

const DEFAULT_CAPS: TruncateOpts = { maxChars: 30_000 };

export function defineTool<A>(
  def: NativeTool<A> & { caps?: TruncateOpts },
): NativeTool<A> {
  const caps = def.caps ?? DEFAULT_CAPS;
  return {
    ...def,
    async execute(args: A, ctx: ToolContext): Promise<ToolResultPayload> {
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
    },
  };
}
