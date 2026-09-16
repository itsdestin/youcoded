// @vitest-environment jsdom
// workbench-engine-states.test.ts — the local-engine states the WORKBENCH must
// be able to show.
//
// WHY THIS FILE EXISTS. Destin signs UI off in the workbench, so a state the
// fake cannot produce is a state nobody ever looks at. Nothing noticed when one
// quietly disappeared: removing the advice line from the fake's quants,
// removing the reason under `refused`, and putting `onStatusChanged` back to a
// no-op stub all left the whole suite green — and each of those blanks out one
// of the five things T23 drew.
//
// These assert the FAKE, deliberately. The real backend has its own guards; the
// hazard here is the mock silently drifting away from it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createStore } from '../src/renderer/dev/workbench/mock-store';
import { createMockShim, setLatency } from '../src/renderer/dev/workbench/mock-shim';
import { SCENARIO_IDS, type ScenarioId } from '../src/renderer/dev/workbench/scenarios';

setLatency(0);

/** The scenario is read off the URL when the shim is built, so the URL is set
 *  first — the same way the workbench itself is driven. */
function shimFor(query: string) {
  window.history.replaceState({}, '', query || '/');
  const asked = new URLSearchParams(query.replace(/^[^?]*/, '')).get('scenario') ?? 'default';
  // The workbench itself takes whatever the URL says; a name that is not a real
  // scenario here would silently seed `default` and make a test pass for the
  // wrong reason.
  const scenario = SCENARIO_IDS.find((id) => id === asked);
  if (!scenario) throw new Error(`not a workbench scenario: ${asked}`);
  return createMockShim(createStore(scenario as ScenarioId)) as any;
}

afterEach(() => { vi.useRealTimers(); window.history.replaceState({}, '', '/'); });

describe('the workbench can show every local-engine state T23 draws', () => {
  it('a model that FAILED TO LOAD, so the red card in its settings is reviewable', async () => {
    const settings = await shimFor('/').models.settings('Qwen3.5-9B-Q8_0');
    expect(settings.lastLoadError).toBeTruthy();
    // A real llama-server line, not invented prose: the dialog quotes whatever
    // it is handed, so reviewing that card against a paraphrase reviews nothing.
    expect(settings.lastLoadError).toContain('not recognized in preset');
  });

  it('a size whose context memory is only a CEILING, so "up to" is reviewable', async () => {
    const rows = await shimFor('/').models.quants('unsloth/Qwen3.5-4B-GGUF');
    expect(rows.some((r: any) => r.fit.breakdown.contextBytesIsUpperBound === true)).toBe(true);
  });

  it('the advice line on every verdict that is not "fits" (R8)', async () => {
    const rows = await shimFor('/').models.quants('unsloth/Qwen3.5-4B-GGUF');
    for (const r of rows) {
      if (r.fit.fit === 'fits') expect(r.fit.breakdown.advice).toBeUndefined();
      else expect(r.fit.breakdown.advice).toBe("Lower this model's context length in its Settings to shrink this.");
    }
  });

  it('a save that is PENDING and then clears, which is what the dialog’s poll exists for', async () => {
    vi.useFakeTimers();
    const models = shimFor('/').models;
    const saved = await models.setSettings('Qwen3.5-9B-Q8_0', { keepLoaded: true });
    expect(saved.pendingApply).toBe(true);
    await vi.advanceTimersByTimeAsync(4100);
    expect((await models.settings('Qwen3.5-9B-Q8_0')).pendingApply).toBeUndefined();
  });

  it('an engine RUNNING WITHOUT each model’s settings, with the machine’s own reason', async () => {
    const status = await shimFor('/?scenario=refused').engine.status();
    // Only a running engine can be in this state at all.
    expect(status.state).toBe('running');
    expect(status.modelSettingsInForce).toBe(false);
    expect(status.modelSettingsError).toContain('EACCES');
  });

  it('…and the OTHER shape of that message, where no reason came back', async () => {
    // Two shapes that look nothing alike — an amber box quoting the machine, and
    // a grey block with two buttons and no quote. Signing off the first says
    // nothing about the second, so both have to be reachable.
    const status = await shimFor('/?scenario=refused&reason=none').engine.status();
    expect(status.modelSettingsInForce).toBe(false);
    expect(status.modelSettingsError).toBeNull();
  });

  it('the settings are in force everywhere else, and unanswered on a stopped engine', async () => {
    expect((await shimFor('/?scenario=stress').engine.status()).modelSettingsInForce).toBe(true);
    // `undefined`, never `false`: a stopped engine has no run to report on.
    expect((await shimFor('/').engine.status()).modelSettingsInForce).toBeUndefined();
  });

  it('a saved engine setting that has not landed yet — and a REAL status push that clears it', async () => {
    vi.useFakeTimers();
    const engine = shimFor('/').engine;
    const seen: any[] = [];
    const off = engine.onStatusChanged((s: any) => seen.push(s));
    // A no-op registrar (what this was before) leaves the card showing the
    // pending line for ever: the card learns the change landed ONLY from a push.
    expect(typeof off).toBe('function');
    const after = await engine.setConfig({ speed: { speculative: false } });
    expect(after.configApplyPending).toBe(true);
    await vi.advanceTimersByTimeAsync(4100);
    expect(seen).toHaveLength(1);
    expect(seen[0].configApplyPending).toBe(false);
    off();
  });

  it('an apply that FAILS, which is the only place its real message can be shown', async () => {
    vi.useFakeTimers();
    const engine = shimFor('/?scenario=refused').engine;
    expect((await engine.status()).configApplyError).toBeNull();
    await engine.setConfig({ speed: { compressCache: false } });
    await vi.advanceTimersByTimeAsync(4100);
    expect((await engine.status()).configApplyError).toContain('EACCES');
  });
});
