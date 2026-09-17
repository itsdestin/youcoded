import { useCallback, useState } from 'react';
import { Button, FieldError } from './ui';
import ConnectGithubModal from './ConnectGithubModal';

// Connected-accounts sub-page INSIDE the Account popup (Destin feedback,
// 2026-07-22: one "Account" card in Settings; external connections live on a
// page within it, not as a sibling row that reads like a second, contradictory
// GitHub sign-in). Currently one provider — GitHub (sync storage, publishing,
// bug reports) — laid out as a list so Google/others slot in later.
//
// Status comes from the combined github:status (app token OR gh CLI). The
// Disconnect button only exists for the APP token — a gh CLI login is not our
// credential to delete (no forced migration), so that state gets an
// explanatory note instead.

export interface GithubStatus {
  installed: boolean;
  authed: boolean;
  login?: string;
  source?: 'app' | 'gh' | null;
  degradedStorage?: boolean;
}

// Same octocat path AccountSection / SignInPromptModal use, so the GitHub
// affordance reads consistently across the app.
function GitHubMarkIcon({ className = 'w-4 h-4 text-fg-muted' }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function ConnectedAccountsBody({ status, refresh }: {
  status: GithubStatus | null;
  refresh: () => Promise<void>;
}) {
  const [showConnect, setShowConnect] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDisconnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await (window as any).claude?.github?.disconnect?.();
      setConfirming(false);
      await refresh();
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const connected = !!status?.authed;
  const viaGhCli = connected && status?.source === 'gh';

  return (
    <div className="space-y-4">
      {/* How this page relates to the WeCoded sign-in the user just came from —
          the exact confusion this layout exists to prevent: both use GitHub,
          for two different jobs. */}
      <p className="text-2xs text-fg-dim leading-relaxed">
        Services YouCoded connects to on your behalf. These are separate from
        your YouCoded account sign-in.
      </p>

      {/* ── GitHub ── (list layout: future providers append below) */}
      <div className="rounded-lg border border-edge bg-inset/40 p-3 space-y-3">
        <div className="flex items-center gap-3">
          <GitHubMarkIcon className="w-6 h-6 text-fg shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs text-fg font-medium">
              GitHub{connected && status?.login ? ` · @${status.login}` : ''}
            </div>
            <div className="text-3xs text-fg-muted">
              {connected
                ? 'Stores your synced data and publishes your themes, skills, and bug reports.'
                : 'Needed for cross-device sync and publishing themes & skills.'}
            </div>
          </div>
          {!connected && (
            <Button size="sm" className="shrink-0" onClick={() => setShowConnect(true)}>
              Connect…
            </Button>
          )}
          {connected && !viaGhCli && !confirming && (
            <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setConfirming(true)}>
              Disconnect
            </Button>
          )}
        </div>

        {/* Keychain-less Linux stores the token as a plain 0600 file — the
            degraded policy is explicit everywhere, including here. */}
        {connected && status?.degradedStorage && (
          <p className="text-2xs text-amber-700 leading-relaxed">
            Your sign-in is stored without system-keychain encryption on this
            computer (no keychain service was available). It is protected only
            by file permissions.
          </p>
        )}

        {viaGhCli && (
          <p className="text-2xs text-fg-muted leading-relaxed">
            Connected through the GitHub CLI installed on this computer, so
            there's nothing for YouCoded to disconnect here — to sign out, run{' '}
            <code className="font-mono">gh auth logout</code> in a terminal.
          </p>
        )}

        {confirming && (
          <div className="space-y-2">
            <p className="text-2xs text-fg-2 leading-relaxed">
              This removes the saved GitHub sign-in from this device. Sync will
              pause until you reconnect; your data on GitHub is not deleted.
            </p>
            <div className="flex items-center gap-2">
              <Button variant="danger" size="sm" disabled={busy} onClick={() => { void handleDisconnect(); }}>
                {busy ? 'Disconnecting…' : 'Disconnect'}
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                Never mind
              </Button>
            </div>
          </div>
        )}

        {error && <FieldError as="p" size="2xs">{error}</FieldError>}
      </div>

      {showConnect && (
        <ConnectGithubModal
          onClose={() => setShowConnect(false)}
          onConnected={() => { void refresh(); }}
        />
      )}
    </div>
  );
}
