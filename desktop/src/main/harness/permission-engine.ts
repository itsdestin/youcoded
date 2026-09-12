// The spec's ONE pure decision function (§2.4). Layer precedence, lowest → highest:
//   presetRules → modeRules → denyList → rememberedRules
// Within the concatenation the LAST matching rule wins, so a later layer's
// match always beats an earlier layer's (remembered user decisions are the
// final word — including over the deny-list, per the review-ruling tier split).
// Tool-layer guards (secret paths, external_directory) are NOT here — they run
// in defineTool() below all configuration and cannot be expressed as rules.
// NOTE: `denyListed` tracks the winning rule's ORIGIN (deny-list layer) — this
// is only safe because remembered rules are allow-originated today (the "Always
// allow" flow persists only allow rules); a future feature persisting remembered
// ask/deny rules must revisit this consequence-warning logic.
import { ruleMatches, type MatchContext } from '../../shared/subject-glob';
import type { PermissionDecision, PermissionRule } from '../../shared/permission-types';

export interface PermissionLayers {
  presetRules: PermissionRule[];
  modeRules: PermissionRule[];
  denyList: PermissionRule[];
  rememberedRules: PermissionRule[];
}

export function decidePermission(
  tool: string,
  subject: string | undefined,
  layers: PermissionLayers,
  // What ruleMatches needs to know about the session: whether its Bash tool runs
  // PowerShell, which also executes code inside arguments (subject-glob.ts).
  context: MatchContext = {},
): PermissionDecision {
  // Concatenate lowest → highest precedence. `deny: true` tags only the
  // deny-list layer so denyListed reflects the WINNING rule's origin.
  const ordered = [
    ...layers.presetRules.map((r) => ({ r, deny: false })),
    ...layers.modeRules.map((r) => ({ r, deny: false })),
    ...layers.denyList.map((r) => ({ r, deny: true })),
    ...layers.rememberedRules.map((r) => ({ r, deny: false })),
  ];
  let winner: { r: PermissionRule; deny: boolean } | null = null;
  for (const entry of ordered) {
    if (entry.r.tool !== '*' && entry.r.tool !== tool) continue;
    // ruleMatches owns what a WHOLE rule means — exact vs glob, plus the two
    // safety rules that keep a wildcard grant from swallowing a second command
    // or a destructive flag. Never call subjectMatches from a decision path.
    if (!ruleMatches(entry.r, subject ?? '', context)) continue;
    winner = entry; // last match wins
  }
  if (!winner) return { action: 'ask', denyListed: false }; // safe default — never silent-allow
  return { action: winner.r.action, denyListed: winner.deny };
}
