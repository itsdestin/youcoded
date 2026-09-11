import React, { useEffect, useRef, useState } from 'react';
import type { EngineModelState } from '../../shared/engine-types';
import { Button, ProgressBar, Tooltip } from './ui';
import BrailleSpinner from './BrailleSpinner';
import { resolveModelBrand } from './provider-brand';
import { ProviderIcon } from './ProviderIcon';

// Centered status strip that floats just ABOVE the input area for a NATIVE
// (local-model) session. States (2026-07-14 memory-lifecycle UX):
//   • LOADING — the model is coming up. Three visual phases:
//       – Reading:    determinate bar tracks resident bytes → "N GB / M GB".
//       – Finalizing: weights are in RAM but the backend is still initializing
//         (KV-cache + compute buffers, Vulkan VRAM upload, warm-up pass). llama-
//         server reports 'loading' this whole time with the byte count pinned at
//         100%, so a plain determinate bar looks frozen — we switch to a full bar
//         with a moving highlight + "Preparing…" so it reads as still-working.
//       – Indeterminate: no byte measurement (non-Linux / racing) — a sweep.
//   • UNLOADED — the model SLEPT after use and no turn is in flight:
//     "Model unloaded to save memory · [Reload Model]". Only shown once the model
//     has actually been resident this session (everResident) so a fresh session's
//     initial cold state shows the loading bar instead of a spurious Reload.
// Renders nothing when the model is loaded (or state unknown). Positioned by the
// caller in ChatView's outer absolute container so it isn't clipped by chat-pane.

interface Props {
  modelState: EngineModelState | null;
  modelInfo: { modelId: string; sizeBytes: number | null } | null;
  /** Bytes resident so far while loading (null when unavailable / not loading). */
  loadedBytes: number | null;
  /** True once the model has reached 'loaded' at least once this session. Gates
   *  the Reload prompt so a fresh session that's still doing its FIRST load never
   *  flashes "unloaded · Reload" during the cold-start race window. */
  everResident: boolean;
  isThinking: boolean;
  onReload: (modelId: string) => void;
}

/** Trim a GGUF id to something human: drop the split suffix + quant tag. */
function friendlyName(modelId: string): string {
  return modelId
    .replace(/-\d{5}-of-\d{5}$/i, '')
    .replace(/-(UD-)?[QIF]\d[^-]*(_[A-Z0-9]+)*$/i, '')
    .replace(/-(UD-)?(BF16|F16|F32|MXFP4(_MOE)?)$/i, '');
}

function gbNum(bytes: number | null | undefined): string {
  return ((bytes ?? 0) / 1024 ** 3).toFixed(1);
}

// Fraction of the file that must be resident before we consider the RAM read
// "done" and switch to the finalizing phase. On Vulkan the child's RSS can peak
// slightly below the file size (weights stream to VRAM/GTT and RSS drops), so
// this is <1 rather than exactly 100%.
const FINALIZE_PCT = 99;
// If resident bytes stop climbing for this long while still 'loading', treat it
// as finalizing too — covers models whose peak RSS plateaus below FINALIZE_PCT.
const PLATEAU_MS = 2500;

