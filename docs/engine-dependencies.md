# Engine Coupling Registry (llama.cpp)

Tracks every YouCoded touchpoint to the bundled llama.cpp engine
(`llama-server`), mirroring the `cc-dependencies.md` discipline. Populated
starting Phase 1 of the platform roadmap (see the workspace archive's
`docs/archive/specs/2026-07-09-platform-vision-roadmap.md` and ADR 007).

## Pinned version

**`b10665`** — pinned 2026-08-27. Empirically verified on Linux x64 (Vulkan build)
against the real binary via `desktop/test-engine/`: probe-health, probe-models,
probe-chat, probe-download and probe-tools all PASS at the bump, and probe-speed,
probe-presets, probe-vision and probe-headers all PASS against the same pin
(2026-09-04/05) — nine probes in total. See Verification below.
Previously `b9992`, pinned 2026-07-13 (Phase 1 Plan B), verified on Windows x64 (CPU).

**Why this bump:** b9992 could not read the `qwen4exp` architecture — a fresh
Qwen3.8-Flash-Next download failed with `unknown model architecture: 'qwen4exp'`
(reproduced against the shipped b9992 binary, 2026-08-27). Upstream support landed
in ggml-org/llama.cpp#27742, merged 2026-08-27T19:32Z; **b10660 IS that merge commit**
(`6c84c7d`, verified identical via the compare API), so b10660 is the earliest
release that can load the model. b10665 is the newest release at bump time.

**Response shapes re-verified unchanged on b10665** (the ones the app parses):
`GET /models` rows still report `status` as an OBJECT (`{value:'unloaded'|…}`), not a
bare string; streamed `/v1/chat/completions` still carries the `timings` block
(`prompt_n`/`prompt_ms`/`predicted_n`/`predicted_ms`/`cache_n`) `prefill-progress.ts`
reads; router-mode `/props` with no `?model=` still answers
`{model_path:"none", default_generation_settings.n_ctx: 0}` and **no slot field** — the
documented case `effectiveContextWindow` falls back to the configured `-c` for. **The app
asks `/props?model=<id>` only for a model `GET /models` already reports `loaded`** (fixed
2026-09-04, twice): only with the model named does the router answer `total_slots: 4` and
that model's `n_ctx` — the **full `-c`** under the app's spawn (no `--parallel`, so b10665
enables `--kv-unified` and all slots share one pool; measured `n_ctx 16384, total_slots 4`
with `-c 16384`), `-c` / N only with an explicit `--parallel N`. **Naming a model is a
load, not a read:** `--models-autoload` defaults on, so `/props?model=<id>` for an
`unloaded` or `sleeping` model blocks until it is loaded (or woken) — the app therefore
gates on the `/models` status and sends the model-less `/props` otherwise, never
`?reload=1`. The key is `total_slots` — there is no `n_slots` key on b10665; the app reads
`total_slots ?? n_slots` for older builds.

**Bump procedure** (same discipline as a Claude Code bump):
1. `node desktop/scripts/generate-engine-pin.mjs <new-tag> --binary <path-to-the-new-llama-server>`
   → paste the rows AND the `ARG_ALIASES` block into
   `desktop/src/main/engine/engine-pin.ts`, bump `ENGINE_VERSION`. Without
   `--binary` the alias table is not regenerated and the script says so.
2. Re-verify archive layouts (`binaryRelPath`) — Windows `.zip` is flat, macOS/
   Linux `.tar.gz` nest under `llama-<tag>/` (the generator templates the tag in;
   confirm it still holds).
3. **Re-check the ROCm target list.** `gfxTargets` on the two ROCm rows is read
   out of upstream's `.github/workflows/release.yml` at the tag (`gpu_targets:`
   in the `ubuntu-24-rocm` and `windows-rocm` matrices) and the two platforms do
   NOT share a list. Upstream edits these between builds; a chip that drops off
   still gets offered ROCm and then dies with no kernel image at the first
   token. The generator refuses to emit a ROCm row it cannot read targets for.
4. **Re-check the CUDA runtime asset.** The Windows CUDA row carries a second
   archive (`cudart-…`, `EngineAsset.runtime`); the generator refuses the row if
   it cannot find one with a usable digest, because a CUDA build without its
   runtime cannot boot on a PC that has no toolkit on PATH.
5. **Re-run ALL NINE probes** in `desktop/test-engine/`, with a small GGUF in
   `test-engine/cache/`. `probe-{health,models,chat,download,tools,speed,presets,
   vision}.mjs --binary <path>`, plus `probe-headers.mjs`, which needs no binary
   and no local model (it reads real Hugging Face headers). Every one must PASS.
   `probe-presets.mjs` is the cheapest and the most load-bearing: `models.ini` is
   the one file where a single unrecognised key stops every local model loading.
6. **Confirm `--list-devices` still parses.** Its block is frozen into every
   install's `.complete` marker and feeds the memory estimator and the engine
   card's hardware line; a format change silently turns both into "we don't know".
7. Update this file with anything that changed.

**How a bump REACHES users:** `EngineManager.autoUpdateOnLaunch()`, fired
fire-and-forget from `registerIpcHandlers`. It updates an existing install to the
pin in the background and is deliberately inert in three cases — no engine yet
(a first install stays the Install button), already on the pin, and an engine
that is currently running (swapping the binary unloads the resident model). It
never throws and never blocks startup; the Settings → Providers **Update** button
is the manual retry when it could not run. A pin bump alone reaches nobody:
`EngineAcquisition.installed()` keeps serving whatever is on disk.
<!-- verify: {"path": "youcoded/desktop/src/main/engine/engine-manager.ts", "contains": "autoUpdateOnLaunch"} -->

**A new install must PROVE it boots before it replaces the old one.**
`acquisition.install()` writes `.complete` and renames the directory into place
before anything executes the binary, and `installed()` prefers the pinned version
over every other — so a build that unpacks cleanly but will not start SHADOWS a
working older engine. `installAndVerify()` discards an install it created when
`verifyBoot` fails (restoring the previous engine as the newest usable one), and
only prunes the older installs after a replacement has booted. It never discards
an install that already existed before the call — a re-install of the running
version reaches `verifyBoot` too, and a transient failure there must not delete a
build that has been working.
Guard: `desktop/tests/engine-auto-update.test.ts`.

## Touchpoints

### `llama-server` CLI flags — spawn shape (engine-supervisor.ts)

Exact router-mode arg list (no `-m`), b10665 / 2026-09-05:
```
--host 127.0.0.1 --port <ENGINE_PORT> --no-webui --jinja
--models-dir <cacheDir> --models-max 2
[--spec-default]            # unless engine.speed.speculative === false
[--cache-type-k q8_0]       # unless engine.speed.compressCache === false
--models-preset <NativeHome.root>/engine/models.ini
```
**`-c` and `--sleep-idle-seconds` are NOT on the command line any more.** They moved
into the preset file's `[*]` section (design §C2) because llama-server merges the
ROUTER's own arguments OVER every preset (`preset.merge(base_preset)`,
server-models.cpp) — a `-c` left here silently outranks, and so defeats, every
per-model context length. The ONE case they come back is the recovery boot that has
no usable preset file:
```
--sleep-idle-seconds 900 -c <contextSize>      # only when presetPath === null
```
<!-- verify: {"path": "youcoded/desktop/src/main/engine/engine-supervisor.ts", "contains": "models-preset"} -->
- **`--models-dir <cacheDir>` is LOAD-BEARING.** It is what makes the router
  DISCOVER manually-placed GGUFs and auto-load them by filename id. Verified
  b9992: WITHOUT it, `GET /models` returns `{"data":[]}` and every
  `/v1/chat/completions` returns HTTP 400 `model '…' not found` — the feature is
  completely non-functional. (This build also has no `LLAMA_CACHE`-based flat
  discovery; see below.)
