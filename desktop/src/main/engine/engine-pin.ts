// The ONE place the llama.cpp engine version is pinned (spec §3.1). Bumping
// ENGINE_VERSION is a PR that MUST re-run the test-engine/ probes and re-verify
// docs/engine-dependencies.md — the same discipline as a Claude Code bump.
// Regenerate the tables: node scripts/generate-engine-pin.mjs <tag> --binary <path>
// binaryRelPath (path of llama-server inside each archive) is pinned per
// archive family and enforced by engine-acquisition's post-unpack existence
// check — a layout change upstream fails loudly, never installs a broken dir.
// Empirically verified for b10665 (2026-08-27, re-checked 2026-09-05): Windows
// .zip archives are FLAT (llama-server.exe + sibling DLLs at the archive root —
// upstream's release job injects the whole CPU toolset into every Windows
// backend zip); macOS/Linux .tar.gz archives nest everything under a single
// `llama-<tag>/` directory (binary at `llama-<tag>/llama-server` alongside its
// .so/.dylib). The tar path is therefore VERSION-DEPENDENT — the generator
// templates the tag in, so a bump regenerates it. Do NOT revert to
// `build/bin/llama-server` (a stale guess).
import type { EngineBackend } from '../../shared/engine-types';

export const ENGINE_VERSION = 'b10665';

export interface EngineAsset {
  platform: 'win32' | 'darwin' | 'linux';
  arch: 'x64' | 'arm64';
  backend: EngineBackend;
  assetName: string;      // exact GitHub release asset filename
  sha256: string;         // from the release API's asset digest
  binaryRelPath: string;  // path of llama-server inside the unpacked archive
  // A SECOND archive that must be unpacked next to the engine for it to start
  // at all. The Windows CUDA zips ship ggml-cuda.dll but not the CUDA runtime,
  // so on a PC without the toolkit on PATH the engine dies at load; upstream
  // publishes that runtime as its own `cudart-…` asset.
  //
  // The two ROCm rows are unset for TWO DIFFERENT reasons, and the Linux one is
  // not "it ships everything it needs". The Windows ROCm zip genuinely is
  // self-contained — it bundles amdhip64_7.dll. The LINUX tarball is NOT:
  // listing b10665's 62 entries on 2026-09-05 found libggml-hip.so but no
  // libamdhip64, hipblas, rocblas or amd_comgr at all. It has no runtime row
  // because upstream publishes none to point at; the HIP and BLAS libraries
  // have to already be on the machine, which is why Linux ROCm needs the
  // system-prerequisite check in rocm-prereqs.ts (design §A3) and Windows
  // does not.
  runtime?: { assetName: string; sha256: string };
  // The AMD compute targets this ROCm build was COMPILED for, straight out of
  // upstream's release workflow at the tag. A chip outside this list has no
  // kernels in the archive and dies at the first token, so gpu-detector's
  // gfxTarget is checked against it before ROCm is ever offered. Unset on every
  // non-ROCm row. Re-check it on every engine bump — the list changes.
  gfxTargets?: string[];
}

