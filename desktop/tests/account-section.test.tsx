// @vitest-environment jsdom
// account-section.test.tsx
// Render tests for the Settings → Account section (AccountSection.tsx).
// Follows the same provider/mock conventions as account-context.test.tsx:
// AccountSection reads state via useAccount(), so we wrap it in a real
// AccountProvider and drive state through a mocked window.claude.account.
//
// The signed-in popup is a view/edit split (2026-07-08 UX rework): read-only
// summary by default, "Edit account" toggles the editors + danger zone in.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { AccountProvider } from "../src/renderer/state/account-context";
import AccountSection from "../src/renderer/components/AccountSection";

// ApiResult helpers matching the { ok, value } / { ok, status, message } union.
const ok = <T,>(value: T) => ({ ok: true as const, value });
const apiErr = (status: number, message = "nope") => ({ ok: false as const, status, message });

// Flush the provider's mount refresh() — it awaits signedIn() then user()
// (two sequential microtask hops), so we drain the microtask queue a few times.
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

// Signed-in account mock. handle is parameterized so tests can cover both the
// "has a handle already" (change → confirm) and "first handle" (no confirm) paths.
// `over` lets a test replace the account.exportData or social.* stubs used by the
// blocked-users + data-export surfaces (Task 9).
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
      // Default: user cancels the save dialog (no-op).
      exportData: vi.fn().mockResolvedValue({ canceled: true }),
      ...over.account,
    },
    // SignedInBody fetches listBlocks() on mount — an empty list by default so
    // the blocked-users section renders nothing.
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

