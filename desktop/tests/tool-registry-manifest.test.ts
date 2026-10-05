// Guard: the registered CORE_TOOLS set and the manifest's advertised
// NATIVE_TOOL_NAMES must stay in lockstep. WHY: presets advertise their tool
// suite via NATIVE_TOOL_NAMES, and the Assistant/Coder prompt bodies name tools
// by that list; if a name is advertised but not registered in CORE_TOOLS, a
// preset instructs the model to call a tool that doesn't exist (hallucinated
// calls / dead capability). If a tool is registered but not advertised, it
// ships invisibly. This test makes either drift a build failure. (Flagged during
// the Plan B Task 13 review, where the manifest briefly listed WebSearch/
// AskUserQuestion before they were registered.)
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CORE_TOOLS } from '../src/main/harness/tools';
import { NATIVE_TOOL_NAMES, CONDITIONAL_TOOL_NAMES } from '../src/shared/harness-manifest';
import { createSkillTool } from '../src/main/harness/tools/skill';
import { createTaskTool } from '../src/main/harness/tools/task';
import { ModelSearchTool } from '../src/main/harness/tools/model-search';
import { GlobTool } from '../src/main/harness/tools/glob';
import { ReadTool } from '../src/main/harness/tools/read';
import { BashTool } from '../src/main/harness/tools/bash';
import { GrepTool } from '../src/main/harness/tools/grep';
import { WebSearchTool } from '../src/main/harness/tools/web-search';
import { mcpToolsFor } from '../src/main/harness/mcp/mcp-tools';

const registered = CORE_TOOLS.map((t) => t.name).sort();
const advertised = [...NATIVE_TOOL_NAMES].sort();

describe('tool registry ↔ manifest parity', () => {

  it('every advertised NATIVE_TOOL_NAME is a registered CORE_TOOL', () => {
    const missing = advertised.filter((name) => !registered.includes(name));
    expect(missing, `advertised but NOT registered: ${missing.join(', ')}`).toEqual([]);
  });

  it('every registered CORE_TOOL is advertised in NATIVE_TOOL_NAMES', () => {
    const unadvertised = registered.filter((name) => !advertised.includes(name));
    expect(unadvertised, `registered but NOT advertised: ${unadvertised.join(', ')}`).toEqual([]);
  });

  it('registered tool names are unique (no accidental double-registration)', () => {
    expect(registered.length).toBe(new Set(registered).size);
  });

  it('the two sets are exactly equal', () => {
    expect(registered).toEqual(advertised);
  });

  it('G-1: BashOutput and KillShell are registered AND advertised', () => {
    expect(registered).toContain('BashOutput');
    expect(registered).toContain('KillShell');
    expect(advertised).toContain('BashOutput');
    expect(advertised).toContain('KillShell');
  });
});

// Conditional tools are the exception this guard's rule implies. `Skill` is
// attached per session only when the capability profile can afford its catalog
// and skills are actually installed — so advertising it statically would commit
// the very sin above: telling the model about a tool that, on a small local model
// or a machine with no skills, is not attached.
describe('conditional tools stay OUT of the advertised set', () => {
  it('Skill is not advertised — its existence depends on the model', () => {
    expect([...NATIVE_TOOL_NAMES]).not.toContain('Skill');
  });

  it('Skill is not a static CORE_TOOL either — it needs a runtime catalog', () => {
    expect(CORE_TOOLS.map((t) => t.name)).not.toContain('Skill');
  });

  it('but it IS implemented — conditional must not mean absent', () => {
    // Without this, "not in either list" would also describe a Skill tool that
    // was never written, and the two assertions above would pass on nothing.
    const tool = createSkillTool({ list: () => [{ id: 'x', description: 'd' }], load: () => { throw new Error('unused'); } });
    expect(tool.name).toBe('Skill');
  });

  it('every conditional name is genuinely absent from the advertised set', () => {
    for (const name of CONDITIONAL_TOOL_NAMES) expect(advertised).not.toContain(name);
  });

  // Task 15 pin (1a review, flagged unpinned): the guard above proves 'Task'
  // is correctly OUT of NATIVE_TOOL_NAMES, but "conditional" must not be
  // allowed to quietly mean "never built" either — syncTaskTool
  // (harness-session.ts) attaches it via createTaskTool() only when
  // profile.canDelegate is true, so nothing else in this file's static sweep
  // (which only walks CORE_TOOLS) ever constructs or names it. Without this,
  // a manifest entry for a tool nobody registered would read identically to
  // one that's correctly gated — this asserts the registered half exists.
  it('but Task IS implemented — conditional must not mean absent', () => {
    const tool = createTaskTool();
    expect(tool.name).toBe('Task');
  });

  // Same direction, Task 14's own addition — ModelSearch rides the identical
  // canDelegate gate as Task (harness-session.ts's syncTaskTool attaches both
  // together) and is exported as a ready-built const rather than a factory,
  // so the "real implementation" check is even more direct here.
  it('but ModelSearch IS implemented — conditional must not mean absent', () => {
    expect(ModelSearchTool.name).toBe('ModelSearch');
  });
});

