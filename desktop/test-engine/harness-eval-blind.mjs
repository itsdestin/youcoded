#!/usr/bin/env node
// Blind side-by-side rating page for a finished harness-eval run.
//
//   node test-engine/harness-eval-blind.mjs <run-dir> --a <arm id> --b <arm id> [--out <file.html>]
//
// <run-dir> is the dated folder harness-eval.mjs prints as "Results:". --a and
// --b name two values of ONE plan axis (two build ids, two instruction ids or
// two models); every other part of the cell id must match for a pair to form,
// so each pair is the same question, model and repeat answered both ways.
//
// WHY a page and not the judge alone: the LLM judge grades against a written
// rubric, but the question an owner actually asks of a prompt change is "which
// would I rather get?" — and that is only honest if he cannot see which is
// which. So the page shuffles sides per pair and the pair order, hides the
// model name, and only reveals arms (and the judge's scores) after rating.
// Ratings live in the browser and can be downloaded as JSON for the session
// that ran the experiment to read back.
import fs from 'node:fs';
import path from 'node:path';

function die(msg) { console.error(`harness-eval-blind: ${msg}`); process.exit(1); }

const argv = process.argv.slice(2);
const runDir = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const armA = flag('a');
const armB = flag('b');
if (!runDir || !armA || !armB) die('usage: harness-eval-blind.mjs <run-dir> --a <arm id> --b <arm id> [--out <file.html>]');
if (!fs.existsSync(runDir)) die(`no such run folder: ${runDir}`);

// Cell ids are `${caseId}|${instructionsId}|${model}|${buildId}|${repeat}` (matrix.ts).
const AXES = ['case', 'instructions', 'model', 'build', 'repeat'];

const cells = [];
for (const name of fs.readdirSync(runDir)) {
  if (!name.endsWith('.json') || name.endsWith('.grades.json') || name.startsWith('run-summary')) continue;
  let result;
  try { result = JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8')); } catch { continue; }
  if (typeof result?.cellId !== 'string') continue;
  const parts = result.cellId.split('|');
  if (parts.length !== AXES.length) continue;
  let grades = null;
  const gradeFile = path.join(runDir, name.replace(/\.json$/, '.grades.json'));
  if (fs.existsSync(gradeFile)) {
    try { grades = JSON.parse(fs.readFileSync(gradeFile, 'utf8')); } catch { /* ungraded is fine */ }
  }
  cells.push({ parts, result, grades });
}
if (!cells.length) die(`no cell results found in ${runDir}`);

// The compared axis is the one where both arm ids occur.
const axis = AXES.findIndex((_, i) => cells.some((c) => c.parts[i] === armA) && cells.some((c) => c.parts[i] === armB));
if (axis < 0) die(`"${armA}" and "${armB}" are not both values of any one axis in this run`);

// Turn the event stream into a readable conversation. Assistant text arrives as
// many small deltas sharing a partId, so consecutive deltas are joined.
// WHY "consecutive" and not a map by partId: ids restart each model step
// ("txt-0" again after every tool call), so a map glued later paragraphs onto
// the first one and showed them all above the tool steps that came between.
function conversation(run) {
  const items = [];
  for (const e of run?.events ?? []) {
    const d = e.data ?? {};
    if (e.type === 'user-message') items.push({ kind: 'user', text: d.text ?? '' });
    else if (e.type === 'assistant-text') {
      const last = items[items.length - 1];
      if (last?.kind === 'assistant' && last.partId === d.partId) last.text += d.text ?? '';
      else items.push({ kind: 'assistant', partId: d.partId, text: d.text ?? '' });
    } else if (e.type === 'tool-use') {
      items.push({ kind: 'tool', tool: d.toolName, input: d.toolInput ?? {}, id: d.toolUseId, result: null });
    } else if (e.type === 'tool-result') {
      const call = items.find((x) => x.kind === 'tool' && x.id === d.toolUseId);
      const text = typeof d.toolResult === 'string' ? d.toolResult : JSON.stringify(d.toolResult ?? '', null, 2);
      if (call) call.result = text.slice(0, 4000);
    } else if (e.type === 'session-error') items.push({ kind: 'error', text: d.text ?? 'error' });
  }
  // The first user message is the question itself, shown once above both sides.
  const firstUser = items.findIndex((x) => x.kind === 'user');
  const question = firstUser >= 0 ? items.splice(firstUser, 1)[0].text : '';
  return { question, items: items.filter((x) => x.kind !== 'assistant' || x.text.trim()) };
}

const byKey = new Map();
for (const c of cells) {
  const arm = c.parts[axis];
  if (arm !== armA && arm !== armB) continue;
  const key = c.parts.filter((_, i) => i !== axis).join('|');
  const slot = byKey.get(key) ?? {};
  slot[arm === armA ? 'a' : 'b'] = c;
  byKey.set(key, slot);
}

const pairs = [];
let unpaired = 0;
for (const [key, slot] of byKey) {
  if (!slot.a || !slot.b) { unpaired++; continue; }
  const convA = conversation(slot.a.result.run);
  const convB = conversation(slot.b.result.run);
  const meta = Object.fromEntries(AXES.map((n, i) => [n, slot.a.parts[i]]));
  delete meta[AXES[axis]];
  pairs.push({
    key,
    meta,
    question: convA.question || convB.question,
    a: { items: convA.items, error: slot.a.result.run?.error ?? null, judge: slot.a.grades?.judge?.grades ?? null },
    b: { items: convB.items, error: slot.b.result.run?.error ?? null, judge: slot.b.grades?.judge?.grades ?? null },
  });
}
if (!pairs.length) die('no complete pairs: every question needs a finished answer from both arms');

const data = { run: path.basename(path.resolve(runDir)), axis: AXES[axis], armA, armB, pairs };
const out = flag('out') ?? path.join(runDir, `blind-rating-${armA}-vs-${armB}.html`);
const template = fs.readFileSync(new URL('./harness-eval-blind.html', import.meta.url), 'utf8');
// WHY the escape: the data is embedded in a <script> block, and a model answer
// containing "</script>" would otherwise end it early and break the page.
const json = JSON.stringify(data).replace(/</g, '\\u003c');
fs.writeFileSync(out, template.replace('/*__DATA__*/null', json));
console.log(`${pairs.length} pairs${unpaired ? ` (${unpaired} left out: one side missing)` : ''} → ${path.resolve(out)}`);
