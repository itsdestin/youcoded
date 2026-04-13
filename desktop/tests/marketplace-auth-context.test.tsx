// @vitest-environment jsdom
// marketplace-auth-context.test.tsx
// Tests for the MarketplaceAuthProvider React context.
// Runs in jsdom so React DOM + document are available.
// Uses vi.useFakeTimers() so the poll setTimeout doesn't slow tests down.
// Uses a small pollIntervalMs (10ms) + real Promise.resolve() flushing via
// vi.runAllTimersAsync() to advance through the polling loop without sleeping.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import {
  MarketplaceAuthProvider,
  useMarketplaceAuth,
} from "../src/renderer/state/marketplace-auth-context";

// Simple probe component that renders current auth state
function Probe() {
  const { signedIn, startSignIn, user } = useMarketplaceAuth();
  return (
    <div>
      <span data-testid="state">{signedIn ? "in" : "out"}</span>
      <span data-testid="user">{user?.login ?? ""}</span>
      <button data-testid="go" onClick={() => void startSignIn()}>
        go
      </button>
    </div>
  );
}

// Helper — build a fresh mock and assign to globalThis.window.claude
function makeMock() {
  return {
    marketplaceAuth: {
      // start() returns ApiResult<AuthStartResponse>
      start: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          device_code: "d",
          user_code: "U",
          auth_url: "http://a",
          expires_in: 900,
        },
      }),
      // poll() returns ApiResult<AuthPollResponse>
      // First call → pending; second call → complete
      poll: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, value: { status: "pending" } })
        .mockResolvedValueOnce({
          ok: true,
          value: { status: "complete", token: "TOK" },
        }),
      // Plain returns (NOT wrapped in ApiResult):
      signedIn: vi
        .fn()
        .mockResolvedValueOnce(false) // initial refresh on mount
        .mockResolvedValue(true),     // after sign-in completes
      user: vi
        .fn()
        .mockResolvedValueOnce(null)  // initial refresh on mount
        .mockResolvedValue({ id: "github:1", login: "u", avatar_url: "http://a" }),
      signOut: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("MarketplaceAuthProvider", () => {
  beforeEach(() => {
    // Fake timers so setTimeout in the poll loop resolves instantly
    vi.useFakeTimers();
    // Assign a fresh mock before each test
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis as any).window.claude = makeMock();
  });

  afterEach(() => {
    // Clean up the rendered tree between tests (prevents element duplication)
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts as signed-out", async () => {
    const { getByTestId } = render(
      <MarketplaceAuthProvider pollIntervalMs={10}>
        <Probe />
      </MarketplaceAuthProvider>
    );

    // Let the initial refresh() promises resolve (signedIn + user calls)
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // After initial refresh, signedIn() returned false → state should be "out"
    expect(getByTestId("state").textContent).toBe("out");
  });

  it("transitions to signed-in after sign-in flow completes", async () => {
    const { getByTestId } = render(
      <MarketplaceAuthProvider pollIntervalMs={10}>
        <Probe />
      </MarketplaceAuthProvider>
    );

    // Wait for initial mount refresh to complete
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Confirm starts out
    expect(getByTestId("state").textContent).toBe("out");

    // Click the sign-in button — starts the device-code flow
    // start() resolves → poll loop begins
    await act(async () => {
      getByTestId("go").click();
      await vi.runAllTimersAsync();
    });

    // Advance through the poll loop:
    // Iteration 1: poll() → "pending" → setTimeout(r, 10ms) → tick
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Iteration 2: poll() → "complete" → refresh() → state updates
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // After "complete", refresh() called signedIn() → true and user() → user obj
    expect(getByTestId("state").textContent).toBe("in");
    expect(getByTestId("user").textContent).toBe("u");
  });
});
