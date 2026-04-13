import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMarketplaceApiClient } from "../src/renderer/state/marketplace-api-client";

describe("MarketplaceApiClient", () => {
  const HOST = "https://api.test";
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it("fetches /stats without auth", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ plugins: {}, themes: {} })));
    const client = createMarketplaceApiClient({ host: HOST, getToken: () => null });
    const stats = await client.getStats();
    expect(fetchMock).toHaveBeenCalledWith(`${HOST}/stats`, expect.objectContaining({ method: "GET" }));
    expect(stats).toEqual({ plugins: {}, themes: {} });
  });

  it("attaches Bearer token to authenticated endpoints", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    const client = createMarketplaceApiClient({ host: HOST, getToken: () => "TOKEN" });
    await client.postInstall("foo:bar");
    expect(fetchMock).toHaveBeenCalledWith(
      `${HOST}/installs`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer TOKEN" }),
      })
    );
  });

  it("throws typed error on 401", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "invalid token" }), { status: 401 }));
    const client = createMarketplaceApiClient({ host: HOST, getToken: () => "BAD" });
    await expect(client.postInstall("foo")).rejects.toMatchObject({ status: 401 });
  });

  it("throws typed error on 403 install-gate", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "must install plugin before rating" }), { status: 403 }));
    const client = createMarketplaceApiClient({ host: HOST, getToken: () => "T" });
    await expect(client.postRating({ plugin_id: "x", stars: 5 })).rejects.toMatchObject({ status: 403 });
  });

  it("starts device-code flow unauthenticated", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      device_code: "d", user_code: "U", auth_url: "http://example", expires_in: 900,
    })));
    const client = createMarketplaceApiClient({ host: HOST, getToken: () => null });
    const out = await client.authStart();
    expect(out.device_code).toBe("d");
  });

  it("polls without auth", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "pending" }), { status: 202 }));
    const client = createMarketplaceApiClient({ host: HOST, getToken: () => null });
    const out = await client.authPoll("d");
    expect(out.status).toBe("pending");
  });

  it("listRatings fetches GET /ratings/:plugin_id without auth", async () => {
    const mockRating = {
      id: "github:42:my-plugin",
      user_id: "github:42",
      user_login: "alice",
      user_avatar_url: "https://avatars.githubusercontent.com/u/42",
      stars: 5,
      review_text: "Great plugin!",
      created_at: 1712880000,
    };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ratings: [mockRating] })));
    const client = createMarketplaceApiClient({ host: HOST, getToken: () => null });
    const out = await client.listRatings("my-plugin");

    // Verify URL uses the encoded plugin id
    expect(fetchMock).toHaveBeenCalledWith(
      `${HOST}/ratings/my-plugin`,
      expect.objectContaining({ method: "GET" })
    );
    // Verify no Authorization header is set (unauthenticated endpoint)
    const callArgs = fetchMock.mock.calls[0][1] as RequestInit;
    expect((callArgs.headers as Record<string, string>)?.Authorization).toBeUndefined();
    // Verify response shape
    expect(out.ratings).toHaveLength(1);
    expect(out.ratings[0]).toMatchObject({ user_login: "alice", stars: 5, review_text: "Great plugin!" });
  });

  it("listRatings forwards the AbortSignal to fetch", async () => {
    // Verify that when a signal is passed, it reaches fetch — this is the load-bearing
    // fix for the fake-abort bug where controller.abort() was called but signal was never wired.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ratings: [] })));
    const client = createMarketplaceApiClient({ host: HOST, getToken: () => null });
    const controller = new AbortController();
    await client.listRatings("my-plugin", controller.signal);

    const callArgs = fetchMock.mock.calls[0][1] as RequestInit;
    expect(callArgs.signal).toBe(controller.signal);
  });
});
