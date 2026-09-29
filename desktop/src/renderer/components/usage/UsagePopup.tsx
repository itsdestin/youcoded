// The usage popup (design 2026-09-29, Q-1 "both"): what clicking a usage or
// cost chip in the status bar opens. Before this, those chips jumped straight
// to a provider's website; that link is now one button per provider in here.
// Top: every limit and balance right now. Below: the same history as Settings.
import React from 'react';
import { Button, Dialog } from '../ui';
import { PlanWindows, WindowRow, type PlanUsage } from '../plan-windows';
import { OPENROUTER_CREDITS_URL } from '../../../shared/provider-types';
import type { UsageAccounts } from '../../../shared/usage-types';
import { UsageStats } from './UsageStats';
import { usePlanWindows, useUsageAccounts } from './usage-live';

function openExternal(url: string) {
  void (window as any).claude.shell.openExternal(url);
}

/** ChatGPT's extras (Q-6): a limit on one model, and extra credits. Shown only
 *  when ChatGPT reports them. Shared with the Cloud providers row. */
export function ChatGptExtras({ accounts }: { accounts: UsageAccounts | null }) {
  const c = accounts?.chatgpt;
  if (!c?.modelLimits?.length && !c?.credits) return null;
  return (
    <div className="space-y-2">
      {c.modelLimits?.map((l) => (
        <WindowRow key={l.model} label={`${l.model} limit`} win={{ utilization: l.utilization, resets_at: l.resets_at }} />
      ))}
      {c.credits && (
        <p className="flex justify-between text-xs">
          <span className="text-fg-muted">Extra credits</span>
          <span className="text-fg-2 tabular-nums">{c.credits.unlimited ? 'Unlimited' : `${c.credits.balance.toLocaleString()} left`}</span>
        </p>
      )}
    </div>
  );
}

function hasWindows(u: PlanUsage | null): boolean {
  return !!(u?.five_hour || u?.seven_day || u?.other?.length);
}

/** One provider's block: name + its own page on the right (G-28), then bars. */
function Block({ name, link, linkLabel, children }: { name: string; link?: string; linkLabel?: string; children: React.ReactNode }) {
  return (
    <div className="bg-inset/50 rounded-lg px-3 py-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-fg">{name}</p>
        {link && (
          <Button variant="secondary" size="sm" onClick={() => openExternal(link)}>{linkLabel}</Button>
        )}
      </div>
      {children}
    </div>
  );
}

export function UsagePopup({ open, onClose }: { open: boolean; onClose: () => void }) {
  // WHY the split: the status bar keeps this mounted in every window, and a
  // closed popup must do no work (performance.md rule 2) — the subscription,
  // the balance read and the history read start only when it opens.
  if (!open) return null;
  return <UsagePopupBody onClose={onClose} />;
}

function UsagePopupBody({ onClose }: { onClose: () => void }) {
  const { claude, chatgpt } = usePlanWindows();
  const accounts = useUsageAccounts();
  const openRouterBalance = accounts?.openrouter?.balanceUsd;
  const anyLive = hasWindows(claude) || hasWindows(chatgpt) || openRouterBalance != null;

  return (
    <Dialog open onClose={onClose} title="Usage" size="panel" screen="chat/usage">
      <div className="space-y-4">
        {anyLive && (
          <section className="space-y-2">
            <h3 className="text-2xs font-medium text-fg-muted tracking-wide uppercase">Limits right now</h3>
            {hasWindows(claude) && (
              <Block name="Claude plan" link="https://claude.ai/settings/usage" linkLabel="claude.ai ↗">
                <PlanWindows usage={claude} />
              </Block>
            )}
            {hasWindows(chatgpt) && (
              <Block name="ChatGPT plan" link="https://chatgpt.com/#settings/Account" linkLabel="chatgpt.com ↗">
                <PlanWindows usage={chatgpt} />
                <ChatGptExtras accounts={accounts} />
              </Block>
            )}
            {openRouterBalance != null && (
              <Block name="OpenRouter" link={OPENROUTER_CREDITS_URL} linkLabel="Add credit ↗">
                <p className="flex justify-between text-xs">
                  <span className="text-fg-muted">Credit left</span>
                  <span className="text-fg-2 tabular-nums">${openRouterBalance.toFixed(2)}</span>
                </p>
              </Block>
            )}
          </section>
        )}

        <section className="space-y-2">
          <h3 className="text-2xs font-medium text-fg-muted tracking-wide uppercase">History</h3>
          <UsageStats compact />
        </section>

        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={() => {
            onClose();
            window.dispatchEvent(new CustomEvent('youcoded:open-model-providers'));
          }}>
            Open in Settings
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
