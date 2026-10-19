import type { NativePermissionMode, PermissionRule } from './permission-types';

export type AdminApprovalScope = 'command' | 'full-auto' | 'session';
const ADMIN_FULL_AUTO_RULE = 'AdminFullAuto';

export function isAdminApprovalScope(value: unknown): value is AdminApprovalScope {
  return value === 'command' || value === 'full-auto' || value === 'session';
}

/** WHY: reuse existing exact-command approvals; only the broader Full Auto
 * choice needs a distinct, mode-gated subject. Session consent never goes to disk. */
export function adminRuleFor(scope: AdminApprovalScope, command: string): PermissionRule | null {
  if (scope === 'session') return null;
  return scope === 'full-auto'
    ? { tool: ADMIN_FULL_AUTO_RULE, action: 'allow', match: 'exact' }
    : { tool: 'Bash', pattern: command, action: 'allow', match: 'exact' };
}

export function hasAdminApproval(rules: PermissionRule[], command: string, mode: NativePermissionMode): boolean {
  return rules.some(rule => rule.action === 'allow' && (
    (rule.tool === ADMIN_FULL_AUTO_RULE && rule.pattern === undefined && mode === 'full-auto') ||
    (rule.tool === 'Bash' && rule.match === 'exact' && rule.pattern === command)
  ));
}
