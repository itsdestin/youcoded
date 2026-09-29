import type { ModelMessage } from 'ai';
import { isAppGenerated } from '../compaction';

/** WHY: a session-lifetime ID cannot vouch for guidance discarded by clear or
 * summary. Inspect only at history replacement boundaries, never per token.
 * Literal source labels are accepted only on app-authored, complete rule blocks;
 * a human quotation or a summary mentioning a rule does not mean it is loaded. */
export function retainedRuleMessages(history: readonly ModelMessage[]): Set<string> {
  const messages = new Set<string>();
  for (const message of history) {
    if (!isAppGenerated(message) || typeof message.content !== 'string') continue;
    const match = /^<project-rule source="([^\r\n]*)">\n[\s\S]*\n<\/project-rule>$/.exec(message.content);
    if (match) messages.add(message.content);
  }
  return messages;
}
