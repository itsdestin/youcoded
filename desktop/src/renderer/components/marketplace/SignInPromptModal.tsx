// SignInPromptModal.tsx
// Generic "Sign in with GitHub" prompt used by marketplace actions that require
// auth (currently: liking a theme). Reviews use RatingSubmitModal which has its
// own inline signed-out branch — keeping that to avoid two nested modals.
//
// Layer L2 (popup) — matches RatingSubmitModal's layering so the visual weight
// is consistent across auth-gated flows.

import React from "react";
import { Scrim, OverlayPanel } from "../overlays/Overlay";
import { useMarketplaceAuth } from "../../state/marketplace-auth-context";
import { useEscClose } from "../../hooks/use-esc-close";

interface Props {
  open: boolean;
  onClose(): void;
  // Title and message let the caller tailor the prompt to the action they were
  // attempting (e.g. "Sign in to like themes" vs "Sign in to write a review").
  title: string;
  message: string;
}

export default function SignInPromptModal({ open, onClose, title, message }: Props) {
  useEscClose(open, onClose);
  const { signedIn, signInPending, startSignIn } = useMarketplaceAuth();

  // Auto-close once sign-in completes — the caller's signed-out gate will
  // disappear and they can retry their action.
  React.useEffect(() => {
    if (open && signedIn) onClose();
  }, [open, signedIn, onClose]);

  if (!open) return null;

  return (
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal
        aria-labelledby="signin-prompt-title"
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm rounded-xl p-5"
      >
        <div className="flex items-center justify-between mb-3">
          <h2 id="signin-prompt-title" className="text-sm font-semibold text-fg">
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-fg-muted hover:text-fg transition-colors leading-none text-lg"
          >
            &times;
          </button>
        </div>

        <div className="flex flex-col items-center gap-3 py-2">
          <p className="text-sm text-fg-muted text-center">{message}</p>
          <button
            onClick={() => void startSignIn()}
            disabled={signInPending}
            className="flex items-center gap-2 px-4 py-1.5 text-sm font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {/* GitHub octocat — same path used in MarketplaceAuthChip for consistency */}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            {signInPending ? "Waiting for browser…" : "Sign in with GitHub"}
          </button>
          {signInPending && (
            <p className="text-xs text-fg-faint text-center">
              Complete sign-in in your browser. This window will close automatically.
            </p>
          )}
        </div>
      </OverlayPanel>
    </>
  );
}
