// The usage popup (design 2026-09-29, Q-1 "both"): what clicking a usage or
// cost chip in the status bar opens. Before this, those chips jumped straight
// to a provider's website; that link is now a button inside the view.
import React from 'react';
import { Dialog } from '../ui';
import { WindowRow } from '../plan-windows';
import type { UsageAccounts, UsageProviderId } from '../../../shared/usage-types';
import { UsageView, type UsageRange } from './UsageView';

/** ChatGPT's extras (Q-6): a limit on one model, and extra credits. Shown only
 *  when ChatGPT reports them. Used by the Cloud providers ChatGPT card. */
export function ChatGptExtras({ accounts }: { accounts: UsageAccounts | null }) {
  const c = accounts?.chatgpt;
  if (!c?.modelLimits?.length && !c?.credits) return null;
  return (
    <div className="space-y-2">
      {c.modelLimits?.map((l) => (
        <WindowRow key={l.model} label={`${l.model}'s own limit`} win={{ utilization: l.utilization, resets_at: l.resets_at }} />
      ))}
      {c.credits && (
        <p className="flex justify-between text-xs">
          <span className="text-fg-muted">Extra credits</span>
          <span className="text-fg-2 tabular-nums">{c.credits.unlimited ? 'Unlimited' : `${c.credits.balance.toLocaleString()} credits left`}</span>
        </p>
      )}
    </div>
  );
}

export function UsagePopup({ open, onClose, initial, initialRange, screen = 'chat/usage' }: {
  open: boolean; onClose: () => void; initial?: UsageProviderId; initialRange?: UsageRange;
  /** The photo-only build's name for what is showing (`chat/usage/chatgpt`…). */
  screen?: string;
}) {
  // WHY render nothing while closed: the status bar keeps this mounted in
  // every window, and a closed popup must do no work (performance.md rule 2)
  // — the subscription and the reads start only when it opens.
  if (!open) return null;
  return (
    <Dialog open onClose={onClose} title="Usage" size="panel" screen={screen}>
      <UsageView
        // Re-keyed so a new starting account or range takes effect even while
        // the popup is already open.
        key={`${initial ?? ''}-${initialRange ?? ''}`}
        initial={initial}
        initialRange={initialRange}
        onManage={() => {
          onClose();
          window.dispatchEvent(new CustomEvent('youcoded:open-model-providers'));
        }}
      />
    </Dialog>
  );
}
