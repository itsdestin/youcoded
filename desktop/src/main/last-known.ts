// Read-with-fallback for the per-session status push (buildStatusData in ipc-handlers.ts).
//
// WHY: the context %, git branch and session stats each repeated the same loop — "if this
// push read a value, use it and remember it; if the read came back empty, reuse the last
// value we remembered for that session". A momentary missing file (statusline.sh rewriting
// it) must not blank the status bar, so the fallback is deliberate. One helper keeps the
// three copies from drifting apart.
export interface LastKnownOptions<R, T> {
  /** Turns a raw read into the stored value; return undefined when it is unusable. Unusable
   *  values are skipped WITHOUT falling back (a garbled context file is not "missing"). */
  parse?: (raw: R) => T | undefined;
  /** Whether the read produced anything. Default: truthy. The context % file passes
   *  `raw != null` because an empty string is still "a read happened". */
  present?: (raw: R) => boolean;
}

export function mergeWithLastKnown<R, T>(
  entries: ReadonlyArray<{ desktopId: string; raw: R }>,
  last: Record<string, T>,
  opts: LastKnownOptions<R, T> = {},
): Record<string, T> {
  const present = opts.present ?? ((raw: R) => !!raw);
  const parse = opts.parse ?? ((raw: R) => raw as unknown as T);
  const out: Record<string, T> = {};
  for (const { desktopId, raw } of entries) {
    if (present(raw)) {
      const value = parse(raw);
      if (value !== undefined) {
        out[desktopId] = value;
        last[desktopId] = value;
      }
    } else if (desktopId in last) {
      out[desktopId] = last[desktopId];
    }
  }
  return out;
}
