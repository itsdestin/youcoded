// test-engine/probe-plan-grammar.mjs — can a local model emit a VALID plan
// through the `--jinja` tool-call grammar when the tool's schema is the large,
// nested `propose_plan` document? (specialists spec §4 + §8 live probe 3.)
// NOT a unit test: run against a live llama-server.
//
// WHY: stage two makes the model author a plan as a tool call, through the
// same constrained-decoding path every other tool uses (the repo has no
// top-level-JSON mode and must not gain one — provider-registry.ts). Every
// other tool's schema is flat. A plan is a tree: a list of steps, each one of
// four kinds, one kind (`repeat`) containing its own list of steps. If the
// grammar the engine derives from that schema does not hold, or a small model
// fills it with garbage, plans are cloud-only and the design has to say so
// before it is built, not after.
//
// The schema below is a faithful draft of spec §4, not the final one: four
// building blocks (map / verify / combine / repeat), every node carrying an
// enforced per-child token budget and a specialist id, `repeat` nesting steps
// with an explicit cap. It is deliberately as deep and as strict as the real
// schema will need to be (enums, required lists, integer bounds, recursion via
// $ref, additionalProperties:false) so a pass here is not a pass on a toy.
//
// Per trial: one prompt that clearly calls for a fan-out, tools=[propose_plan],
// tool_choice:auto, parallel_tool_calls:false (the harness's local-engine
// shape). Scored: did it call the tool at all; did the args parse as JSON; do
// they validate against the schema (Ajv, strict); does the plan make sense
// for the prompt (the right number of map items, a combine at the end).
//
// Launch a server first (engine-supervisor.ts router-mode spawn shape):
//   llama-server --host 127.0.0.1 --port 8199 --no-webui --jinja \
//     --models-dir <cacheDir> --models-max 2 --sleep-idle-seconds 900 -c 16384
//
// Usage: node test-engine/probe-plan-grammar.mjs <baseURL> <modelId> [trials=3]
import Ajv from 'ajv';
import { pathToFileURL } from 'node:url';

let base;
let model;
let TRIALS;