// -----------------------------------------------------------------------
// Guard (Task 14): the bounds contract applies to every tool, including ones
// nobody has written yet. Two halves, both pinned here:
//   (1) a tool that CAN cut its own output must set `bounds` on the call
//       where it actually cut something (spec §2.3 / Task 1).
//   (2) a tool that can be capped by the PIPELINE's own char limit (Task 19)
//       must declare a static `moreHint` — the fallback composeNotice uses
//       when the tool itself declared no `bounds` for that call. Without it,
//       a capped result gives the model a byte count and no way to widen.
// Both are "silent regression" bugs: nothing throws, nothing red-lines in a
// manual test of the tool. Only a sweep across the whole registry catches
// them, which is what makes this the guard for FUTURE tools, not just the
// ones already fixed on this branch.

// Tools that CANNOT exceed their cap, with the reason — verified against each
// tool's own execute() on 2026-08-06, not copied from the brief unread.
// Keeping exemptions LISTED (rather than an implicit "not tested") is the
// point: the list is reviewable, and a wrong reason here is the same failure
// mode as a wrong test — it hides a real gap instead of catching one.
const BOUNDS_EXEMPT: Record<string, string> = {
  // Not wrapped by defineTool at all (ask-user-question.ts) — the driver
  // routes it straight to askUser() and execute() never runs, so neither
  // half of the contract applies.
  AskUserQuestion: 'interactive; defineTool never wraps it and execute() never runs',
  // text is `Todo list updated: N items, M completed.` — depends only on the
  // COUNT of todos in the call, never their content, so it cannot approach
  // the 30k-char cap under normal use.
  TodoWrite: 'returns a fixed-size acknowledgement, never file or process output',
  // text is `Overwrote/Created ${file_path} (${content.length} chars).` — a
  // one-line confirmation; the actual diff rides `structuredPatch`, which
  // defineTool's truncation never touches.
  Write: 'returns a one-line confirmation; the diff rides structuredPatch',
  // text is `Edited ${file_path}.` — same shape as Write.
  Edit: 'returns a one-line confirmation; the diff rides structuredPatch',
  // text is `Sent N file(s) to the user.` or a per-path error list — same
  // one-line-confirmation shape as Write/Edit; it names files, it never
  // returns their contents.
  SendUserFile: 'returns a one-line confirmation or a per-path error list; never file or process output',
  // text is `Sent N link(s) to the user.` or a per-URL error list — same
  // one-line-confirmation shape as SendUserFile; it names URLs, it never
  // returns their contents.
  SendUserLink: 'returns a one-line confirmation or a per-URL error list; never HTML or page content',
  // T8 (doc-comments build, §5) — ReplyToComment/ResolveComment/ReopenComment/
  // AddComment/MoveComment each return a single fixed-shape confirmation line
  // naming only the path and comment id (never the comment TEXT itself,
  // unlike ReadFileComments below, which is not exempt) — same one-line-
  // confirmation shape as Write/Edit, verified against each tool's own
  // execute() in doc-comments-tools.ts.
  ReplyToComment: 'returns a one-line confirmation naming path + comment id; never the comment text',
  ResolveComment: 'returns a one-line confirmation naming path + comment id; never the comment text',
  ReopenComment: 'returns a one-line confirmation naming path + comment id; never the comment text',
  AddComment: 'returns a one-line confirmation naming path + the new comment id; never the comment text',
  MoveComment: 'returns a one-line confirmation naming path + comment id; never the comment text',
  // The brief also exempted Skill here ("returns catalog text already bounded
  // by the injection budget"). That description belongs to a DIFFERENT code
  // path: native-session-host.ts's invokeSkill() (the /skill-name slash
  // command) calls fitInjection() on the skill body before it ever reaches
  // history. The Skill TOOL's own execute() (skill.ts) returns
  // catalog.load(id).body VERBATIM through defineTool with no length cap of
  // its own and no `bounds` — unlike Write/Edit/TodoWrite, its output scales
  // with an arbitrary SKILL.md on disk, so it genuinely CAN exceed the
  // pipeline's 30k-char cap. Corrected: removed from this list. See the
  // dedicated test below, which now pins that skill.ts declares a static
  // moreHint fallback for exactly this case.
};

