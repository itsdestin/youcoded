import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useEscClose } from '../hooks/use-esc-close';
import { useAccount } from '../state/account-context';
import type { MarketplaceUser } from '../../main/marketplace-auth-store';
import type { BlockRow } from '../state/marketplace-api-client';
import { Button, Dialog, FieldError, InputGroup, SettingRow, Callout } from './ui';
import { ConnectedAccountsBody } from './ConnectedAccounts';
import { useScreenOpen, ScreenMark } from '../shoot-mode';

// Settings → Account section. One self-contained row-button + popup, mounted in
// both the Desktop and Android settings stacks. Auth-token state and mutations
// (sign in/out, profile, handle, delete) all flow through useAccount() — the
// context owns that boundary. The blocked-users and data-export controls call
// window.claude.social.* / window.claude.account.exportData() directly; those
// aren't part of the token lifecycle. Follows the chip+popup pattern used by
// PerformanceButton / SoundButton / AboutPopup — a small settings row that opens
// a centered L2 overlay where the real controls live.

// GitHub octocat mark — same path used in SignInPromptModal / MarketplaceAuthChip
// so the sign-in affordance reads consistently across the app.
function GitHubIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

// Generic person glyph — the stand-in whenever there is no usable photo to show
// (signed out, no avatar_url, or the photo failed to load).
function PersonIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={`${className} text-fg-muted`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" />
    </svg>
  );
}

