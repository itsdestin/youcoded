// Live account figures for the usage view (design 2026-09-29): the plan
// windows that already arrive on status:data, plus the balances Q-5/Q-6 add.
import { useEffect, useState } from 'react';
import type { PlanUsage } from '../plan-windows';
import type { UsageAccounts } from '../../../shared/usage-types';

/** Both plans' windows. Subscribed here, not threaded from App, for the same
 *  reason ModelProvidersPopup's useClaudePlanUsage is: the popup and the
 *  Settings page are both far from App and nothing between needs them. */
export function usePlanWindows(): { claude: PlanUsage | null; chatgpt: PlanUsage | null } {
  const [claude, setClaude] = useState<PlanUsage | null>(null);
  const [chatgpt, setChatgpt] = useState<PlanUsage | null>(null);
  useEffect(() => {
    const handler = window.claude.on.statusData((data: any) => {
      setClaude(data?.usage ?? null);
      setChatgpt(data?.chatgptUsage ?? null);
    });
    return () => { window.claude.off('status:data', handler); };
  }, []);
  return { claude, chatgpt };
}

/** OpenRouter balance, ChatGPT credits and per-model limits. null until read;
 *  a failed read leaves it empty, so a line that cannot be answered is simply
 *  absent rather than wrong. */
export function useUsageAccounts(): UsageAccounts | null {
  const [accounts, setAccounts] = useState<UsageAccounts | null>(null);
  useEffect(() => {
    let live = true;
    (window as any).claude.usage?.accounts?.().then(
      (a: UsageAccounts) => { if (live) setAccounts(a); },
      () => { if (live) setAccounts({}); },
    );
    return () => { live = false; };
  }, []);
  return accounts;
}
