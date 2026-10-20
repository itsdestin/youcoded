import React from 'react';
import { Radio, RadioGroup } from '../ui';

import type { AdminApprovalScope } from '../../../shared/admin-approval';
export type { AdminApprovalScope } from '../../../shared/admin-approval';
const OPTIONS: { scope: AdminApprovalScope; label: string; limits: string }[] = [
  { scope: 'command', label: 'Only this exact command', limits: 'This exact command in this project, in any permission mode.' },
  { scope: 'full-auto', label: 'Always allow in Full Auto', limits: 'All passwordless admin commands, across projects and future sessions. Full Auto only.' },
  { scope: 'session', label: 'Allow all for this session', limits: 'All passwordless admin commands in any permission mode. Resets when this session closes.' },
];

/** WHY: extend the existing Always allow confirmation, not a separate admin
 * menu. Match its compact width choices and keep its command, warning and actions. */
export function AdminApprovalChoices({ scope, onChange, responding }: {
  scope: AdminApprovalScope;
  onChange: (scope: AdminApprovalScope) => void;
  responding: boolean;
}) {
  return <>
    <RadioGroup options={OPTIONS.map(o => o.scope)} value={scope}
      onChange={next => onChange(next as AdminApprovalScope)} aria-label="How much to allow"
      className="flex flex-col gap-1.5 pt-0.5">
      {OPTIONS.map(option => (
        <label key={option.scope} className="flex items-start gap-2 text-left disabled:opacity-50 rounded-md px-1 -mx-1 state-layer cursor-pointer">
          <Radio checked={scope === option.scope} onChange={() => onChange(option.scope)} disabled={responding}
            aria-label={option.label} tabIndex={scope === option.scope ? 0 : -1} className="mt-0.5" />
          <span className="text-2xs text-fg-2 break-all">{option.label}</span>
        </label>
      ))}
    </RadioGroup>
    <p className="text-3xs text-fg-muted leading-relaxed">{OPTIONS.find(o => o.scope === scope)?.limits} Password entry is still required when needed.</p>
  </>;
}
