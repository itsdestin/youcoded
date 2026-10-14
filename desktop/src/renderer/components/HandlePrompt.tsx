// Post-sign-in handle prompt (spec §2/§6): you need a handle to be
// discoverable, so ask once right after sign-in. Skippable; "skip" persists
// so we never nag. Also catches pre-existing signed-in users without handles.

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAccount } from '../state/account-context';
import { Button, CARD_LEVEL_1, Dialog, FieldError, InputGroup } from './ui';
import { useScreenOpen } from '../shoot-mode';

// Persisted "don't nag me again" flag. Set on skip (and on ESC, which is the
// same as skip), never set when the user actually claims a handle.
//
// Keyed by account id (knowledge-debt #4: user A skipping used to suppress the
// prompt for user B on the same machine). The legacy global key is honored
// once as a fallback so existing dismissals don't re-prompt anyone.
const LEGACY_DISMISS_KEY = 'youcoded-handle-prompt-dismissed';
const dismissKey = (userId: string) => `youcoded-handle-prompt-dismissed:${userId}`;

export default function HandlePrompt() {
  const { signedIn, user, setHandle } = useAccount();
  const [open, setOpen] = useState(false);
  // photo-only build: nothing to click — `?signedIn=1&handleMissing=1` (mock-shim)
  // is what makes the effect below open this on its own, same shape as `welcome`.
  useScreenOpen('handle-prompt', () => {});

  // Once the user answers (skip or save) or ESC-dismisses this session, don't
  // let the effect re-open the prompt — even though refresh() re-fires the
  // effect and (in tests) the mocked profile may still report no handle.
  const closedRef = useRef(false);

  // Effect-driven open: show only when signed in, no handle yet, and not
  // previously dismissed. Recomputes when auth state changes (e.g. right after
  // sign-in completes, or when a refresh reveals a handle-less profile).
  useEffect(() => {
    if (closedRef.current) return;
    // Per-account dismissal: honor this account's key, falling back to the
    // legacy global key (read-only) so anyone who skipped before this change
    // isn't re-prompted.
    const dismissed = user
      ? localStorage.getItem(dismissKey(user.id)) === '1' ||
        localStorage.getItem(LEGACY_DISMISS_KEY) === '1'
      : false;
    setOpen(Boolean(signedIn && user && !user.handle && !dismissed));
  }, [signedIn, user]);

  if (!open || !user) return null; // render nothing when closed
  return <HandlePromptPopup userId={user.id} setHandle={setHandle} closedRef={closedRef} setOpen={setOpen} />;
}

// Mounted only while open so the input's useState initializer seeds cleanly.
function HandlePromptPopup({
  userId,
  setHandle,
  closedRef,
  setOpen,
}: {
  userId: string;
  setHandle: (handle: string) => Promise<void>;
  closedRef: React.MutableRefObject<boolean>;
  setOpen: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Skip (and ESC — registered below) persist the flag so we never nag again.
  // Write the per-account key only; the legacy global key is never written
  // again (it stays in localStorage indefinitely but is read-only from here on
  // — pre-existing dismissals keep working, new ones are always per-account).
  const skip = () => {
    localStorage.setItem(dismissKey(userId), '1');
    closedRef.current = true;
    setOpen(false);
  };

  // ESC dismissal is the same as clicking "Skip for now": the shared popup's own Escape
  // calls its onClose, which is `skip` (a second useEscClose here made two closers).

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await setHandle(draft.trim());
      // Claiming a handle is a real answer — close WITHOUT setting the dismissal
      // flag (there's nothing left to nag about).
      closedRef.current = true;
      setOpen(false);
    } catch (err) {
      // 400/409 (taken / reserved / invalid) arrive as the server's message.
      setError(err instanceof Error ? err.message : 'Could not set handle');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <>
      {/* Skip on scrim click so the prompt is genuinely skippable. */}
      {/* WHY the shared popup's own title, and a card around the words and the field
          (final-review#ST-21/#PR-7, the one popup rule; guide "Popups": every popup has the
          16px title, the ✕ and the tapered line): this had a hand-made 14px heading with no ✕,
          and its words and field sat bare on the popup. Same words and controls. */}
      <Dialog open onClose={skip} size="prompt" title="Pick a handle" screen="handle-prompt">
        <div className={`${CARD_LEVEL_1} p-3 space-y-3`}>
          <p className="text-2xs text-fg-dim leading-relaxed">
            Friends will find you by your handle — like a username. You can change it later in Settings → Account.
          </p>

          {/* Change 77: same migration as Settings → Account's handle field, which
              this duplicates. Save moves inside the field. "Skip for now" is a cancel,
              not a submit, so it stays outside, as its own full-width button below. */}
          <InputGroup size="md">
            <span className="pl-3 text-xs text-fg-muted select-none">@</span>
            <InputGroup.Field
              id="handle-prompt-input"
              aria-label="Handle"
              className="pl-0"
              autoFocus
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim().length > 0 && !saving) void save(); }}
            />
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={saving || draft.trim().length === 0}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </InputGroup>
          {/* Plain words for status, never glyphs. */}
          {error && <FieldError as="p">{error}</FieldError>}
        </div>

        <Button variant="secondary" onClick={skip} className="w-full">
          Skip for now
        </Button>
      </Dialog>
    </>,
    document.body,
  );
}
