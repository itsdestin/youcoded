// propose.ts — the app's half of "the assistant proposes an automation" (pages-finish step 4; build plan
// decision 13). Both kinds of chat pass their steps through here; when one is the ProposeAutomation tool,
// the description is turned into a draft (shared/propose-automation.ts) and sent to the windows, where the
// "Check this automation" popup opens on it. Nothing is saved here.
//
// WHY from the chat's own record and not from the tool: the tool runs in two different places (the app's
// own loop, or a small program Claude Code starts) and neither can reach the screens; the record of the
// step reaches this process the same way from both.
import { randomUUID } from 'node:crypto';
import type { AutomationLink, AutomationSummary } from '../../shared/automation-types';
import type { PageSummary } from '../../shared/pages-types';
import type { TranscriptEvent } from '../../shared/types';
import { draftFromProposal, isProposeAutomationTool, type ProposalContext } from '../../shared/propose-automation';

export interface ProposalWatcherDeps {
  pages: () => Promise<PageSummary[]>;
  /** The model the chat runs on, or null when it is not known (the draft then starts on Claude Sonnet). */
  modelFor: (sessionId: string) => ProposalContext['model'] | null;
  /** Show the draft to the person. */
  show: (draft: AutomationSummary, sessionId: string) => void;
}

const DEFAULT_MODEL: ProposalContext['model'] = { name: 'Claude Sonnet', runsOn: { runtime: 'claude', modelId: 'sonnet' }, subscription: true };

/** The page the assistant named: by the app's id, by the shorter id its page tools list ("money",
 *  "project:money"), or by its exact name. */
export function pageNamed(pages: readonly PageSummary[], key: unknown): AutomationLink | undefined {
  if (typeof key !== 'string' || !key.trim()) return undefined;
  const k = key.trim();
  const slug = k.replace(/^project:/, '');
  const p = pages.find((x) => x.id === k) ?? pages.find((x) => x.id.endsWith(`:${slug}`)) ?? pages.find((x) => x.name === k);
  return p ? { kind: 'page', id: p.id, name: p.name, ...(p.icon ? { icon: p.icon } : {}) } : undefined;
}

/** Returns the function both chat streams call with every event. */
export function watchProposals(deps: ProposalWatcherDeps): (event: TranscriptEvent) => void {
  // A step can be reported more than once (a resend, a second window's replay); each is shown once.
  const seen = new Set<string>();
  return (event) => {
    if (event.type !== 'tool-use') return;
    const d = event.data as { toolUseId?: string; toolName?: string; toolInput?: unknown };
    if (!isProposeAutomationTool(d.toolName) || !d.toolUseId || seen.has(d.toolUseId)) return;
    seen.add(d.toolUseId);
    if (seen.size > 500) seen.delete(seen.values().next().value as string);
    void (async () => {
      const input = (d.toolInput ?? {}) as { page?: unknown };
      const page = pageNamed(await deps.pages().catch(() => []), input.page);
      const r = draftFromProposal(d.toolInput, { id: `job-${randomUUID().slice(0, 8)}`, model: deps.modelFor(event.sessionId) ?? DEFAULT_MODEL, ...(page ? { page } : {}) });
      // An unusable proposal shows nothing: the assistant was already told what the tool needs by its
      // description, and a half-filled popup would ask the person to approve something nobody wrote.
      if (r.ok) deps.show(r.draft, event.sessionId);
    })();
  };
}
