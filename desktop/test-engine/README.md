# test-engine — llama.cpp smoke probes

Dev-run probes against the REAL pinned `llama-server` binary (never CI), and
record outcomes in `../../docs/engine-dependencies.md` — the same discipline as
`test-conpty/` on a Claude Code bump.

**THIS FILE IS THE ONE PLACE THAT SAYS WHICH PROBES A BUMP RE-RUNS.** Twelve
`probe-*.mjs` files live here and they are not all the same kind of thing:

- **NINE are engine-bump gates** — every one asserts, exits non-zero on failure,
  and must PASS before a new pin ships: `probe-health`, `probe-models`,
  `probe-chat`, `probe-download`, `probe-tools`, `probe-speed`, `probe-presets`,
  `probe-vision`, `probe-headers`. These are the nine listed below.
- **TWO are one-off MEASUREMENTS, not gates** — `probe-parallel` (how many
  requests the server really runs at once) and `probe-prefix-cache` (whether a
  shared system prefix is reused). They print a number and a classification;
  there is no pass/fail to break, and each needs a server you launched yourself.
  Re-run them when the NUMBER matters — a specialists fan-out change, or a build
  whose scheduler is suspect — not on every bump. Their findings live in
  `engine-dependencies.md` → "Parallel slots" and "KV prefix reuse".
- **ONE is not about the engine at all** — `probe-shell-command` tests that a
  "Run in terminal" command survives being typed into a real shell. Re-run it
  when that path changes or a shell is added, never on an engine bump.

The pinned version + per-platform asset table live in
`../src/main/engine/engine-pin.ts`. Regenerate that table with
`node ../scripts/generate-engine-pin.mjs <tag> --binary <path-to-llama-server>`.
**Without `--binary` the `ARG_ALIASES` block is NOT regenerated** and the app
keeps reasoning about the previous build's option names; the script says so.

## Setup (once)

1. Get a `llama-server` binary of the pinned version. Easiest: install through
   the app (Settings → Providers → Install) and point `--binary` at
   `<userData>/engine/<version>-<backend>/llama-server(.exe)`. Or download the
   pinned release asset from
   `https://github.com/ggml-org/llama.cpp/releases/tag/<ENGINE_VERSION>` and
   unpack it (Windows `.zip` is flat; macOS/Linux `.tar.gz` nests under
   `llama-<tag>/`).
2. Drop a small single-file GGUF into `test-engine/cache/` (any works;
   ~0.5 GB keeps runs fast), e.g. `Qwen3-0.6B-Q4_K_M.gguf` from
   `unsloth/Qwen3-0.6B-GGUF` on Hugging Face.

`cache/` and `engine/` are git-ignored.

## Probes

- `node probe-health.mjs --binary <path>` — the router SKELETON boots and
  `GET /health` returns 200 when ready. (Observed on b9992: 200 with an EMPTY
  body — the supervisor only checks `res.ok`, never parses the body, so this is
  fine.) **It does NOT boot the shipped flag set**: it spawns the RECOVERY shape,
  with `-c` on the command line and no `--models-preset`, `--spec-default` or
  `--cache-type-k`. The shipped shape is covered by `probe-presets` (the preset
  path) and `probe-speed` (the two speed flags reaching the model child), so
  nothing is unguarded — but do not read this probe's arg list as "what the app
  runs", and do not widen this bullet back to "our exact flag set".
- `node probe-models.mjs --binary <path>` — TWO assertions. (1) `GET /models`
  schema + id parity: the router's model ids match `cache-scan.ts`'s
  filename-derived ids for the same directory. PRINTS both lists — on mismatch,
  fix `ggufIdFromFileName` in `cache-scan.ts` and this probe together, and update
  `engine-dependencies.md`. (2) **`GET /models?reload=1` picks up a GGUF added
  AFTER boot.** The router never re-scans `--models-dir` on its own, so this
  param is the only thing that makes a just-downloaded model usable without
  restarting the engine — `EngineSupervisor.refreshModels()`/`ensureServable()`
  depend on it entirely, and the unit tests mock fetch so they cannot see it
  disappear. If (2) fails after an engine bump, local models are broken for
  anyone who downloads one mid-session; find the replacement mechanism before
  shipping the new engine. It also NOTEs (does not fail) if a plain `GET /models`
  starts re-scanning, which would make our refresh redundant rather than wrong.
