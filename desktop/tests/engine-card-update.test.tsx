// @vitest-environment jsdom
// engine-card-update.test.tsx
// Pins the ONLY route an already-installed engine has to a newer pinned build.
//
// WHY this test exists (2026-08-27): bumping ENGINE_VERSION upgrades nobody on
// its own. EngineAcquisition.installed() falls back to any complete install it
// finds, so an existing b-number keeps serving forever, and the "Install" button
// is hidden the moment ANY engine is present. A user whose model needs a newer
// llama.cpp (qwen4exp did) had no way to get one from the UI. If this test goes
// red, a pin bump has silently become a no-op again.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, waitFor, fireEvent } from '@testing-library/react';
import EngineCard from '../src/renderer/components/EngineCard';

function mountClaude(status: Record<string, unknown>, install = vi.fn(async () => status)) {
  (globalThis as any).window.claude = {
    engine: {
      status: vi.fn(async () => status),
      install,
      restart: vi.fn(async () => status),
      onInstallProgress: vi.fn(() => () => {}),
      onStatusChanged: vi.fn(() => () => {}),
    },
    models: { setBackend: vi.fn(async () => {}) },
  };
  return install;
}

const installed = (version: string, pinned: string) => ({
  installed: true,
  installedVersion: version,
  pinnedVersion: pinned,
  backend: 'vulkan',
  state: 'stopped' as const,
  cacheDir: '/cache',
  contextSize: 32768,
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('EngineCard — engine update route', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('offers Update when the installed engine is older than the pinned one', async () => {
    mountClaude(installed('b9992', 'b10665'));
    const { getByText } = render(<EngineCard />);
    await flush();
    await waitFor(() => expect(getByText('Update')).toBeTruthy());
    // The copy must say what the update is FOR — a bare version number tells a
    // non-developer nothing about whether they need it.
    expect(getByText(/won't load/i)).toBeTruthy();
  });

  it('Update calls engine.install(), which fetches the PINNED build', async () => {
    const install = mountClaude(installed('b9992', 'b10665'));
    const { getByText } = render(<EngineCard />);
    await flush();
    await waitFor(() => expect(getByText('Update')).toBeTruthy());
    await act(async () => { fireEvent.click(getByText('Update')); });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('offers nothing when the installed engine already matches the pin', async () => {
    mountClaude(installed('b10665', 'b10665'));
    const { queryByText } = render(<EngineCard />);
    await flush();
    expect(queryByText('Update')).toBeNull();
    expect(queryByText('Install')).toBeNull();
  });

  it('still shows Install — not Update — when nothing is installed', async () => {
    mountClaude({
      installed: false, installedVersion: null, pinnedVersion: 'b10665',
      backend: null, state: 'not-installed' as const, cacheDir: '/cache', contextSize: 32768,
    });
    const { getByText, queryByText } = render(<EngineCard />);
    await flush();
    await waitFor(() => expect(getByText('Install')).toBeTruthy());
    expect(queryByText('Update')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T19 — the fact line's two live numbers.
// ---------------------------------------------------------------------------
describe('EngineCard — the live hardware fact line', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  const running = (extra: Record<string, unknown>) => ({
    installed: true,
    installedVersion: 'b10665',
    pinnedVersion: 'b10665',
    backend: 'vulkan',
    state: 'running' as const,
    cacheDir: '/cache',
    contextSize: 32768,
    ...extra,
  });

  async function line(status: Record<string, unknown>) {
    mountClaude(status);
    const { container } = render(<EngineCard />);
    await flush();
    return container.textContent ?? '';
  }

  it('shows both rates from a real b10665 reading, rounded', async () => {
    // The captured b10665 numbers: 84.057… reading, 37.821… writing.
    expect(await line(running({
      deviceName: 'AMD Radeon 8060S Graphics',
      loadedModelsBytes: 9_527_502_048,
      lastReply: { promptPerSecond: 84.05715886803026, generatePerSecond: 37.821109441135555 },
    }))).toContain('8.9 GB loaded · last reply 84 read / 38 write per second');
  });

  it('shows the write rate alone when the prompt came out of the cache', async () => {
    // A fully-cached prompt has no reading work to time. The card must not
    // print "0 read", and must not drop the write rate it does have.
    const text = await line(running({ lastReply: { generatePerSecond: 37.821109441135555 } }));
    expect(text).toContain('last reply 38 write per second');
    expect(text).not.toContain('read');
    expect(text).not.toContain('NaN');
  });

  it('says nothing about speed or memory before either has been measured', async () => {
    // Absent, not zero: no reply has been sent and the engine has not been
    // polled, so the card must not assert "nothing loaded" or a speed.
    const text = await line(running({}));
    expect(text).not.toContain('last reply');
    expect(text).not.toContain('nothing loaded');
  });

  it('says "nothing loaded" only when the engine was actually asked', async () => {
    expect(await line(running({ loadedModelsBytes: 0 }))).toContain('nothing loaded');
  });
});

// The refusal sentences main writes for a rejected engine switch are the whole
// point of the device check (design §A4) — and Electron wraps every rejected
// invoke as `Error invoking remote method '<channel>': Error: <the real
// message>`. A non-developer cannot read past that prefix, so it must never
// reach the card.
describe('EngineCard — what a rejected switch actually reads like', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  const REFUSAL = 'Kept the current engine: the ROCm build found no graphics chip it can use '
    + '— it reported: llvmpipe (LLVM 22.1.6, 256 bits). Nothing was changed.';

  it('strips the IPC wrapper off a refused switch, leaving the sentence alone', async () => {
    const status = {
      ...installed('b10665', 'b10665'),
      backendOptions: [{ backend: 'rocm', label: 'Try ROCm (AMD) — reads faster, writes slower', state: 'ready' }],
    };
    (globalThis as any).window.claude = {
      engine: {
        status: vi.fn(async () => status),
        install: vi.fn(async () => status),
        restart: vi.fn(async () => status),
        onInstallProgress: vi.fn(() => () => {}),
        onStatusChanged: vi.fn(() => () => {}),
      },
      models: {
        setBackend: vi.fn(async () => {
          throw new Error(`Error invoking remote method 'engine:set-backend': Error: ${REFUSAL}`);
        }),
      },
    };
    const { getByText, queryByText } = render(<EngineCard showDetails />);
    await flush();
    // ROCm is an OPTIONAL build as of 2026-09-06 and sits inside Advanced, which
    // is shut by default — so the row has to be opened before it can be clicked.
    await waitFor(() => expect(getByText('Advanced')).toBeTruthy());
    await act(async () => { fireEvent.click(getByText('Advanced')); });
    await waitFor(() => expect(getByText('Switch')).toBeTruthy());
    await act(async () => { fireEvent.click(getByText('Switch')); });
    await waitFor(() => expect(getByText(REFUSAL)).toBeTruthy());
    // Asserted as an absence too: a substring match on the sentence would pass
    // with the whole wrapper still glued to the front of it.
    expect(queryByText(/invoking remote method/)).toBeNull();
  });
});
