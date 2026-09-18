// @vitest-environment jsdom
// local-engine-fields-rendered.test.tsx — the engine card's share of the text
// main computes and the screens did not draw. (The Local Models row's share
// lives in LocalModelsSection.test.tsx.)
//
// WHY THIS FILE EXISTS. Every field below was already being produced by the
// backend and thrown away by the renderer, which is invisible in every other
// kind of test: types pass, main's own tests pass, and the user simply never
// finds out. Each guard therefore comes in a PAIR — the text appears when the
// field is set, and it is ABSENT when the field is not there at all.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act, screen, waitFor } from '@testing-library/react';
import EngineCard from '../src/renderer/components/EngineCard';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });


// ── The engine card ──────────────────────────────────────────────────────────

const RUNNING = {
  installed: true, installedVersion: 'b10665', pinnedVersion: 'b10665',
  backend: 'vulkan', state: 'running' as const, cacheDir: '/cache', contextSize: 32768,
  speed: { speculative: true, compressCache: true },
};

function mountEngine(status: Record<string, unknown>) {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = {
    engine: {
      status: vi.fn(async () => status),
      install: vi.fn(async () => status),
      restart: vi.fn(async () => status),
      setContext: vi.fn(async () => status),
      setConfig: vi.fn(async () => status),
      onInstallProgress: vi.fn(() => () => {}),
      onStatusChanged: vi.fn(() => () => {}),
    },
    models: { setBackend: vi.fn(async () => {}) },
  };
}

/** Render the card with its details and open Advanced, where the settings live. */
async function renderAdvanced(status: Record<string, unknown>) {
  mountEngine(status);
  render(<EngineCard showDetails />);
  await waitFor(() => expect(screen.getByText('Advanced')).toBeTruthy());
  await act(async () => { fireEvent.click(screen.getByText('Advanced')); });
  await waitFor(() => expect(screen.getByTestId('engine-advanced')).toBeTruthy());
}

const NOT_IN_FORCE = 'Each model’s own settings are off right now';
const OS_ERROR = "EACCES: permission denied, open '/home/d/.youcoded/engine/models.ini'";

