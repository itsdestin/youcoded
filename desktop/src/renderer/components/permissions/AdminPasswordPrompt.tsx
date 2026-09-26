import React, { useEffect, useRef, useState } from 'react';
import type { PasswordAsk } from '../../../shared/types';
import { Button, Callout, InputGroup } from '../ui';
import { EyeIcon, EyeOffIcon } from '../Icons';
import { isAndroid } from '../../platform';

/**
 * The admin password card (design 2026-09-25, docs/active/design/2026-09-25-admin-password/).
 * Shown on a RUNNING Bash card whose sudo is waiting for the computer password —
 * after the approval card for a visible `sudo`, or mid-command when a script
 * asks for admin partway through.
 *
 * WHY every word here is the app's own: a command can set sudo's prompt to
 * anything ("Enter your Google password"), so the card never shows it. The
 * command line shown is the admin step read from the real sudo process.
 *
 * Layout from Destin's review (R-3, 2026-09-26): a full-width field with a
 * show/hide eye inside it, and ONE Confirm button below — no Skip. Backing out
 * at this step is the chat's Stop button, which ends the command.
 */
export function AdminPasswordPrompt({ ask, onSubmit }: {
  ask: PasswordAsk;
  onSubmit?: (password: string) => void;
}) {
  const [value, setValue] = useState('');
  const [shown, setShown] = useState(false);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // WHY focus the field: with focus left in the message box, a password typed
  // there and sent with Enter would reach the assistant and the chat history —
  // the one leak this card exists to prevent.
  useEffect(() => { inputRef.current?.focus(); }, [ask.requestId, ask.triesLeft]);

  // A wrong try re-asks with the field emptied and hidden again.
  useEffect(() => { setValue(''); setShown(false); setSending(false); }, [ask.triesLeft]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!value || sending) return;
    setSending(true);
    onSubmit?.(value);
    // WHY clear at once: the text must not linger in React state after send.
    setValue('');
  };

  const wrong = typeof ask.triesLeft === 'number';
  const pad = isAndroid() ? 'py-2.5' : 'py-1.5';

  return (
    <form className="px-3 py-2 space-y-2 border-t border-edge bg-inset/30" data-testid="admin-password-prompt" onSubmit={submit}>
      <div className="space-y-0.5">
        <p className="text-xs font-medium text-fg-2">Enter your computer password</p>
        <p className="text-2xs text-fg-dim leading-relaxed">To run this with full control of your computer:</p>
      </div>
      {/* WHY a callout (UX review 1, U2; Destin R-6 "improve this visually"): a
          script pausing to ask for admin partway through is the shape of an
          attack, so who is asking and how to judge it stand out from the text. */}
      {ask.via && (
        <Callout tone="info" title={`Asked partway through ${ask.via}`}>
          Only type your password if you expected this step.
        </Callout>
      )}
      <p className="text-2xs leading-relaxed text-fg-2 bg-inset/70 px-2 py-1.5 rounded-sm break-all font-mono">
        {ask.command}
      </p>
      {/* Destin R-4/R-5: a wrong try is a yellow warning banner, not a line of text. */}
      {wrong && (
        <div role="alert">
          <Callout tone="warning" title="Wrong password">
            {ask.triesLeft === 1
              ? '1 try left. Another wrong one may lock you out of admin actions for about 10 minutes.'
              : `${ask.triesLeft} tries left.`}
          </Callout>
        </div>
      )}
      <InputGroup size="sm" disabled={sending}>
        {/* WHY these attributes: stop browsers and password managers offering to
            save it (Destin: never saved), and stop spellcheck sending it anywhere. */}
        <InputGroup.Field
          ref={inputRef}
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Password"
          aria-label="Your computer password"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          data-1p-ignore
          data-lpignore="true"
          disabled={sending}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
          onClick={() => { setShown((v) => !v); inputRef.current?.focus(); }}
        >
          {shown ? <EyeOffIcon className="w-3.5 h-3.5" /> : <EyeIcon className="w-3.5 h-3.5" />}
        </Button>
      </InputGroup>
      <p className="text-3xs text-fg-muted leading-relaxed">
        Used once for this step, then erased. It's never saved, and the assistant never sees it.
      </p>
      {/* Same status-colour carve-out as PermissionButtons (spec §11, change 61);
          full width per G-28. */}
      <button
        type="submit"
        disabled={sending || !value}
        className={`w-full px-3 ${pad} text-xs font-medium rounded-lg bg-green-400/60 hover:bg-green-400/80 text-green-100 transition-colors disabled:opacity-50`}
      >
        Confirm
      </button>
    </form>
  );
}