// Exported so the production schema can be pinned (as data) to the exact
// constrained-decoding grammar that the live model probe exercised.
//
// 2026-09-18, TWO changes, both driven by three of Destin's real sessions:
//  1. BOUNDED recursion — a repeat body is `$defs/leafStep`, which cannot be a
//     `repeat`. A model rode the old unbounded `steps` 343, 353 and 206 levels
//     deep with filler steps until the output-token cap cut the arguments
//     mid-string.
//  2. A REAL PER-KIND UNION — `$defs/step` was one flat object with every
//     kind's fields optional, so a model following it emitted `of`,
//     `max_iterations`, `until` AND `steps` on a `map` step, which the strict
//     runtime validator then rejected. Each kind is now its own branch listing
//     only its own fields, all of them required, so the two cannot disagree.
// Both changes NARROW the grammar, so every document the probe proved still
// parses; the probe was NOT re-run. See plans/schema.ts and plan-schema.test.ts.
//
// 2026-09-18, a THIRD change (decision 30, tightened by decision 33): a
// `summary` on every step — one plain sentence for the person approving the
// plan, because the card's row was the first line of a prompt written for a
// machine. It is advertised on all four branches and REQUIRED on all four: the
// owner asked for it ("i'm not sure what the benefit would be of making it
// optional"), knowing plans written before it stop parsing ("all of the
// existing plans are demos"). This is the one change that does NOT merely
// narrow or widen around the probe's documents — the probe's own trial
// documents would need a summary per step to pass today. The probe was NOT
// re-run; it exercises whether a local model can fill a deep tree at all, and
// one more short bounded string per node does not change that question.
// 2026-09-24 (spending rework stage 1, design §2, decision 34): `budget_tokens`
// is REMOVED (the model no longer predicts a per-step cost) and `model` is
// ADDED, optional, advertised on all four branches like `summary` was before
// it became required (design §9, decision 35.4). The probe was NOT re-run:
// dropping one bounded numeric field and adding one bounded optional string
// field changes neither the recursion bound nor the per-kind union shape the
// probe actually exercises — the question this probe answers ("can a local
// model fill a deep tree at all") is unaffected.
// 2026-09-24 (issue 3, owner's live test): `model`'s DESCRIPTION TEXT ONLY is
// reworded to a flat prohibition (a live plan froze a model on a step nobody
// asked to change, under the older, softer "only when the user explicitly
// asked... otherwise omit" wording). The field's type, maxLength and
// optionality are unchanged, so this is not a shape the probe exercises
// differently — the probe was NOT re-run, same reasoning as every change
// above it. Kept byte-identical to plans/schema.ts's copy (plan-schema.test.ts
// pins the two equal).
// 2026-09-24 (decision 39, ANOTHER owner's live test): `of` becomes a single
// id OR an array of up to 6 distinct ids — a verify/combine step must be able
// to name every earlier step it needs, not only one (three independent
// researcher steps followed by a combine that could only name the first
// produced a "keyboards-only" report when the plan covered three categories).
// This is still a LEAF value, not new recursion, and the union is exactly the
// `anyOf`-of-scalars shape every kind branch already is — the probe was NOT
// re-run, same reasoning as every change above it. Kept byte-identical to
// plans/schema.ts's copy (plan-schema.test.ts pins the two equal).
const FIELD = {
  id: { type: 'string', minLength: 1, maxLength: 64, description: 'Short unique step id, e.g. "s1".' },
  specialist: { type: 'string', enum: ['explorer', 'researcher', 'reviewer', 'worker'] },
  task: { type: 'string', minLength: 1, maxLength: 4000, description: 'What each child does. For map, may reference {item}.' },
  summary: { type: 'string', minLength: 1, maxLength: 200, description: 'One plain sentence for the user who approves this plan, in everyday words: what this step does. Not a restatement of task, no jargon, no file paths or tool names.' },
  model: { type: 'string', maxLength: 128, description: 'Leave unset. Do NOT set this yourself for any reason (a step seeming hard, slow, cheap, or important is not a reason) — that is the user\'s decision alone, never yours. Set it ONLY when the user has explicitly named a model or provider for this exact step, earlier in this conversation: "budget", "frontier", or an exact model id.' },
  items: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 2000 }, minItems: 1, maxItems: 8, description: 'map only: one child per item.' },
  of: {
    description: 'verify/combine: the id(s) of the earlier step(s) whose results this consumes. Name a single id, or an array of every step you need (up to 6) — never drop one.',
    anyOf: [
      { type: 'string', minLength: 1, maxLength: 64 },
      { type: 'array', items: { type: 'string', minLength: 1, maxLength: 64 }, minItems: 1, maxItems: 6, uniqueItems: true },
    ],
  },
  max_iterations: { type: 'integer', minimum: 1, maximum: 5, description: 'repeat only: hard cap.' },
  until: { type: 'string', minLength: 1, maxLength: 2000, description: 'repeat only: plain-words stop condition.' },
  steps: { type: 'array', items: { $ref: '#/$defs/leafStep' }, minItems: 1, maxItems: 4, description: 'repeat only: the steps to repeat. These may not repeat again.' },
};
const KIND_FIELDS = {
  map: ['items'],
  verify: ['of'],
  combine: ['of'],
  repeat: ['max_iterations', 'until', 'steps'],
};
const KIND_DESCRIPTION = {
  map: 'Run one child per item.',
  verify: "Check an earlier step's results.",
  combine: "Merge an earlier step's results.",
  repeat: 'Run a short body up to max_iterations times.',
};
function stepBranch(kind) {
  const properties = {
    id: FIELD.id,
    kind: { type: 'string', enum: [kind], description: KIND_DESCRIPTION[kind] },
    specialist: FIELD.specialist,
    task: FIELD.task,
    summary: FIELD.summary,
    model: FIELD.model,
  };
  for (const field of KIND_FIELDS[kind]) properties[field] = FIELD[field];
  return {
    type: 'object',
    additionalProperties: false,
    // Decision 33: `summary` is advertised on every branch and required on
    // all. `model` (decision 35.4) is advertised on every branch too, but
    // stays OPTIONAL — see the WHY above `FIELD`.
    required: ['id', 'kind', 'specialist', 'task', 'summary', ...KIND_FIELDS[kind]],
    properties,
  };
}

export const STEP_SCHEMA = {
  $defs: {
    leafStep: { anyOf: ['map', 'verify', 'combine'].map(stepBranch) },
    step: { anyOf: ['map', 'verify', 'combine', 'repeat'].map(stepBranch) },
  },
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'steps'],
  properties: {
    goal: { type: 'string', minLength: 1, maxLength: 2000, description: 'One sentence: what the whole plan achieves.' },
    steps: { type: 'array', items: { $ref: '#/$defs/step' }, minItems: 1, maxItems: 6 },
  },
};

const PROPOSE_PLAN = {
  type: 'function',
  function: {
    name: 'propose_plan',
    description: 'Propose a multi-step plan that fans work out to specialist helpers. Use map to run one helper per item, verify to check each result, combine to merge results, repeat to loop a bounded number of times.',
    parameters: STEP_SCHEMA,
  },
};

const PROMPT = `I have three source files: auth.ts, billing.ts and sync.ts. Use propose_plan to plan this: have a reviewer look at each file for bugs (one helper per file), then have a researcher verify each review against the docs, then combine everything into one report. Keep budgets modest.`;