// Profile photo with a guaranteed fallback, used by both the Account row and the
// popup's identity summary.
//
// Fix: an <img> whose src fails to load paints the browser's broken-image glyph,
// and that was leaking into the Account row whenever the GitHub avatar CDN was
// unreachable (offline, blocked, or a stale URL). The row must only ever show a
// real photo or our own person glyph. Same onError guard MarketplaceAuthChip and
// ReviewList already carry.
//
// We remember the URL that failed rather than a bare boolean so the fallback
// un-sticks on its own: signing out and back in with a working photo changes the
// URL, which no longer matches the failed one, so the photo is tried again.
function AccountAvatar({ url, size }: { url?: string | null; size: 'row' | 'large' }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const box = size === 'large' ? 'w-10 h-10' : 'w-5 h-5';

  // Retry a failed photo. This is what makes the row behave like the popup.
  //
  // SettingsPanel is always mounted (it hides by sliding off-screen, it does not
  // unmount), so the ROW's <img> is created seconds after app start and gets
  // exactly one shot at the network — a browser <img> never re-requests a src it
  // already failed on. The POPUP's <img> is created fresh on every open, so it
  // always gets a new attempt and, once fetched, is served from the HTTP cache.
  // That asymmetry is why the row could sit broken while the popup looked fine.
  //
  // Two short automatic retries cover a network stack that wasn't up yet at
  // launch; after that we only retry on a real signal (back online, or the user
  // returning to the window) so an offline machine isn't requesting on a loop.
  // Same "next focus retries" philosophy the account refresh already uses.
  const retriesRef = useRef(0);
  useEffect(() => {
    retriesRef.current = 0; // a different account's photo starts with a full budget
  }, [url]);
  useEffect(() => {
    if (!failedSrc) return;
    const retry = () => {
      retriesRef.current += 1;
      setFailedSrc(null);
    };
    window.addEventListener('online', retry);
    window.addEventListener('focus', retry);
    const timer =
      retriesRef.current < 2 ? window.setTimeout(retry, 5000 * (retriesRef.current + 1)) : undefined;
    return () => {
      window.removeEventListener('online', retry);
      window.removeEventListener('focus', retry);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [failedSrc]);

  if (!url || url === failedSrc) {
    // Signed-out row shows the bare glyph (unchanged); the popup's larger slot
    // keeps its filled circle so the identity block doesn't look empty.
    return size === 'large' ? (
      <div className={`${box} rounded-full bg-inset flex items-center justify-center shrink-0`}>
        <PersonIcon />
      </div>
    ) : (
      <PersonIcon />
    );
  }

  return (
    // alt="" so the avatar doesn't leak into the row's accessible name.
    <img src={url} alt="" onError={() => setFailedSrc(url)} className={`${box} rounded-full object-cover shrink-0`} />
  );
}

export default function AccountSection() {
  const { signedIn, user } = useAccount();
  const [open, setOpen] = useState(false);
  useScreenOpen('settings/account', () => setOpen(true)); // photo-only build: `shoot` opens it by name

  const rowLabel = 'Account';
  const rowDesc = signedIn
    ? `Signed in as @${user?.handle ?? user?.login ?? ''}`
    : 'Sign in to like themes, rate plugins, and play games';

  return (
    <>
      <SettingRow
        icon={<AccountAvatar url={signedIn ? user?.avatar_url : null} size="row" />}
        title={rowLabel}
        description={rowDesc}
        onClick={() => setOpen(true)}
      />

      {/* AccountPopup portals itself to document.body (same as AboutPopup) so the
          popup centers over the full viewport, not inside SettingsPanel's
          transformed wrapper. Render directly here — do NOT wrap in a second portal. */}
      {open && <AccountPopup onClose={() => setOpen(false)} />}
    </>
  );
}

// Mounted only while open, so useState initializers seed cleanly from the current
// user profile (no reset-on-change effect needed).
function AccountPopup({ onClose }: { onClose: () => void }) {
  const { signedIn, user, signInPending, startSignIn, signOut, updateProfile, setHandle, deleteAccount } =
    useAccount();

  // In-popup navigation (Destin feedback 2026-07-22): ONE Account card in
  // Settings; external connections (GitHub now, Google etc. later) live on a
  // "Connected accounts" PAGE inside it. A sibling settings row read as a
  // second, contradictory GitHub sign-in ("Sign in with GitHub" right above
  // "Connected as @…") because the WeCoded account also authenticates via
  // GitHub — two different jobs wearing the same octocat.
  const [page, setPage] = useState<'main' | 'connections'>('main');
  useScreenOpen('settings/account/connections', () => setPage('connections')); // photo-only build

  // Combined github:status for the row summary + the connections page.
  // 'unavailable' (handler missing / rejected — the Android stub) hides the
  // whole Connected-accounts affordance rather than offering a dead flow.
  const [ghStatus, setGhStatus] = useState<import('./ConnectedAccounts').GithubStatus | null | 'unavailable'>(null);
  const refreshGh = React.useCallback(async () => {
    const fn = (window as any).claude?.github?.status;
    if (typeof fn !== 'function') { setGhStatus('unavailable'); return; }
    try { setGhStatus(await fn()); } catch { setGhStatus('unavailable'); }
  }, []);
  useEffect(() => { void refreshGh(); }, [refreshGh]);

  useEscClose(true, onClose);

  // Collapsed-row summary. While signed OUT of the YouCoded account the row
  // stays NEUTRAL ("Manage…") — a "GitHub · @login" line directly under the
  // "Sign in with GitHub" button read as the app contradicting itself
  // (Destin, 2026-07-22, second screenshot). Signed in, the concrete status
  // is useful and the sign-in button isn't on screen to clash with.
  const ghSummary = !signedIn
    ? 'Manage GitHub and other connections'
    : ghStatus === 'unavailable' || ghStatus === null ? 'GitHub'
      : ghStatus.authed ? `GitHub · @${ghStatus.login ?? 'connected'}`
        : 'GitHub — not connected';

  return createPortal(
    <>
      <Dialog
        screen="settings/account"
        open
        onClose={onClose}
        size="panel"
        title={page === 'connections' ? 'Connected services' : 'Account'}
        onBack={page === 'connections' ? () => setPage('main') : undefined}
      >
        {page === 'connections' && <ScreenMark name="settings/account/connections" />}
            {page === 'connections' ? (
              <ConnectedAccountsBody
                status={ghStatus === 'unavailable' ? null : ghStatus}
                refresh={refreshGh}
              />
            ) : (
              <>
                {signedIn && user ? (
                  // key on the canonical handle so SignedInBody remounts (re-seeding
                  // its useState draft initializers) if HandlePrompt saves a handle
                  // while this popup is open — otherwise handleDraft goes stale.
                  <SignedInBody
                    key={user.handle ?? ''}
                    user={user}
                    signOut={signOut}
                    updateProfile={updateProfile}
                    setHandle={setHandle}
                    deleteAccount={deleteAccount}
                    onClose={onClose}
                  />
                ) : (
                  <SignedOutBody signInPending={signInPending} startSignIn={startSignIn} />
                )}

                {/* Connected accounts entry — shown regardless of WeCoded
                    sign-in state (the GitHub connection is independent of it),
                    hidden only where the github:* channels don't exist. */}
                {ghStatus !== 'unavailable' && (
                  <SettingRow
                    onClick={() => setPage('connections')}
                    icon={
                      /* Neutral link glyph, NOT the octocat — the WeCoded
                         sign-in button above already wears GitHub's mark, and
                         doubling it is what made the two read as one broken
                         flow. Provider marks belong on the sub-page rows. */
                      <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                      </svg>
                    }
                    title="Connected services"
                    description={ghSummary}
                  />
                )}
              </>
            )}
      </Dialog>
    </>,
    document.body,
  );
}

// ── Signed-out ──────────────────────────────────────────────────────────────

function SignedOutBody({
  signInPending,
  startSignIn,
}: {
  signInPending: boolean;
  startSignIn: () => Promise<void>;
}) {
  // Surface sign-in failures (poll timeout, network) inline — previously the
  // void startSignIn() swallowed them and the user saw nothing happen.
  const [signInError, setSignInError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-center gap-4 py-2 text-center">
      <p className="text-2xs text-fg-dim leading-relaxed">
        One YouCoded account for the marketplace, games, and syncing with friends.
      </p>
      {/* Page-level CTA -> lg. Also drops hover:brightness-110, which was
          invisible on Light/Creme (their accent is already near-black), and
          gains the focus ring it never had. */}
      {/* "Sign in to YouCoded", NOT "Sign in with GitHub" (Destin, 2026-07-22):
          the account is a YOUCODED account — GitHub is only the login
          mechanism, and naming the button after the mechanism made it read as
          a duplicate of the Connected-accounts GitHub repo connection. The
          mechanism lives in the small print below; the octocat stays off the
          CTA for the same reason. Same rename applied to every sign-in
          surface (SignInPromptModal, GameLobby, RatingSubmitModal, chip). */}
      <Button
        size="lg"
        onClick={() => {
          setSignInError(null);
          startSignIn().catch((e) =>
            setSignInError(e instanceof Error ? e.message : 'sign-in failed'),
          );
        }}
        disabled={signInPending}
      >
        {signInPending ? 'Signing in…' : 'Sign in to YouCoded'}
      </Button>
      <p className="text-3xs text-fg-muted leading-relaxed">
        Uses your GitHub profile to sign in — GitHub only shares your public info.
      </p>
      {signInError && <FieldError as="p">{signInError}</FieldError>}
    </div>
  );
}

// ── Signed-in ───────────────────────────────────────────────────────────────

// Pencil glyph for the Edit account affordance — same stroke style as the
// app's other inline icons. Always paired with a text label (never icon-only).
function PencilIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  );
}