// forwardRef (fix: jump-to-bottom/model-status-strip overlap): ChatView needs
// this component's OWN rendered height to publish `--model-status-height`
// (mirrors QueuedMessagesStrip's `--queued-strip-height`) so `.jump-to-bottom`
// can lift above this strip instead of sharing its exact bottom offset. The
// ref targets the root div directly, not a ChatView-side wrapper — this root
// is `position: absolute`, so a plain static wrapper around it would not size
// itself to the absolutely-positioned child and would always measure 0.
const ModelLoadingBar = React.forwardRef<HTMLDivElement, Props>(function ModelLoadingBar(
  { modelState, modelInfo, loadedBytes, everResident, isThinking, onReload },
  ref,
) {
  const notResident = modelState === 'sleeping' || modelState === 'unloaded';
  // The model is coming up if it's explicitly loading, OR a turn is in flight
  // while it's still asleep/unloaded (the send is waking it), OR it's a fresh
  // session whose model hasn't finished its first load yet (eager load in flight).
  const loading =
    modelState === 'loading' ||
    (isThinking && notResident) ||
    (notResident && !everResident);
  // Reload prompt ONLY after the model was resident and then dropped while idle.
  const showReload = !isThinking && notResident && everResident;

  // Elapsed-seconds ticker — also serves as a 1s re-render heartbeat so the
  // plateau check below re-evaluates even when byte updates have stopped arriving.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!loading) { setElapsed(0); return; }
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [loading, modelInfo?.modelId]);

  // Track the last time resident bytes increased, to detect a plateau (weights
  // fully read, backend still initializing) independent of the exact peak %.
  const lastBytesRef = useRef<number | null>(null);
  const lastGrowthAtRef = useRef<number>(0);
  useEffect(() => {
    if (!loading) { lastBytesRef.current = null; lastGrowthAtRef.current = 0; return; }
    if (loadedBytes != null && (lastBytesRef.current == null || loadedBytes > lastBytesRef.current)) {
      lastBytesRef.current = loadedBytes;
      lastGrowthAtRef.current = Date.now();
    }
  }, [loading, loadedBytes]);

  if (!modelInfo || (!loading && !showReload)) return null;

  const name = friendlyName(modelInfo.modelId);
  // Local GGUF filenames name their company ("qwen2.5-coder…", "gemma-3-27b…"),
  // so the mark resolves off the id alone. Null for a model whose file is named
  // after nothing recognisable — the line then reads exactly as it does today.
  const brand = resolveModelBrand(modelInfo.modelId, 'local-engine');
  const size = modelInfo.sizeBytes;
  // Determinate GB progress when we have both resident bytes and a total size.
  const hasProgress = loading && loadedBytes != null && loadedBytes > 0 && size != null && size > 0;
  const pct = hasProgress ? Math.min(100, Math.round((loadedBytes! / size!) * 100)) : 0;
  // Finalizing: weights are in RAM (near-full % OR bytes plateaued) but the
  // backend is still initializing — show a full, animated "Preparing…" bar.
  const plateaued =
    hasProgress && lastGrowthAtRef.current > 0 && Date.now() - lastGrowthAtRef.current > PLATEAU_MS;
  const finalizing = hasProgress && (pct >= FINALIZE_PCT || plateaued);

  // NOT an L4 overlay, despite what change 29 reads like. This strip is
  // positioned INSIDE the chat column (absolute, z-10) — converting it to a
  // fixed L4 panel would relocate a correctly-placed element. It was already on
  // .layer-surface; change 29's real work here was dropping the rounded-xl and
  // shadow-lg that .layer-surface already supplies (globals.css:861-862), so the
  // surface recipe stays in exactly one place.
  return (
    <div ref={ref} className="model-status-strip absolute left-1/2 -translate-x-1/2 z-10 w-[min(88%,26rem)]">
      <div className="layer-surface px-4 py-3">
        {loading ? (
          <div className="flex flex-col gap-2">
            {/* Change 49 (requested by Destin 2026-07-16): a spinner at the head of
                the line, matching the §1.6 state-family anatomy — spinner means
                working. items-center rather than items-baseline: the braille glyph
                has no meaningful baseline to align text against. */}
            <div className="flex items-center justify-center gap-1.5 text-sm text-fg-2">
              <BrailleSpinner size="sm" />
              {finalizing ? (
                <>
                  <span className="italic">Preparing</span>
                  {brand?.icon && <span className="inline-flex shrink-0" style={{ color: brand.color }}><ProviderIcon icon={brand.icon} size={12} /></span>}
                  <span className="font-medium">{name}</span>
                  <Tooltip text="Weights are loaded — allocating memory and warming up the model">
                  <span
                    className="text-fg-dim text-xs"
                  >
                    · finishing up · {elapsed}s
                  </span>
                  </Tooltip>
                </>
              ) : (
                <>
                  <span className="italic">Loading</span>
                  {brand?.icon && <span className="inline-flex shrink-0" style={{ color: brand.color }}><ProviderIcon icon={brand.icon} size={12} /></span>}
                  <span className="font-medium">{name}</span>
                  {hasProgress ? (
                    <span className="text-fg-dim text-xs tabular-nums">
                      · {gbNum(loadedBytes)} / {gbNum(size)} GB
                    </span>
                  ) : size != null ? (
                    <span className="text-fg-dim text-xs">· {gbNum(size)} GB · {elapsed}s</span>
                  ) : (
                    <span className="text-fg-muted text-xs tabular-nums">· {elapsed}s</span>
                  )}
                </>
              )}
            </div>
            {finalizing ? (
              // Full bar + moving highlight: RAM read is done, backend is still
              // initializing. Never sits frozen at 100%.
              <div className="model-load-finalize h-1.5 rounded-full" />
            ) : hasProgress ? (
              // Determinate: fill tracks resident bytes / total size. Change 46 —
              // this is the only one of the three states that is a real progress
              // bar, so it is the only one the primitive can own. It also gains a
              // role="progressbar" + aria-valuenow it never had.
              <ProgressBar percent={pct} aria-label={`Loading ${name}`} />
            ) : (
              // Indeterminate: no byte measurement (non-Linux / racing) — sweep.
              // Track moved bg-well -> bg-inset to match the primitive above:
              // leaving it on bg-well would make the SAME strip change track colour
              // depending on whether byte progress happened to be available.
              <div className="model-load-track h-1.5 rounded-full bg-inset" />
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center gap-3">
            <span className="text-sm text-fg-muted">Model unloaded to save memory.</span>
            {/* Spec change 65: this one NORMALIZES — rounded-full drops to the
                one control radius. The pill exception is reserved for floating
                overlay affordances (e.g. ChatView's "Jump to bottom"); this sits
                inside a panel, so it's an ordinary primary action. */}
            <Button size="sm" onClick={() => onReload(modelInfo.modelId)} className="shrink-0">
              Reload model
            </Button>
          </div>
        )}
      </div>
    </div>
  );
});

export default ModelLoadingBar;