- **`--models-dir` MUST EXIST or the router exits during startup (verified b9992).**
  A missing directory is FATAL: `error: '<dir>' does not exist or is not a directory`
  and the process exits immediately — it is NOT treated as "zero models, empty
  router." Since `cacheDir` (`~/.cache/llama.cpp`) is created lazily on the first
  model download, a fresh install's verify-boot ran BEFORE any model existed and
  always died this way. `EngineSupervisor.start()` therefore `fs.mkdirSync(cacheDir,
  {recursive:true})` before spawning (an empty dir boots fine — the router just
  serves no models yet). The supervisor also drains + tail-captures child stdout/
  stderr so a startup exit surfaces the engine's REAL message instead of a guess.
- **`--models-max 2`** — the router's LRU default is 4; 2 bounds RAM on consumer
  machines while keeping chat↔utility switching cheap.
- **Auto-sleep after 15 minutes — now `[*] sleep-idle-seconds = 900` in the preset
  file, NOT a command-line flag.** The router frees an idle model's memory (status →
  `'sleeping'`) and wakes it on the next request. Verified b9992. FINER-grained than the
  engine-wide idle stop (`idleMs`, 25 min) which tears down the whole process — the two
  are complementary, and "Keep loaded" on a model turns BOTH off for it
  (`sleep-idle-seconds = -1` in its section, and `hasKeepLoadedResident()` holds the
  engine timer). `SLEEP_IDLE_SECONDS` still lives in `engine-supervisor.ts` because the
  preset writer reads it. **`engine-supervisor.test.ts` now pins the flag's ABSENCE from
  the command line** — it only reappears on the recovery boot that has no usable preset.
  (Raised 5→15 min and 10→25 min on 2026-09-07 per Destin.)
- **Speed flags (2026-09-04), both measured on b10665, Qwen3.5-9B Q8_0, Z13 Vulkan;
  guard: `test-engine/probe-speed.mjs` (flags reach the model child AND the drafter fires).
  Both are now user switches (`engine.speed` in config.json, `engine:set-config`) and
  both DEFAULT ON, so an untouched config spawns exactly the command line that shipped
  before they existed. Turning one off needs a fresh spawn — they are command-line
  arguments, not preset values.**
  - **`--spec-default`** — llama.cpp's draft-FREE speculative decoding (n-gram lookup
    against the prompt; `--spec-type` was `none` by default). A 736-token "rewrite this
    file with one change" reply went **16 → 104 tok/s** (768 drafted, 673–722 accepted);
    a 700-token essay was 9.0 → 9.3 tok/s with `draft_n` absent — the drafter simply
    never fires on novel prose, so no measured penalty. This is the shape of every
    Edit/Write tool call. The router forwards it to each model child (probe-pinned).
  - **`--cache-type-k q8_0`** — 8-bit KEY cache. `llama-bench` at 16,384 tokens of
    depth: generation 11.4 → 16.2 tok/s, prompt 281 → 452 tok/s, half the K memory.
  - **V cache is deliberately left f16.** `-ctv q8_0` measured a further prompt-speed
    gain (598 tok/s at depth) but **is a FATAL load error whenever flash attention is
    off** — verified with `-fa off -ctv q8_0`: `quantized V cache requires flash_attn to
    be enabled`, the model never loads. `-fa` is `auto`, so a CPU fallback or a GPU
    without FA support would break every local send. `-ctk q8_0 -fa off` boots fine
    (also verified). `engine-supervisor.test.ts` pins the ABSENCE of `--cache-type-v`.
- **`--jinja`** from day one so Phase 2 tool calling needs no process-shape change.
- **The context length every model inherits is `[*] ctx-size` in the preset file** —
  the router writes each model child's command line from it (visible in `/models`
  `status.args` WITHOUT loading the model). A model with its own section overrides it.

### Model discovery: `--models-dir` vs `LLAMA_CACHE` (engine-supervisor, cache-scan, engine-manager)

- **`--models-dir` serves flat `.gguf` files** dropped in the directory. The model
  id the router exposes is the **filename minus `.gguf`** — this EXACTLY matches
  `cache-scan.ts`'s `ggufIdFromFileName`, so the engine-off list (cache scan) and
  the engine-on list (`GET /models`) agree. Pinned by `probe-models.mjs`
  (router ids == scan ids). **It ALSO serves one level of subdirectories, and a model
  in one is named by the FOLDER, not the file** — that is where a vision model lives,
  because `--mmproj` is only paired inside a single folder. Details and the three
  probed traps: "GGUF cache layout" below.
- **`LLAMA_CACHE`** (still set in the env) only tracks `llama-server`'s own `-hf`
  AUTO-DOWNLOADED models in a structured layout; `--cache-list` shows `0` for a
  flat dropped GGUF. It is effectively **vestigial**: Plan C does NOT use
  `llama-server --hf` — its downloader (`model-downloader.ts`) fetches HF files
  over plain HTTP and writes them FLAT into this same cache dir, so Plan C models
  land under `--models-dir` discovery exactly like a hand-placed GGUF. So
  `--models-dir` covers BOTH bring-your-own AND Plan C downloads; `LLAMA_CACHE`
  is kept harmlessly, and should be revisited only if some future path actually
  invokes `-hf`. (Any new probe — including Plan C's `probe-download.mjs` — MUST
  spawn with `--models-dir`, or it falsely reports empty and mis-blames the
  downloader.)
- **`--models-preset PATH`** is now LOAD-BEARING (see "Per-model settings" below). `--cache-list` still exists and is unused.

### Per-model settings: the preset file (`model-presets.ts`, probe-presets.mjs)

`--models-preset <NativeHome.root>/engine/models.ini`, an INI file the app rewrites
before EVERY spawn (the router reads it once, at startup). Grammar transcribed from
llama.cpp's `common/preset.cpp` (`parse_ini_from_file` + `load_from_ini`); every fact
below PROBED on b10665, 2026-09-05.

- **`[*]` is the global section and cascades into every model.** A model's own
  `[<router id>]` section overrides single keys and inherits the rest. Probed: `[*]
  sleep-idle-seconds = 77` reached a model child that had its own section setting only
  `ctx-size`.
- **A sectioned model reports `source: "preset"` in `GET /models`, and its `status.args`
  shows the child's exact command line WITHOUT loading the model.** That is how
  `probe-presets.mjs` proves all of this in milliseconds instead of gigabytes.
- **ANY defect is FATAL for the whole server, not for one model.** `option 'x' not
  recognized in preset 'y'` → exit 1; `failed to parse server config file: <path>` →
  exit 1; `preset file does not exist` → exit 1 (probed with a missing file);
  `failed to open server preset file: <p>` → exit 1 (probed with `chmod 000`). A
  RUNNING engine survives — `?reload=1` just 500s and the old presets stay in force —
  so nothing looks broken until the next spawn, at which point every local model is
  gone. `EngineSupervisor` therefore retries: once without the section the engine
  named, then once without the preset file at all (`presetInForce()` reports which).
