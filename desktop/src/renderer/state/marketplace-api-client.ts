// Typed fetch wrapper for the DestinCode marketplace Cloudflare Worker backend.
// Lives in renderer/ because the same React bundle runs on both desktop and Android —
// fetch calls go directly to the Worker (CORS allowlist covers both platforms).
// No IPC needed for read endpoints; write endpoints gate on token which callers supply via getToken().

export const MARKETPLACE_API_HOST = "https://destincode-marketplace-api.destinj101.workers.dev";

export class MarketplaceApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface AuthStartResponse {
  device_code: string;
  user_code: string;
  auth_url: string;
  expires_in: number;
}

export type AuthPollResponse =
  | { status: "pending" }
  | { status: "complete"; token: string };

export interface StatsResponse {
  generated_at: number;
  plugins: Record<string, { installs: number; review_count: number; rating: number }>;
  themes: Record<string, { likes: number }>;
}

export interface PostRatingInput {
  plugin_id: string;
  stars: 1 | 2 | 3 | 4 | 5;
  review_text?: string;
}

export interface MarketplaceApiClient {
  getStats(): Promise<StatsResponse>;
  authStart(): Promise<AuthStartResponse>;
  authPoll(deviceCode: string): Promise<AuthPollResponse>;
  postInstall(pluginId: string): Promise<void>;
  postRating(input: PostRatingInput): Promise<{ hidden: boolean }>;
  deleteRating(pluginId: string): Promise<void>;
  toggleThemeLike(themeId: string): Promise<{ liked: boolean }>;
  postReport(input: { rating_user_id: string; rating_plugin_id: string; reason?: string }): Promise<void>;
}

export function createMarketplaceApiClient(opts: {
  host: string;
  getToken: () => string | null;
}): MarketplaceApiClient {
  const { host, getToken } = opts;

  async function request<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers as Record<string, string>) };
    if (init.auth) {
      const token = getToken();
      if (!token) throw new MarketplaceApiError(401, "not signed in");
      headers.Authorization = `Bearer ${token}`;
    }
    // Remove the custom 'auth' flag before passing to fetch (not a standard RequestInit field)
    const { auth: _auth, ...fetchInit } = init;
    const res = await fetch(`${host}${path}`, { ...fetchInit, headers });
    // 202 Accepted is used for poll-pending responses — treat as success with { status: "pending" }
    const body = res.status === 202 ? { status: "pending" as const } : await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) {
      throw new MarketplaceApiError(res.status, (body as { message?: string })?.message ?? res.statusText);
    }
    return body as T;
  }

  return {
    getStats: () => request<StatsResponse>("/stats", { method: "GET" }),
    authStart: () => request<AuthStartResponse>("/auth/github/start", { method: "POST" }),
    authPoll: (device_code) =>
      request<AuthPollResponse>("/auth/github/poll", {
        method: "POST",
        body: JSON.stringify({ device_code }),
      }),
    postInstall: async (plugin_id) => {
      await request("/installs", { method: "POST", body: JSON.stringify({ plugin_id }), auth: true });
    },
    postRating: (input) =>
      request<{ hidden: boolean }>("/ratings", {
        method: "POST",
        body: JSON.stringify(input),
        auth: true,
      }),
    deleteRating: async (plugin_id) => {
      await request(`/ratings/${encodeURIComponent(plugin_id)}`, { method: "DELETE", auth: true });
    },
    toggleThemeLike: (theme_id) =>
      request<{ liked: boolean }>(`/themes/${encodeURIComponent(theme_id)}/like`, {
        method: "POST",
        auth: true,
      }),
    postReport: async (input) => {
      await request("/reports", { method: "POST", body: JSON.stringify(input), auth: true });
    },
  };
}
