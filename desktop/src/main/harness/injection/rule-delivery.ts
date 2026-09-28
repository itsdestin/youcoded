import type { NativeTool } from '../tools/types';
import { parseToolArgs } from '../tool-args';
import { fitInjection } from './injection-budget';
import { fitRuleGroupDelivery } from './fit-rule-group';
import type { PathTrigger, TriggerIndex } from './path-triggers';

export interface PathCall { toolName: string; input: unknown }
const fullContent = (t: PathTrigger, budget: number) =>
  `<project-rule source="${t.source}">\n${fitInjection(t.body, budget, t.source).text}\n</project-rule>`;
// fitInjection may fit *only* a notice; that is not guidance for a later write.
const noticeOnly = (content: string) => /<project-rule source="[^"]*">\n\s*\[\.\.\.truncated/.test(content);

/** WHY: both post-read and pre-write selection use the same validated subject
 * and exact retained-body dedupe. Non-path tool subjects are never file paths. */
export function pendingRules(calls: readonly PathCall[], index: TriggerIndex | undefined,
  byName: ReadonlyMap<string, NativeTool>, budget: number, nonPath: ReadonlySet<string>,
  injected: Set<string>, retained: Set<string>): PathTrigger[] {
  if (!index) return [];
  const pending: PathTrigger[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    if (nonPath.has(call.toolName)) continue;
    const tool = byName.get(call.toolName);
    if (!tool) continue;
    const parsed = parseToolArgs(tool, call.input);
    if (!parsed.success) continue;
    const subject = tool.permissionSubject(parsed.data);
    if (!subject) continue;
    for (const rule of index.match(subject)) {
      if (seen.has(rule.id) || injected.has(rule.id)) continue;
      seen.add(rule.id);
      const full = fullContent(rule, budget);
      if (retained.has(full) && !noticeOnly(full)) { injected.add(rule.id); continue; }
      pending.push(rule);
    }
  }
  // A resumed pre-write group may retain its *bounded* body rather than the
  // per-file full-budget fit. Compare exact app-generated content, not source
  // alone; a changed body must still be delivered again.
  const bounded = fitRuleGroupDelivery(pending, budget);
  return pending.filter((rule, i) => {
    const content = bounded.contents[pending.length > 1 && bounded.contents.length === 1 ? 0 : i];
    if (!bounded.omitted.includes(rule.id) && content?.startsWith('<project-rule source=') && retained.has(content)) {
      injected.add(rule.id);
      return false;
    }
    return true;
  });
}

/** Once a complete paired tool result has been committed, publish guidance as
 * app-generated history. A partial rule counts as delivered; do not replan it forever. */
export function deliverRules(rules: readonly PathTrigger[], budget: number, bounded: boolean,
  injected: Set<string>, retained: Set<string>, append: (text: string) => void): void {
  const fitted = bounded ? fitRuleGroupDelivery(rules, budget) : null;
  const contents = fitted?.contents ?? rules.map(r => fullContent(r, budget));
  rules.forEach((rule, i) => {
    const content = contents[bounded && contents.length === 1 && rules.length > 1 ? 0 : i];
    if (fitted?.omitted.includes(rule.id) || (!bounded && noticeOnly(content))) {
      if (content && !retained.has(content)) { retained.add(content); append(content); }
      return; // a notice-only Read cannot authorize a later Write
    }
    injected.add(rule.id);
    if (!content || retained.has(content)) return;
    retained.add(content);
    append(content);
  });
}