export const ENGINE_ASSETS: EngineAsset[] = [
  { platform: 'win32', arch: 'x64', backend: 'vulkan', assetName: 'llama-b10665-bin-win-vulkan-x64.zip', sha256: '9bee8af29495148c04c62cd2e254cf6310686d89025f04a4884eb3d7c4031f0d', binaryRelPath: 'llama-server.exe' },
  { platform: 'win32', arch: 'x64', backend: 'cpu', assetName: 'llama-b10665-bin-win-cpu-x64.zip', sha256: '4b039869c48c2f5842ccc0c005cb36437bac33476be2d661f85e2814a7681af0', binaryRelPath: 'llama-server.exe' },
  { platform: 'win32', arch: 'arm64', backend: 'cpu', assetName: 'llama-b10665-bin-win-cpu-arm64.zip', sha256: 'fa296ac9312b894e8ca1c620623a0620907202ae023b957959997b64abf7ec02', binaryRelPath: 'llama-server.exe' },
  { platform: 'win32', arch: 'x64', backend: 'cuda', assetName: 'llama-b10665-bin-win-cuda-12.4-x64.zip', sha256: 'd9b05b81a3f60d30f6625e5561139af505a7ac1fd933c82ee9067ebbada0887a', binaryRelPath: 'llama-server.exe', runtime: { assetName: 'cudart-llama-bin-win-cuda-12.4-x64.zip', sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6' } },
  { platform: 'win32', arch: 'x64', backend: 'rocm', assetName: 'llama-b10665-bin-win-rocm-7.14-x64.zip', sha256: '081c1a079e7987ee9d36d8cd90a16e0b8e04f1c80c2e5183d694bf31d1c3db61', binaryRelPath: 'llama-server.exe', gfxTargets: ['gfx1010', 'gfx1011', 'gfx1012', 'gfx1030', 'gfx1031', 'gfx1032', 'gfx1033', 'gfx1034', 'gfx1035', 'gfx1036', 'gfx1100', 'gfx1101', 'gfx1102', 'gfx1103', 'gfx1150', 'gfx1151', 'gfx1152', 'gfx1153', 'gfx1200', 'gfx1201'] },
  { platform: 'darwin', arch: 'arm64', backend: 'metal', assetName: 'llama-b10665-bin-macos-arm64.tar.gz', sha256: 'bea206745e751cf8957eb729cc8f2950ca5e5340e29aaa9a055a0e4100dabdd1', binaryRelPath: 'llama-b10665/llama-server' },
  { platform: 'darwin', arch: 'x64', backend: 'metal', assetName: 'llama-b10665-bin-macos-x64.tar.gz', sha256: '6c976150c7f74509c60b7cfa04ee31d734d54bcb35fe272cccaa3a2f7f6946aa', binaryRelPath: 'llama-b10665/llama-server' },
  { platform: 'linux', arch: 'x64', backend: 'vulkan', assetName: 'llama-b10665-bin-ubuntu-vulkan-x64.tar.gz', sha256: '92f8d63384132e6a70b3b106996a5dce06121bbf770eef68500b1cfb7ff22bcc', binaryRelPath: 'llama-b10665/llama-server' },
  { platform: 'linux', arch: 'x64', backend: 'cpu', assetName: 'llama-b10665-bin-ubuntu-x64.tar.gz', sha256: '7d065b7fe283eac932929bbc92b6e39b58551132a6291d7ab10ea9116997cb4e', binaryRelPath: 'llama-b10665/llama-server' },
  { platform: 'linux', arch: 'x64', backend: 'rocm', assetName: 'llama-b10665-bin-ubuntu-rocm-7.14-x64.tar.gz', sha256: 'e5ac52287056b9bd35b6e01e6f5d07210f081313691a7d958944833ab90232e4', binaryRelPath: 'llama-b10665/llama-server', gfxTargets: ['gfx908', 'gfx90a', 'gfx942', 'gfx950', 'gfx1010', 'gfx1011', 'gfx1012', 'gfx1030', 'gfx1031', 'gfx1032', 'gfx1033', 'gfx1034', 'gfx1035', 'gfx1036', 'gfx1100', 'gfx1101', 'gfx1102', 'gfx1150', 'gfx1151', 'gfx1152', 'gfx1200', 'gfx1201'] },
  { platform: 'linux', arch: 'arm64', backend: 'vulkan', assetName: 'llama-b10665-bin-ubuntu-vulkan-arm64.tar.gz', sha256: '746df9199ddfcc11f135f2750d1b38ce73564557642c38bef735fd2f08a9b8f6', binaryRelPath: 'llama-b10665/llama-server' },
  { platform: 'linux', arch: 'arm64', backend: 'cpu', assetName: 'llama-b10665-bin-ubuntu-arm64.tar.gz', sha256: '36983c882d7a88cbc02c190a3980cf397e526d588dd66c684b8cd53385a242a6', binaryRelPath: 'llama-b10665/llama-server' },
];

// The pinned binary's own CLI alias table, generated from `llama-server --help`
// (274 entries for b10665). llama-server accepts three spellings of most
// options — short (`-c`), long (`--ctx-size`) and environment
// (`LLAMA_ARG_CTX_SIZE`) — and its models preset file accepts all three too, so
// a caller that reasons about option NAMES (writing the preset, or refusing to
// let a user override a reserved one) has to collapse them to one name first.
// Read it as `ARG_ALIASES[key] ?? key`: only the alternate spellings are
// listed, and a canonical name maps to itself by absence.
//
// A negated spelling keeps its own `no-` name (`nkvo` → `no-kv-offload`,
// `no-webui` → `no-ui`) rather than folding into the positive. Folding them
// would rewrite a user's `--no-mmap` into `mmap` and silently do the opposite
// of what they asked; a caller that wants one bucket for both strips the
// leading `no-` itself.
// PROTOTYPE-LESS ON PURPOSE. Read as `ARG_ALIASES[key] ?? key`, a plain object
// literal would answer `constructor`, `toString`, `valueOf`, `hasOwnProperty`
// and `__proto__` with an inherited FUNCTION — not nullish, so the `?? key`
// fallback never fires. A user typing `--valueOf 1` into Advanced settings
// would then get a Function as their "canonical" option name, sail past a
// string denylist, and be stringified into the preset file, where any
// unrecognised key makes llama-server exit 1 at startup — with nothing on
// screen tracing "the engine won't start" back to what they typed.
export const ARG_ALIASES: Record<string, string> = Object.assign(Object.create(null), {
  C: 'cpu-mask', Cb: 'cpu-mask-batch', Cbd: 'cpu-mask-batch-draft', Cd: 'cpu-mask-draft',
  Cr: 'cpu-range', Crb: 'cpu-range-batch', Crd: 'cpu-range-draft', HF_TOKEN: 'hf-token',
  LLAMA_API_KEY: 'api-key', LLAMA_ARG_AGENT: 'agent', LLAMA_ARG_ALIAS: 'alias',
  LLAMA_ARG_API_KEY_FILE: 'api-key-file', LLAMA_ARG_API_PREFIX: 'api-prefix',
  LLAMA_ARG_BACKEND_SAMPLING: 'backend-sampling', LLAMA_ARG_BATCH: 'batch-size',
  LLAMA_ARG_CACHE_IDLE_SLOTS: 'cache-idle-slots', LLAMA_ARG_CACHE_PROMPT: 'cache-prompt',
  LLAMA_ARG_CACHE_RAM: 'cache-ram', LLAMA_ARG_CACHE_REUSE: 'cache-reuse',
  LLAMA_ARG_CACHE_TYPE_K: 'cache-type-k', LLAMA_ARG_CACHE_TYPE_V: 'cache-type-v',
  LLAMA_ARG_CHAT_TEMPLATE: 'chat-template', LLAMA_ARG_CHAT_TEMPLATE_FILE: 'chat-template-file',
  LLAMA_ARG_CHAT_TEMPLATE_KWARGS: 'chat-template-kwargs',
  LLAMA_ARG_CHECKPOINT_MIN_SPACING_NT: 'checkpoint-min-step',
  LLAMA_ARG_CONTEXT_SHIFT: 'context-shift', LLAMA_ARG_CONT_BATCHING: 'cont-batching',
  LLAMA_ARG_CORS_CREDENTIALS: 'cors-credentials', LLAMA_ARG_CORS_HEADERS: 'cors-headers',
  LLAMA_ARG_CORS_METHODS: 'cors-methods', LLAMA_ARG_CORS_ORIGINS: 'cors-origins',
  LLAMA_ARG_CPU_MOE: 'cpu-moe', LLAMA_ARG_CTX_CHECKPOINTS: 'ctx-checkpoints',
  LLAMA_ARG_CTX_SIZE: 'ctx-size', LLAMA_ARG_DEFRAG_THOLD: 'defrag-thold',
  LLAMA_ARG_DEVICE: 'device', LLAMA_ARG_DIO: 'direct-io', LLAMA_ARG_DOCKER_REPO: 'docker-repo',
  LLAMA_ARG_DRAFT_MAX: 'draft-max', LLAMA_ARG_DRAFT_MIN: 'draft-min',
  LLAMA_ARG_EMBEDDINGS: 'embeddings', LLAMA_ARG_ENDPOINT_METRICS: 'metrics',
  LLAMA_ARG_ENDPOINT_PROPS: 'props', LLAMA_ARG_ENDPOINT_SLOTS: 'slots', LLAMA_ARG_FIT: 'fit',
  LLAMA_ARG_FIT_CTX: 'fit-ctx', LLAMA_ARG_FIT_TARGET: 'fit-target',
  LLAMA_ARG_FLASH_ATTN: 'flash-attn', LLAMA_ARG_HF_FILE: 'hf-file',
  LLAMA_ARG_HF_REPO: 'hf-repo', LLAMA_ARG_HOST: 'host',
  LLAMA_ARG_IMAGE_MAX_TOKENS: 'image-max-tokens',
  LLAMA_ARG_IMAGE_MIN_TOKENS: 'image-min-tokens', LLAMA_ARG_JINJA: 'jinja',
  LLAMA_ARG_KV_OFFLOAD: 'kv-offload', LLAMA_ARG_KV_UNIFIED: 'kv-unified',
  LLAMA_ARG_KV_UNIFIED_PER_SLOT: 'kv-unified-per-slot', LLAMA_ARG_LOAD_MODE: 'load-mode',
  LLAMA_ARG_LOG_COLORS: 'log-colors', LLAMA_ARG_LOG_FILE: 'log-file',
  LLAMA_ARG_LOG_PREFIX: 'log-prefix', LLAMA_ARG_LOG_TIMESTAMPS: 'log-timestamps',
  LLAMA_ARG_LOG_VERBOSITY: 'log-verbosity', LLAMA_ARG_MAIN_GPU: 'main-gpu',
  LLAMA_ARG_MCP_SERVERS_CONFIG: 'mcp-servers-config',
  LLAMA_ARG_MCP_SERVERS_JSON: 'mcp-servers-json', LLAMA_ARG_MLOCK: 'mlock',
  LLAMA_ARG_MMAP: 'mmap', LLAMA_ARG_MMPROJ: 'mmproj', LLAMA_ARG_MMPROJ_AUTO: 'mmproj-auto',
  LLAMA_ARG_MMPROJ_OFFLOAD: 'mmproj-offload', LLAMA_ARG_MMPROJ_URL: 'mmproj-url',
  LLAMA_ARG_MODEL: 'model', LLAMA_ARG_MODELS_AUTOLOAD: 'models-autoload',
  LLAMA_ARG_MODELS_DIR: 'models-dir', LLAMA_ARG_MODELS_MAX: 'models-max',
  LLAMA_ARG_MODELS_PRESET: 'models-preset', LLAMA_ARG_MODEL_URL: 'model-url',
  LLAMA_ARG_MTMD_BATCH_MAX_TOKENS: 'mtmd-batch-max-tokens', LLAMA_ARG_NO_HOST: 'no-host',
  LLAMA_ARG_NUMA: 'numa', LLAMA_ARG_N_CPU_FFN: 'n-cpu-ffn', LLAMA_ARG_N_CPU_MOE: 'n-cpu-moe',
  LLAMA_ARG_N_GPU_LAYERS: 'n-gpu-layers', LLAMA_ARG_N_GPU_LAYERS_DRAFT: 'n-gpu-layers-draft',
  LLAMA_ARG_N_PARALLEL: 'parallel', LLAMA_ARG_N_PREDICT: 'n-predict',
  LLAMA_ARG_OFFLINE: 'offline', LLAMA_ARG_OVERRIDE_TENSOR: 'override-tensor',
  LLAMA_ARG_PERF: 'perf', LLAMA_ARG_POOLING: 'pooling', LLAMA_ARG_PORT: 'port',
  LLAMA_ARG_PREFILL_ASSISTANT: 'prefill-assistant', LLAMA_ARG_REASONING: 'reasoning',
  LLAMA_ARG_REASONING_EFFORT: 'reasoning-effort',
  LLAMA_ARG_REASONING_PRESERVE: 'reasoning-preserve', LLAMA_ARG_REPACK: 'repack',
  LLAMA_ARG_RERANKING: 'reranking', LLAMA_ARG_REUSE_PORT: 'reuse-port',
  LLAMA_ARG_ROPE_FREQ_BASE: 'rope-freq-base', LLAMA_ARG_ROPE_FREQ_SCALE: 'rope-freq-scale',
  LLAMA_ARG_ROPE_SCALE: 'rope-scale', LLAMA_ARG_ROPE_SCALING_TYPE: 'rope-scaling',
  LLAMA_ARG_RPC: 'rpc', LLAMA_ARG_SKIP_CHAT_PARSING: 'skip-chat-parsing',
  LLAMA_ARG_SPEC_DRAFT_BACKEND_SAMPLING: 'spec-draft-backend-sampling',
  LLAMA_ARG_SPEC_DRAFT_CACHE_TYPE_K: 'cache-type-k-draft',
  LLAMA_ARG_SPEC_DRAFT_CACHE_TYPE_V: 'cache-type-v-draft',
  LLAMA_ARG_SPEC_DRAFT_CPU_MOE: 'spec-draft-cpu-moe',
  LLAMA_ARG_SPEC_DRAFT_HF_REPO: 'hf-repo-draft', LLAMA_ARG_SPEC_DRAFT_MODEL: 'spec-draft-model',
  LLAMA_ARG_SPEC_DRAFT_N_CPU_MOE: 'spec-draft-n-cpu-moe',
  LLAMA_ARG_SPEC_DRAFT_N_MAX: 'spec-draft-n-max',
  LLAMA_ARG_SPEC_DRAFT_N_MIN: 'spec-draft-n-min',
  LLAMA_ARG_SPEC_DRAFT_P_MIN: 'spec-draft-p-min',
  LLAMA_ARG_SPEC_DRAFT_P_SPLIT: 'spec-draft-p-split',
  LLAMA_ARG_SPEC_SYNTH_LEN: 'spec-synth-len', LLAMA_ARG_SPEC_SYNTH_RATES: 'spec-synth-rates',
  LLAMA_ARG_SPEC_TYPE: 'spec-type', LLAMA_ARG_SPLIT_MODE: 'split-mode',
  LLAMA_ARG_SSE_PING_INTERVAL: 'sse-ping-interval', LLAMA_ARG_SSL_CERT_FILE: 'ssl-cert-file',
  LLAMA_ARG_SSL_KEY_FILE: 'ssl-key-file', LLAMA_ARG_STATIC_PATH: 'path',
  LLAMA_ARG_SWA_FULL: 'swa-full', LLAMA_ARG_TAGS: 'tags',
  LLAMA_ARG_TENSOR_READ_LAZY: 'tensor-read-lazy', LLAMA_ARG_TENSOR_SPLIT: 'tensor-split',
  LLAMA_ARG_THINK: 'reasoning-format', LLAMA_ARG_THINK_BUDGET: 'reasoning-budget',
  LLAMA_ARG_THINK_BUDGET_MESSAGE: 'reasoning-budget-message', LLAMA_ARG_THREADS: 'threads',
  LLAMA_ARG_THREADS_HTTP: 'threads-http', LLAMA_ARG_TIMEOUT: 'timeout',
  LLAMA_ARG_TOOLS: 'tools', LLAMA_ARG_TOOLS_RUNTIME: 'tools-runtime', LLAMA_ARG_TOP_K: 'top-k',
  LLAMA_ARG_UBATCH: 'ubatch-size', LLAMA_ARG_UI: 'ui', LLAMA_ARG_UI_CONFIG: 'ui-config',
  LLAMA_ARG_UI_CONFIG_FILE: 'ui-config-file', LLAMA_ARG_UI_MCP_PROXY: 'ui-mcp-proxy',
  LLAMA_ARG_VIDEO_FFMPEG_DIR: 'video-ffmpeg-dir', LLAMA_ARG_VIDEO_FPS: 'video-fps',
  LLAMA_ARG_VIDEO_TIMESTAMP_INTERVAL: 'video-timestamp-interval',
  LLAMA_ARG_YARN_ATTN_FACTOR: 'yarn-attn-factor', LLAMA_ARG_YARN_BETA_FAST: 'yarn-beta-fast',
  LLAMA_ARG_YARN_BETA_SLOW: 'yarn-beta-slow', LLAMA_ARG_YARN_EXT_FACTOR: 'yarn-ext-factor',
  LLAMA_ARG_YARN_ORIG_CTX: 'yarn-orig-ctx', MTMD_BACKEND_DEVICE: 'mmproj-device', a: 'alias',
  ag: 'agent', b: 'batch-size', bs: 'backend-sampling', c: 'ctx-size', cb: 'cont-batching',
  cl: 'cache-list', cmoe: 'cpu-moe', cmoed: 'spec-draft-cpu-moe', cms: 'checkpoint-min-step',
  'cpu-moe-draft': 'spec-draft-cpu-moe', cram: 'cache-ram', ctk: 'cache-type-k',
  ctkd: 'cache-type-k-draft', ctv: 'cache-type-v', ctvd: 'cache-type-v-draft',
  ctxcp: 'ctx-checkpoints', dev: 'device', devd: 'device-draft', dio: 'direct-io',
  dr: 'docker-repo', draft: 'draft-max', 'draft-n': 'draft-max', 'draft-n-min': 'draft-min',
  'draft-p-min': 'spec-draft-p-min', 'draft-p-split': 'spec-draft-p-split', dt: 'defrag-thold',
  e: 'escape', embedding: 'embeddings', fa: 'flash-attn', fitc: 'fit-ctx', fitt: 'fit-target',
  'gpu-layers': 'n-gpu-layers', 'gpu-layers-draft': 'n-gpu-layers-draft', h: 'usage',
  help: 'usage', hf: 'hf-repo', hfd: 'hf-repo-draft', hff: 'hf-file', hfr: 'hf-repo',
  hfrd: 'hf-repo-draft', hft: 'hf-token', j: 'json-schema', jf: 'json-schema-file',
  kvo: 'kv-offload', kvu: 'kv-unified', l: 'logit-bias', lcd: 'lookup-cache-dynamic',
  lcs: 'lookup-cache-static', lm: 'load-mode', lv: 'log-verbosity', m: 'model',
  md: 'spec-draft-model', mg: 'main-gpu', mm: 'mmproj', mmdev: 'mmproj-device',
  mmu: 'mmproj-url', 'model-draft': 'spec-draft-model', mu: 'model-url', n: 'n-predict',
  'n-cpu-moe-draft': 'spec-draft-n-cpu-moe', ncffn: 'n-cpu-ffn', ncmoe: 'n-cpu-moe',
  ncmoed: 'spec-draft-n-cpu-moe', ndio: 'no-direct-io', ngl: 'n-gpu-layers',
  ngld: 'n-gpu-layers-draft', nkvo: 'no-kv-offload', 'no-ag': 'no-agent',
  'no-kvu': 'no-kv-unified', 'no-mmproj': 'no-mmproj-auto', 'no-webui': 'no-ui',
  'no-webui-mcp-proxy': 'no-ui-mcp-proxy', nocb: 'no-cont-batching', np: 'parallel',
  nr: 'no-repack', ot: 'override-tensor', otd: 'override-tensor-draft', predict: 'n-predict',
  r: 'reverse-prompt', rea: 'reasoning', rerank: 'reranking', s: 'seed',
  'sampler-seq': 'sampling-seq', sm: 'split-mode', sp: 'special',
  'spec-draft-cpu-mask': 'cpu-mask-draft', 'spec-draft-cpu-mask-batch': 'cpu-mask-batch-draft',
  'spec-draft-cpu-range': 'cpu-range-draft', 'spec-draft-cpu-strict': 'cpu-strict-draft',
  'spec-draft-cpu-strict-batch': 'cpu-strict-batch-draft', 'spec-draft-device': 'device-draft',
  'spec-draft-hf': 'hf-repo-draft', 'spec-draft-ncmoe': 'spec-draft-n-cpu-moe',
  'spec-draft-ngl': 'n-gpu-layers-draft', 'spec-draft-override-tensor': 'override-tensor-draft',
  'spec-draft-poll': 'poll-draft', 'spec-draft-poll-batch': 'poll-batch-draft',
  'spec-draft-prio': 'prio-draft', 'spec-draft-prio-batch': 'prio-batch-draft',
  'spec-draft-threads': 'threads-draft', 'spec-draft-threads-batch': 'threads-batch-draft',
  'spec-draft-type-k': 'cache-type-k-draft', 'spec-draft-type-v': 'cache-type-v-draft',
  sps: 'slot-prompt-similarity', 'swa-checkpoints': 'ctx-checkpoints', t: 'threads',
  tb: 'threads-batch', tbd: 'threads-batch-draft', td: 'threads-draft', temp: 'temperature',
  to: 'timeout', 'top-nsigma': 'top-n-sigma', ts: 'tensor-split', typical: 'typical-p',
  ub: 'ubatch-size', v: 'log-verbose', verbose: 'log-verbose', verbosity: 'log-verbosity',
  webui: 'ui', 'webui-config': 'ui-config', 'webui-config-file': 'ui-config-file',
  'webui-mcp-proxy': 'ui-mcp-proxy',
});

export function pickAsset(
  platform: NodeJS.Platform | string, arch: string, backend: EngineBackend
): EngineAsset | null {
  return ENGINE_ASSETS.find(
    (a) => a.platform === platform && a.arch === arch && a.backend === backend
  ) ?? null;
}

export function assetUrl(a: EngineAsset): string {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${ENGINE_VERSION}/${a.assetName}`;
}

/** Spec §3.1 defaults: Metal on macOS; Vulkan on Windows/Linux (CPU is the
 *  automatic fallback when the Vulkan build fails to boot — engine-manager).
 *  CUDA and ROCm are never a default: both need vendor drivers on the machine
 *  that Vulkan does not, so they are an opt-in switch (design §A3). */
export function defaultBackend(platform: NodeJS.Platform | string): EngineBackend {
  return platform === 'darwin' ? 'metal' : 'vulkan';
}
