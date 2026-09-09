# Provider Coupling Registry (cloud APIs + AI SDK)

Tracks YouCoded's couplings to external model-provider APIs and the Vercel
AI SDK, mirroring `cc-dependencies.md`. Populated starting Phase 1 (ADR 006
in the youcoded-dev workspace).

## Pinned versions

- **ai** — `7.0.89` (Vercel AI SDK). Stream-part, finish-reason, and
  tool-call/tool-result message shapes pinned by
  `desktop/tests/harness-*.test.ts`.
- **@modelcontextprotocol/sdk** — `^1.30.0` (native MCP phase 1). `Client`,
  `StdioClientTransport`, `StreamableHTTPClientTransport`, `UnauthorizedError`,
  `ErrorCode`/`McpError` from `types.js`. Consumer: `harness/mcp/mcp-client.ts`.

## ChatGPT diagnostics SDK coupling (Stage 1, unshipped)

`@ai-sdk/openai` 4.0.55 Responses `includeRawChunks` exposes `rawValue` before
normalized usage fills absent cache fields. `chatgpt-model.ts` reduces those
chunks to allowlisted usage at consumer demand, then removes raw parts from the
outward stream. It does not clone/tee HTTP bodies or add wire fields. Auth owns
actual-send and 401 resend identity; async-local middleware context associates
the successful stream with its transport attempt. Tests in `chatgpt-auth.test.ts`
exercise fake SSE through the actual installed SDK. Storage limits, local CLI,
privacy and measured hashing costs: `native-runtime.md` → ChatGPT request diagnostics.

## ChatGPT continuation identity (Stage 4, unshipped)

`chatgpt-account.json` carries a `credentialEpoch` field: 16 random bytes (hex),
minted on every fresh sign-in, dropped with the account on sign-out, reported as
`legacy` for a row written before the field existed. It is the durable half of
the continuation identity `ProviderRegistry.continuationIdentity()` builds
(`providerId\0modelId\0sha256(accountId)\0credentialEpoch`) — the in-memory
`authGeneration` counter restarts at 0 each process and so cannot fence a
checkpoint across a restart. The identity is what the durable accepted-history
sidecar is bound to, and what the pinned `@ai-sdk/openai` 4.0.55 Responses
continuation metadata is only ever replayed under. Depth:
`native-runtime.md` → Durable accepted history.

## Touchpoints (to be filled as built)

- **Vercel AI SDK surface** — `streamText` stream-part shapes, tool-approval
  mechanism (`needsApproval` vs `toolApproval` — version-sensitive), provider
  factory signatures. (harness, provider-registry)