- `node probe-chat.mjs --binary <path>` — streamed `/v1/chat/completions`
  round-trip: auto-load on first request, delta frames, final usage/timings.
- `node probe-download.mjs --binary <path>` — the naming contract, end to end. It
  downloads a real ~0.4 GB GGUF from Hugging Face, ALSO splits it with the sibling
  `llama-gguf-split`, drops both in the cache and asserts the router lists AND serves
  the single-file id AND the `-00001-of-00002` split id, with a real chat round-trip
  against the split model. This is the only cheap check of the large-tier multi-part
  path, which cannot be downloaded on a 32 GB dev box. It also pins the two folder
  ids (a vision model is named by its FOLDER, not its file).
- `node probe-tools.mjs http://127.0.0.1:<port> <model-id>` — runs against an
  ALREADY-RUNNING engine, not one it spawns. Fires a tool-y prompt (asserts
  schema-valid JSON arguments come back), then a plain prompt (asserts the build does
  NOT force a tool call on ordinary text — that would break normal chat), and prints
  the real `/props` `n_ctx`. Tool-call argument encoding and the `/props` field layout
  are both build-sensitive, which is why this is bump-gated.
- `node probe-speed.mjs --binary <path>` — the speed flags (`--spec-default`, `--cache-type-k q8_0`)
  reach the router's model child and the n-gram drafter fires on an echo task (2026-09-04)
- `node probe-presets.mjs --binary <path>` — the per-model settings file
  (`--models-preset`, design §C2), which is the most dangerous file the app
  writes: llama-server treats ANY defect in it as a FATAL startup error, so one
  bad key means every local model disappears at the next launch with nothing on
  screen to explain it. Asserts that `[*]` reaches a model, that a per-model
  section overrides one key and inherits the rest, that a sectioned model reports
  `source: preset`, that an unrecognised key in EITHER section is fatal with the
  exact message `model-presets.ts` quotes back to the user, and that EVERY key on
  the reserved list is a real option on this build (47 today — the probe prints
  the count it checked, so it cannot drift out of date here). Cheap: `GET /models` renders each
  model's full child command line without loading it, so nothing here reads a
  gigabyte of weights. If the fatal-key assertion ever goes GREEN-by-passing (the
  engine tolerates a bad key), the save-time binary check has stopped being
  load-bearing and its cost can be revisited.
- `node probe-vision.mjs --binary <path> [--port N]` — the vision folder layout
  (design §E2). Downloads SmolVLM-256M (~0.4 GB, both files) into
  `cache/<id>/`, then asserts the router lists that model under the FOLDER's
  name, reports `input_modalities` including `image`, and answers an inline
  solid-red PNG with the word "red". Both halves matter: the modality alone only
  proves the flag was passed, and the same two files laid out FLAT report
  `["text"]` with no `--mmproj` at all — which is the silent failure the whole
  folder layout exists to avoid.
- `node probe-headers.mjs` — the ONLY probe that needs no binary and no local
  GGUF: it reads each curated repo's header straight off Hugging Face and asserts
  that ONE 1 MB range request is enough. `gguf-header.ts`'s whole design rests on
  a fact about real files we do not control — that a converted GGUF writes its
  architecture keys before its multi-megabyte tokenizer arrays — and unit
  fixtures cannot notice that changing upstream. It prints each model's real
  layer/head/window numbers, which is also the fastest way to see what a new
  family looks like. `--repo <id>` for one repo; `--local <file.gguf>` for a file
  on disk. It has already earned its keep: on its first run it found that
  Gemma 4's larger models write `head_count_kv` as a per-LAYER array, which the
  reader was dropping (2026-09-05).

Each probe exits 0 on pass and prints the raw JSON it saw (that output is what
goes into `engine-dependencies.md` entries).

## Harness evaluator

`harness-eval.mjs` answers "did this change make the assistant better or
worse?" It runs a **case** — a task plus a rubric and a set of mechanical
checks — across a matrix of **code version × instruction file × model**, one
disposable fixture per cell, then grades every run twice.

Use it when you change a harness tool, change an instruction file
(`CLAUDE.md`-style guidance), or want to compare two models on the same work.

Build the compiled harness code first — the script imports `dist/`, never
`src/`, so it never runs something different from what the app ships. Use
`build:main` (plain `tsc`), not the full `build` script — `build` also runs
`vite build` and `electron-builder` to package the whole desktop app, which is
slow and fails outright on a machine not set up for packaging (e.g. missing
`rpmbuild`), even though the harness files it needs are written by `tsc` in
the first few seconds:

