// @vitest-environment jsdom
// Settings -> Account (AccountSection.tsx), wrapped in a real AccountProvider and driven through a mocked window.claude.account.
// The signed-in popup is a view/edit split: read-only summary by default, "Edit account" toggles the editors + danger zone in.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { AccountProvider } from "../src/renderer/state/account-context";
import AccountSection from "../src/renderer/components/AccountSection";

// ApiResult helpers matching the { ok, value } / { ok, status, message } union.
const ok = <T,>(value: T) => ({ ok: true as const, value });
const apiErr = (status: number, message = "nope") => ({ ok: false as const, status, message });

// Flush the provider's mount refresh() (signedIn() then user(): two microtask hops).
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Signed-out account mock: signedIn() → false, user() → null.
function signedOutMock() {
  return {
    account: {
      start: vi.fn(),
      poll: vi.fn(),
      signedIn: vi.fn().mockResolvedValue(false),
      user: vi.fn().mockResolvedValue(null),
      signOut: vi.fn().mockResolvedValue(undefined),
      updateProfile: vi.fn().mockResolvedValue({ ok: true }),
      setHandle: vi.fn().mockResolvedValue({ ok: true }),
      deleteAccount: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

// Signed-in account mock; `handle` covers both "has a handle" (change -> confirm) and "first handle" paths, `over` replaces exportData / social.* stubs.
function signedInMock(
  handle: string | null = "octo",
  over: { account?: Record<string, any>; social?: Record<string, any> } = {},
) {
  return {
    account: {
      start: vi.fn(),
      poll: vi.fn(),
      signedIn: vi.fn().mockResolvedValue(true),
      user: vi.fn().mockResolvedValue({
        id: "github:1",
        login: "octocat",
        avatar_url: "http://avatar",
        display_name: "Octo Cat",
        handle,
      }),
      signOut: vi.fn().mockResolvedValue(undefined),
      updateProfile: vi.fn().mockResolvedValue({ ok: true }),
      setHandle: vi.fn().mockResolvedValue({ ok: true }),
      deleteAccount: vi.fn().mockResolvedValue({ ok: true }),
      exportData: vi.fn().mockResolvedValue({ canceled: true }),
      ...over.account,
    },
    // SignedInBody fetches listBlocks() on mount; empty by default so the blocked-users section renders nothing.
    social: {
      listBlocks: vi.fn().mockResolvedValue(ok([])),
      unblock: vi.fn().mockResolvedValue(ok(undefined)),
      ...over.social,
    },
  };
}

// A blocked-user row shape (BlockRow = SocialUserCard + created_at).
const block = (over: Partial<{ id: string; display_name: string; handle: string | null }> = {}) => ({
  id: over.id ?? "github:9",
  display_name: over.display_name ?? "Blocky",
  handle: over.handle ?? "blocky",
  avatar_url: null,
  created_at: 0,
});

function renderSection() {
  return render(
    <AccountProvider pollIntervalMs={10}>
      <AccountSection />
    </AccountProvider>,
  );
}

// Open the settings row popup, then (optionally) enter edit mode.
async function openPopup(utils: ReturnType<typeof renderSection>, edit = false) {
  fireEvent.click(utils.getByRole("button", { name: /Account/i }));
  if (edit) {
    fireEvent.click(utils.getByRole("button", { name: "Edit account" }));
  }
}

/** Install the mock, render, flush the mount refresh and open the popup (optionally into edit mode). */
async function setup(mock: object, opts: { popup?: boolean; edit?: boolean } = {}) {
  (globalThis as any).window.claude = mock;
  const utils = renderSection();
  await flush();
  if (opts.popup !== false) await openPopup(utils, opts.edit);
  return utils;
}

describe("AccountSection", () => {
  beforeEach(() => {
    (globalThis as any).window = (globalThis as any).window ?? {};
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("signed out: shows a Sign in to YouCoded row", async () => {
    const utils = await setup(signedOutMock());
    expect(utils.getByText("Sign in to YouCoded")).toBeTruthy();
  });

  it("signed in: view mode is read-only — avatar, name, handle, provider row, sign out, Edit account", async () => {
    const utils = await setup(signedInMock());

    expect(utils.container.querySelector('img[src="http://avatar"]')).toBeTruthy();

    // Read-only identity: name + @handle as text, not inputs.
    expect(utils.getByText("Octo Cat")).toBeTruthy();
    expect(utils.getByText("@octo")).toBeTruthy();

    expect(utils.getByText(/Signs in with GitHub \(@octocat\)/)).toBeTruthy();

    // Sign out + the single edit affordance are present
    expect(utils.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(utils.getByRole("button", { name: "Edit account" })).toBeTruthy();

    // View mode has NO inputs and NO danger zone
    expect(utils.queryByLabelText("Display name")).toBeNull();
    expect(utils.queryByLabelText("Handle")).toBeNull();
    expect(utils.queryByRole("button", { name: "Delete account" })).toBeNull();
  });

  // WHY: the Account row must NEVER paint the browser's broken-image glyph; both slots (row icon and popup summary) swap to our person glyph.
  it("avatar that fails to load is replaced by the person glyph, in the row and the popup", async () => {
    (globalThis as any).window.claude = signedInMock();
    const utils = renderSection();
    await flush();

    // Row icon starts as the photo, then the load fails.
    const rowImg = utils.container.querySelector('img[src="http://avatar"]') as HTMLImageElement;
    expect(rowImg).toBeTruthy();
    await act(async () => {
      fireEvent.error(rowImg);
    });
    expect(utils.container.querySelector('img[src="http://avatar"]')).toBeNull();
    expect(utils.container.querySelector("svg")).toBeTruthy();

    // Same guard inside the popup's identity summary.
    await openPopup(utils);
    const popupImg = document.body.querySelector('img[src="http://avatar"]') as HTMLImageElement;
    expect(popupImg).toBeTruthy();
    await act(async () => {
      fireEvent.error(popupImg);
    });
    expect(document.body.querySelector('img[src="http://avatar"]')).toBeNull();
  });

  // WHY: a browser never re-requests a src it already failed on, so a launch-time network race would strand the glyph all session; two timed retries cover that and the third failure stops (no loop offline).
  it("a failed avatar retries on a timer twice, then stops", async () => {
    vi.useFakeTimers();
    try {
      (globalThis as any).window.claude = signedInMock();
      const utils = renderSection();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const fail = async () => {
        const img = utils.container.querySelector('img[src="http://avatar"]') as HTMLImageElement;
        expect(img).toBeTruthy();
        await act(async () => {
          fireEvent.error(img);
        });
        expect(utils.container.querySelector('img[src="http://avatar"]')).toBeNull();
      };

      // First failure → retried 5s later.
      await fail();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      // Second failure → retried 10s later.
      await fail();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      // Third failure exhausts the timed budget — no further automatic retry.
      await fail();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(utils.container.querySelector('img[src="http://avatar"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // WHY: Settings stays mounted while closed, so without a focus retry the glyph would outlive an outage until restart.
  it("a failed avatar is retried when the window regains focus", async () => {
    (globalThis as any).window.claude = signedInMock();
    const utils = renderSection();
    await flush();

    const rowImg = utils.container.querySelector('img[src="http://avatar"]') as HTMLImageElement;
    await act(async () => {
      fireEvent.error(rowImg);
    });
    expect(utils.container.querySelector('img[src="http://avatar"]')).toBeNull();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(utils.container.querySelector('img[src="http://avatar"]')).toBeTruthy();
  });

  it("Edit account reveals the editors + danger zone; Done returns to view mode", async () => {
    const utils = await setup(signedInMock(), { edit: true });

    // Editors seeded from the profile
    expect((utils.getByLabelText("Display name") as HTMLInputElement).value).toBe("Octo Cat");
    expect((utils.getByLabelText("Handle") as HTMLInputElement).value).toBe("octo");

    // Danger zone lives in edit mode
    expect(utils.getByRole("button", { name: "Delete account" })).toBeTruthy();

    // Done returns to the read-only view
    fireEvent.click(utils.getByRole("button", { name: "Done" }));
    expect(utils.queryByLabelText("Display name")).toBeNull();
    expect(utils.getByRole("button", { name: "Edit account" })).toBeTruthy();
  });

  it("changing an existing handle requires the inline confirm step before setHandle is called", async () => {
    const mock = signedInMock("octo");
    const utils = await setup(mock, { edit: true });

    fireEvent.change(utils.getByLabelText("Handle"), { target: { value: "newname" } });
    fireEvent.click(utils.getByRole("button", { name: "Save handle" }));

    // Save did NOT commit — it opened the consequences warning instead.
    expect(mock.account.setHandle).not.toHaveBeenCalled();
    expect(utils.getByText(/frees @octo for anyone else to claim after 30 days/)).toBeTruthy();

    // Explicit confirm commits the change.
    fireEvent.click(utils.getByRole("button", { name: "Confirm change" }));
    await flush();
    expect(mock.account.setHandle).toHaveBeenCalledWith("newname");
  });

  it("cancelling the handle confirm step does not call setHandle", async () => {
    const mock = signedInMock("octo");
    const utils = await setup(mock, { edit: true });

    fireEvent.change(utils.getByLabelText("Handle"), { target: { value: "newname" } });
    fireEvent.click(utils.getByRole("button", { name: "Save handle" }));
    fireEvent.click(utils.getByRole("button", { name: "Cancel handle change" }));
    await flush();

    expect(mock.account.setHandle).not.toHaveBeenCalled();
    // Warning gone; Save affordance back.
    expect(utils.queryByText(/frees @octo/)).toBeNull();
    expect(utils.getByRole("button", { name: "Save handle" })).toBeTruthy();
  });

  it("first-time handle set commits directly with no confirm step", async () => {
    const mock = signedInMock(null); // no existing handle → nothing to lose
    (globalThis as any).window.claude = mock;
    const utils = renderSection();
    await flush();
    await openPopup(utils, true);

    fireEvent.change(utils.getByLabelText("Handle"), { target: { value: "fresh" } });
    fireEvent.click(utils.getByRole("button", { name: "Save handle" }));
    await flush();

    expect(mock.account.setHandle).toHaveBeenCalledWith("fresh");
  });

  it("delete requires typing the confirmation word before the button enables", async () => {
    const utils = await setup(signedInMock(), { edit: true });

    // Expand the danger zone (step 1 of 2).
    fireEvent.click(utils.getByRole("button", { name: "Delete account" }));

    const confirmBtn = utils.getByRole("button", {
      name: "Delete my account",
    }) as HTMLButtonElement;
    // Disabled until the confirmation word matches (step 2 of 2).
    expect(confirmBtn.disabled).toBe(true);

    const confirmInput = utils.getByLabelText("Type delete to confirm") as HTMLInputElement;
    fireEvent.change(confirmInput, { target: { value: "delete" } });

    expect(confirmBtn.disabled).toBe(false);
  });

  // ── Blocked users (view mode) ──────────────────────────────────────────────

  it("blocked users: renders a row per block with @handle when the list is non-empty", async () => {
    const utils = await setup(signedInMock("octo", {
      social: { listBlocks: vi.fn().mockResolvedValue(ok([block()])) },
    }));

    // Wait for the mount-time listBlocks() to populate the section.
    await waitFor(() => expect(utils.getByText("Blocked users")).toBeTruthy());
    expect(utils.getByText("Blocky")).toBeTruthy();
    expect(utils.getByText("@blocky")).toBeTruthy();
    expect(utils.getByRole("button", { name: "Unblock" })).toBeTruthy();
  });

  it("blocked users: renders nothing when the block list is empty", async () => {
    // signedInMock defaults listBlocks → ok([]).
    const utils = await setup(signedInMock());
    await flush();

    expect(utils.queryByText("Blocked users")).toBeNull();
    expect(utils.queryByRole("button", { name: "Unblock" })).toBeNull();
  });

  it("Unblock calls unblock(id) then refetches the list", async () => {
    const listBlocks = vi
      .fn()
      // First load has one block; after unblock the refetch returns empty.
      .mockResolvedValueOnce(ok([block({ id: "github:9", display_name: "Blocky", handle: "blocky" })]))
      .mockResolvedValueOnce(ok([]));
    const unblock = vi.fn().mockResolvedValue(ok(undefined));
    const utils = await setup(signedInMock("octo", { social: { listBlocks, unblock } }));

    const unblockBtn = await waitFor(() => utils.getByRole("button", { name: "Unblock" }));
    fireEvent.click(unblockBtn);

    await waitFor(() => expect(unblock).toHaveBeenCalledWith("github:9"));
    // Refetch ran (2nd call) and the now-empty list removes the section.
    await waitFor(() => expect(listBlocks).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(utils.queryByText("Blocked users")).toBeNull());
  });

  it("Unblock surfaces a row error on failure", async () => {
    const listBlocks = vi
      .fn()
      .mockResolvedValue(ok([block({ id: "github:9", display_name: "Blocky", handle: "blocky" })]));
    const unblock = vi.fn().mockResolvedValue(apiErr(500, "server exploded"));
    const utils = await setup(signedInMock("octo", { social: { listBlocks, unblock } }));

    const unblockBtn = await waitFor(() => utils.getByRole("button", { name: "Unblock" }));
    fireEvent.click(unblockBtn);

    await waitFor(() => expect(utils.getByText("server exploded")).toBeTruthy());
    // Row still present (unblock failed).
    expect(utils.getByText("Blocky")).toBeTruthy();
  });

  // ── Download my data (view mode) ───────────────────────────────────────────

  it("Download my data: shows the saved path on success", async () => {
    const exportData = vi.fn().mockResolvedValue({ path: "C:/Users/me/youcoded-export.json" });
    const utils = await setup(signedInMock("octo", { account: { exportData } }));

    fireEvent.click(utils.getByRole("button", { name: "Download my data" }));
    await waitFor(() =>
      expect(utils.getByText("Saved to C:/Users/me/youcoded-export.json")).toBeTruthy(),
    );
    expect(exportData).toHaveBeenCalledTimes(1);
  });

  it("Download my data: shows the server error verbatim on failure", async () => {
    const exportData = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 400, error: "export requires Android 10+" });
    const utils = await setup(signedInMock("octo", { account: { exportData } }));

    fireEvent.click(utils.getByRole("button", { name: "Download my data" }));
    await waitFor(() => expect(utils.getByText("export requires Android 10+")).toBeTruthy());
  });

  it("Download my data: a canceled export shows neither a saved path nor an error", async () => {
    const exportData = vi.fn().mockResolvedValue({ canceled: true });
    const utils = await setup(signedInMock("octo", { account: { exportData } }));

    fireEvent.click(utils.getByRole("button", { name: "Download my data" }));
    await flush();

    expect(exportData).toHaveBeenCalledTimes(1);
    expect(utils.queryByText(/Saved to/)).toBeNull();
    // No red error line either.
    expect(utils.container.querySelector(".text-red-500")).toBeNull();
  });
});
