// MarketplaceAuthChip.tsx
// Persistent marketplace auth entry point shown top-left of MarketplaceScreen,
// just before the "Marketplace" title.
//
// Signed out: circular GitHub octocat icon with a small red dot indicator
//             (mirrors the settings-gear danger badge — see HeaderBar.tsx).
//             Click → opens the device-code OAuth flow in the system browser.
// Signed in : the user's GitHub avatar inside the same circle. Click toggles
//             a tiny popover with "@login" and a Sign out button.
//
// Why a red dot: the user explicitly compared this to the settings menu's
// red badge — same data-loss-vs-friction signal. Sign-in is opt-in but
// without it likes/reviews silently fail, which surprises users who don't
// realize there's an account at all.

import { useState, useCallback } from "react";
import { useAccount } from "../../state/account-context";
import { FieldError, Menu, MenuItem, MenuNote } from "../ui";

function GitHubMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export default function MarketplaceAuthChip() {
  const { signedIn, user, signInPending, signInError, startSignIn, signOut } = useAccount();
  const [popoverOpen, setPopoverOpen] = useState(false);
  // Avatar load failure → fall back to the octocat so we never render a broken image
  const [avatarFailed, setAvatarFailed] = useState(false);

  const handleClick = useCallback(() => {
    if (signedIn) {
      setPopoverOpen(p => !p);
    } else {
      void startSignIn();
    }
  }, [signedIn, startSignIn]);

  // The shared Menu closes itself when an item is chosen.
  const handleSignOut = useCallback(async () => {
    await signOut();
  }, [signOut]);

  const showAvatar = signedIn && user?.avatar_url && !avatarFailed;
  const title = signedIn
    ? `Signed in as @${user?.login ?? "github user"}`
    : signInPending
      ? "Sign-in pending — complete in your browser"
      // knowledge-debt #6: reflect a failed sign-in in the tooltip too (the chip is
      // an icon; the anchored error popover below carries the full message).
      : signInError
        ? `Sign-in failed: ${signInError}. Click to try again.`
        : "Sign in to YouCoded";

  return (
    // WHY the shared Menu (games-social friction, proposal 8): the signed-in popover was a
    // hand copy of the friends card's status menu — its own outside-click listener, no Escape,
    // 14px text. The Menu owns the popover now: outside click, Escape, arrow keys, roles.
    // The outer box stays the anchor for the sign-in error note below (not a menu).
    <div className="relative shrink-0">
      <Menu
        open={popoverOpen && signedIn}
        // Signed out there is nothing to show: the chip starts sign-in instead (handleClick), and
        // an arrow key on it must not leave a menu waiting to pop open once sign-in finishes.
        onOpenChange={(o) => setPopoverOpen(o && signedIn)}
        label="Your account"
        className="min-w-44"
        trigger={(
          <button
            type="button"
            onClick={handleClick}
            title={title}
            aria-label={title}
            className="relative w-7 h-7 rounded-full overflow-hidden flex items-center justify-center bg-inset border border-edge-dim hover:border-edge text-fg-2 hover:text-fg transition-colors"
          >
            {showAvatar ? (
              <img
                src={user!.avatar_url}
                alt=""
                className="w-full h-full object-cover"
                onError={() => setAvatarFailed(true)}
              />
            ) : (
              <GitHubMark size={14} />
            )}
            {/* Red dot — same shape/position as the settings-gear danger badge in
                HeaderBar.tsx. Only shown when signed-out so first-time users have
                an obvious "you need to do something here" cue. */}
            {!signedIn && !signInPending && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500 ring-1 ring-canvas" />
            )}
            {/* Pending spinner replaces the red dot while we wait for the browser */}
            {!signedIn && signInPending && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500 ring-1 ring-canvas animate-pulse" />
            )}
          </button>
        )}
      >
        <MenuNote>Signed in as <span className="text-fg font-medium">@{user?.login}</span></MenuNote>
        <MenuItem onSelect={() => void handleSignOut()}>Sign out</MenuItem>
      </Menu>

      {/* knowledge-debt #6: signed-out sign-in error — anchored under the chip so a
          failed sign-in isn't silently swallowed. No scrim (matches the signed-in popover). */}
      {/* WHY FieldError, not text-destructive-fg (guide: no red/coloured body
          text for messages); it carries its own role="alert", so the outer
          box no longer needs one. */}
      {signInError && !signedIn && !signInPending && (
        <div
          className="layer-surface absolute left-0 top-full mt-2 min-w-[200px] max-w-[260px] rounded-md p-2 text-xs shadow-md"
          style={{ zIndex: 62 }}
        >
          <FieldError as="span" size="2xs">Sign-in failed: {signInError}. Click the icon to try again.</FieldError>
        </div>
      )}
    </div>
  );
}
