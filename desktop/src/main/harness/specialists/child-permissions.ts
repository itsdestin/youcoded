// Permission composition for a specialist child (plan 1a, spec §5). A child's
// decide() is the PARENT's decide() with two caps stacked on top of it — the
// definition's tool allowlist and its charter — plus the launch envelope.
//
// The whole design in one sentence: a child can never do something the parent
// could not, and usually much less. Pure function over an injected parentDecide,
// mirroring permission-engine.ts's style (no I/O, no state, testable alone).
import type { PermissionDecision } from '../../../shared/permission-types';

/** Tools that can CHANGE something, for the read-only charter check.
 *
 *  WHY hardcoded rather than derived: there is no "writes things" flag on
 *  NativeTool to read, and inventing one would put the classification in ten
 *  files instead of one. Bash is in the set because it is write-capable BY
 *  NATURE — its subject is an arbitrary command string, so no argument
 *  inspection can make `bash -c 'rm -rf .'` look read-only. MCP tools are
 *  deliberately out of scope here: children get no MCP servers at all in 1a
 *  (the cold-start contract), so an MCP tool name can never reach this check;
 *  when 1b gives children MCP access this set stops being sufficient and the
 *  charter check must consult the server's own declared annotations. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'Bash']);

export interface ChildPermissionInputs {
  /** The parent session's decide() — the full configured stack (preset rules,
   *  the parent's live permission mode, the destructive deny-list, remembered
   *  "Always allow" rules). Built against the PARENT's session id and cwd. */
  parentDecide: (tool: string, subject: string | undefined) => Promise<PermissionDecision>;
  charter: 'read-only' | 'read-write';
  allowedTools: string[];
  /** True when the user approved this specialist's launch (the Task-tool ask IS
   *  the consent moment — spec §5). Inside a granted envelope the child does not
   *  re-ask for work the user already said yes to; without the envelope an
   *  in-charter tool the parent would ASK about passes through as 'ask' (step 7
   *  below), which childAskRouter then routes to the parent's card too — it is
   *  no longer an effective refusal as it was under plan 1a's deny-everything
   *  child-ask-policy.ts, just a real ask with a real (if delayed) answer. */
  envelopeGranted: boolean;
}

/**
 * Compose the child's decide(). Order is strictest-first (spec §5):
 *   1. tool not in the definition's allowlist → deny, naming what IS available
 *   2. write tool under a read-only charter  → deny, naming the charter
 *   3. parent says deny                      → pass that deny through unchanged
 *   4. parent says allow                     → allow
 *   5. parent says ask + deny-listed         → pass the ask through UNCHANGED, always
 *      (no envelope can override — spec §5; plan 1b Task 8: childAskRouter carries
 *      this to a REAL user via the parent's card instead of hard-denying it)
 *   6. parent says ask + envelope granted    → allow (the user already consented)
 *   7. parent says ask + no envelope         → pass the ask through
 *
 * Steps 1 and 2 short-circuit BEFORE the parent is consulted: parentDecide reads
 * the remembered-rule store (disk), and a tool the child may never call should
 * not cost that read.
 *
 * TOOL-LAYER GUARDS ARE NOT REPLICATED HERE. The credential-path denies and the
 * external-directory verdict live in checkPathGuard, which runs BELOW all
 * configuration inside runOneTool — this function is one of the configuration
 * layers it sits above. Re-implementing any of it here would create a second
 * copy that can drift from the real guard while looking authoritative.
 */
export function buildChildDecide(i: ChildPermissionInputs): ChildPermissionInputs['parentDecide'] {
  const allowed = new Set(i.allowedTools);
  return async (tool: string, subject: string | undefined): Promise<PermissionDecision> => {
    // 1. Outside the definition's toolset. Named, not silent: the refusal lists
    //    what this specialist DOES have so the model's next step is obvious
    //    (same reasoning as SkillNotFound naming the installed skills).
    if (!allowed.has(tool)) {
      return {
        action: 'deny',
        denyListed: false,
        message: `The ${tool} tool is not available to this specialist. Available tools: ${i.allowedTools.join(', ')}. Do the work with those, or report back that it cannot be done without ${tool}.`,
      };
    }
    // 2. Charter cap. Belt-and-suspenders with (1) — a definition that lists a
    //    write tool under a read-only charter is a bug in the definition, and
    //    this is where that bug stops being exploitable rather than shipping.
    if (i.charter === 'read-only' && WRITE_TOOLS.has(tool)) {
      return {
        action: 'deny',
        denyListed: false,
        message: `The ${tool} tool cannot run: this specialist has a read-only charter and may not modify anything. Report what you found instead of changing it.`,
      };
    }
    const parent = await i.parentDecide(tool, subject);
    // 3. A parent deny is final — the envelope grants what the PARENT could do,
    //    never more. Passed through unchanged so its own message (if any) is
    //    what the model reads: that message is the real reason.
    if (parent.action === 'deny') return parent;
    // 4. Parent allow → allow.
    if (parent.action === 'allow') return parent;
    // The destructive deny-list ALWAYS cuts through the envelope (spec §5): approving
    // a specialist's LAUNCH is consent for its charter of work, not for `rm -rf` /
    // `git push` / `sudo`. Plan 1a had no user to ask, so this hard-denied with a
    // typed message; plan 1b Task 8 gives specialists a real path to the parent's
    // user via childAskRouter, so this now passes the ask through UNCHANGED instead —
    // the router re-registers it under the PARENT's session with the specialist's
    // identity attached, and the child waits for the person's answer (no time
    // limit, like the main assistant's own asks). A
    // remembered "Always allow" on the parent wins upstream (it produces action
    // 'allow', never reaching this branch) — the user stays sovereign either way.
    if (parent.action === 'ask' && parent.denyListed) {
      return parent;
    }
    // 6/7. Parent ask. The launch approval already covered this work, so inside
    //      a granted envelope it becomes an allow. denyListed is hardcoded
    //      false here (not `parent.denyListed`): step 5 above already
    //      intercepted every deny-listed ask before this line, so
    //      `parent.denyListed` is provably always false by the time we get
    //      here — a deny-listed ask can never reach this branch. Without an
    //      envelope the ask passes through untouched — this function never
    //      escalates on its own.
    return i.envelopeGranted ? { action: 'allow', denyListed: false } : parent;
  };
}