// UX rework (Destin, 2026-07-08): the signed-in popup is read-only by default.
// A single "Edit account" button toggles into edit mode, where the display-name /
// handle editors and the delete danger zone live. Keeps the common case (glance
// at who I am, sign out) free of inputs and destructive controls.
function SignedInBody({
  user,
  signOut,
  updateProfile,
  setHandle,
  deleteAccount,
  onClose,
}: {
  // Reuse the canonical profile type instead of a duplicate local interface.
  user: MarketplaceUser;
  signOut: () => Promise<void>;
  updateProfile: (name: string) => Promise<void>;
  setHandle: (handle: string) => Promise<void>;
  deleteAccount: () => Promise<void>;
  onClose: () => void;
}) {
  // 'view' is the default on every mount. A successful handle change refreshes
  // the profile, which changes this component's key (AccountPopup keys on
  // user.handle) → remount → back to view mode showing the new handle. That
  // remount is the intended "exit edit mode after a handle change" path.
  const [mode, setMode] = useState<'view' | 'edit'>('view');

  // Sign-out awaits a network revocation (bounded at 5s on both platforms — see
  // MarketplaceApiClient.logout). Show that something is happening and prevent a
  // double-click while the request is in flight.
  const [signingOut, setSigningOut] = useState(false);

  // Blocked users — fetched once when the popup opens (SignedInBody mounts on
  // open). null while loading / on error; we render nothing in either case so
  // settings stays free of empty-state noise. window.claude.social is the same
  // surface the friends UI uses directly — the context only owns the auth token
  // boundary (profile/handle/delete), not the social graph.
  const [blocks, setBlocks] = useState<BlockRow[] | null>(null);
  // In-flight id (single-fire guard) + per-row unblock error text.
  const [unblockingId, setUnblockingId] = useState<string | null>(null);
  const [unblockErrors, setUnblockErrors] = useState<Record<string, string>>({});

  // Data export — single-fire guard + a persisted saved-path / error line. Both
  // persist until the popup closes (SignedInBody unmounts).
  const [exporting, setExporting] = useState(false);
  const [exportSavedPath, setExportSavedPath] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const refetchBlocks = async () => {
    const res = await window.claude.social.listBlocks();
    // Leave blocks null on failure so the section simply doesn't render.
    setBlocks(res.ok ? res.value : null);
  };

  useEffect(() => {
    void refetchBlocks();
    // Fetch once on mount (popup open). No deps — user identity is fixed for
    // this mount (SignedInBody remounts on handle change via the parent key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onUnblock = async (id: string) => {
    if (unblockingId) return; // single-fire guard across rows
    setUnblockingId(id);
    setUnblockErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const res = await window.claude.social.unblock(id);
      if (res.ok) {
        await refetchBlocks();
      } else {
        setUnblockErrors((prev) => ({ ...prev, [id]: res.message || 'Could not unblock' }));
      }
    } finally {
      setUnblockingId(null);
    }
  };

  const onExport = async () => {
    if (exporting) return; // single-fire guard
    setExporting(true);
    setExportError(null);
    setExportSavedPath(null);
    try {
      const res = await window.claude.account.exportData();
      if ('path' in res) {
        setExportSavedPath(res.path);
      } else if ('canceled' in res) {
        // User dismissed the save dialog — nothing to report.
      } else {
        // Server errors pass through verbatim (e.g. "export requires Android 10+").
        setExportError(res.error || 'Could not export data');
      }
    } finally {
      setExporting(false);
    }
  };

  return mode === 'view' ? (
    <>
      {/* Identity summary — avatar + display name + @handle, all read-only. */}
      <section className="flex items-center gap-3">
        <AccountAvatar url={user.avatar_url} size="large" />
        <div className="min-w-0">
          <p className="text-sm text-fg font-medium truncate">{user.display_name ?? user.login}</p>
          {/* Plain words when there's no handle yet — no placeholder glyphs. */}
          <p className="text-2xs text-fg-muted truncate">
            {user.handle ? `@${user.handle}` : 'No handle yet'}
          </p>
        </div>
      </section>

      {/* Login-method line — which GitHub profile backs this YouCoded account.
          Says "Signs in with", NOT "Connected:" — "connected" now belongs to
          the Connected-accounts page (repo access), and reusing the word here
          recreated the two-GitHubs confusion this popup was reworked to kill. */}
      <section className="flex items-center gap-1.5 text-xs text-fg-2">
        <GitHubIcon className="w-3.5 h-3.5" />
        <span>Signs in with GitHub (@{user.login})</span>
      </section>

      {/* Blocked users — only rendered when the list is non-empty (loading and
          empty both leave `blocks` falsy so nothing shows in settings). */}
      {blocks && blocks.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Blocked users</h3>
          {blocks.map((b) => (
            <div key={b.id} className="space-y-1">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0 flex items-baseline gap-1.5">
                  <span className="text-xs text-fg truncate">{b.display_name}</span>
                  {b.handle && <span className="text-2xs text-fg-muted truncate">@{b.handle}</span>}
                </div>
                {/* No confirm — unblocking is the recovery action, not the
                    destructive one (blocking is what's consequence-gated). */}
                <Button
                  variant="secondary"
                  onClick={() => void onUnblock(b.id)}
                  disabled={unblockingId === b.id}
                  className="shrink-0"
                >
                  {unblockingId === b.id ? 'Unblocking…' : 'Unblock'}
                </Button>
              </div>
              {unblockErrors[b.id] && <FieldError as="p">{unblockErrors[b.id]}</FieldError>}
            </div>
          ))}
        </section>
      )}

      {/* The single edit affordance — pencil icon + label, per the rework spec.
          The primitive already centers its children and owns the icon gap, so
          only the full-bleed width survives as a layout extra (the py-2.5 row
          shortens to md's py-1.5, same as the danger-zone Cancel — change 3). */}
      <Button variant="secondary" onClick={() => setMode('edit')} className="w-full">
        <PencilIcon />
        Edit account
      </Button>

      {/* Sign out is reversible (you can sign back in), so it stays secondary
          rather than joining the danger family. */}
      <Button
        variant="secondary"
        onClick={async () => {
          setSigningOut(true);
          try {
            await signOut();
          } finally {
            setSigningOut(false);
          }
        }}
        disabled={signingOut}
        className="w-full"
      >
        {signingOut ? 'Signing out…' : 'Sign out'}
      </Button>

      {/* Download my data — GDPR-style export of everything the server stores.
          Desktop shows a save dialog (resolves to {path}); Android writes to
          Downloads. Single-fire guarded while the request is in flight. */}
      <section className="space-y-1.5">
        <Button
          variant="secondary"
          onClick={() => void onExport()}
          disabled={exporting}
          className="w-full"
        >
          {exporting ? 'Preparing export…' : 'Download my data'}
        </Button>
        <p className="text-3xs text-fg-muted leading-relaxed">
          Downloads a file containing everything YouCoded's server stores about your account.
        </p>
        {exportSavedPath && <p className="text-3xs text-fg-muted">Saved to {exportSavedPath}</p>}
        {exportError && <FieldError as="p">{exportError}</FieldError>}
      </section>
    </>
  ) : (
    // Mounted fresh on each entry into edit mode, so the draft useState
    // initializers re-seed from the CURRENT profile every time.
    <EditAccountBody
      user={user}
      updateProfile={updateProfile}
      setHandle={setHandle}
      deleteAccount={deleteAccount}
      onClose={onClose}
      onDone={() => setMode('view')}
    />
  );
}

