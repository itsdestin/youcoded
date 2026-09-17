import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { RENDERER, readStripped, assertScopeIsPopulated, assertPatternMatches } from './helpers/guard-scope';

// Timers that tick while the window is hidden are CPU for nobody: a minimised
// or covered YouCoded should do no rendering work, and a `setInterval` that
// keeps firing setState while nobody can see the result is exactly that work.
// This guard is the INVENTORY (2026-09-16, simplification audit §7 G3): every
// renderer file that calls `setInterval(` must either gate on visibility itself
// (document.hidden / visibilityState / visibilitychange, or a
// `useVisibleInterval`-style hook) or sit in the allowlist below with a reason.
//
// The allowlist is populated with today's offenders and is meant to SHRINK: a
// file converted to a visibility-gated hook must delete its line (the guard
// fails on a stale entry, so the list stays an honest inventory rather than a
// blanket exemption). Most entries are legitimately cheap — a 1s elapsed
// counter that only mounts while something is in flight — which is why this is
// an allowlist and not a ban. Adding a NEW entry should take the same thought as
// gating the timer instead.
const TIMER = /\bsetInterval\(/;
const GATED = /document\.hidden|visibilityState|visibilitychange|useVisibleInterval/;

// Path relative to src/renderer → one-line reason it is allowed to tick unseen.
const ALLOWLIST: Record<string, string> = {
  'App.tsx': 'settings-badge poll every 10s — one cheap IPC read, no render unless the answer changes',
  'components/assistant-settings/AssistantSettings.tsx': 're-renders every 4s only while the Assistant dialog is open',
  'components/AttentionBanner.tsx': '1s elapsed counter, only while a stalled banner is on screen',
  'components/BrailleSpinner.tsx': 'shared 40ms spinner tick; runs only while a spinner is mounted (interval-driven by design, see animation-frame-budget.test.ts)',
  'components/CompactingCard.tsx': '1s elapsed counter while a compaction card is mounted',
  'components/guide/GuideRing.tsx': '250ms anchor re-measure while a first-run tour ring is shown',
  'components/guide/GuideTour.tsx': '300ms anchor-presence check while a first-run tour is running',
  'components/LocalModelDownloadStrip.tsx': '1s download-status poll while a model download is in flight',
  'components/LocalModelsSection.tsx': '2s settings re-read while a local-model dialog is open',
  'components/ModelLoadingBar.tsx': '1s elapsed counter while a local model loads',
  'components/ModelProvidersPopup.tsx': '1s sign-in poll only while a browser sign-in is pending',
  'components/specialists/RunStatusLine.tsx': '1s elapsed counter while a specialist run is running',
  'components/ThinkingIndicator.tsx': 'word rotation (2.5s), retry countdown (1s) and prefill tick (250ms), each only while a reply is in flight',
  'components/tool-views/ToolBody.tsx': '1s elapsed counter while a tool call is running',
  'hooks/useAttentionClassifier.ts': '1s PTY buffer read only while Claude is thinking; stall detection must keep working when the window is hidden',
  'hooks/useVoiceInput.ts': '500ms seconds counter only while the microphone is listening',
  'state/account-context.tsx': 'account refresh every 15 minutes — negligible',
  'dev/workbench/compare/registry.tsx': 'workbench-only, never in the shipped app',
  'dev/workbench/mock-shim.ts': 'workbench-only fake backend, never in the shipped app',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    if (!/\.(ts|tsx)$/.test(full) || full.includes('.test.')) return [];
    return [full];
  });
}

const rel = (abs: string) => abs.slice(RENDERER.length + 1).split('\\').join('/');

describe('renderer intervals are visibility-gated or allowlisted with a reason', () => {
  const files = walk(RENDERER);
  assertScopeIsPopulated(files, 300);
  assertPatternMatches(TIMER, 'const id = window.setInterval(() => tick(), 500);', 'a setInterval call');
  assertPatternMatches(GATED, "document.addEventListener('visibilitychange', onVis);", 'a visibilitychange listener');

  const timerFiles = files.filter((f) => TIMER.test(readStripped(f))).map(rel);

  it('sees the known timer files (non-vacuity)', () => {
    expect(timerFiles).toContain('components/BrailleSpinner.tsx');
    expect(timerFiles).toContain('components/mascot/MascotRig.tsx');
  });

  it('every file that calls setInterval is gated on visibility or allowlisted', () => {
    const offenders = timerFiles.filter((f) => !GATED.test(readStripped(join(RENDERER, f))) && !(f in ALLOWLIST));
    expect(
      offenders,
      `These renderer files call setInterval( without checking document.hidden / visibilityState / visibilitychange ` +
        `(or a useVisibleInterval-style hook) and are not in ALLOWLIST (tests/visible-intervals.test.ts):\n  ${offenders.join('\n  ')}\n` +
        `Gate the timer on visibility, or add the file to ALLOWLIST with a one-line reason it may tick while nobody is looking.`,
    ).toEqual([]);
  });

  it('every allowlist entry still names a file that needs it', () => {
    const stale = Object.keys(ALLOWLIST).filter((f) => {
      if (!timerFiles.includes(f)) return true;                       // gone, or no longer calls setInterval
      return GATED.test(readStripped(join(RENDERER, f)));            // now gated — the entry is dead weight
    });
    expect(
      stale,
      `ALLOWLIST entries whose file no longer calls setInterval( ungated — delete them so the list stays an honest inventory:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });

  it('gives every allowlist entry a reason', () => {
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, `${file} is allowlisted with no reason`).toBeGreaterThan(10);
    }
  });
});
