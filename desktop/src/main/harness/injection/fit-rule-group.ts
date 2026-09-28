import { fitInjection } from './injection-budget';
import type { PathTrigger } from './path-triggers';

/** WHY: one pre-write boundary can activate many rules; granting each the
 * entire injection budget would silently multiply the model's context cost. */
export function fitRuleGroupDelivery(rules: readonly PathTrigger[], budgetTokens: number): { contents: string[]; omitted: string[] } {
  const budget = Math.max(0, Math.floor(budgetTokens * 4));
  const wrap = (source: string, body: string) => `<project-rule source="${source}">\n${body}\n</project-rule>`;
  const floor = rules.map(r => `[Read ${r.source}: rule shortened or omitted.]`);
  const overhead = rules.reduce((n, r) => n + wrap(r.source, '').length, 0);
  const separators = Math.max(0, rules.length - 1) * 2;
  if (overhead + floor.reduce((n, text) => n + text.length, 0) + separators > budget) {
    // Every source must remain identifiable when space permits. Never claim a
    // body was supplied if the budget cannot even hold its labelled wrapper.
    const sources = rules.map(r => r.source).join(', ');
    const notice = `[Project rules omitted to fit context. Read: ${sources}]`;
    return { contents: [notice.length <= budget ? notice : '[Project rules omitted.]'.slice(0, budget)], omitted: rules.map(r => r.id) };
  }
  let remaining = budget - overhead - separators;
  const omitted: string[] = [];
  const contents = rules.map((rule, i) => {
    const reserve = floor.slice(i + 1).reduce((n, s) => n + s.length, 0);
    const room = Math.max(floor[i].length, Math.floor((remaining - reserve) / (rules.length - i)));
    const fitted = fitInjection(rule.body, Math.floor(room / 4), rule.source);
    const body = fitted.text.length <= room ? fitted.text : floor[i];
    // fitInjection can itself return only a truncation notice. A label plus a
    // notice is NOT delivered guidance, even if its wrapper technically fits.
    if (body === floor[i] || (fitted.truncated && body.trimStart().startsWith('[...truncated'))) omitted.push(rule.id);
    remaining -= body.length;
    return wrap(rule.source, body);
  });
  return { contents, omitted };
}

/** No rule body may authorize an edit through an omission-only notice. */
export function ruleFitRefusal(rules: readonly PathTrigger[], budgetTokens: number): string | null {
  const missing = fitRuleGroupDelivery(rules, budgetTokens).omitted;
  if (!missing.length) return null;
  const sources = rules.filter(t => missing.includes(t.id));
  const detail = sources.slice(0, 3).map(t => t.source).join(', ');
  return `Not run: project rules could not fit this model's context (${detail}${sources.length > 3 ? ` and ${sources.length - 3} more` : ''}). This file change was not run. Use a model with a larger context window before retrying this change.`;
}

/** Keep the original formatter interface for callers that display fitted text;
 * execution authorization uses fitRuleGroupDelivery's explicit omission IDs. */
export function fitRuleGroup(rules: readonly PathTrigger[], budgetTokens: number): string[] {
  return fitRuleGroupDelivery(rules, budgetTokens).contents;
}