function EditAccountBody({
  user,
  updateProfile,
  setHandle,
  deleteAccount,
  onClose,
  onDone,
}: {
  user: MarketplaceUser;
  updateProfile: (name: string) => Promise<void>;
  setHandle: (handle: string) => Promise<void>;
  deleteAccount: () => Promise<void>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [nameDraft, setNameDraft] = useState(user.display_name ?? user.login);
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);

  const [handleDraft, setHandleDraft] = useState(user.handle ?? '');
  const [handleSaving, setHandleSaving] = useState(false);
  const [handleError, setHandleError] = useState<string | null>(null);
  const [handleSaved, setHandleSaved] = useState(false);
  // Inline handle-change confirm step (no browser confirm() dialogs). Only armed
  // when the user already HAS a handle — first-time setting has no consequences
  // worth a warning, so it commits directly.
  const [handleConfirming, setHandleConfirming] = useState(false);

  const [deleteExpanded, setDeleteExpanded] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const currentHandle = user.handle ?? '';
  const trimmedHandle = handleDraft.trim();
  // Saving the same handle back is a no-op — keep Save disabled so the scary
  // change warning can never appear for a non-change.
  const handleUnchanged = currentHandle.length > 0 && trimmedHandle === currentHandle;

  const saveName = async () => {
    setNameSaving(true);
    setNameError(null);
    setNameSaved(false);
    try {
      await updateProfile(nameDraft.trim());
      setNameSaved(true);
    } catch (err) {
      // Surface the server's message verbatim (e.g. validation copy).
      setNameError(err instanceof Error ? err.message : 'Could not save name');
    } finally {
      setNameSaving(false);
    }
  };

  // Save click: existing handle → arm the inline confirm step; no existing
  // handle → commit directly (nothing is being given up).
  const onSaveHandleClick = () => {
    if (currentHandle.length > 0 && !handleConfirming) {
      setHandleConfirming(true);
      return;
    }
    void commitHandle();
  };

  const commitHandle = async () => {
    setHandleSaving(true);
    setHandleError(null);
    setHandleSaved(false);
    try {
      await setHandle(trimmedHandle);
      // On success the context refresh() updates user.handle → AccountPopup's
      // key changes → SignedInBody remounts in view mode. These setters are
      // effectively unreachable then, but kept for the no-refresh edge (tests,
      // server returning the same handle).
      setHandleConfirming(false);
      setHandleSaved(true);
    } catch (err) {
      // 400/409 (taken / reserved / cooldown) all arrive as the server's message.
      setHandleError(err instanceof Error ? err.message : 'Could not set handle');
      setHandleConfirming(false);
    } finally {
      setHandleSaving(false);
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteAccount();
      onClose(); // success — close the popup; the row falls back to signed-out
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Could not delete account');
      setDeleting(false);
    }
  };

  return (
    <>
      {/* Edit-mode header: label + the way back to view mode. */}
      <div className="flex items-center justify-between">
        <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Edit account</h3>
        <Button variant="secondary" onClick={onDone}>
          Done
        </Button>
      </div>

      {/* Display name */}
      <section className="space-y-1.5">
        <label htmlFor="account-display-name" className="text-3xs font-medium text-fg-muted tracking-wider uppercase">
          Display name
        </label>
        {/* Change 77: Save moved INSIDE the field. Besides matching the spec, this
            removes the height mismatch the button migration introduced — a button
            sitting alongside a field no longer has to match its height, because
            it's now a child of the field's own bordered wrapper. */}
        <InputGroup size="md">
          <InputGroup.Field
            id="account-display-name"
            aria-label="Display name"
            value={nameDraft}
            onChange={(e) => { setNameDraft(e.target.value); setNameSaved(false); }}
          />
          <Button
            size="sm"
            onClick={() => void saveName()}
            aria-label="Save display name"
            disabled={nameSaving || nameDraft.trim().length === 0}
          >
            {nameSaving ? 'Saving…' : 'Save'}
          </Button>
        </InputGroup>
        {nameError && <FieldError as="p">{nameError}</FieldError>}
        {nameSaved && !nameError && <p className="text-3xs text-fg-muted">Saved</p>}
      </section>

      {/* Handle */}
      <section className="space-y-1.5">
        <label htmlFor="account-handle" className="text-3xs font-medium text-fg-muted tracking-wider uppercase">
          Handle
        </label>
        {/* Change 77: this was already a hand-rolled InputGroup (bordered wrapper +
            borderless input) with Save alongside; now it's the real primitive with
            Save inside, so the button no longer has to height-match the field.
            The leading "@" carries the wrapper's left padding and the field drops
            its own, keeping the tight "@handle" spacing the hand-rolled version had. */}
        <InputGroup size="md">
          <span className="pl-3 text-xs text-fg-muted select-none">@</span>
          <InputGroup.Field
            id="account-handle"
            aria-label="Handle"
            className="pl-0"
            value={handleDraft}
            onChange={(e) => {
              setHandleDraft(e.target.value);
              setHandleSaved(false);
              // Editing the draft invalidates an armed confirm — the warning
              // refers to committing a specific value.
              setHandleConfirming(false);
            }}
          />
          {!handleConfirming && (
            <Button
              size="sm"
              onClick={onSaveHandleClick}
              aria-label="Save handle"
              disabled={handleSaving || trimmedHandle.length === 0 || handleUnchanged}
            >
              {handleSaving ? 'Saving…' : 'Save'}
            </Button>
          )}
        </InputGroup>

        {/* Handle-change consequences + explicit confirm (existing handle only). */}
        {handleConfirming && (
          <div className="space-y-2 rounded-lg bg-inset border border-edge-dim p-3">
            <p className="text-2xs text-fg-dim leading-relaxed">
              Changing your handle frees @{currentHandle} for anyone else to claim after 30 days — and
              you can't take it back during those 30 days. Friends who know you by @{currentHandle} will
              need your new handle.
            </p>
            <div className="flex gap-2">
              {/* This Cancel unarms the confirm step rather than closing the
                  popup, so it survives the "no redundant text cancel" rule. */}
              <Button
                variant="secondary"
                onClick={() => setHandleConfirming(false)}
                aria-label="Cancel handle change"
                className="flex-1"
              >
                Cancel
              </Button>
              {/* Stays primary, not danger: a handle change is consequential but
                  not destructive — nothing attached to the account is deleted. */}
              <Button
                onClick={() => void commitHandle()}
                disabled={handleSaving}
                className="flex-1"
              >
                {handleSaving ? 'Saving…' : 'Confirm change'}
              </Button>
            </div>
          </div>
        )}

        {/* Plain words for status, never glyphs. */}
        {handleError && <FieldError as="p">{handleError}</FieldError>}
        {handleSaved && !handleError && <p className="text-3xs text-fg-muted">Saved</p>}
      </section>

      {/* Danger zone — 2-step: expand, then typed confirm + explicit button. */}
      <section className="space-y-2">
        {/* K9: was an <h4> at `text-3xs font-medium text-red-500 uppercase
            tracking-wider` — a retired class ORDER that the K1 guard could not
            catch precisely because it was red, so it sat outside the recipe the
            guard matches on. It is the K1 label now; the danger signal lives in
            the callout and the button variant below, where it belongs. */}
        <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Danger zone</h3>
        {!deleteExpanded ? (
          // Arming step -> danger-outline. red-500 becomes the --destructive
          // token so packs can restyle it (#C62828 today — no longer identical
          // to the fixed status red #DD4444, which stayed put).
          <Button variant="danger-outline" onClick={() => setDeleteExpanded(true)} className="w-full">
            Delete account
          </Button>
        ) : (
          <div className="space-y-2">
            {/* K9: the consequence goes in a danger callout, kept with the
                control it describes. Copy unchanged — it was already specific,
                plain, and explicit about the irreversibility. */}
            <Callout tone="danger">
              Deleting your account removes everything attached to it immediately — your likes,
              reviews, and install history are all gone. This cannot be undone.
              {/* The freed-handle lock only applies when there IS a handle to free. */}
              {currentHandle.length > 0 && (
                <span className="block mt-2">
                  Your handle @{currentHandle} is freed, but locked for 30 days before anyone else can
                  claim it.
                </span>
              )}
            </Callout>
            <label htmlFor="account-delete-confirm" className="block text-3xs text-fg-muted">
              Type <span className="font-semibold text-fg">delete</span> to confirm
            </label>
            {/* Deliberately NOT migrated to <TextInput>: this field already IS the
                FIELD recipe except for its red focus border, which is a danger-zone
                signal. FIELD focuses to accent, and a `focus:border-red-500`
                className can't reliably win over `focus:border-accent` (Tailwind
                resolves same-plugin utilities by its own source order, not ours —
                see the CONFLICT_GROUPS note in ui/Button.tsx). Left hand-rolled. */}
            <input
              id="account-delete-confirm"
              aria-label="Type delete to confirm"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              className="w-full text-xs bg-inset border border-edge-dim rounded-lg px-3 py-2 text-fg focus:outline-none focus:border-red-500"
            />
            <div className="flex gap-2">
              {/* This Cancel earns its place next to the ✕ rule: it collapses the
                  danger-zone confirm rather than closing the popup, so it does
                  something the ✕ doesn't. */}
              <Button
                variant="secondary"
                onClick={() => { setDeleteExpanded(false); setDeleteConfirm(''); setDeleteError(null); }}
                className="flex-1"
              >
                Cancel
              </Button>
              {/* text-white becomes the derived --on-destructive: --destructive is
                  pack-overridable with no contrast guard, so white can vanish on a
                  pale red. */}
              <Button
                variant="danger"
                onClick={() => void confirmDelete()}
                disabled={deleteConfirm.trim() !== 'delete' || deleting}
                className="flex-1"
              >
                {deleting ? 'Deleting…' : 'Delete my account'}
              </Button>
            </div>
            {deleteError && <FieldError as="p">{deleteError}</FieldError>}
          </div>
        )}
      </section>
    </>
  );
}