```
npm run build:main
```

Then:

- `node test-engine/harness-eval.mjs --plan test-engine/eval-plans/<plan>.json --dry-run`
  — **free, no key.** Prints the expanded grid of cells and a dollar estimate,
  spends nothing. Always start here.
- `node test-engine/harness-eval.mjs --plan <plan>.json --key-file <path> --max-spend 5`
  — **paid.** `--max-spend` is a hard cap, re-checked against OpenRouter's own
  billing between cells. `--only <cellId>` runs one cell; `--repeats <n>` and
  `--timeout <seconds>` override the plan; `--yes` skips the confirmation.

**The key must arrive by file.** The script **refuses to start** if
`OPENROUTER_API_KEY` is set in its environment, because a model running under
it can read the parent's environment out of `/proc` — see
`docs/harness-evaluator-internals.md`. Worker config goes over stdin, never
argv or env.

Exit codes: `0` every cell ran · `2` usage or config error · `3` stopped early
because the spend cap was hit.

A **plan** is a small JSON file (`test-engine/eval-plans/`) naming cases,
models, optional instruction files (`test-engine/eval-guidance/`), and
optional builds to compare. Cases live in
`src/main/harness/eval/cases/`. Every cell gets its own disposable fixture
workspace (a seeded project tree under `os.tmpdir()`, deleted after the run),
byte-identical across runs, so results are comparable and no run can see
another's leftovers.

Grading is two independent halves. Mechanical checks read the event stream and
report `passed` / `failed` / **`never ran`** — a check whose precondition never
happened is never rendered as a pass. An LLM judge scores the written answer
against the case's rubric, and **any grade that does not quote the answer
verbatim is discarded**.

Output lands in `docs/active/investigations/harness-eval-runs/<date>/`: a full
event transcript and grades per cell, plus a rendered `report-<plan>.md`. The
transcripts are git-ignored; the report is the durable record. One cell failing
does not stop the rest.

There is **no resume** — a stopped run re-pays for every finished cell.

### `review-harness.mjs` (legacy)

The original roster-driven battery runner, kept because it appends each model's
free-form prose review to
`docs/active/investigations/2026-08-01-native-agent-harness-reviews.md`, which
the evaluator does not do. It now imports its runner logic from the evaluator's
code, but **it still takes its key from the environment and therefore leaks it
to the models it runs** (ROADMAP → Bugs). Prefer `harness-eval.mjs`.

## conversation-triage.mjs — failure screening over past conversations (2026-08-11)

Two-stage triage for the super-agent roadmap's error-analysis step
(`docs/active/plans/2026-08-11-super-agent-roadmap.md`, step 1). Ranks stored
sessions (native store + Claude transcript lane) by failure signals so the
human taxonomy pass reads the right sessions first. No build step needed — it
parses session files directly, no `dist/` import.

- `node test-engine/conversation-triage.mjs scan` — **free, no key.** Deterministic
  lexical + structural signals (apologies, user redirects/interrupts, tool errors,
  doom-loop/max-steps gates, compaction-then-correction). Writes a ranked
  `scan-report.md` + `scan.jsonl`.
- `node test-engine/conversation-triage.mjs triage --top 40 --dry-run` — prints the
  call plan and token estimate, spends nothing, needs no key.
- `OPENROUTER_API_KEY=sk-... node test-engine/conversation-triage.mjs triage --top 40` —
  **paid.** Sends flagged excerpt windows to a cheap model (default
  `deepseek/deepseek-v4-flash-0731`; verify current pricing first) to classify
  candidate failure categories as strict JSON. Capped by `--top`/`--max-calls`.

Stage 2 runs two passes: per-session incident reviews (category, upstream cause,
harness-fix idea, wasted-turn estimate, verbatim quote), then a **synthesis call**
(`--synth-model` to use a stronger model for just that step) that consolidates
all incidents into a draft taxonomy — definitions, counts, exemplar quotes, a
suggested eval assertion per category, and a recommended eval-build order.

Outputs land in `docs/active/investigations/conversation-triage-runs/<date>/`
(git-ignored — reports contain conversation excerpts). The drafted taxonomy is
built for **skim-and-veto** review: every entry carries verbatim quotes with
session basenames so claims can be checked against the source session — same
falsifiability discipline as the review battery above.