describe('the engine card', () => {
  it('T7: says per-model settings are off, and QUOTES the reason it was given', async () => {
    mountEngine({ ...RUNNING, modelSettingsInForce: false, modelSettingsError: OS_ERROR });
    render(<EngineCard showDetails />);
    await waitFor(() => expect(screen.getByText(NOT_IN_FORCE)).toBeTruthy());
    // Both sentences, not just a fragment: what is happening, and that it is not
    // permanent. Deleting either one left every other assertion true.
    expect(screen.getByText(/Every model is running on the engine’s own settings\./)).toBeTruthy();
    expect(screen.getByText(/It tries again the next time the engine starts\./)).toBeTruthy();
    // The OS's own words. `engine-supervisor.ts` used to throw this away in a
    // bare catch, which left the card able to say only "something went wrong".
    const cause = screen.getByText(OS_ERROR);
    expect(cause).toBeTruthy();
    expect(cause.className).toContain('break-words');
    // A cause we HAVE is the specific+accurate shape — no Report bug / Diagnose.
    expect(screen.queryByText('Diagnose with the assistant')).toBeNull();
  });

  it('T7: with NO reason available, stays non-committal and offers the two standard actions', async () => {
    // docs/error-message-standards.md: general is allowed, general with an
    // invented cause is not — and a general message with no next step is not
    // either.
    mountEngine({ ...RUNNING, modelSettingsInForce: false, modelSettingsError: null });
    render(<EngineCard showDetails />);
    await waitFor(() => expect(screen.getByText(NOT_IN_FORCE)).toBeTruthy());
    expect(screen.getByText('Report bug')).toBeTruthy();
    expect(screen.getByText('Diagnose with the assistant')).toBeTruthy();
    expect(screen.getByText(/gave no reason we can show you/)).toBeTruthy();
  });

  it('T7: the two actions on the no-reason message actually DO something', async () => {
    // Wired to nothing, this is a general error with no next step — which the
    // standard disallows just as firmly as an invented cause. Making
    // "Diagnose with the assistant" a no-op left every other assertion green.
    mountEngine({ ...RUNNING, modelSettingsInForce: false, modelSettingsError: null });
    render(<EngineCard showDetails />);
    await waitFor(() => expect(screen.getByText('Diagnose with the assistant')).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByText('Diagnose with the assistant')); });
    // The app's one bug-report surface opens — its own dialog title, which
    // nothing else on this card renders. Renamed 2026-09-10 when the approved
    // screen replaced the legacy one for every user: one heading, both kinds.
    await waitFor(() => expect(screen.getByText('Submit a ticket')).toBeTruthy());
  });

  it('T7: the message is NOT hidden behind the expanded details panel', async () => {
    // `showDetails` is false wherever the card sits outside Local models. Gated
    // on it, this message would never reach anyone who does not open that panel
    // — and it is about their models being silently ignored.
    mountEngine({ ...RUNNING, modelSettingsInForce: false, modelSettingsError: OS_ERROR });
    render(<EngineCard />);
    await waitFor(() => expect(screen.getByText(NOT_IN_FORCE)).toBeTruthy());
    expect(screen.getByText(OS_ERROR)).toBeTruthy();
    // …and the details really are collapsed, so this is not a false pass.
    expect(screen.queryByText('Advanced')).toBeNull();
  });

  it('T7: says nothing when those settings ARE in force', async () => {
    mountEngine({ ...RUNNING, modelSettingsInForce: true });
    render(<EngineCard showDetails />);
    await waitFor(() => expect(screen.getByText('Advanced')).toBeTruthy());
    expect(screen.queryByText(NOT_IN_FORCE)).toBeNull();
  });

  it('T7: says nothing when the engine is not running', async () => {
    // `undefined` is not `false`.
    mountEngine({ ...RUNNING, state: 'stopped' as const });
    render(<EngineCard showDetails />);
    await waitFor(() => expect(screen.getByText('Advanced')).toBeTruthy());
    expect(screen.queryByText(NOT_IN_FORCE)).toBeNull();
  });

  it('T7: says nothing when the engine IS running but the field is absent', async () => {
    // The hazard the three-state field was designed around, and the one case
    // the first version of these tests missed: written as `state === 'running'
    // && !modelSettingsInForce`, everything else here still passed. A remote or
    // Android client on an older desktop is exactly this — running, no answer —
    // and every one of those users would be told their settings are ignored.
    const { modelSettingsInForce, ...noAnswer } = { ...RUNNING, modelSettingsInForce: true };
    mountEngine(noAnswer);
    render(<EngineCard showDetails />);
    await waitFor(() => expect(screen.getByText('Advanced')).toBeTruthy());
    expect(screen.queryByText(NOT_IN_FORCE)).toBeNull();
    expect(screen.queryByText('Diagnose with the assistant')).toBeNull();
  });

  it('says a saved setting waits for the reply on screen', async () => {
    await renderAdvanced({ ...RUNNING, configApplyPending: true, configApplyWaitingForReply: true });
    expect(screen.getByTestId('engine-apply-pending').textContent).toContain('Applies after the current reply.');
  });

  it('does NOT blame a reply when the machine is idle', async () => {
    // `configApplyPending` is true from the moment a change is queued, including
    // a restart on a machine with nothing running — where the change lands a
    // poll interval later and there is no reply anywhere in sight.
    await renderAdvanced({ ...RUNNING, configApplyPending: true, configApplyWaitingForReply: false });
    const line = screen.getByTestId('engine-apply-pending').textContent ?? '';
    expect(line).toContain('Applying now');
    expect(line).not.toContain('current reply');
  });

  it('says nothing about waiting when nothing is pending', async () => {
    await renderAdvanced(RUNNING);
    expect(screen.queryByTestId('engine-apply-pending')).toBeNull();
  });

  it('shows the REAL failure when applying a saved setting went wrong', async () => {
    await renderAdvanced({ ...RUNNING, configApplyError: 'EACCES: permission denied, open ’/home/d/.youcoded/engine/models.ini’' });
    expect(screen.getByText(/EACCES: permission denied/)).toBeTruthy();
  });

  it('shows no failure line when applying went fine', async () => {
    await renderAdvanced({ ...RUNNING, configApplyError: null });
    expect(screen.queryByText(/EACCES/)).toBeNull();
  });

  it('draws the speed switches from the status, and NOT from a copy of the defaults', async () => {
    // The card used to fall back to a hardcoded { speculative: true,
    // compressCache: true } — a third copy of a default written down twice in
    // main. It is gone: a status with no `speed` now shows no switches rather
    // than two switches asserting an ON state nobody reported.
    await renderAdvanced({ ...RUNNING, speed: { speculative: false, compressCache: true } });
    expect(screen.getByLabelText('Speculative decoding').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByLabelText('Compress context memory').getAttribute('aria-checked')).toBe('true');

    cleanup();
    const { speed, ...noSpeed } = RUNNING;
    await renderAdvanced(noSpeed);
    expect(screen.queryByLabelText('Speculative decoding')).toBeNull();
    expect(screen.queryByLabelText('Compress context memory')).toBeNull();
  });
});