- **A section whose name matches no file on disk becomes a GHOST row that can never
  load.** Sections are emitted only for ids `scanGgufCache` actually found.
- **A value is cut at the first `#` or `;`, SILENTLY** (llama.cpp's value rule stops at
  a comment start), so `alias = a#b` becomes `a`. No error, wrong setting — which is
  why those two characters are refused at save time.
- **llama.cpp strips only `models-dir/max/preset/autoload`, `api-key` and the two
  `ssl-*-file` from a per-model preset** (`unset_reserved_args(preset, false)`,
  server-models.cpp). It does NOT strip `model`, `mmproj`, `alias`, `hf-repo`,
  `model-url`, `docker-repo` or `rpc` — so the app keeps its own reserved denylist, and
  `probe-presets.mjs` asserts every key on it is a real option on the pinned build
  (47 today; the probe prints the count it checked, so this number cannot drift).
- **The router's own command line merges OVER every preset**, so `cache-type-k` and
  `cache-type-v` are settable-looking and would do nothing per model.
- **`GET /props?model=<id>` is REQUIRED to read a model's real context window.** Bare
  `/props` is the ROUTER's dummy and answers `n_ctx: 0` even while a model is loaded
  and serving. The id is a filename, so it is URL-encoded.
- **A context change needs no restart** — write the file, then `GET /models?reload=1`.
  A SPEED switch does need a fresh spawn (command-line flags).
<!-- verify: {"path": "youcoded/desktop/src/main/engine/model-presets.ts", "contains": "models.ini"} -->

### Health / readiness (engine-supervisor readiness poll)

`GET /health` → `200 {"status":"ok"}` when ready (503 while loading). The
supervisor checks `res.ok` ONLY and never parses the body, so a body-shape shift
is harmless. Router mode reports healthy with ZERO models in the dir — so
install-time `verifyBoot` works on a fresh machine before any GGUF exists.

### `GET /models` schema (engine-supervisor.listModels, cache-scan parity, probe-models.mjs)

Observed b9992 shape:
```json
{ "object": "list", "data": [
  { "id": "Qwen3-0.6B-Q4_K_M", "object": "model", "owned_by": "llamacpp",
    "created": 1783986018, "aliases": [], "tags": [],
    "status": { "value": "unloaded", "args": ["…","--model","…/Foo.gguf"], "preset": "…" },
    "architecture": { "input_modalities": ["text"], "output_modalities": ["text"] },
    "source": "models_dir", "can_remove": false } ] }
```
- **`status` is an OBJECT `{value: 'loaded'|'unloaded'|'loading'|'sleeping'}`, NOT
  a bare string.** `listModels` maps `row.status.value` → `EngineModelState` via
  `mapModelState` (unknown → `'unloaded'`, the safe default). `'sleeping'` is
  produced by `--sleep-idle-seconds` (below). Regression-pinned in
  `engine-supervisor.test.ts`.
- **No `size` field** on `/models` rows — `sizeBytes` comes from the cache scan,
  merged in by id (the loading banner needs the model size).
- **`architecture.input_modalities` is now CONSUMED, not just observed (design
  §E5).** `listModels` keeps the array on `EngineModel.inputModalities`,
  `EngineManager.catalogModels` turns `includes('image')` into
  `CatalogModel.supportsVision`, and the session's vision resolver in
  `ipc-handlers.ts` reads that field for a local binding exactly as it already
  did for an OpenRouter one. Re-captured verbatim from **b10665, 2026-09-05**:
  a model in a folder beside its `mmproj-*.gguf` reports
  `{"input_modalities":["text","image"],"output_modalities":["text"]}`, the same
  model flat reports `["text"]`. If this field is ever renamed or dropped
  upstream, every local vision model silently becomes text-only — a row we
  cannot read leaves `supportsVision` UNSET (never a guessed `false`), and
  `probe-vision.mjs` is the check that catches it on an engine bump.
- **Per-model state polling (2026-07-14):** the supervisor polls `GET /models`
  every 1.5 s while running (400 ms while a load is in flight) and emits `models-changed` only on an (id→state)
  diff (llama-server has no push channel). `ipc-handlers` joins this with the
  session→model ref-count and pushes `native:model-state` per session → the
  ChatView unloaded/loading banner. Cheap localhost GET; timer is `.unref()`'d.
