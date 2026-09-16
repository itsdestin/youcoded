// Shared HarnessSession test scaffolding — extracted from
// harness-session-loop.test.ts (which now re-imports HARNESS/makeOpts/fakeTool)
// so the profile-driven driver test (Task 5) and later tasks build a REAL
// HarnessSession over a scripted model without duplicating this setup. Kept
// deliberately minimal; later tasks extend it.
import { z } from 'zod';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { HarnessSession, type HarnessSessionOpts } from '../../src/main/harness/harness-session';
import type { HarnessManifest } from '../../src/shared/harness-manifest';
import type { NativeTool } from '../../src/main/harness/tools/types';
import type { PermissionDecision } from '../../src/shared/permission-types';
import type { AskRequest, AskDecision } from '../../src/main/harness/permission-broker';
import { resolveProfile, type CapabilityProfile } from '../../src/main/harness/capability-profile';
import type { ReadyServer } from '../../src/main/harness/mcp/mcp-manager';
import { textChunks, toolCallChunk, finishChunk, stream } from './scripted-model';

/** The cwd every faked session runs in. Exported because tests must resolve
 *  their expected paths against THIS base, not against process.cwd(): a test
 *  that resolves `/etc/x` on its own gets the *runner's* drive on Windows
 *  (`D:/etc/x`) while the session resolves it against `C:/x` and produces
 *  `C:/etc/x`. Duplicating the literal is what made that mismatch invisible. */
export const FAKE_SESSION_CWD = 'C:/x';


// Default harness manifest for driver tests (matches the loop suite's).
export const HARNESS: HarnessManifest = {
  schema: 1, id: 'agent', name: 'Agent', systemPrompt: 'sys', tools: [],
  permissionPolicy: 'ask', limits: { maxTokens: 256 },
};

// A permissive fake tool that RECORDS executions. subject undefined by default
// (so tool-layer guards are skipped and decide() is the sole gate). Default
// schema requires file_path — override `schema` for tools with other args.
export function fakeTool(name: string, over: Partial<NativeTool> & { schema?: z.ZodType; onExecute?: (args: any, ctx: any) => any } = {}): NativeTool {
  const calls: any[] = [];
  const t: NativeTool = {
    name,
    description: `fake ${name}`,
    inputSchema: over.schema ?? z.object({ file_path: z.string() }),
    permissionSubject: over.permissionSubject ?? (() => undefined),
    ...(over.interactive ? { interactive: over.interactive } : {}),
    async execute(args, ctx) {
      calls.push(args);
      if (over.onExecute) return over.onExecute(args, ctx);
      return { text: `${name} ran` };
    },
  };
  (t as any).calls = calls;
  return t;
}

/** An installed-skill source that finds nothing.
 *
 *  DEFAULT for every test session, because without it `syncSkillTool` falls back
 *  to `createSkillCatalog()` — which scans the REAL `~/.claude`. That makes the
 *  attached tool set depend on the machine running the suite: it passed locally
 *  and on macOS/Windows CI (where the scan found nothing) and failed on Ubuntu CI
 *  with "expected 10 tools, got 11" (2026-07-29). A test that reaches the
 *  developer's home directory is not a test of the code.
 *
 *  Tests that care about skills pass their own catalog and override this. */
export const EMPTY_SKILL_CATALOG = {
  list: () => [],
  load: (id: string) => { throw new Error(`no skills installed (test catalog): ${id}`); },
};

export function makeOpts(over: Partial<HarnessSessionOpts>): HarnessSessionOpts {
  return {
    sessionId: 's-1', cwd: FAKE_SESSION_CWD, harness: HARNESS,
    binding: { providerId: 'openrouter', modelId: 'm' },
    retryDelays: [1, 1, 1],   // test hook: near-zero backoff so the suite stays fast
    skillCatalog: EMPTY_SKILL_CATALOG,
    ...over,
  } as HarnessSessionOpts;
}

// One scripted step: optional leading text, zero+ tool calls, optional usage.
// scriptModel turns each into ONE streamText consumption (a driver step).
// `throwError` makes that consumption's stream surface an error part (which the
// driver throws) — used to test the compaction fail-safe (a summary model call
// that explodes must NOT brick the turn). A throwError step ignores text/tools.
export interface ScriptStep {
  text?: string;
  toolCalls?: { name: string; input: unknown }[];
  usage?: { inputTokens?: number; outputTokens?: number };
  throwError?: string;
}