describe('every bounded tool declares its bounds', () => {
  it('exemptions are all real tools, so the list cannot rot', () => {
    // Prevents a renamed or removed tool from silently keeping a stale
    // exemption around, which would then apply to nothing (a check that
    // always passes vacuously and gives false confidence).
    const known = new Set([...NATIVE_TOOL_NAMES, ...CONDITIONAL_TOOL_NAMES]);
    for (const name of Object.keys(BOUNDS_EXEMPT)) expect(known).toContain(name);
  });

  it('Bash, Grep, Glob, Read and WebSearch all declare bounds when driven past their cap', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounds-manifest-'));
    try {
      for (let i = 0; i < 2_100; i++) fs.writeFileSync(path.join(dir, `f${i}.ts`), 'needle\n');
      const ctx = { sessionId: 't', cwd: dir, signal: new AbortController().signal, readRegistry: new Map(), todos: [] } as any;

      // Glob: RESULT_LIMIT (2,000) < the 2,100 files just created, so the walk
      // withholds real hits — the exact case `bounds` exists to describe.
      const glob = await GlobTool.execute({ pattern: '*.ts' }, ctx);
      expect(glob.bounds, 'Glob').toBeDefined();

      // Read: limit:10 against a 5,000-line file leaves lines 11-5000 unread.
      const big = path.join(dir, 'big.txt');
      fs.writeFileSync(big, Array.from({ length: 5_000 }, (_, i) => `l${i}`).join('\n'));
      const read = await ReadTool.execute({ file_path: big, limit: 10 }, ctx);
      expect(read.bounds, 'Read').toBeDefined();

      // Bash: 300,000 chars of stdout blows past the 22,000+6,000-char
      // head/tail retention window bash.ts keeps under its own cap.
      const bash = await BashTool.execute({ command: `node -e "process.stdout.write('q'.repeat(300000))"` }, ctx);
      expect(bash.bounds, 'Bash').toBeDefined();

      // Grep: content-mode output past the 24,000+6,000-char retention window.
      // 480 matching lines (under grep.ts's own `--max-count 500`, so rg
      // itself does not clip the match count first) at ~300 chars each pushes
      // total stdout past ~64KB — big enough to span multiple pipe 'data'
      // events, not just past the 30k-char cap. grep.ts's retention check
      // (`if (head.length < 24_000) head += s`) runs BEFORE appending, so a
      // single stdout chunk under ~64KB (Node's default highWaterMark) lands
      // entirely in `head` regardless of size, and `dropped` never flips —
      // the same head-cap "dead zone" bash.ts's own comment describes fixing
      // for itself. Sized to actually cross a chunk boundary, not just the cap.
      const grepFile = path.join(dir, 'grep-target.txt');
      fs.writeFileSync(grepFile, Array.from({ length: 480 }, (_, i) => `needle line ${i} ${'x'.repeat(280)}`).join('\n'));
      const grep = await GrepTool.execute({ pattern: 'needle', path: 'grep-target.txt', output_mode: 'content' }, ctx);
      expect(grep.bounds, 'Grep').toBeDefined();

      // WebSearch: needs its injected search service; return more than the
      // 8-result display cap so `unique.length > shown.length`.
      const manyResults = Array.from({ length: 20 }, (_, i) => ({ title: `r${i}`, url: `https://example.com/${i}`, snippet: 's' }));
      const searchCtx = { ...ctx, services: { search: { search: async () => ({ results: manyResults, source: 'fake' }) } } };
      const search = await WebSearchTool.execute({ query: 'q' }, searchCtx);
      expect(search.bounds, 'WebSearch').toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('the Skill tool declares a static moreHint fallback for its unbounded SKILL.md body', () => {
    // This is the test the corrected exemption comment above points at. Skill's
    // execute() (skill.ts) still returns an unbounded SKILL.md body with no
    // per-call `bounds` — a large skill file can still hit defineTool's
    // pipeline cap. skill.ts:51 now supplies the STATIC fallback (types.ts
    // NativeTool.moreHint) for exactly that case, naming only the `skill`
    // param this schema actually has (the "no tool advises a parameter its
    // own schema does not accept" guard below would fail the build otherwise).
    // This was a deliberately-red pin before that fix landed; it is now a
    // green regression guard, not a documented gap.
    const tool = createSkillTool({ list: () => [{ id: 'x', description: 'd' }], load: () => { throw new Error('unused'); } });
    expect(tool.moreHint, 'Skill can exceed the pipeline cap (unbounded SKILL.md) and must keep declaring a static moreHint').toBeTruthy();
  });

  it('no tool advises a parameter its own schema does not accept', () => {
    // The generalized form of the bug this whole branch exists to fix: the
    // shared truncation string used to tell EVERY caller to "use
    // offset/limit", which Bash and WebSearch do not accept, and two
    // reviewing models followed it into a dead end. Covers `moreHint` too
    // (Task 19's static fallback) — it is a user-visible advice string just
    // like description/shortDescription, and can name a parameter on its own.
    for (const tool of CORE_TOOLS) {
      // zod v4's ZodObject exposes `.shape` directly (the `_def.shape()`
      // accessor form was zod v3) — verified against the installed
      // "zod": "^4.4.3" in package.json, not assumed from the brief's snippet.
      const shape = (tool.inputSchema as any)?.shape ?? {};
      const params = new Set(Object.keys(shape));
      const advice = `${tool.description} ${tool.shortDescription ?? ''} ${tool.moreHint ?? ''}`;
      for (const word of ['offset', 'limit']) {
        if (advice.includes(word) && !params.has(word)) {
          throw new Error(`${tool.name} mentions "${word}" but its schema has no such parameter (has: ${[...params].join(', ')})`);
        }
      }
    }
  });
});

// -----------------------------------------------------------------------
// Guard (Task 19's own request): "Task 14's manifest guard asserts every
// non-exempt tool declares [a static moreHint]." Separate from the
// drove-past-cap tests above, which only exercise five tools directly — this
// sweeps every CORE_TOOL so a future tool that CAN be capped but forgets its
// static fallback fails here even before anyone constructs a case big enough
// to trigger it.
describe('every non-exempt CORE_TOOL declares a static moreHint', () => {
  it('reuses BOUNDS_EXEMPT: a tool that can never approach the cap needs no fallback for it', () => {
    for (const tool of CORE_TOOLS) {
      // AskUserQuestion is `interactive` — the driver never runs its execute()
      // via defineTool, so the pipeline cap (and thus moreHint) never applies.
      if (BOUNDS_EXEMPT[tool.name] || tool.interactive) continue;
      expect(tool.moreHint, `${tool.name} can exceed its cap but declares no static moreHint fallback`).toBeTruthy();
    }
  });
});

// -----------------------------------------------------------------------
// BLOCKER fix (2026-08-06): every guard above sweeps CORE_TOOLS — the
// statically-registered set (index.ts). MCP-derived tools (mcp-tools.ts) are
// NOT in that array; they are built at runtime, one per server, from
// mcpToolsFor(). A guard that can structurally only see CORE_TOOLS cannot
// catch a whole tool FAMILY shipping with no static moreHint — which is
// exactly what happened here: MCP tools inherited the pipeline's default cap
// with no fallback, so a big response from ANY MCP server hit composeNotice's
// bare no-advice branch. This block exercises mcpToolsFor() directly so a
// future regression (a moreHint accidentally dropped from mcp-tools.ts) fails
// a test instead of shipping silently again.
describe('MCP-derived tools declare a static moreHint too (structural gap the CORE_TOOLS sweep above cannot see)', () => {
  function fakeServer(toolNames: string[]) {
    return {
      id: 'test-server',
      label: 'Test Server',
      tools: toolNames.map((name) => ({ name, description: `desc for ${name}`, inputSchema: { type: 'object' } })),
      call: async () => ({ text: '', isError: false }),
    } as any;
  }

  it('every tool mcpToolsFor() wraps declares a non-empty moreHint', () => {
    const tools = mcpToolsFor(fakeServer(['search', 'send_email', 'wipe_all']));
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.moreHint, `${tool.name} (MCP-derived) declares no static moreHint fallback`).toBeTruthy();
    }
  });

  it('the MCP static hint never guesses a parameter name — the arguments belong to the SERVER schema, not this file', () => {
    // Same failure mode the CORE_TOOLS guard checks for offset/limit, applied
    // to MCP tools' own vocabulary risk: mcp-tools.ts never validates
    // `rawInputSchema` (it is passthrough), so a hint that named a specific
    // parameter would be a guess this file cannot back up.
    const tools = mcpToolsFor(fakeServer(['search_threads']));
    for (const tool of tools) {
      expect(tool.moreHint).not.toMatch(/\boffset\b|\blimit\b/);
    }
  });
});

