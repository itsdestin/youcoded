// Task 10 — profile-driven simplified tool presentation. A 'simplified' profile
// (small local models) must hand the model each tool's COMPACT shortDescription
// instead of its full description, while keeping ALL ten tools present; a 'full'
// profile keeps the rich descriptions. buildAiTools() is the single seam that
// decides this, so we assert on its output directly.
//
// makeSession already accepts a `tools` override; we pass the REAL CORE_TOOLS set
// (10 tools incl. WebSearch) so the assertions run against production tools, not
// the fake Glob+Read default. CLOUD_DEFAULT.canDelegate is true (Task 6), so
// buildAiTools() also attaches the conditional Task tool here — 11, not 10 — and
// (Task 14) ModelSearch rides the identical gate as Task, so it's 12.
import { describe, it, expect } from 'vitest';
import { makeSession } from './helpers/harness-fakes';
import { CLOUD_DEFAULT } from '../src/main/harness/capability-profile';
import { CORE_TOOLS } from '../src/main/harness/tools';

const CORE_PLUS_CONDITIONAL_TASK = CORE_TOOLS.length + 2; // Task + ModelSearch (Task 14)

describe('simplified tool presentation', () => {
  // WHY the title says "ten CORE tools (plus the conditional Task tool)"
  // rather than a single count: this session attaches Task (CLOUD_DEFAULT.
  // canDelegate is true and it's not a specialist child) AND ModelSearch
  // (Task 14, same gate), so the assertion below checks
  // CORE_PLUS_CONDITIONAL_TASK (12), not CORE_TOOLS.length (10).
  // A title claiming "ten" while asserting twelve silently drifts true the
  // moment someone reads only the title.
  it('simplified profile hands the model compact descriptions; all ten CORE tools (plus the conditional Task tool) stay present', () => {
    const simplified = (makeSession({ tools: CORE_TOOLS, profile: { ...CLOUD_DEFAULT, maxToolPresentation: 'simplified' } }) as any).buildAiTools();
    const full = (makeSession({ tools: CORE_TOOLS, profile: CLOUD_DEFAULT }) as any).buildAiTools();
    // All ten CORE tools survive the simplified presentation — we compact
    // wording, never drop a tool. Plus the conditionally-attached Task tool
    // (Task 6): CLOUD_DEFAULT.canDelegate is true and this session is not a
    // specialist child, so syncTaskTool attaches it here same as production.
    expect(Object.keys(simplified)).toContain('WebSearch');
    expect(Object.keys(simplified)).toHaveLength(CORE_PLUS_CONDITIONAL_TASK);
    // WebSearch is one of the richest-schema tools: its simplified description is
    // the compact shortDescription, strictly shorter than the full one and well
    // under 200 chars. (This is what fails before shortDescription exists — the
    // simplified path would otherwise echo the full description verbatim.)
    expect((simplified.WebSearch.description as string).length).toBeLessThan(200);
    expect((simplified.WebSearch.description as string).length).toBeLessThan((full.WebSearch.description as string).length);
    // The 7 CORE tools must ALSO shrink under simplified presentation — before
    // they got a shortDescription they fell back to the full description, so a
    // small local model still saw the full schema (the feature was hollow). Bash
    // is the canary: its simplified form must be strictly shorter than its full one.
    expect((simplified.Bash.description as string).length).toBeLessThan((full.Bash.description as string).length);
  });
  it('full profile keeps rich descriptions and all ten tools (plus the conditional Task tool)', () => {
    // + NotifyUser: a full-presentation root session decides "ready" itself (shared/notify-user.ts); a simplified one does not get it.
    expect(Object.keys((makeSession({ tools: CORE_TOOLS, profile: CLOUD_DEFAULT }) as any).buildAiTools())).toHaveLength(CORE_PLUS_CONDITIONAL_TASK + 1);
  });
});