- `POST /models/unload` takes `{"model":"<id>"}` — used to free a model the
  moment its last session releases it (`NativeSessionHost` ref-count → 0, #1).
  `loadModel` warms a model via a 1-token `/v1/chat/completions` ([Reload Model]).

### `/v1/chat/completions` streaming (harness via @ai-sdk/openai-compatible; probe-chat.mjs)

- Naming an UNLOADED models-dir model auto-loads it on the first request.
- Stream frames: `data: {…"object":"chat.completion.chunk","choices":[{"delta":{"content":"…"}}]}`,
  terminated by `data: [DONE]`.
- The final frame carries `finish_reason` + a `timings` object
  (`predicted_per_second`, `predicted_n`, `prompt_n`, `prompt_ms`, …) and `usage`
  (`completion_tokens`/`prompt_tokens`/`total_tokens`). `HarnessSession` maps the
  SDK's usage → the transcript `usage` shape (native adds `tokensPerSecond`).
- Note: Qwen3 emits a `reasoning_content` field on the message; not consumed in
  Plan B (dormant reasoning path).

### Native tool-calling + real-ctx report (harness tool loop; `/props`; probe-tools.mjs)

Plan C runs Claude-Code-style tool calls straight through llama-server's OpenAI-
compatible endpoint. The coupling is `--jinja` + the `/v1/chat/completions` request
shape the harness sends, plus the `/props` read used to learn a loaded model's real
context window.

- **`--jinja` is what enables native tool-calling.** Already in the pinned spawn
  flag set (above), so no process-shape change was needed for Plan C. With it, a
  request carrying `tools: [...]` + `tool_choice: 'auto'` returns a
  `choices[0].message.tool_calls[]` whose `function.arguments` is a **JSON string**
  (parse it, don't read it as an object) matching the tool's `parameters` schema.
- **`parallel_tool_calls: false` pins serial-only tool use — when the caller asks for it.** The
  harness passes `serialToolCalls` for the tiers that execute one tool at a time (transcript +
  permission flow assume a single in-flight tool), and `provider-registry.ts` sets the flag only
  then, rather than reconciling a fan-out.
- **Never-force invariant:** with `tool_choice: 'auto'` a plain-text prompt must come
  back with NO `tool_calls` — the model answers in `message.content`. A build that
  force-calls a tool on ordinary text would break normal chat; the probe asserts
  against this.
- **Real context window + slot count via `GET /props?model=<id>`.** The loaded model's
  actual `n_ctx` is the ground truth the known-model registry (advertised context) is
  checked against. **Name the model in the query** — in router mode a bare `/props` answers
  `n_ctx: 0` and no slot field regardless of what is loaded (verified 2026-09-04 on b10665;
  the app shipped for weeks reading that model-less answer, so every local model was capped
  at ONE concurrent helper). **The field names drift across builds** — read
  `default_generation_settings.n_ctx` first, then fall back to top-level `n_ctx`; the slot
  count is `total_slots` on b10665 (`n_slots` on older builds — read `total_slots ?? n_slots`);
  if none is present the build moved it again (re-check against the pinned tag). With the
  model named, `n_ctx` is what the engine holds for **that model**: under the app's spawn
  (no `--parallel` → `--kv-unified` on) it is the **full `-c`**, shared by all slots; it
  becomes `-c` / N only if someone adds an explicit `--parallel N` (measured both ways
  2026-09-04 on b10665). **Only name a model that `GET /models` reports `loaded`** — on this
  build `?model=` autoloads (or wakes) the named model and blocks until it is resident; the
  app sends the model-less `/props` for any other status (see the b10665 notes above).
  **Do NOT "fix" a zero here by putting `-c` back on the command line** — that flag
  outranks every per-model preset and is exactly what the settings file exists to keep
  off the command line. The fallback when `/props` is uninformative is the CONFIGURED
  context size (this model's own setting, else the engine-wide one), not a constant.
- **Verified by `test-engine/probe-tools.mjs`** — fires a tool-y prompt (asserts
  schema-valid JSON args), a plain prompt (asserts no forced call), and prints the
  `/props?model=` `n_ctx` and `total_slots` (the probe names the model up front, so on
  b10665 that first call is what loads it). Usage: `node test-engine/probe-tools.mjs http://127.0.0.1:<port>
  <model-id>` against an already-running engine. **Engine-bump gated:** re-run this
  probe whenever the pinned llama.cpp build changes (tool-call arg encoding and the
  `/props` field layout are both build-sensitive).

### Release assets + archive layout (engine-pin.ts, generate-engine-pin.mjs, engine-acquisition.ts)

- GitHub release API (`/repos/ggml-org/llama.cpp/releases/tags/<tag>`) publishes a
  per-asset SHA-256 `digest` (`sha256:…`), consumed verbatim by the generator.
- **Windows `.zip` archives are FLAT** — `llama-server.exe` + sibling DLLs at the
  archive root (`binaryRelPath: 'llama-server.exe'`).
- **macOS/Linux `.tar.gz` archives nest under `llama-<tag>/`** — binary at
  `llama-<tag>/llama-server` alongside its `.so`/`.dylib` (`binaryRelPath` is
  version-dependent; the generator templates the tag in). Do NOT revert to
  `build/bin/llama-server` (a stale guess). Enforced by `engine-acquisition`'s
  post-unpack existence check (fails loudly, never installs a broken dir).
- **Twelve rows are pinned (`ENGINE_ASSETS`), and two of them are ROCm** —
  `win-rocm-7.14-x64` and `ubuntu-rocm-7.14-x64`, added 2026-09-05. There is still NO
  upstream Linux CUDA asset, so CUDA remains a Windows-x64 offer; `pickAsset` is what
  decides that, never a platform list repeated elsewhere. Still NOT pinned at b10665:
  `win-cuda-13.3-x64`, `win-cuda-13.4-arm64`, `ubuntu-sycl-fp16/fp32-x64`,
  `win-sycl-x64`, `*-openvino-*`, `win-opencl-adreno-arm64`, `android-arm64`.
- **The Windows CUDA zip does NOT contain the CUDA runtime — so the pin carries a
  SECOND archive for it.** `EngineAsset.runtime` on the CUDA row names
  `cudart-llama-bin-win-cuda-12.4-x64.zip` (373 MB) with its own sha256;
  `engine-acquisition.install()` downloads it, verifies it, and unpacks it into the
  SAME directory as the engine (not a sibling — those DLLs have to sit beside
  `llama-server.exe`). Pressing "Switch to CUDA" is therefore a 238 MB engine plus a
  373 MB runtime, 611 MB in one operation, and `probeDownloadSize()` reports both parts.
  The cudart archive carries no version tag in its NAME, so the generator does not
  template one in. If the runtime is missing or its hash is wrong the INSTALL is
  abandoned — nothing half-unpacked is ever renamed into place — but only the corrupt
  runtime archive's bytes are deleted; the engine archive beside it is deliberately
  KEPT, so a retry reuses those (already checksum-verified) bytes. (The engine archive's own hash failure deletes
  ITS bytes, because there is nothing left to retry with.)
- **The two ROCm rows carry NO `runtime`, for two DIFFERENT reasons.** The Windows
  ROCm zip genuinely is self-contained (it bundles `amdhip64_7.dll`). The Linux
  tarball is NOT: listing b10665's 62 entries on 2026-09-05 found `libggml-hip.so` but
  no `libamdhip64`, `hipblas`, `rocblas` or `amd_comgr` at all. It has no runtime row
  because upstream publishes none — the HIP and BLAS libraries must already be on the
  machine. That is what `rocm-prereqs.ts` checks before Linux ROCm is offered, and why
  Windows needs no such check.
- **`gfxTargets` — the AMD chips each ROCm build was COMPILED for — is per-row, and
  the two rows are NOT the same list.** Read out of upstream's
  `.github/workflows/release.yml` at the tag (`gpu_targets:` in the `ubuntu-24-rocm`
  and `windows-rocm` matrices). At b10665: Windows has 20 targets including
  `gfx1103`/`gfx1153`; Linux has 22 including the four CDNA parts
  (`gfx908`/`gfx90a`/`gfx942`/`gfx950`) that Windows lacks. **`backendOptions()` checks
  that list on LINUX ONLY.** Windows is offered ROCm with no gfx check at all, because
  the kfd topology the target is read from is a Linux kernel interface and Windows
  publishes no equivalent — so `gfxTarget` is always null there and a check would refuse
  every Windows chip. On Linux the check reads THAT ROW's list, never "the pin's gfx
  list": a shared list would offer ROCm to a Linux chip with no machine code in the
  archive, which dies at the first token. The generator refuses to emit a ROCm row it
  cannot read targets for.
- **Every install records the build's own device list.** After unpacking (and after
  the runtime, if any), `engine-acquisition` runs `llama-server --list-devices` and
  freezes the parsed block into the `.complete` marker: each device's engine-printed
  id (`Vulkan0`, `CUDA0`, `ROCm0`, `Metal0`), name, total/free MiB, and an `isGpu`
  flag. `totalMiB: null` means "printed in a shape this parser could not measure",
  never "this chip has no memory" — a zero would read downstream as a machine with no
  graphics memory. `isGpu: false` marks a software renderer (llvmpipe, SwiftShader):
  forced into view on the Z13, llvmpipe reported 124,406 MiB of "VRAM", which is
  simply system RAM. The probe is capped twice — a 15 s SIGKILL timeout AND a hard
  17 s deadline the whole call races — because `execFile`'s own timeout only SIGNALS
  a child, and one wedged inside a GPU driver never dies (measured: a child with
  `trap '' TERM` left the promise unsettled past 30 s, i.e. an install frozen forever).
  Cost when healthy: ~70 ms. An install made before this field existed is backfilled
  lazily, once per process, success OR failure.
- Windows unpack MUST use System32 `bsdtar` (reads both `.zip` and `.tar.gz`); a
  bare `tar` on PATH can resolve to Git's GNU tar, which cannot read `.zip`.

#### ROCm vs Vulkan, measured

**ROCm is not simply faster than Vulkan. It is a trade, and on the one machine we
have measured it loses the half a user actually watches.** The UI shipped
`Switch to ROCm (faster on AMD)` from 2026-09-05 to 2026-09-06; that claim was
never measured. When it was, it was wrong.

Measured 2026-09-05. Same llama.cpp build (**b10665**), same models, same
machine, **200 tokens forced** (`n_predict`), a **non-repeating** prompt (so
nothing came out of the prefix cache), **speculative decoding OFF**, one model
loaded at a time. Rates are llama-server's own `timings.prompt_per_second` /
`timings.predicted_per_second`.

| Model / backend | Prompt reading (t/s) | Writing the reply (t/s) |
|---|---:|---:|
| Qwen3.5-9B Q8 — ROCm | 769.6 | 14.41 |
| Qwen3.5-9B Q8 — **Vulkan** | 639.8 | **21.01** |
| Qwen3.8-27B Q8 — ROCm | 239.9 | 4.98 |
| Qwen3.8-27B Q8 — **Vulkan** | 197.3 | **6.17** |

ROCm reads prompts **~20% faster** and writes replies **24–46% slower**. Reading
happens once, before the first word appears; writing is what the user sits and
watches, so "faster" was false for the part that matters.

Sanity check on the numbers themselves: generation is memory-bandwidth-bound, and
Vulkan reaches **~72%** of this chip's theoretical bandwidth on BOTH models while
ROCm reaches **50–57%**. Two independent models agreeing on the same shortfall is
a coherent result, not run-to-run noise.

**Scope — read this before generalising.** ONE machine, ONE chip: an AMD Strix
Halo APU (Radeon 8060S, `gfx1151`, unified memory), Linux, engine b10665. It is
evidence about Strix Halo, and it is the reason ROCm is offered as an optional
build rather than recommended — see `OPTIONAL_BACKENDS` in `EngineCard.tsx` and
`BACKEND_LABELS` in `gpu-detector.ts`. It is **not** evidence about discrete
Radeon cards, about CDNA parts, about Windows ROCm, or about a later engine
build. Re-measuring on a different part, or on a newer build, is how this changes
— not an assumption that upstream fixed it.
<!-- verify: {"path": "youcoded/desktop/src/main/models/gpu-detector.ts", "contains": "reads faster, writes slower"} -->

### CLI alias table (`ARG_ALIASES` in engine-pin.ts, generated by generate-engine-pin.mjs)

llama-server accepts up to THREE spellings of most options — short (`-c`), long
(`--ctx-size`) and environment (`LLAMA_ARG_CTX_SIZE`) — and its preset file accepts all
three too. So anything that reasons about option NAMES (writing `models.ini`, or
refusing to let a user override a reserved option in Advanced → extra flags) has to
collapse them to one name first, or `--ctk` sails past a denylist that only knows
`cache-type-k`.

- **274 entries at b10665**, generated from that binary's own `--help`. Read it as
  `ARG_ALIASES[key] ?? key`: only the alternate spellings are listed, and a canonical
  name maps to itself by absence.
- **Regenerated ONLY with `--binary`.** `node desktop/scripts/generate-engine-pin.mjs
  <tag> --binary <path>` emits the `ARG_ALIASES` block along with the asset rows;
  without `--binary` the table is not regenerated and the script says so. A bump that
  skips it leaves the app reasoning about the previous build's option names.
- **A negated spelling keeps its own `no-` name** (`nkvo` → `no-kv-offload`, `no-webui`
  → `no-ui`) rather than folding into the positive. Folding would rewrite a user's
  `--no-mmap` into `mmap` and silently do the opposite of what they asked.
- **The object is PROTOTYPE-LESS (`Object.create(null)`) on purpose.** A plain object
  literal answers `constructor`, `toString`, `valueOf`, `hasOwnProperty` and
  `__proto__` with an inherited FUNCTION — not nullish, so `?? key` never fires. A user
  typing `--valueOf 1` would get a Function as their "canonical" option name, sail past
  a string denylist, and be written into `models.ini`, where an unrecognised key makes
  llama-server exit 1 at startup with nothing on screen tracing it back.
<!-- verify: {"path": "youcoded/desktop/src/main/engine/engine-pin.ts", "contains": "ARG_ALIASES"} -->

### GGUF cache layout + downloader naming contract (cache-scan.ts, Plan C model-downloader.ts)

Flat `*.gguf` files in `--models-dir` (== the configured `cacheDir`). Multi-part
split sets follow `<name>-00001-of-000NN.gguf`; the model is addressed through its
first part and cache-scan sums the parts' sizes into one entry.

- **Downloader flat-basename contract (Plan C):** `model-downloader.ts` writes each
  HF file into the cache dir under its BASENAME (repo subfolders collapsed) — that
  is exactly what `--models-dir` discovery + `cache-scan.ts`'s `ggufIdFromFileName`
  read, so the router-served id == the downloaded filename minus `.gguf`. NEVER
  rename downloaded files or change how split parts are named without re-running
  `probe-download.mjs`.
- **Multi-part router-id VERIFIED (Amendment H):** `probe-download.mjs` downloads a
  real ~0.4 GB unsloth GGUF, ALSO splits it with the sibling `llama-gguf-split`
  (same archive as `llama-server`), drops both flat in the cache, and asserts the
  router LISTS + SERVES both the single-file id AND the `-00001-of-00002` split id,
  with a real chat round-trip against the split model. This is the only cheap check
  of the large-tier (gpt-oss-120b / Qwen3.5-122B) multi-part path, which can't be
  downloaded on a 32 GB dev box. **PASS on b9992** (Windows x64 Vulkan,
  `Qwen3-0.6B-Q4_K_M` single + `Qwen3-0.6B-SPLIT-00001-of-00002`), 2026-07-14 —
  router discovered both ids from `--models-dir` and served the split model.
- **One level of folders, named by the FOLDER — VERIFIED b10665, 2026-09-05
  (design §E2).** A model that ships a vision projector cannot live flat: the
  router only passes `--mmproj` when the model and an `mmproj*.gguf` sit together
  in ONE subdirectory of `--models-dir`. Probed with SmolVLM-256M laid out both
  ways — flat, `input_modalities` was `["text"]` and no `--mmproj` was passed;
  in a folder, `["text","image"]`, `--mmproj` passed, and a solid-red PNG came
  back answered "Red." Three further facts that `cache-scan.ts` depends on, all
  probed the same day:
  - **The id is the FOLDER's name, not the file's.** `weird-folder/C-Q8_0.gguf`
    was served as `weird-folder`. So the downloader must name the folder exactly
    what the flat layout would have called the model, or the app and the router
    disagree about what a model is called.
  - **Two levels deep is invisible.** `deep/inner/B-Q8_0.gguf` was absent from
    `GET /models` entirely (checked with `--models-max 16`, so it is not a cap).
  - **A name collision is resolved NON-DETERMINISTICALLY — never reason about
    which copy "wins".** `<cacheDir>/X.gguf` and `<cacheDir>/X/` are one model id
    to the router: it serves exactly one of the two and silently drops the other.
    On ONE server, one cache dir: `ACOLL-Q4_K_M.gguf` beside
    `ACOLL-Q4_K_M/ACOLL-Q4_K_M.gguf` was served from the FLAT file
    (`input_modalities: ["text"]`), while `BCOLL-Q4_K_M` — the same pair, created
    in the opposite order — was served from the FOLDER (`["text","image"]`). The
    outcome tracks directory-entry order, which is the filesystem's and not the
    app's, so it cannot be predicted from the layout or from creation order.
    `ModelDownloader.start` refuses to create the pair from EITHER end.
    **Before moving a flat model into its folder (§E4 / T17), read this:** do not
    order that move on an assumption that a half-populated folder is ignored
    while the flat file is still there. It may shadow the working model instead,
    and the user's model then stops loading with nothing on screen to explain it.
  A split set inside a folder is one model, named by the folder, loaded from its
  part 1. `probe-download.mjs` pins both folder ids; `probe-vision.mjs` pins the
  pairing and the image round-trip. **The FLAT half of that comparison — the same two
  files side by side reporting `["text"]` with no `--mmproj` — was measured by hand on
  2026-09-05 and is NOT in any probe**, so an engine bump re-verifies that a folder
  works, not that flat still fails. Extending `probe-vision.mjs` to lay the pair out
  both ways would close that; until it does, treat the flat result as a dated
  measurement, not a guard.
- **Router hot-reload of `--models-dir` after boot — RESOLVED 2026-08-16.** The
  router discovers GGUFs at BOOT and re-scans ONLY when asked: `GET /models?reload=1`
  (any non-empty value) re-runs `load_models()`. Its `need_reload` dirty flag is set
  only when a download the ROUTER itself started finishes, and ours are app-side, so
  it never fires for us. There is no timer, no inotify, no SIGHUP, no 404-miss
  rescan, and a plain `GET /models` does NOT re-scan.
  <!-- verify: {"path": "youcoded/desktop/src/main/engine/engine-supervisor.ts", "contains": "reload=1"} -->
  **A post-boot file is NOT servable until that rescan** — measured end-to-end on
  2026-08-16 against a real b9992 router on an isolated port: file dropped in after
  boot → absent from `GET /models` after 8s → `POST /v1/chat/completions` returns
  `400 model 'X' not found` → `GET /models?reload=1` → same send returns 200 and the
  model generates. This closes the question the 2026-07-15 note left open, and it is
  the answer the upstream README's line 1613 ("The server must be restarted after
  adding a new model") gets WRONG — contradicted by its own `?reload=1` note at 1765.
  Measured cost of a rescan: **0.8–1.6 ms** (dir holding a 5 GB GGUF).
  Amendment K2's union in `EngineSupervisor.listModels()` still stands, but it is a
  LISTING fix only: it merges a fresh `scanGgufCache` into the router's rows (router
  rows win — they carry live residency state; disk-only rows surface as 'unloaded'),
  which makes a disk-only model a fully selectable picker row the router has never
  heard of. Serveability is now guaranteed separately by `EngineSupervisor.ensureServable`
  (rescan-once-then-recheck, fails OPEN) at the local-send chokepoint in
  `provider-registry.ts`, plus a refresh after every download and delete.
  **`?reload=1` is a WRITE, never a poll:** `load_models()` unloads a running model
  whose source changed or vanished. Two behaviors measured on the same live probe —
  a model already `loaded` SURVIVES a rescan unchanged, and an in-flight streaming
  completion survives one (599 SSE chunks, clean exit); a model whose file was
  deleted is dropped from the list.
  Guards: engine-supervisor.test.ts → the "router rescan" describe (esp. "the
  background model poll NEVER sends reload=1"); provider-registry.test.ts →
  "an unservable model fails with the REAL cause, not the router 400".

## Verification

`desktop/test-engine/` holds twelve `probe-*.mjs` files against the real binary, of
which **NINE are engine-bump gates** — analogous to `test-conpty/` on a CC bump:
`probe-health` (the router SKELETON boots and answers `/health` — it spawns the
RECOVERY shape, not the shipped one; see its header), `probe-models` (id parity + `?reload=1`
picking up a post-boot file), `probe-chat` (streamed round-trip), `probe-download`
(flat-basename ↔ router id, single AND split), `probe-tools` (`--jinja` constrained
tool call + real `/props` `n_ctx`), `probe-speed` (both speed flags reach the model
child and the drafter fires), `probe-presets` (the `models.ini` grammar, the fatal-key
behaviour, and that every reserved key is a real option on this build), `probe-vision`
(the folder layout, `input_modalities`, and a real image answered) and `probe-headers`
(no binary needed — real Hugging Face headers in one 1 MB range request).

**`desktop/test-engine/README.md` is the one place that decides which probes a bump
re-runs, and why the other three are excluded** — `probe-parallel` and
`probe-prefix-cache` are one-off MEASUREMENTS with no pass/fail (their findings are
the "Parallel slots" and "KV prefix reuse" sections below), and `probe-shell-command`
is about the "Run in terminal" path, not the engine. Do not re-derive that list from
a directory listing, or from a count in this file.

The original three PASS on b9992 (Windows x64 CPU,
Qwen3-0.6B-Q4_K_M.gguf), 2026-07-13; the `?reload=1` assertion was added 2026-08-16
and PASSES on b9992 (Linux x64 Vulkan, Qwen3.5-2B-Q8_0). **That assertion is the
only guard that can see upstream dropping the rescan** — the unit tests mock fetch,
so its removal would look exactly like the 2026-08-16 bug and nothing else we own
would catch it.
`probe-download.mjs` (Plan C: flat-basename ↔ router-id for single AND multi-part)
PASS on b9992 (Windows x64 Vulkan), 2026-07-14 — also re-run on every engine bump.
`probe-tools.mjs` (Plan C: `--jinja` constrained tool-call round-trip + never-force +
real `/props` `n_ctx`) runs against an already-running engine — re-run on every engine
bump; verified live during acceptance on the Linux dev box.
`probe-speed.mjs` (2026-09-04: `--spec-default` + `--cache-type-k q8_0` reach the model
CHILD's cmdline and the drafter fires on an echo task at ≥50% acceptance) — re-run on
every engine bump. **PASS on b10665** (Linux x64 Vulkan, `Qwen3.5-2B-Q8_0`): 640 drafted,
573 accepted (90%), 281 tok/s; probe-tools also PASSED against a router carrying both
flags on the same day, so grammar-constrained tool calls and n-gram drafting coexist.

`probe-presets.mjs` (2026-09-05: the `[*]` cascade, a per-model override, `source:
"preset"`, a bad key being FATAL in either section, and every reserved key being a real
option) — **PASS on b10665**, Linux x64 Vulkan. It loads no weights: `GET /models`
renders each model's full child command line without reading the model.
`probe-vision.mjs` (2026-09-05: SmolVLM-256M in a folder is listed under the FOLDER's
name, reports `input_modalities` including `image`, and answers a solid-red PNG with
"red"; the same two files laid out flat report `["text"]` and pass no `--mmproj`) —
**PASS on b10665**, Linux x64 Vulkan.
`probe-headers.mjs` (2026-09-05: one 1 MB range request reaches every curated repo's
architecture keys) — **PASS**; on its first run it found that Gemma 4's larger models
write `head_count_kv` as a per-LAYER array, which the reader was dropping.

**b10665 bump, 2026-08-27 (Linux x64 Vulkan, `Qwen3.5-2B-Q8_0` + `Qwen3-0.6B-Q4_K_M`):**
the five that existed then all PASS — health, models (id parity + `?reload=1`), chat
(streamed, 47 t/s), download (single-file AND `-00001-of-00002` split served), tools
(schema-valid constrained call + never-force held). Archive layout unchanged:
Linux/macOS `.tar.gz` still nest under `llama-<tag>/`, and the pinned sha256 for
`llama-b10665-bin-ubuntu-vulkan-x64.tar.gz` was verified against the downloaded file.
The four newer probes (speed, presets, vision, headers) were added 2026-09-04/05
against this same pin and each is recorded PASS above, on the dates given. Those four
results are the ones from the local-engine-upgrades build; they were not re-run for
this documentation pass.

**`GET /models` lists one row per FILE, so a split set is N rows, not one.** Measured
on b10665: a cache holding `Qwen3-0.6B-SPLIT-00001-of-00002` + `-00002-of-00002`
returns BOTH ids. `cache-scan.ts` collapses split sets to the first part, so the two
lists differ by design — that is listing granularity, not an id-derivation mismatch.
`EngineSupervisor.listModels()` drops the follower rows via `isFollowerPart`
(`shared/gguf-split.ts`) and `probe-models.mjs` folds them before its parity
assertion. Parts 2..N carry no architecture header, so a follower row offered to a
user can only ever fail — that reached the model picker as four selectable rows for
one Qwen3.8-Flash-Next download, three of which 500'd (2026-08-27).
<!-- verify: {"path": "youcoded/desktop/src/shared/gguf-split.ts", "contains": "isFollowerPart"} -->

## Parallel slots (specialists, plan 1a probe)

**Measured 2026-08-12** on the Linux dev box against a system-installed
`llama-server` (`version: 9957 (c4ae9a88f8)`, i.e. build `b9957` — NOT the app's
pinned `b9992`; this was the only binary available on this machine, so results
are directionally useful but should be re-checked against the current pin (`b10665`) before being
treated as final). Server launched manually on an isolated port (8199, separate
from the live app's engine on 9920) with the supervisor's exact router-mode arg
list (`engine-supervisor.ts:290-309`), `-c 8192` (shrunk from the real default
32768 only to keep iteration fast on this box), against `Qwen3.5-2B-Q8_0`
(the smallest model in `~/.cache/llama.cpp`). `desktop/test-engine/probe-parallel.mjs`
fires N simultaneous short chat completions (`max_tokens: 24`) for N in {1, 2, 4}
and reports total wall time, average per-request time, and a total-vs-N×single
classification.

**Run 1 — default args (no `--parallel`, i.e. `-np -1` = auto):**

| N | total_ms | avg_req_ms | min_ms | max_ms | classification |
|---|----------|------------|--------|--------|----------------|
| 1 | 642 | 641 | 641 | 641 | batched (baseline) |
| 2 | 599 | 598 | 597 | 599 | batched |
| 4 | 1200 | 1188 | 1178 | 1199 | partial |

Server startup log showed `n_slots = 4` (the log's name; `/props?model=` reports the same
figure as `total_slots`) even with no `--parallel` flag —
this build's `-np -1` "auto" already resolves to 4 slots on this hardware.

**Run 2 — explicit `--parallel 4` added to the same spawn args:**

| N | total_ms | avg_req_ms | min_ms | max_ms | classification |
|---|----------|------------|--------|--------|----------------|
| 1 | 558 | 558 | 558 | 558 | batched (baseline) |
| 2 | 495 | 486 | 477 | 495 | batched |
| 4 | 952 | 939 | 935 | 950 | partial |

`--parallel 4` added to the supervisor's arg set did **not** error — the
process started and served normally. Numbers are consistent with Run 1 within
noise, confirming the "auto" default and an explicit `--parallel 4` behave the
same on this build/hardware (4 slots either way).

**Decision:** `HOSTED_MAX_CONCURRENT_SPECIALISTS = 4` (`harness/specialists/limits.ts`) — at N=4, avg per-request
latency (~939–1188 ms) is ≤ 2× the single-request baseline (~558–642 ms) in
both runs (ratio ≈ 1.7–1.85×), the largest of the tested N values that clears
that bar. N=2 batches cleanly (avg per-request latency actually *dropped*
below the single-request baseline in both runs — within measurement noise, not
a real speedup). N=4 shows partial batching, not full serialization.

**Supervisor arg change:** because this build's default already resolves to 4
slots, adding `--parallel 4` explicitly to `engine-supervisor.ts`'s spawn args
is optional on this hardware/build but is still recommended for plan 1b — it
pins the slot count instead of relying on an "auto" heuristic that could
resolve differently on a smaller consumer machine (fewer cores/less RAM). That
supervisor code change belongs to plan 1b, not this probe.

**Before adding `--parallel N` (measured 2026-09-04 on b10665):** an explicit slot count
turns `--kv-unified` OFF, so each slot gets its own `-c` / N window and `/props?model=`
reports THAT (`-c 16384 --parallel 4` → `n_ctx 4096`), while the auto default keeps one
shared pool at the full `-c` (`n_ctx 16384`). `effectiveContextWindow` passes the engine's
number through, so sessions would follow it — but the Settings context knob
(`EngineCard.tsx`) still shows the `-c` the user typed. Adding the flag means teaching the
knob the same split, or the gauge and the threshold disagree.

**Caveat:** measured against a non-pinned build (`b9957` vs the app's pinned
`b9992`) and a reasoning model (`Qwen3.5-2B` emits `reasoning_content`,
truncated by the low `max_tokens`) rather than a plain chat model — re-run
`probe-parallel.mjs` against `b9992` with the app's actual small-model tier
before this decision is treated as load-bearing.

### KV prefix reuse (specialists, plan 1a probe)

**Measured 2026-08-12**, same server/model/build as above (default args, no
`--parallel`; single manually-launched instance on port 8199).
`desktop/test-engine/probe-prefix-cache.mjs` builds a ~2,000-token filler
system prefix, sends two sequential requests sharing it (different user
turns) for run (a), then two sequential requests with fully distinct
~2,000-token prefixes for run (b), reading `timings.prompt_ms` from each
completion payload (present on this build — no wall-clock fallback needed).

| run | request | prompt_n | prompt_ms |
|-----|---------|----------|-----------|
| (a) identical prefix | a1 (cold) | 2209 | 1407.8 |
| (a) identical prefix | a2 (same prefix, new user turn) | 17 | 177.6 |
| (b) distinct prefixes | b1 (prefix A again) | 19 | 180.8 |
| (b) distinct prefixes | b2 (prefix B, never seen) | 2207 | 1804.0 |

a2/b2 prefill ratio = 177.6 / 1804.0 = **9.8%** (well under the 50% reuse
threshold).

**Verdict: prefix reuse survives sequential child-style fan-out on build
b9957.** `prompt_n` on a repeated-prefix request drops from ~2,200 to ~17–19
tokens (only the new user turn is reprocessed), and prefill time drops
correspondingly from ~1.4–1.8s to ~0.18s. The server log for the parallel
probe (above) independently corroborates this: repeat requests were
`selected slot by LCP similarity` rather than by LRU, i.e. the router matched
the incoming prompt against a cached slot's longest common prefix.

Note run (b)'s b1 also hit the cache (reused prefix A's slot from run (a)'s
a2, since b1 resends prefix A) — this is expected given all four requests ran
sequentially against the same server instance and slot LRU/LCP selection
persists across the two "runs" as scripted (they are not isolated fresh
server starts). This does not weaken the verdict — b2 (the first-ever
occurrence of prefix B) is the true cold-prefix comparison point, and it cost
2207 prompt tokens vs a2's 17.

## Stage-two probes — re-run on the pinned build (2026-09-04)

The specialists spec (§8) names three live probes that must be answered before the
stage-two (plans) design is final. The 2026-08-12 numbers above were taken on a
non-pinned build (`b9957`) and probe 2 was *sequential*. All three were re-run on
2026-09-04 on the Linux dev box (Strix Halo, 121 GB unified memory, Vulkan) against the
app's **pinned `b10665`** binary (the copy under `~/.config/youcoded-dev/engine/`),
launched by hand on port 8199 with the supervisor's exact router-mode arg list and
`-c 16384`, in two shapes: **the app's real shape (no slot flag)** and `--parallel 4`.
Destin's live engine on 9920 was left alone.

### Probe 1 — how many helpers really run at once (`probe-parallel.mjs`, now takes an N list)

Qwen3.5-2B-Q8_0, `max_tokens: 24`, N simultaneous requests, **app shape (no `--parallel`)**:

| N | total_ms | avg_req_ms | min_ms | max_ms | vs N×single | classification (the script's) |
|---|----------|------------|--------|--------|-------------|----------------|
| 1 | 475 | 475 | 475 | 475 | 100% | batched |
| 2 | 528 | 522 | 517 | 528 | 56% | batched |
| 4 | 907 | 900 | 892 | 907 | 48% | partial |
| 8 | 1890 | 1465 | 878 | 1889 | 50% | partial |

Reading the N=8 row: `min` 878 ms and `max` 1889 ms are two waves — four requests finish in
about one wave's time and four wait for the first four — which is what a four-slot ceiling
looks like from outside. N=4's average is 1.9× the single-request baseline. `--parallel 4`
gave the same picture (390 / 556 / 799 / 1160 ms; N=8 split 787 / 1533).
`/props?model=<id>` and the server log both say **`total_slots = 4`** in either shape.

**Findings that matter to the plan card:**

1. **Four helpers at once is the ceiling on this build, with or without the flag, and an
   N=8 fan-out serializes into two waves.** `HOSTED_MAX_CONCURRENT_SPECIALISTS = 4` stands.
2. **The two shapes divide the context differently.** With an explicit `--parallel 4` the
   engine splits `-c` evenly (`n_ctx_slot = 4096`, `kv_unified = false`): every request gets a
   quarter. With **the app's real shape** the engine reports `kv_unified = true` and
   `n_ctx_slot = 16384`: every request may use the whole window, but all concurrent
   requests draw from ONE pool of that size. Four helpers with 32k of context each on
   Destin's `-c 128000` engine fill it; one helper alone can use all 128k. A plan's
   per-child budgets therefore have to be summed against the shared pool, not checked one
   at a time against `-c`. **Do not add `--parallel` to the supervisor** (the plan-1a note
   above suggested it) without also deciding to give up the shared pool.

Side finding, filed as a bug the same day: the app reads the slot count as `n_slots` from
a model-less `GET /props`. On `b10665` the field is **`total_slots`** and only present on
`GET /props?model=<id>` (the model-less call answers `model_path: "none"`, `n_ctx: 0`, no
slot field). So `totalSlots` is always null in the shipped app and
`capability-profile.ts`'s `localSlotCap(null)` caps every local model at **one** concurrent
helper. Fix branch: `fix/engine-slot-count-field`.

### Probe 2 — does prefix reuse survive PARALLEL fan-out (`probe-prefix-fanout.mjs`, new)

`probe-prefix-cache.mjs` sends its requests one after another, so they share a slot; a
plan fans children out at once, into different slots. The new probe measures that.
Qwen3.5-2B-Q8_0, a ~2,150-token shared system prefix already seen once, N=4;
`timings.prompt_n` = tokens actually prefilled, `cache_n` = tokens taken from cache.

| shape | wave 1 (first simultaneous fan-out) | wave 2 (same prefix again) |
|---|---|---|
| app shape (unified KV) | 1 of 4 reused (22 tokens); 3 paid the full 2,151 — avg **71%** of a cold prefill, ~2.3 s each | all 4 reused (23 tokens, **1%**), ~0.7 s each |
| `--parallel 4` | 2 of 4 reused; 2 paid in full — avg **48%** | all 4 reused, **1%** |

Cold prefill for reference: 2,264 tokens in ~0.9 s alone; a full prefill inside a wave of
four costs ~2–2.9 s because four prefills contend for one GPU.

**Verdict: partial, in both shapes.** The engine does not copy a cached prefix into every
slot the moment a wave arrives; whichever slots have not held that prefix pay for it. After
one wave every slot has it and reuse is total. For the plan card: **the worst-case
ceiling must charge a full prefill per child on the first wave** (the spec's "honest
arithmetic" rule); a re-planning second wave over the same helpers is cheap. The 2026-08-12
sequential result is unchanged.

### Probe 3 — can a local model author a valid plan through the tool-call grammar (`probe-plan-grammar.mjs`, new)

The probe defines `propose_plan` with a faithful draft of the spec §4 schema — a tree of
steps, four kinds (`map` / `verify` / `combine` / `repeat`), enums, required lists, integer
bounds, `additionalProperties: false`, and recursion through `$ref` for `repeat.steps` — and
asks for a three-file review → verify → combine plan, three trials per model, through the
harness's local-engine request shape (`tools`, `tool_choice: auto`,
`parallel_tool_calls: false`, `max_tokens: 2048`). Ajv (strict) validates the arguments.

| model | schema-valid | valid AND sensible | seconds per trial | what went wrong |
|---|---|---|---|---|
| gemma-4-E2B-it-Q8_0 | 0/3 | 0/3 | 14–21 | Emitted `{name, description}` steps — keys the schema forbids. The grammar was **not enforced at all** for this template, even though `/props` reports `supports_tools: true` |
| Qwen3.5-2B-Q8_0 | 2/3 | 1/3 | 8–28 | One plan cut off mid-JSON (ran out of output budget); one valid plan mapped over one file and had no combine |
| Qwen3.5-9B-Q8_0 | 3/3 | 3/3 | 40–44 | — |
| Qwen3.6-35B-A3B-UD-Q6_K_XL | 2/3 | 2/3 | 47–143 | One trial answered in prose and never called the tool |
| Qwen3.8-27B-UD-Q8_K_XL | 3/3 | 3/3 | 108–253 | — |

**Verdict: plan authoring is a model-class gate, not cloud-only.** From the 9B class up,
every local model on this machine produced a schema-valid, sensible plan every time (the
35B's single miss was a refusal to call the tool, not a bad plan). Below that, the grammar
is unreliable or absent. Three design consequences:

1. **Gate `propose_plan` on the same model class as the `Task` tool** (spec §4 already
   allows this); the 2B class must not be offered it.
2. **Validate on the app side and allow one retry** (spec §8 "one-retry schema validation")
   — the engine's grammar cannot be trusted to have run, as the gemma case proves, and a
   truncated JSON body is a real failure mode even when it did.
3. **Plan authoring on a local model is slow**: 40 s on the 9B, two to four minutes on the
   27B, because the model reasons at length before the call. The plan card needs a
   "writing the plan…" state, not a spinner that looks hung.

Re-run all three (`probe-parallel.mjs <base> <model> 1,2,4,8`, `probe-prefix-fanout.mjs`,
`probe-plan-grammar.mjs`) on every engine bump; results replace this section.