// -----------------------------------------------------------------------
// Ledger D-2 (2026-08-26 native-tools investigation): every NATIVE tool's
// input schema must REJECT unknown parameters. Before this, all of them were
// plain z.object() — a model trained on Claude Code that sent `Grep {pattern,
// "-i": true}` got a case-SENSITIVE search and no error, because zod dropped
// the key it did not recognize. This sweep covers the static CORE_TOOLS and
// the three runtime-attached tools (Skill, Task, ModelSearch), which
// CORE_TOOLS can structurally never see. MCP tools are the deliberate
// exception: their schema is `z.object({}).passthrough()` because the SERVER
// is the authority on its own arguments (mcp-tools.ts), so they are pinned
// as NOT strict here — a future "make everything strict" sweep must not
// break every MCP server.
describe('native tool schemas reject unknown parameters (D-2)', () => {
  const runtimeTools = [
    createSkillTool({ list: () => [{ id: 'x', description: 'd' }], load: () => { throw new Error('unused'); } }),
    createTaskTool({ list: () => [], get: () => undefined } as any),
    ModelSearchTool,
  ];

  it('every CORE_TOOL and runtime-attached native tool rejects an unrecognized key', () => {
    for (const tool of [...CORE_TOOLS, ...runtimeTools]) {
      const r = tool.inputSchema.safeParse({ __not_a_real_parameter__: true });
      expect(r.success, `${tool.name} silently accepted an unknown parameter`).toBe(false);
      const codes = r.success ? [] : r.error.issues.map((i) => i.code);
      expect(codes, `${tool.name} did not report the unknown key as unrecognized_keys`).toContain('unrecognized_keys');
    }
  });

  it('MCP-derived tools stay permissive — the server validates its own arguments', () => {
    const tools = mcpToolsFor({
      id: 'srv', label: 'Srv',
      tools: [{ name: 'do_thing', description: 'd', inputSchema: { type: 'object' } }],
      call: async () => ({ text: '', isError: false }),
    } as any);
    for (const tool of tools) {
      expect(tool.inputSchema.safeParse({ anything: 1 }).success, `${tool.name} must pass unknown keys through to the server`).toBe(true);
    }
  });

  it('Grep advertises the four ripgrep flags added for ledger G-7', () => {
    const params = Object.keys((GrepTool.inputSchema as any).shape);
    for (const p of ['ignore_case', 'literal', 'type', 'multiline']) {
      expect(params, `Grep schema is missing "${p}"`).toContain(p);
    }
  });
});
