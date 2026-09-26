import React, { useEffect, useRef, useState } from 'react';
import type { PasswordAsk } from '../../../shared/types';
import { TextInput } from '../ui';
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
 */
export function AdminPasswordPrompt({ ask, onSubmit, onSkip }: {
  ask: PasswordAsk;
  onSubmit?: (password: string) => void;
  onSkip?: () => void;
}) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // WHY focus the field: with focus left in the message box, a password typed
  // there and sent with Enter would reach the assistant and the chat history —
  // the one leak this card exists to prevent.
  useEffect(() => { inputRef.current?.focus(); }, [ask.requestId, ask.triesLeft]);

  // A wrong try re-asks with the field emptied.
  useEffect(() => { setValue(''); setSending(false); }, [ask.triesLeft]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!value || sending) return;
    setSending(true);
    onSubmit?.(value);
    // WHY clear at once: the text must not linger in React state after send.
    setValue('');
  };

  const wrong = typeof ask.triesLeft === 'number';
  const pad = isAndroid() ? 'py-2' : 'py-1';

  return (
    <div className="px-3 py-2 space-y-2 border-t border-edge bg-inset/30" data-testid="admin-password-prompt">
      <div className="space-y-0.5">
        <p className="text-xs font-medium text-fg-2">
          {ask.via ? `${ask.via} needs your computer password` : 'Enter your computer password'}
        </p>
        <p className="text-2xs text-fg-dim leading-relaxed">To run this with full control of your computer:</p>
      </div>
      <p className="text-2xs leading-relaxed text-fg-2 bg-inset/70 px-2 py-1.5 rounded-sm break-all font-mono">
        {ask.command}
      </p>
      <form className="flex items-center gap-2" onSubmit={submit}>
        {/* WHY these attributes: stop browsers and password managers offering to
            save it (Destin: never saved), and stop spellcheck sending it anywhere. */}
        <TextInput
          ref={inputRef}
          size="sm"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Password"
          aria-label="Your computer password"
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          disabled={sending}
          className="flex-1 min-w-0"
        />
        {/* Same status-colour carve-out as PermissionButtons (spec §11, change 61). */}
        <button
          type="submit"
          disabled={sending || !value}
          className={`px-3 ${pad} text-xs font-medium rounded-lg bg-green-400/60 hover:bg-green-400/80 text-green-100 transition-colors disabled:opacity-50 shrink-0`}
        >
          Run it
        </button>
        <button
          type="button"
          disabled={sending}
          onClick={onSkip}
          className={`px-3 ${pad} text-xs font-medium rounded-lg bg-red-400/60 hover:bg-red-400/80 text-red-100 transition-colors disabled:opacity-50 shrink-0`}
        >
          Skip it
        </button>
      </form>
      {wrong && (
        <p role="alert" className="text-2xs text-fg-2 leading-relaxed">
          {ask.triesLeft === 1
            ? "Wrong password. 1 try left. Another wrong one may lock admin commands for about 10 minutes."
            : `Wrong password. ${ask.triesLeft} tries left.`}
        </p>
      )}
      <p className="text-3xs text-fg-muted leading-relaxed">
        Used once for this step, then erased. It's never saved, and the assistant never sees it.
      </p>
    </div>
  );
}
