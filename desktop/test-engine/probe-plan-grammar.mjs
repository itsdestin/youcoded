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
//     --models-dir <cacheDir> --models-max 2 --sleep-idle-seconds 300 -c 16384
//
// Usage: node test-engine/probe-plan-grammar.mjs <baseURL> <modelId> [trials=3]
import Ajv from 'ajv';
import { pathToFileURL } from 'node:url';

let base;
let model;
let TRIALS;

// Exported so the production schema can be pinned byte-for-byte (as data) to
// the exact constrained-decoding grammar that the live model probe exercised.
export const STEP_SCHEMA = {
  $defs: {
    step: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'kind', 'specialist', 'task', 'budget_tokens'],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 64, description: 'Short unique step id, e.g. "s1".' },
        kind: { type: 'string', enum: ['map', 'verify', 'combine', 'repeat'] },
        specialist: { type: 'string', enum: ['explorer', 'researcher', 'reviewer', 'worker'] },
        task: { type: 'string', minLength: 1, maxLength: 4000, description: 'What each child does. For map, may reference {item}.' },
        budget_tokens: { type: 'integer', minimum: 500, maximum: 20000 },
        items: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 2000 }, minItems: 1, maxItems: 8, description: 'map only: one child per item.' },
        of: { type: 'string', minLength: 1, maxLength: 64, description: 'verify/combine: the id of the step whose results this consumes.' },
        max_iterations: { type: 'integer', minimum: 1, maximum: 5, description: 'repeat only: hard cap.' },
        until: { type: 'string', minLength: 1, maxLength: 2000, description: 'repeat only: plain-words stop condition.' },
        steps: { type: 'array', items: { $ref: '#/$defs/step' }, minItems: 1, maxItems: 4, description: 'repeat only: the steps to repeat.' },
      },
    },
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