- **AI SDK v7 tool-call loop surface** — tools passed WITHOUT `execute` make
  `streamText` emit a `tool-call` fullStream part and finish the step with
  finishReason `'tool-calls'` (the SDK does NOT loop on its own). The RAW
  provider chunk (`LanguageModelV4ToolCall`) carries `input` as a STRINGIFIED
  JSON string and `finishReason` as the V4 object `{ unified, raw }`;
  `streamText` TRANSFORMS these into the fullStream `tool-call` part
  `{ type:'tool-call', toolCallId, toolName, input:<parsed object> }` and
  flattens `result.finishReason` back to the `'tool-calls'` string. The driver
  executes tools itself and appends an assistant message with a
  `{ type:'tool-call', toolCallId, toolName, input:<object> }` part plus a
  `role:'tool'` message whose parts are
  `{ type:'tool-result', toolCallId, toolName, output:{ type:'text', value } }`
  — the v7 field is `output` (a `ToolResultOutput`), NOT `result`. Field names
  verified against ai@7.0.22 and PINNED by
  `desktop/tests/harness-sdk-toolcall-contract.test.ts` — run it first on any
  ai bump. Error surface (verified empirically during the spike, NOT pinned by
  the test — Task 9's retry wrapper adds its own coverage): `streamText`
  returns synchronously and never throws; a `doStream` rejection appears as a
  `{ type:'error' }` fullStream part AND rejects the awaited promises
  (`result.text` throws `AI_NoOutputGeneratedError`); the SDK already wraps
  calls in `retryWithExponentialBackoff` internally. (harness)
- **`@modelcontextprotocol/sdk@1.30.0` `Client#callTool` positional signature** —
  real signature is `(params, resultSchema, options)`; `mcp-client.ts` always
  passes `undefined` for `resultSchema` (falls back to the SDK's default
  `CallToolResultSchema` — this file never validates structured output) so
  `signal`/`timeout` land in `options` (position 3). A "simplified" 2-arg call
  would silently shift `options` into the `resultSchema` slot instead, dropping
  `signal`/`timeout` — the SDK would then apply its own hardcoded
  `DEFAULT_REQUEST_TIMEOUT_MSEC` (60_000ms) with an error naming neither the
  server nor the configured bound. `UnauthorizedError` (thrown by
  `StreamableHTTPClientTransport` when a server needs OAuth, unsupported in
  phase 1) does NOT set `.name` — it inherits `Error.prototype.name`, so
  `instanceof` is the only reliable check; `.name`/`.constructor.name` are
  checked too so a test-built synthetic error is still recognized.
  `StdioClientTransport`'s `stderr` option defaults to `'inherit'` — phase 1
  overrides it to `'pipe'` so a failing server's stderr can be quoted in the
  connect-failure message instead of vanishing into the app's own stderr.
  Verified against `@modelcontextprotocol/sdk@1.30.0`'s shipped `.d.ts`/built
  JS; pinned by `desktop/tests/mcp-client.test.ts`. (harness/mcp)
- **models.dev `api.json` schema** — `https://models.dev/api.json`, shape
  `{ [providerKey]: { models: { [modelId]: {...} } } }`. Fields consumed per
  model row: `name` (string label), `limit.context` (number → contextLength),
  `tool_call` (boolean → supportsTools), `reasoning` (boolean →
  supportsReasoning), `cost.input` / `cost.output` (numbers, ALREADY USD per
  1M tokens — no scaling), `cost.cache_read` / `cost.cache_write` (numbers,
  same per-1M convention — the prompt-cache rates; omitted unless the row
  publishes them as numbers, never coerced to 0). Provider keys used:
  `anthropic`, `openai`, `google`. Parsed DEFENSIVELY in `src/main/providers/model-catalog.ts` —
  malformed rows are skipped, absent fields omitted (never guessed), and a
  failed fetch falls back to the 24h disk cache
  (`provider-catalog-cache.json` in Electron userData — per-profile, so the
  dev instance and the built app never share or contend for it),
  stale-if-offline. If
  models.dev renames fields or restructures the top level, the catalog
  silently thins out rather than erroring — check this consumer first.
  (model-catalog)
- **OpenRouter `/api/v1/models`** — `https://openrouter.ai/api/v1/models`,
  shape `{ data: [...] }`. Fields consumed per row: `id` (string, required —
  rows without it are skipped), `name` (string label), `context_length`
  (number), `supported_parameters` (string array — `includes('tools')` →
  supportsTools), `pricing.prompt` / `pricing.completion` (STRINGS, USD per
  single token — multiplied by 1e6 into CatalogModel's per-1M convention),
  `pricing.input_cache_read` / `pricing.input_cache_write` (STRINGS, same
  per-token → per-1M scaling — the prompt-cache rates; a field that is absent,
  null, empty or whitespace-only is omitted rather than read as $0).
  Same defensive-parse + stale-cache-fallback posture as models.dev; consumer
  is `src/main/providers/model-catalog.ts`. (model-catalog)
- **AI SDK local-model serial-only constraint** — `@ai-sdk/openai-compatible`
  `3.0.7`'s `createOpenAICompatible({ …, transformRequestBody })` config hook
  rewrites the request body before send. The LOCAL-engine branch of
  `languageModel(binding, { serialToolCalls })` uses it to inject
  `parallel_tool_calls: false` for small local models (spec §4.2) — llama-server
  honors it and `--jinja` already grammar-constrains the emitted tool-call args.
  We deliberately do NOT set a top-level `json_schema`/`response_format` (that
  would force JSON on every reply and break plain-text answers). The hook is
  stored on the model's `config` (reachable at runtime as `(model as any).config`,
  pinned by `desktop/tests/provider-registry.test.ts`) — if the openai-compatible
  config API drops/renames `transformRequestBody`, the constraint silently stops
  applying; re-verify on any `@ai-sdk/openai-compatible` bump. Round-trip proven
  by `desktop/test-engine/probe-tools.mjs` (dev-run, engine-bump gated).
  (provider-registry)
- **OpenRouter attribution + BYOK** — attribution headers (`HTTP-Referer`,
  `X-Title`), BYOK behavior. (provider-registry)
- **Per-vendor quirks** — reasoning blocks, prompt caching, rate-limit
  headers; one entry per adopted `@ai-sdk/*` provider. (provider-registry)
- **HF model search** —
  `https://huggingface.co/api/models?search=<q>&filter=gguf&sort=downloads&limit=30`.
  Fields consumed per row: `id` (string, required — rows without it are
  skipped), `downloads` / `likes` (numbers, default 0 when absent). Parsed
  DEFENSIVELY — a non-array response yields no hits. Consumer:
  `src/main/models/hf-client.ts`. (hf-client)
- **HF repo tree** —
  `https://huggingface.co/api/models/<owner>/<repo>/tree/main?recursive=true`.
  `recursive=true` is REQUIRED (unsloth keeps dynamic quants in subfolders).
  Fields consumed per row: `type` (`file` / `directory` — only `file` rows
  are kept), `path` (string, required), `size` (number, required), `lfs.oid`
  (64-hex sha256, optional → null when absent or malformed; the downloader
  skips verification when null). Rows missing a required field are skipped.
  Consumers: `src/main/models/hf-client.ts`, `model-downloader.ts`. (hf-client)
- **HF resolve URLs** —
  `https://huggingface.co/<owner>/<repo>/resolve/main/<path>` → 302 to the CDN
  (Node fetch follows redirects). `Range` request support is relied on for
  resumable downloads. Path segments are individually `encodeURIComponent`-encoded
  (subfolders preserved). Consumer: `model-downloader.ts`. (hf-client)
- **Curated remote list** —
  `https://raw.githubusercontent.com/itsdestin/youcoded/master/curated-models.json`.
  Gated on `schemaVersion` (must equal 1); on fetch failure or a malformed /
  version-mismatched payload, falls back to the shipped copy. Consumer:
  `src/main/models/curated-catalog.ts`. (curated-catalog)
- **Exa hosted MCP search** — `https://mcp.exa.ai/mcp` (keyless; `?exaApiKey=`
  lifts limits on the same endpoint). JSON-RPC 2.0 `tools/call` → `web_search_exa`
  `{query, numResults}`. OBSERVED (2026-07-16, keyless): **no `initialize`
  handshake is required** — a stateless `tools/call` on the bare endpoint returns
  HTTP 200 (the initialize → `notifications/initialized` sequence is kept in the
  probe as a fallback only). Responses are **SSE-framed** (`event: message` +
  `data:` lines), never plain JSON on this endpoint, but the parser handles both.
  Result payload path is `result.content[0].text` — and that text is a
  **human-readable PLAIN-TEXT block, NOT a JSON string**: records separated by
  `\n\n---\n\n`, each formatted as `Title:` / `URL:` / `Published:` (ISO date or
  `N/A`) / `Author:` (or `N/A`) / `Highlights:` (snippet, may span lines). The
  content item also carries `_meta.searchTime`. A tool-level failure comes back
  as HTTP 200 with `result.isError:true` and the message inside
  `content[0].text`. Malformed/refused responses throw a typed backend error the
  chain absorbs. Probe: `desktop/test-search/probe-exa.mjs`; parser pinned by
  `desktop/tests/search-backends.test.ts` on a captured fixture. Consumer:
  `src/main/harness/search/backends/exa.ts`. (search)
- **DuckDuckGo HTML fallback** — `https://html.duckduckgo.com/html/?q=`. Scrape,
  not an API: `202` = rate-limited → honest error, SINGLE attempt, never retried
  (Apr–May 2025 breakage waves; see youcoded-dev
  docs/active/investigations/2026-07-15-web-search-backends.md). OBSERVED
  (2026-07-16): returned `200` (not rate-limited) with 10 results. Parses
  `result__a` anchors (+ `result__snippet` blocks). Hrefs are **indirect
  redirects, not direct**: `//duckduckgo.com/l/?uddg=<url-encoded target>&amp;rut=<hash>`
  — the parser must HTML-unescape `&amp;`→`&`, read the `uddg` query param, and
  `decodeURIComponent` it to recover the real URL. Markup drift → parser returns
  a "DDG markup changed" error, not garbage. Probe:
  `desktop/test-search/probe-ddg.mjs`. Consumer:
  `src/main/harness/search/backends/ddg.ts`. (search)
- **Tavily `/search`** — `https://api.tavily.com/search`, `Authorization: Bearer`,
  `{query, max_results}` → `{results:[{title,url,content}]}` (keyed upgrade,
  1,000/mo free). Not exercised live — no key on this machine; shape is from
  official docs and pinned to the probe's SKIP message until a key exists.
  Defensive per-row parse; rows without `url` skipped. Probe:
  `desktop/test-search/probe-tavily.mjs`. Consumer:
  `src/main/harness/search/backends/tavily.ts`. (search)
- **vercel/ai tool-result image split (watch, unmerged)** —
  [vercel/ai PR #12621](https://github.com/vercel/ai/pull/12621) (unmerged as
  of 2026-08-11) implements exactly the tool-result image split we hand-roll
  in `wire-adapter.ts`'s `adaptForWire`, natively inside
  `@ai-sdk/openai-compatible`. Tracking issue:
  [vercel/ai #10850](https://github.com/vercel/ai/issues/10850). If #12621
  merges, `adaptForWire`'s OpenAI-compatible split branch could shrink to
  configuration — but the adapter still earns its keep regardless: for the
  llama.cpp path (no images in tool-role messages at all — llama.cpp #20319,
  a gap `@ai-sdk/openai-compatible` itself can't close) and for the
  non-vision pixel strip, neither of which #12621 addresses. Re-check on
  merge. Design: youcoded-dev
  `docs/active/specs/2026-08-11-native-image-handling.md`. Consumer:
  `src/main/harness/wire-adapter.ts`. (harness/wire-adapter)