// Build a fake model whose Nth doStream call replays the Nth scripted step. Once
// the turn OUTRUNS the scripted steps (e.g. the driver loops once more after a
// doom-loop denial), it emits a natural STOP instead of repeating the last —
// possibly tool-calling — step forever, so higher-level tests can't wedge.
export function scriptModel(steps: ScriptStep[]) {
  const scripts = steps.map((s, i) => {
    // An error step: emit a single error part (same shape the retry test uses).
    // streamText surfaces it on fullStream AND textStream, so both the driver's
    // consumeStep and generateSummary see the throw. doStream itself still
    // RESOLVES cleanly, so the SDK does not retry it (the error is mid-stream).
    if (s.throwError !== undefined) return stream({ type: 'error', error: new Error(s.throwError) });
    const chunks: any[] = [];
    if (s.text) chunks.push(...textChunks(`t${i}`, s.text));
    (s.toolCalls ?? []).forEach((tc, j) => chunks.push(toolCallChunk(`c${i}-${j}`, tc.name, tc.input)));
    const reason = (s.toolCalls?.length ?? 0) > 0 ? 'tool-calls' : 'stop';
    chunks.push(finishChunk(reason, s.usage?.inputTokens ?? 1, s.usage?.outputTokens ?? 1));
    return stream(...chunks);
  });
  const terminal = stream(finishChunk('stop'));   // implicit end when the script runs out
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = call < scripts.length ? scripts[call] : terminal;
      call++;
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

// A model whose FIRST doStream call HANGS forever — its stream never emits and
// never closes, simulating a stalled local model (the exact case the summary
// abort-race + timeout must survive). `onFirstCall` fires once the hang begins so
// a test can then interrupt(). Every later call stops cleanly, so the turn can
// still unwind after the interrupt without wedging on a repeated hang.
export function hangingFirstCallModel(onFirstCall: () => void) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      call++;
      if (call === 1) {
        onFirstCall();
        // Never enqueue, never close → textStream.next() never resolves on its own.
        return { stream: new ReadableStream<any>({ start() { /* intentionally idle */ } }) };
      }
      return { stream: simulateReadableStream({ chunks: stream(finishChunk('stop')) }) };
    },
  });
}

// A ModelFactory (not a doStream fake) that RECORDS the system prompt it was
// actually handed by the AI SDK, then behaves exactly like scriptModel(steps).
//
// WHY this can't be a wrapped modelFactory that reads HarnessSessionOpts:
// systemPrompt is consumed inside HarnessSession (systemText getter) and only
// surfaces again when streamText hands it to the model as `system`, which the
// SDK folds into the FIRST message of doStream's `options.prompt` array
// (`{ role: 'system', content: string }` — LanguageModelV4Prompt, verified
// against tests/harness-session.test.ts's own `req.prompt` capture). Reading
// it there is a genuine integration assertion: it proves the text reached the
// model, not merely that some function was called with some options object.
// scriptModel's own doStream (above) discards its `options` argument entirely,
// so it can't be reused directly — this wraps a real scriptModel instance and
// intercepts the SAME options object on the way to it, forwarding the call
// unchanged so behavior (text/tool-calls/finish reason) is identical.
export function capturingFactory(sink: string[], steps: ScriptStep[] = [{ text: 'done' }]) {
  const inner = scriptModel(steps);
  return async () => new MockLanguageModelV4({
    doStream: async (options: any) => {
      const systemMessage = (options.prompt as any[] | undefined)
        ?.find((m) => m.role === 'system');
      // Fix 3 (Task 3 review): a `: ''` fallback here would MASK a shape change
      // instead of catching one. If the AI SDK ever stops representing system
      // content as a plain string (or stops sending a system message at all),
      // the old fallback silently recorded '' — and every negative assertion
      // built on this sink (e.g. "the assembled prompt has no
      // <project-instructions> block") would then pass VACUOUSLY, because an
      // empty string trivially contains none of the text being checked for.
      // Throwing, naming what was actually received, turns that into a loud
      // failure on the next run instead of a test that can never fail again.
      if (typeof systemMessage?.content !== 'string') {
        throw new Error(
          `capturingFactory: expected the system message's content to be a string, got: ${JSON.stringify(systemMessage)}`,
        );
      }
      sink.push(systemMessage.content);
      return inner.doStream(options);
    },
  }) as any;
}

