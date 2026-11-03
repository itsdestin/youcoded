/** What the listener is actually doing, straight from the server. */
export interface RemoteStatus {
  state: 'listening' | 'stopped' | 'failed';
  reason?: string;
  port: number;
}

/**
 * Which state the remote-access row shows, and whether its light is green.
 * WHY this reads `status` and not `config.enabled`: the light used to go green because the
 * switch was on, so a server whose port never bound still said Connected and the reason
 * sat in a log nobody reads. A function rather than inline JSX so a test can hand it the
 * server's real states (tests/SettingsPanel.test.tsx → "the remote-access light").
 */
export function remoteIndicator(
  loading: boolean,
  status: RemoteStatus | null | undefined,
  enabled: boolean | undefined,
  tailscale: { installed?: boolean; connected?: boolean } | null | undefined,
): { connected: boolean; kind: 'loading' | 'failed' | 'off' | 'connected' | 'tailscale-signed-out' | 'no-tailscale' } {
  const connected = status?.state === 'listening' && !!tailscale?.installed && !!tailscale?.connected;
  const kind = loading ? 'loading'
    : status?.state === 'failed' ? 'failed'
    : !enabled || status?.state === 'stopped' ? 'off'
    : connected ? 'connected'
    : tailscale?.installed ? 'tailscale-signed-out' : 'no-tailscale';
  return { connected, kind };
}