const ajv = new Ajv({ strict: true, allErrors: true });
const validate = ajv.compile(STEP_SCHEMA);

async function trial(i) {
  const start = performance.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: PROMPT }],
      tools: [PROPOSE_PLAN],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      temperature: 0.2,
      max_tokens: 2048,
    }),
  });
  const wall = performance.now() - start;
  if (!res.ok) return { i, wall, outcome: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
  const json = await res.json();
  // Review F8: a 200 with no choices (an {error} body, a proxy hiccup) is its own outcome,
  // not "the model answered in prose" — that label is read as a model failure in the doc.
  const choice = json.choices?.[0];
  if (!choice) return { i, wall, outcome: 'NO CHOICES IN RESPONSE', raw: JSON.stringify(json).slice(0, 300) };
  const msg = choice.message ?? {};
  const call = msg.tool_calls?.[0];
  const finish = choice.finish_reason ?? '?';
  if (!call) return { i, wall, outcome: `NO TOOL CALL (finish_reason=${finish})`, text: String(msg.content ?? '').slice(0, 200) };
  const rawArgs = String(call.function?.arguments ?? '');
  let args;
  // Review F9: a call cut off by max_tokens is a budget failure, not garbage — say which.
  try { args = JSON.parse(rawArgs); } catch { return { i, wall, outcome: finish === 'length' ? 'ARGS TRUNCATED (finish_reason=length — raise max_tokens)' : `ARGS NOT JSON (finish_reason=${finish})`, raw: rawArgs.slice(0, 300) }; }
  const ok = validate(args);
  if (!ok) return { i, wall, outcome: 'SCHEMA INVALID', errors: ajv.errorsText(validate.errors).slice(0, 400), args };
  // Sense check: did it map over the three files and end in a combine?
  const kinds = args.steps.map((s) => s.kind);
  const mapSteps = args.steps.filter((s) => s.kind === 'map');
  // Review F11: three map steps of one item each is a fair reading of "one helper per file" —
  // count items across every map step, not only the first.
  const mapped = mapSteps.reduce((n, s) => n + (s.items ?? []).length, 0);
  const sense = [];
  if (!mapSteps.length) sense.push('no map step');
  else if (mapped !== 3) sense.push(`map steps cover ${mapped} items, expected 3`);
  if (!kinds.includes('combine')) sense.push('no combine step');
  if (kinds.includes('repeat')) sense.push('used repeat when nothing looped');
  return { i, wall, outcome: sense.length ? `VALID BUT ODD (${sense.join('; ')})` : 'VALID + SENSIBLE', kinds, args };
}

async function main() {
  const [baseArg, modelArg, trialsArg] = process.argv.slice(2);
  if (!baseArg || !modelArg) { console.error('usage: probe-plan-grammar.mjs <baseURL> <modelId> [trials]'); process.exitCode = 2; return; }
  const parsedTrials = Number(trialsArg ?? 3);
  if (!Number.isInteger(parsedTrials) || parsedTrials < 1) { console.error(`usage: trials must be a positive integer, got "${trialsArg}"`); process.exitCode = 2; return; }
  base = baseArg;
  model = modelArg;
  TRIALS = parsedTrials;

  console.log(`probe-plan-grammar: ${model} @ ${base}, ${TRIALS} trials`);
  const results = [];
  for (let i = 1; i <= TRIALS; i++) {
    const r = await trial(i);
    results.push(r);
    console.log(`\n trial ${i}: ${r.outcome}  (${(r.wall / 1000).toFixed(1)}s)`);
    if (r.kinds) console.log('   steps:', r.kinds.join(' → '));
    if (r.errors) console.log('   errors:', r.errors);
    if (r.raw) console.log('   raw:', r.raw);
    if (r.text) console.log('   text:', r.text);
    if (r.args && i === 1) console.log('   first plan:', JSON.stringify(r.args).slice(0, 600));
  }
  const valid = results.filter((r) => r.outcome.startsWith('VALID')).length;
  // Review F9: the summary names truncation separately so a small max_tokens is not read as a model failure.
  const truncated = results.filter((r) => r.outcome.startsWith('ARGS TRUNCATED')).length;
  if (truncated) console.log(`\n${truncated}/${TRIALS} trials were cut off by max_tokens — a budget failure, not a grammar failure.`);
  const sensible = results.filter((r) => r.outcome === 'VALID + SENSIBLE').length;
  console.log(`\nSUMMARY ${model}: ${valid}/${TRIALS} schema-valid, ${sensible}/${TRIALS} valid and sensible`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(String(e.message || e)); process.exitCode = 1; });
}
