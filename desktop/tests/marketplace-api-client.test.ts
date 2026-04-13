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
});
