import type { AskRequest, AskDecision, PermissionBroker } from '../permission-broker';
import { rememberedRuleFor, type HarnessSessionOpts } from '../harness-session';
import type { PermissionRule } from '../../../shared/permission-types';
import { SPECIALIST_ASK_HOLD_MS } from './limits';

// Task 11: doom_loop is a synthetic budget ask that never supports "Always
// allow", even for a root session: harness-session.ts only reads
// AskDecision.always at the ONE call site that gates on decide() (the normal
// gated-tool ask), never for doom_loop. A routed copy of the same ask must not
// gain a capability the direct (root-session) version never had. Exported
// (Task 11 fix pass, Finding 2) so native-session-host.ts's onLateResponse can
// apply the SAME exclusion to a LATE "Always allow".
export const BUDGET_ASK_TOOL_NAMES = new Set(['doom_loop']);

// Child ask routing (plan 1b, Task 8). Replaces child-ask-policy.ts's
// deny-everything stub: a specialist child has no user of its own, but it now
// has a PARENT that does. doom_loop and a decide-originated ask (today only
// the deny-listed-inside-a-granted-envelope case — see
// child-permissions.ts branch 5) re-register on the broker under the
// PARENT's sessionId, with the specialist's identity attached, so the
// existing permission card renders it exactly like any other ask. The child
// waits up to SPECIALIST_ASK_HOLD_MS; if nobody answers by then, the call
// resolves with ASK_REDIRECT_MESSAGE so the child can keep making progress
// instead of remaining blocked on an unanswered parent permission card.
//
// Interactive (AskUserQuestion) and external-forced asks are the two
// exceptions that STILL deny instantly, exactly as child-ask-policy.ts always
// denied everything:
//  - AskUserQuestion is never in a specialist's allowedTools (cold-start
//    contract), so this branch is currently unreachable in production — kept
//    as belt-and-suspenders in case a future definition ever lists it, since
//    there genuinely is no user for an interactive tool to ask through a
//    specialist.
//  - An external-directory forced ask means the child tried to touch a path
//    outside its work directory — routing THAT to the parent would ask the
//    user to approve the specialist leaving its assigned sandbox, which is a
//    different (and much bigger) decision than the ones this route is for.
// Both denials carry FACTUAL, non-blaming copy (never "the user declined" —
// no user was ever consulted for either case; error-message-standards.md).
export const ASK_REDIRECT_MESSAGE =
  'This action needs the user\'s direct approval, and the user has not responded yet — '
  + 'the request is still pending on their screen. Continue any assigned work that does NOT '
  + 'depend on the blocked action. Do NOT attempt the blocked action by any other means or '
  + 'work around it. Do NOT build further work on the assumption it will be approved. '
  + 'If everything left depends on it, write up your progress so far and finish with your report.';

export interface ChildAskRouterDeps {
  /** Structural, not the concrete class — a test can inject a fake with just
   *  an `ask()` method instead of standing up a real broker. */
  broker: Pick<PermissionBroker, 'ask'>;
  parentId: string;
  childId: string;
  agentType: string;
  title: string;
  /** The Task-tool call that spawned this specialist (Task 6, 1c) — rides
   *  onto the routed ask's `specialist` payload so the renderer can nest the
   *  ask row under the right specialist card instead of just labelling it. */
  parentToolCallId: string;
  /** Overridable for tests (default SPECIALIST_ASK_HOLD_MS = 5 minutes). */
  timeoutMs?: number;
  /** Task 11 (closes a review finding): called when the parent answers a
   *  routed ask with "Always allow". Optional so a test that doesn't care
   *  about persistence can omit it; the real wiring (native-session-host.ts's
   *  createChild) always supplies NativeSessionHost's own rememberRule(),
   *  bound to the PARENT's id/cwd — never called with anything the caller
   *  didn't ask to persist. */
  remember?: (rule: PermissionRule) => void;
}

export function childAskRouter(deps: ChildAskRouterDeps): NonNullable<HarnessSessionOpts['askUser']> {
  return async (req: AskRequest): Promise<AskDecision> => {
    if (req.toolName === 'AskUserQuestion') {
      return {
        behavior: 'deny',
        message: 'AskUserQuestion is not available to this specialist — there is no user it can ask directly. Continue with your best judgment, or note the open question in your final report.',
      };
    }
    if (req.external) {
      return {
        behavior: 'deny',
        message: `${req.toolName} on a path outside this specialist's work directory cannot be approved — specialists cannot ask the user to approve leaving their assigned work directory. Stay within it, or note the constraint in your report.`,
      };
    }
    const decision = await deps.broker.ask(
      {
        ...req,
        sessionId: deps.parentId,
        raisedBy: deps.childId,
        specialist: { childId: deps.childId, agentType: deps.agentType, title: deps.title, parentToolCallId: deps.parentToolCallId },
      },
      {
        timeoutMs: deps.timeoutMs ?? SPECIALIST_ASK_HOLD_MS,
        onTimeout: () => ({ behavior: 'deny', message: ASK_REDIRECT_MESSAGE }),
      },
    );
    // "Always allow" on a routed ask (Task 11 — the dropped-decision finding):
    // a root session's HarnessSession would emit 'remember-rule' on itself for
    // this same decision, but a specialist child is never wire()'d, so that
    // event has no listener. Persist it HERE instead, scoped to THIS
    // specialist's agentType (never unscoped — an unscoped grant earned by a
    // specialist would widen the user's own permissions, the exact leak Task
    // 11's scope filter exists to prevent). No `!req.external` check needed
    // here — the external branch above already returned before this point, so
    // an externally-forced ask can never reach here at all. The budget-ask
    // exclusion below is the one exception that DOES still need a check:
    // doom_loop reaches this same code path (it is not filtered out above),
    // but never supports "Always allow" even for a root session.
    //
    // Fix (Important 6, final review): rememberedRuleFor (harness-session.ts)
    // is the ONE function that turns (toolName, subject, grantScope) into the
    // rule to store — the same builder a root session's own ask uses. This
    // used to hand-build `{tool, pattern: subject, action:'allow'}` itself,
    // which silently discarded the grant WIDTH the user picked (always
    // storing an exact-match rule regardless of decision.grantScope) and
    // skipped the builder's own "never rememberable" cases (e.g. a bare
    // `git push`, whose bashGrantOptions is empty). `specialist` is merged in
    // here, not inside the shared builder — that function has no concept of
    // a specialist key; it's the same one a root session's ask reuses as-is.
    if (decision.behavior === 'allow' && decision.always && !BUDGET_ASK_TOOL_NAMES.has(req.toolName)) {
      const rule = rememberedRuleFor(req.toolName, req.subject, decision.grantScope);
      if (rule) deps.remember?.({ ...rule, specialist: deps.agentType });
    }
    return decision;
  };
}