describe("AccountSection", () => {
  beforeEach(() => {
    (globalThis as any).window = (globalThis as any).window ?? {};
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("signed out: shows a Sign in to YouCoded row", async () => {
    (globalThis as any).window.claude = signedOutMock();
    const utils = renderSection();
    await flush();

    // Open the Account popup from the settings row.
    fireEvent.click(utils.getByRole("button", { name: /Account/i }));

    // Signed-out popup surfaces the GitHub sign-in button.
    // "Sign in to YouCoded", never "with GitHub" — the mechanism small print
    // owns the GitHub mention (2026-07-22 two-GitHubs fix). PINNED copy.
    expect(utils.getByText("Sign in to YouCoded")).toBeTruthy();
  });

  it("signed in: view mode is read-only — avatar, name, handle, provider row, sign out, Edit account", async () => {
    (globalThis as any).window.claude = signedInMock();
    const utils = renderSection();
    await flush();
    await openPopup(utils);

    // Avatar image rendered from user.avatar_url
    expect(utils.container.querySelector('img[src="http://avatar"]')).toBeTruthy();

    // Read-only identity: display name + @handle as text, not inputs
    expect(utils.getByText("Octo Cat")).toBeTruthy();
    expect(utils.getByText("@octo")).toBeTruthy();

    // Connected-provider row shows the GitHub login
    // "Signs in with", NOT "Connected:" — that word belongs to the
    // Connected-accounts (repo access) page. PINNED copy.
    expect(utils.getByText(/Signs in with GitHub \(@octocat\)/)).toBeTruthy();

    // Sign out + the single edit affordance are present
    expect(utils.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(utils.getByRole("button", { name: "Edit account" })).toBeTruthy();

    // View mode has NO inputs and NO danger zone
    expect(utils.queryByLabelText("Display name")).toBeNull();
    expect(utils.queryByLabelText("Handle")).toBeNull();
    expect(utils.queryByRole("button", { name: "Delete account" })).toBeNull();
    // Sign out everywhere is a destructive action, so it lives one level down with Delete account
    // (Destin, 2026-11-02), not on this page.
    expect(utils.queryByRole("button", { name: "Sign out everywhere" })).toBeNull();
    expect(utils.queryByText("Lost a device?")).toBeNull();
  });

  // The Account row must NEVER paint the browser's broken-image glyph. Before the
  // fix the <img> had no onError, so an unreachable avatar CDN left a broken-image
  // placeholder sitting in Settings. Both slots (the row icon and the popup's
  // identity summary) must swap to our own person glyph instead.
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

  // The row's <img> is created at app start and a browser never re-requests a src
  // it already failed on, so a launch-time network race would strand the glyph for
  // the whole session with no user action to trigger a retry. Two timed retries
  // cover that; the third failure stops, so an offline machine isn't looping.
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

  // A photo that failed during an outage must come back on its own — Settings
  // stays mounted while closed, so without the retry the glyph would outlive the
  // outage until the app restarted.
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
    (globalThis as any).window.claude = signedInMock();
    const utils = renderSection();
    await flush();
    await openPopup(utils, true);

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
    (globalThis as any).window.claude = mock;
    const utils = renderSection();
    await flush();
    await openPopup(utils, true);

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
    (globalThis as any).window.claude = mock;
    const utils = renderSection();
    await flush();
    await openPopup(utils, true);

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
    (globalThis as any).window.claude = signedInMock();
    const utils = renderSection();
    await flush();
    await openPopup(utils, true);

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

  // Sign out everywhere: the same two-step as Delete account, in the Danger zone on Edit account.
  it("sign out everywhere: red button in the Danger zone, facts + Cancel / confirm after pressing", async () => {
    const signOutAll = vi.fn().mockResolvedValue({ ok: true });
    (globalThis as any).window.claude = signedInMock("octo", { account: { signOutAll } });
    const utils = renderSection();
    await flush();
    await openPopup(utils, true);

    // Nothing happens, and the facts are not shown, until the button is pressed.
    expect(utils.queryByText(/every device, this one too/)).toBeNull();
    fireEvent.click(utils.getByRole("button", { name: "Sign out everywhere" }));
    expect(utils.getByText("Signs out every device, this one too.")).toBeTruthy();
    // Only the confirm that is open shows: Delete account is hidden until Cancel.
    expect(utils.queryByRole("button", { name: "Delete account" })).toBeNull();
    expect(signOutAll).not.toHaveBeenCalled();

    // Cancel puts the single button back.
    fireEvent.click(utils.getByRole("button", { name: "Cancel" }));
    expect(utils.queryByText(/every device, this one too/)).toBeNull();
    expect(utils.getByRole("button", { name: "Delete account" })).toBeTruthy();

    // Confirming ends every sign-in, then this window's own.
    fireEvent.click(utils.getByRole("button", { name: "Sign out everywhere" }));
    fireEvent.click(utils.getAllByRole("button", { name: "Sign out everywhere" })[0]);
    await waitFor(() => expect(signOutAll).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((globalThis as any).window.claude.account.signOut).toHaveBeenCalled());
  });

  it("sign out everywhere: when the server cannot be reached nothing changes and it says so", async () => {
    const signOutAll = vi.fn().mockResolvedValue({ ok: false, status: 0 });
    (globalThis as any).window.claude = signedInMock("octo", { account: { signOutAll } });
    const utils = renderSection();
    await flush();
    await openPopup(utils, true);
    fireEvent.click(utils.getByRole("button", { name: "Sign out everywhere" }));
    fireEvent.click(utils.getAllByRole("button", { name: "Sign out everywhere" })[0]);
    await waitFor(() => expect(utils.getByText(/nothing changed/)).toBeTruthy());
    expect((globalThis as any).window.claude.account.signOut).not.toHaveBeenCalled();
  });

  // ── Blocked users (view mode) ──────────────────────────────────────────────

  it("blocked users: renders a row per block with @handle when the list is non-empty", async () => {
    (globalThis as any).window.claude = signedInMock("octo", {
      social: {
        listBlocks: vi
          .fn()
          .mockResolvedValue(ok([block({ id: "github:9", display_name: "Blocky", handle: "blocky" })])),
        unblock: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const utils = renderSection();
    await flush();
    await openPopup(utils);

    // Wait for the mount-time listBlocks() to populate the section.
    await waitFor(() => expect(utils.getByText("Blocked users")).toBeTruthy());
    expect(utils.getByText("Blocky")).toBeTruthy();
    expect(utils.getByText("@blocky")).toBeTruthy();
    expect(utils.getByRole("button", { name: "Unblock" })).toBeTruthy();
  });

  // WHY (error inventory 2026-09-10, Settings row 86): a failed read used to hide the section, so
  // someone who HAD blocked people saw nothing - the same as having blocked no one.
  it("blocked users: a failed read says so, with the reason and Try again, and Try again re-asks", async () => {
    const listBlocks = vi
      .fn()
      .mockResolvedValueOnce(apiErr(503, "the server is busy"))
      .mockResolvedValue(ok([block({ id: "github:9", display_name: "Blocky", handle: "blocky" })]));
    (globalThis as any).window.claude = signedInMock("octo", { social: { listBlocks, unblock: vi.fn() } });
    const utils = renderSection();
    await flush();
    await openPopup(utils);

    await waitFor(() => expect(utils.getByText(/Couldn't load your blocked users: the server is busy/)).toBeTruthy());
    fireEvent.click(utils.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(utils.getByText("Blocky")).toBeTruthy());
    expect(utils.queryByText(/Couldn't load your blocked users/)).toBeNull();
  });

  it("blocked users: renders nothing when the block list is empty", async () => {
    // signedInMock defaults listBlocks → ok([]).
    (globalThis as any).window.claude = signedInMock();
    const utils = renderSection();
    await flush();
    await openPopup(utils);
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
    (globalThis as any).window.claude = signedInMock("octo", { social: { listBlocks, unblock } });

    const utils = renderSection();
    await flush();
    await openPopup(utils);

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
    (globalThis as any).window.claude = signedInMock("octo", { social: { listBlocks, unblock } });

    const utils = renderSection();
    await flush();
    await openPopup(utils);

    const unblockBtn = await waitFor(() => utils.getByRole("button", { name: "Unblock" }));
    fireEvent.click(unblockBtn);

    await waitFor(() => expect(utils.getByText("server exploded")).toBeTruthy());
    // Row still present (unblock failed).
    expect(utils.getByText("Blocky")).toBeTruthy();
  });

  // ── Download my data (view mode) ───────────────────────────────────────────

  it("Download my data: shows the saved path on success", async () => {
    const exportData = vi.fn().mockResolvedValue({ path: "C:/Users/me/youcoded-export.json" });
    (globalThis as any).window.claude = signedInMock("octo", { account: { exportData } });

    const utils = renderSection();
    await flush();
    await openPopup(utils);

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
    (globalThis as any).window.claude = signedInMock("octo", { account: { exportData } });

    const utils = renderSection();
    await flush();
    await openPopup(utils);

    fireEvent.click(utils.getByRole("button", { name: "Download my data" }));
    await waitFor(() => expect(utils.getByText("export requires Android 10+")).toBeTruthy());
  });

  it("Download my data: a canceled export shows neither a saved path nor an error", async () => {
    const exportData = vi.fn().mockResolvedValue({ canceled: true });
    (globalThis as any).window.claude = signedInMock("octo", { account: { exportData } });

    const utils = renderSection();
    await flush();
    await openPopup(utils);

    fireEvent.click(utils.getByRole("button", { name: "Download my data" }));
    await flush();

    expect(exportData).toHaveBeenCalledTimes(1);
    expect(utils.queryByText(/Saved to/)).toBeNull();
    // No red error line either.
    expect(utils.container.querySelector(".text-red-500")).toBeNull();
  });
});