export interface MakeSessionOver {
  profile?: CapabilityProfile;
  askUser?: (req: AskRequest) => Promise<AskDecision>;
  model?: any;                       // a scriptModel()/scriptedModel() fake
  contextLength?: number | null;
  tools?: NativeTool[];
  // Appended onto the default tool set (Glob+Read) WITHOUT replacing it — for
  // tests that need one extra tool (e.g. an MCP-shaped tool with
  // rawInputSchema) alongside the usual fakes, instead of hand-rolling the
  // whole set via `tools`.
  extraTools?: NativeTool[];
  decide?: (tool: string, subject: string | undefined) => Promise<PermissionDecision>;
  systemPrompt?: string;
  // Subscribe to the session's transcript-event stream (each emitted event is
  // forwarded here) — lets a test assert on the frozen emit surface directly.
  onEvent?: (e: any) => void;
  // Pre-fill history with ~this-many tokens of large user/assistant messages
  // (alternating roles). The bulk is PROTECTED non-tool content, so pruning
  // frees almost nothing — this is how a compaction test forces the SUMMARIZE
  // branch (pruning insufficient) instead of the cheap prune-only path.
  seedBulkHistoryTokens?: number;
  // MCP servers this session may use (Task 6). Defaults to EMPTY in the shared
  // factory — same reason as EMPTY_SKILL_CATALOG above: a test factory that
  // silently reached some real/ambient server list would make the attached
  // tool set depend on more than what the test itself passed in.
  mcpServers?: ReadyServer[];
  // Shorthand for the one profile field the tool-less-model test needs,
  // without hand-building a whole CapabilityProfile object via `profile`.
  supportsTools?: boolean;
  // The manifest, for tests whose subject is window arithmetic: HARNESS's
  // 256-token output reserve makes the compaction trigger and the trim budget
  // coincide with the pre-2026-09-10 numbers, so a test of "compaction fires
  // before trimming" needs the production 16,000 reserve to reproduce the bug.
  harness?: HarnessManifest;
}

// Construct a real HarnessSession over a scripted model. Defaults: an allow-all
// decide() and a Glob+Read tool set, so a scripted tool call actually executes
// (and the doom-loop, not a permission ask, is what trips) unless overridden.
export function makeSession(over: MakeSessionOver = {}): HarnessSession {
  const model = over.model ?? scriptModel([{ text: 'ok' }]);
  const tools = over.tools ?? [
    fakeTool('Glob', { schema: z.object({ pattern: z.string() }) }),
    fakeTool('Read'),
    ...(over.extraTools ?? []),
  ];
  // Resolve through the REAL three-layer function (rather than defaulting
  // straight to CLOUD_DEFAULT) whenever the caller doesn't hand-build a
  // profile, so `contextLength` actually drives window-sized fields (Task 6's
  // mcpToolBudgetTokens) the same way NativeSessionHost.resolveContextAndProfile
  // does in production. This is a no-op for every OTHER field when the binding
  // stays 'openrouter' (a FRONTIER provider — see capability-profile.ts):
  // maxToolPresentation/promptVariant/doomLoopThreshold/etc. all still resolve
  // identically to CLOUD_DEFAULT regardless of contextLength, so no existing
  // contextLength-only test (which never asserted on profile fields) changes
  // behavior. `supportsTools` layers a plain override on top, for the one test
  // that needs a tool-less model without hand-building a whole profile.
  const profile: CapabilityProfile = over.profile ?? {
    ...resolveProfile({ providerType: 'openrouter', modelId: 'm', contextLength: over.contextLength ?? null }),
    ...(over.supportsTools !== undefined ? { supportsTools: over.supportsTools } : {}),
  };
  const opts: HarnessSessionOpts = {
    sessionId: 's-1', cwd: FAKE_SESSION_CWD, harness: over.harness ?? HARNESS,
    binding: { providerId: 'openrouter', modelId: 'm' },
    retryDelays: [1, 1, 1],
    tools,
    // Same reason as makeOpts: without this, buildAiTools scans the real
    // ~/.claude and the tool set becomes machine-dependent.
    skillCatalog: EMPTY_SKILL_CATALOG,
    decide: over.decide ?? (async () => ({ action: 'allow', denyListed: false })),
    ...(over.askUser ? { askUser: over.askUser } : {}),
    profile,
    ...(over.contextLength !== undefined ? { contextLength: over.contextLength } : {}),
    ...(over.systemPrompt ? { systemPrompt: over.systemPrompt } : {}),
    mcpServers: over.mcpServers ?? [],
  };
  const session = new HarnessSession(opts, async () => model as any);
  // Forward every transcript event to the test's listener (before any turn runs).
  if (over.onEvent) session.on('transcript-event', over.onEvent);
  // Seed protected bulk history so a later compaction check must SUMMARIZE.
  if (over.seedBulkHistoryTokens && over.seedBulkHistoryTokens > 0) {
    const filler = 'x'.repeat(4000);   // ~1000 tokens per message (chars/4)
    const msgs: any[] = [];
    let tokens = 0;
    for (let i = 0; tokens < over.seedBulkHistoryTokens; i++) {
      // Alternate roles so the history has ≥2 user-delimited turns — the summarize
      // cut needs the 2nd-to-last user message to sit at index > 0 (starting on an
      // assistant keeps the first seeded user off index 0). Big content per message.
      const role = i % 2 === 0 ? 'assistant' : 'user';
      const content = `bulk ${i} ${filler}`;
      msgs.push({ role, content });
      tokens += Math.ceil(content.length / 4);
    }
    session.seedHistory(msgs);
  }
  return session;
}

// Drive one user turn to completion.
export async function drainTurn(session: HarnessSession, text: string): Promise<void> {
  await session.send(text);
}