// T25 (2026-09-06). ROCm shipped as "Switch to ROCm (faster on AMD)", pushed at
// every AMD machine from the card body. Measuring it (engine b10665, AMD Strix
// Halo / Radeon 8060S, Qwen3.5-9B Q8 + Qwen3.8-27B Q8, 200 forced tokens,
// non-repeating prompt, speculation off) found it read prompts ~20% faster and
// WROTE replies 24–46% slower than the Vulkan build it replaces — so most of
// the people it was sold to would have got a slower assistant. Destin's call:
// keep it, hide it as a power-user option, do not recommend it as CUDA is.
//
// These are a PAIR on purpose. Demoting the row without rewriting its words
// would still promise a speed-up in a quieter place; rewording it without
// moving it would still push it at everyone.
describe('T25: which engine builds the card pushes, and which it merely offers', () => {
  afterEach(() => { cleanup(); });

  const ROCM = { backend: 'rocm', label: 'Try ROCm (AMD) — reads faster, writes slower', state: 'ready' as const };
  const CUDA = { backend: 'cuda', label: 'Switch to CUDA (faster on NVIDIA)', state: 'ready' as const };

  it('ROCm is not in the card body at all — it is inside Advanced, which is shut', async () => {
    mountEngine({ ...RUNNING, backendOptions: [ROCM] });
    render(<EngineCard showDetails />);
    await waitFor(() => expect(screen.getByText('Advanced')).toBeTruthy());
    expect(screen.queryByText(/Optional engine for your AMD chip/)).toBeNull();
    // Not merely invisible: the whole Advanced section is unrendered.
    expect(screen.queryByTestId('engine-advanced')).toBeNull();

    await act(async () => { fireEvent.click(screen.getByText('Advanced')); });
    const row = await screen.findByText(/Optional engine for your AMD chip/);
    expect(screen.getByTestId('engine-advanced').contains(row)).toBe(true);
  });

  it('and its words describe the trade, never a speed-up', async () => {
    await renderAdvanced({ ...RUNNING, backendOptions: [ROCM] });
    const words = screen.getByTestId('engine-advanced').textContent ?? '';
    expect(words).toMatch(/Not recommended/);
    expect(words).toMatch(/writes its reply more slowly than Vulkan/);
    // The claim that was measured false, in either of its spellings.
    expect(words).not.toMatch(/much faster than Vulkan/);
    expect(words).not.toMatch(/faster on AMD/);
  });

  it('CUDA keeps the card body and keeps its recommendation', async () => {
    mountEngine({ ...RUNNING, backendOptions: [CUDA] });
    render(<EngineCard showDetails />);
    // Present WITHOUT opening Advanced — this is the prominence ROCm lost.
    await waitFor(() => expect(screen.getByText(/Faster engine for your NVIDIA chip/)).toBeTruthy());
    expect(screen.getByText(/CUDA \(NVIDIA\) is usually much faster than Vulkan/)).toBeTruthy();
    expect(screen.queryByTestId('engine-advanced')).toBeNull();
  });
});
