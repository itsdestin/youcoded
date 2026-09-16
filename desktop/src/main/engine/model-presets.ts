// The router's per-model settings file — `~/.youcoded/engine/models.ini`, passed
// to llama-server as `--models-preset`. One `[*]` section holds the values every
// model inherits (context length, auto-sleep), and one section per model holds
// that model's own overrides. Design §C2.
//
// THIS IS THE MOST DANGEROUS FILE THE APP WRITES. llama-server treats ANY defect
// in it as a FATAL startup error, not a per-model one: an unrecognised key in any
// section, or a line the grammar cannot parse, and the router exits 1 before it
// serves anything. A running engine survives (the `?reload=1` just 500s and the
// old presets stay in force), so nothing looks broken until the next spawn — a
// speed restart, an engine restart, or the next app launch — at which point EVERY
// local model is gone with no in-app way back. Everything below that looks
// paranoid is guarding that one outcome.
//
// Probed on b10665 (2026-09-05), and the grammar transcribed from llama.cpp's own
// `common/preset.cpp` (`parse_ini_from_file` + `load_from_ini`):
//   - `[*]` is honoured and cascades into every model; a model's own section
//     overrides single keys and inherits the rest.
//   - A model that has a section reports `source: "preset"` in GET /models, and
//     `status.args` shows the exact child command line WITHOUT loading the model
//     — which is how probe-presets.mjs proves any of this cheaply.
//   - A section whose name matches no file on disk becomes a GHOST model row that
//     can never load. Hence: sections only for ids the cache scan actually found.
//   - `option 'x' not recognized in preset 'y'` → exit 1. `failed to parse server
//     config file: <path>` → exit 1.
//   - A value is cut at the first `#` or `;` SILENTLY (llama.cpp's value rule
//     stops at a comment start), so `alias = a#b` becomes `a`. No error, wrong
//     setting — which is why those two characters are refused at save time.
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { ARG_ALIASES } from './engine-pin';
import type { ModelSettings } from '../../shared/model-manager-types';

/** `<NativeHome.root>/engine/models.ini` — the file `--models-preset` points at. */
export function presetFilePath(homeRoot: string): string {
  return path.join(homeRoot, 'engine', 'models.ini');
}

/** The section every model inherits from (llama.cpp's `COMMON_PRESET_DEFAULT_NAME`). */
const GLOBAL_SECTION = '*';

// llama.cpp's own key grammar: `ident ::= [a-zA-Z_] [a-zA-Z0-9_.-]*`. A key
// outside it does not make the ENGINE reject one option — it makes the whole
// FILE fail to parse, taking every model down with it. Matching the grammar
// exactly is therefore stricter, and safer, than "looks like a word".
const INI_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

// What a user may type in Advanced → extra flags. Long form only (`--name`), the
// spelling llama-server's own docs use. A single dash is deliberately NOT a key
// here: it is how a NEGATIVE VALUE is written (`--n-predict -1`), and reading
// `-1` as an option name would refuse a perfectly good flag.
const FLAG_TOKEN_RE = /^--[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Why an option cannot be typed into the extra-flags box. Each kind carries one
 *  sentence that is true of EVERY key filed under it — read off llama-server's
 *  own `--help` for b10665, never inferred. */
type ReservedReason =
  | 'controls'    // the three the Context length / GPU layers / Keep loaded controls write
  | 'managed'     // ours, with no control to point the user at
  | 'engine-wide' // ours, and set for EVERY model at once — a per-model value is ignored
  | 'network' | 'remote' | 'writes' | 'runs' | 'exposes' | 'connection';

const RESERVED: ReadonlyMap<string, ReservedReason> = new Map<string, ReservedReason>([
  // --- Managed by the app (design §C2, R1-13) -------------------------------
  // `host`/`port`/`alias` are rewritten by the router for every child, `model`/
  // `mmproj`/`models-*` are how the app points the engine at its own files, and
  // the last three are what the Context length / GPU layers / Keep loaded
  // controls write.
  // Split in two on purpose: only three of them have a control to send the user
  // to. Telling someone to "use the controls above" for --host, when no host
  // control exists or ever will, is a message that sends them looking for
  // something that is not there.
  ['ctx-size', 'controls'], ['n-gpu-layers', 'controls'], ['sleep-idle-seconds', 'controls'],
  ['host', 'managed'], ['port', 'managed'], ['model', 'managed'],
  ['models-dir', 'managed'], ['models-preset', 'managed'], ['models-max', 'managed'],
  ['mmproj', 'managed'], ['alias', 'managed'],

  // --- Set once, for every model, on the engine's command line ---------------
  // The compressed-cache speed switch spawns as `--cache-type-k q8_0` on the
  // ROUTER's own command line, and llama.cpp merges that command line over every
  // per-model preset (`preset.merge(base_preset)`, server-models.cpp) — so a
  // per-model `cache-type-k` is read, accepted, and then silently overridden.
  // Its own reason because its own sentence is different: these are not managed
  // out of reach like --host, they LOOK settable and would do nothing. Without
  // this entry a user could type `--cache-type-k f16`, watch it pass the binary
  // check, save it, and get no change at all with nothing to explain why.
  ['cache-type-k', 'engine-wide'], ['cache-type-v', 'engine-wide'],

  // --- Fetches over the network --------------------------------------------
  // llama.cpp strips `models-dir/max/preset/autoload`, `api-key` and the two
  // `ssl-*-file` options from every per-model preset itself
  // (`unset_reserved_args(preset, false)` in server-models.cpp) — but it does
  // NOT strip these, and it does not strip `model`, `mmproj`, `alias` or
  // `hf-repo` either. So a user could point one model at a Hugging Face repo,
  // a URL or Docker Hub and the engine would start a multi-gigabyte transfer
  // the app never showed them, on whatever connection they are on. That is not
  // a power-user option, it is a trap: the contract offers "extra engine
  // options", not "every option llama.cpp has".
  ['hf-repo', 'network'], ['hf-file', 'network'], ['hf-token', 'network'],
  ['hf-repo-draft', 'network'], ['model-url', 'network'], ['docker-repo', 'network'],
  ['mmproj-url', 'network'],
  // The eleven one-word model presets. Each replaces the model the user picked
  // AND, in llama-server's own words, "can download weights from the internet".
  ['embd-gemma-default', 'network'], ['fim-qwen-1.5b-default', 'network'],
  ['fim-qwen-3b-default', 'network'], ['fim-qwen-7b-default', 'network'],
  ['fim-qwen-7b-spec', 'network'], ['fim-qwen-14b-spec', 'network'],
  ['fim-qwen-30b-default', 'network'], ['gpt-oss-20b-default', 'network'],
  ['gpt-oss-120b-default', 'network'], ['vision-gemma-4b-default', 'network'],
  ['vision-gemma-12b-default', 'network'],

  // --- Sends this model's work to another computer ---------------------------
  // `--rpc host:port` offloads the model's WEIGHTS AND ITS COMPUTATION to an
  // llama.cpp RPC server over TCP — measured reaching the child at b10665, and
  // not stripped. llama.cpp's own tools/rpc/README.md: the backend "is fragile
  // and insecure. Never run the RPC server on an open network or in a sensitive
  // environment!" A line pasted from a forum thread would send every prompt and
  // the model itself to an unauthenticated machine, with nothing in YouCoded
  // saying so. Its own reason because its own sentence is different: this is not
  // a download, it is the user's work leaving the computer.
  ['rpc', 'remote'],

  // --- Writes outside the model folder --------------------------------------
  // Files the app does not manage, never cleans up, and cannot show the user —
  // `log-prompts-dir` in particular writes everything they type to disk.
  ['log-file', 'writes'], ['log-prompts-dir', 'writes'], ['slot-save-path', 'writes'],
  ['lookup-cache-dynamic', 'writes'],

  // --- Starts other programs -------------------------------------------------
  // `--tools` includes `exec_shell_command`, `write_file` and `edit_file`;
  // `--tools-runtime` accepts `docker:`, `podman:` and `ssh:<target>`; `--agent`
  // turns the whole set on at once; the MCP options spawn servers from a JSON
  // file; `--video-ffmpeg-dir` names a folder the engine executes binaries from.
  ['tools', 'runs'], ['tools-runtime', 'runs'], ['agent', 'runs'],
  ['mcp-servers-config', 'runs'], ['mcp-servers-json', 'runs'],
  ['video-ffmpeg-dir', 'runs'],

  // --- Opens a way in for something that is not YouCoded ---------------------
  // `--media-path` lets a chat message read that folder through `file://` URLs,
  // `--path` serves a folder over HTTP, `--ui-mcp-proxy` forwards requests to
  // other servers.
  ['media-path', 'exposes'], ['path', 'exposes'], ['ui-mcp-proxy', 'exposes'],

  // --- Breaks the app's own connection to the model --------------------------
  // `api-key-file` is not stripped by llama.cpp (only the inline `api-key` is),
  // so the child would demand a key the app never sends and answer every message
  // with a 401. `api-prefix` is the same defect from the other end: the router
  // proxies the request path to the child verbatim, so a child serving only
  // under `/x` 404s every routed request (both measured reaching the child).
  ['api-key-file', 'connection'], ['api-prefix', 'connection'],
]);

export const RESERVED_KEYS: ReadonlySet<string> = new Set(RESERVED.keys());

const RESERVED_SENTENCE: Record<ReservedReason, string> = {
  controls: 'is set from the controls above. Change it there instead.',
  managed: 'is set by YouCoded and cannot be changed here.',
  'engine-wide': 'is set by YouCoded for every model at once, so setting it for one model here would have no effect.',
  network: 'is not allowed here: it would make the engine fetch files from the internet on its own.',
  remote: "is not allowed here: it would send this model's work — your prompts and the model itself — to another computer over the network.",
  writes: 'is not allowed here: it would make the engine write files outside your models folder.',
  runs: 'is not allowed here: it would let the engine start other programs on this computer.',
  exposes: 'is not allowed here: it would open a way for something other than YouCoded to read or reach files through the engine.',
  connection: 'is not allowed here: it would change how YouCoded connects to this model.',
};

/** What a NEGATED spelling gets instead. `--no-agent` TURNS OFF the tools that
 *  `--agent` turns on, so "it would let the engine start other programs" is the
 *  opposite of what that flag does — and a message that describes the reverse of
 *  what the user typed is worse than no message. Both spellings are refused
 *  because YouCoded decides the option, so that is what it says. */
const NEGATED_SENTENCE = 'is decided by YouCoded, so neither spelling can be set here.';

/** Collapse any spelling of an option onto its canonical long name: `c`,
 *  `ctx-size` and `LLAMA_ARG_CTX_SIZE` are all the same option to llama-server,
 *  and a denylist that only knows one of them stops nothing.
 *
 *  Read straight out of the pin's PROTOTYPE-LESS table on purpose — copying it
 *  into a plain object would make `--valueOf` resolve to a Function (see
 *  engine-pin.ts). Leading dashes are stripped the way llama.cpp's
 *  `rm_leading_dashes` does. */
export function normaliseArgKey(rawKey: string): string {
  const key = rawKey.replace(/^-+/, '');
  const canonical = ARG_ALIASES[key];
  return typeof canonical === 'string' ? canonical : key;
}

/** Why this canonical key is refused, or null if a user may type it.
 *
 *  The `no-` strip is not cosmetic. A negative spelling keeps its OWN canonical
 *  name (`--no-mmap` → `no-mmap`, `-nkvo` → `no-kv-offload`), so without this
 *  every reserved option has a negative twin that walks straight past the list —
 *  `--no-host` and `--no-agent`, for two, are real llama-server flags. */
export function reservedReason(canonicalKey: string): ReservedReason | null {
  return reservedMatch(canonicalKey)?.reason ?? null;
}

/** `viaNegation` = it matched only after the `no-` strip, i.e. the user typed the
 *  OFF spelling of a reserved option. The message has to change with it (S4). */
export function reservedMatch(
  canonicalKey: string
): { reason: ReservedReason; viaNegation: boolean } | null {
  const direct = RESERVED.get(canonicalKey);
  if (direct) return { reason: direct, viaNegation: false };
  const stripped = RESERVED.get(canonicalKey.replace(/^no-/, ''));
  return stripped ? { reason: stripped, viaNegation: true } : null;
}

export function isReservedKey(canonicalKey: string): boolean {
  return reservedReason(canonicalKey) !== null;
}

/** Can this model id be written as `[id]` and read back as the SAME id?
 *
 *  Every rule here is a measured failure of llama.cpp's header grammar
 *  (`"[" ws <one or more non-']'> ws "]"`), and model ids are filenames, so a
 *  user can produce all of them just by naming a file:
 *   - `]` or a line break  → the whole FILE fails to parse; every model is lost.
 *   - a leading space/tab  → eaten by the grammar's `ws`, so `[ foo]` reads back
 *                            as `foo`: a ghost row named `foo`, and the real
 *                            model silently keeps the engine-wide defaults.
 *   - `*`                  → a second `[*]` header, which RESETS the section the
 *                            parser already built, wiping the global block.
 *  Everything else round-trips, verified on b10665: `a[b`, `a#b`, `a=b`, a tab
 *  or `#` mid-name, non-ASCII, and even a TRAILING space all come back intact. */
export function isWritableSectionName(id: string): boolean {
  if (!id || id === GLOBAL_SECTION) return false;
  if (/[\]\r\n]/.test(id)) return false;
  if (/^[ \t]/.test(id)) return false;
  return true;
}

/** One `key = value` line. `key` is canonical and already reserved-checked. */
export interface PresetEntry {
  key: string;
  value: string;
}

export type ExtraFlagsResult =
  | { ok: true; entries: PresetEntry[] }
  | { ok: false; message: string };

/** Tokenise the Advanced box: `--key value` → `key = value`, bare `--key` →
 *  `key = 1` (design §C2). Every key is normalised first, then refused if it is
 *  reserved or cannot be written into the file safely.
 *
 *  Splitting on whitespace is also what keeps a NEWLINE out of a value — a value
 *  containing one makes the file unparseable and the engine unstartable. */
export function parseExtraFlags(raw: string): ExtraFlagsResult {
  const tokens = (raw ?? '').split(/\s+/).filter((t) => t.length > 0);
  // A Map, never a plain object: a key of `__proto__` or `constructor` on an
  // object literal is a live grenade, and these keys come from typed text.
  const entries = new Map<string, string>();
  let pendingKey: string | null = null;
  let pendingToken = '';

  const flush = () => {
    if (pendingKey !== null) entries.set(pendingKey, '1'); // bare flag = on
    pendingKey = null;
  };

  for (const token of tokens) {
    if (token.startsWith('--')) {
      flush();
      if (!FLAG_TOKEN_RE.test(token)) {
        return { ok: false, message: `"${token}" is not an option name. Write each one as --name or --name value.` };
      }
      const canonical = normaliseArgKey(token);
      // Unreachable today, and deliberately kept: FLAG_TOKEN_RE already allows
      // only ident-shaped names, and every value in the pin's alias table is
      // ident-shaped too (checked by model-presets.test.ts). It is here because
      // the day one of those changes, this is what stops a key the INI grammar
      // cannot express from making the WHOLE file unparseable.
      if (!INI_KEY_RE.test(canonical)) {
        return { ok: false, message: `"${token}" cannot be saved — the engine's settings file has no way to write it.` };
      }
      const match = reservedMatch(canonical);
      if (match) {
        // Name the canonical option too when the user typed an alias, so the
        // sentence is about an option they can actually find in the docs.
        const via = canonical === token.slice(2) ? '' : ` (another name for --${canonical})`;
        const sentence = match.viaNegation ? NEGATED_SENTENCE : RESERVED_SENTENCE[match.reason];
        return { ok: false, message: `${token}${via} ${sentence}` };
      }
      pendingKey = canonical;
      pendingToken = token;
      continue;
    }
    if (pendingKey === null) {
      return { ok: false, message: `"${token}" does not follow an option. Write each one as --name or --name value.` };
    }
    // WHY a VALUE is constrained when the design only constrained KEYS: probed,
    // llama.cpp cuts a value at the first `#` or `;` and reports NOTHING, so
    // `--chat-template a#b` quietly becomes `a`. The engine starts, the setting
    // is wrong, and there is no error anywhere to trace it back to. Refusing it
    // at save time is the only moment the user can still be told.
    if (/[#;]/.test(token)) {
      return {
        ok: false,
        message: `The value for ${pendingToken} cannot contain # or ; — the engine reads everything after those as a comment.`,
      };
    }
    // A control character would be written into the file as-is and handed to the
    // model's child process on its command line.
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    if (/[\u0000-\u001f\u007f]/.test(token)) {
      return { ok: false, message: `The value for ${pendingToken} cannot contain control characters.` };
    }
    entries.set(pendingKey, token);
    pendingKey = null;
  }
  flush();

  return { ok: true, entries: [...entries].map(([key, value]) => ({ key, value })) };
}

/** Every line one model's section gets, in file order. Returns `[]` for a model
 *  on all defaults — and an empty section is then never written, because a
 *  section flips that model's `source` to `preset` in GET /models for no reason.
 *
 *  A malformed number is DROPPED rather than written: `ctx-size = NaN` is not a
 *  parse error, it is a `std::stoi` throw at load time, which takes out that one
 *  model with a message no user could act on. */
export function modelSectionEntries(settings: Partial<ModelSettings> | null | undefined): PresetEntry[] {
  const out: PresetEntry[] = [];
  if (!settings || typeof settings !== 'object') return out;

  const ctx = intOrNull(settings.contextLength);
  if (ctx !== null && ctx > 0) out.push({ key: 'ctx-size', value: String(ctx) });

  // 'auto' is llama-server's own default (it splits the model across GPU and RAM
  // itself), so the key is omitted entirely rather than written as a number.
  // 999 is what the UI stores for "all layers" — the engine clamps it.
  if (settings.gpuLayers !== undefined && settings.gpuLayers !== 'auto') {
    const layers = intOrNull(settings.gpuLayers);
    if (layers !== null && layers >= 0) out.push({ key: 'n-gpu-layers', value: String(layers) });
  }

  // -1 is llama-server's "never auto-sleep". Written only when the user asked for
  // it; otherwise the model inherits the global auto-sleep from [*].
  if (settings.keepLoaded === true) out.push({ key: 'sleep-idle-seconds', value: '-1' });

  const extra = parseExtraFlags(typeof settings.extraFlags === 'string' ? settings.extraFlags : '');
  if (extra.ok) {
    // A managed key above always wins. Unreachable today — the extra-flag parser
    // refuses every reserved name long before this, so no mutation of this line
    // changes what the file says — and kept anyway, because it is what makes
    // "the controls win" true by construction rather than by two rules agreeing.
    const claimed = new Set(out.map((e) => e.key));
    for (const entry of extra.entries) if (!claimed.has(entry.key)) out.push(entry);
  }
  // WHY a bad extra-flags string is skipped instead of thrown: it was already
  // refused at save time, so reaching here means the config file was edited by
  // hand or written by an older build. Dropping the flags costs that user their
  // customisation; writing them costs EVERY model on the next spawn.

  return out;
}

export interface PresetFileInput {
  /** The engine-wide context length — `[*] ctx-size`. Moves OFF the command line
   *  (design §C2): the router's own CLI args are merged over every preset, so a
   *  `-c` on the command line would outrank a model's own value. */
  contextSize: number;
  /** The engine-wide auto-sleep — `[*] sleep-idle-seconds`, same reason. */
  sleepIdleSeconds: number;
  /** Ids the CACHE SCAN found. A section for anything else is a ghost model row
   *  (probed) that can never load and cannot be removed from the app. */
  modelIds: readonly string[];
  /** `config.json` → `engine.models`. Ids with no entry get no section. */
  settings?: Readonly<Record<string, Partial<ModelSettings>>> | null;
  /** Sections to copy VERBATIM instead of rendering from `settings`, keyed by
   *  model id — the output of `parsePresetSections` on the file already on disk.
   *
   *  WHY a whole mechanism for this: the preset file is shared by every model,
   *  and the router unloads a model whose section CHANGED on `?reload=1`. So
   *  when one model's saved change is ready to land while another's is still
   *  waiting for that model's reply to finish, writing the file from config
   *  alone would apply BOTH — and unload the model the wait exists to protect,
   *  mid-answer. Holding the waiting model's section at what the engine is
   *  already running makes its line of the diff empty (design §C2).
   *
   *  An empty array means "this model had no section": it gets none, which is
   *  the same file it had. A Map, not an object: model ids are filenames. */
  preserve?: ReadonlyMap<string, readonly string[]>;
}

/** The `[*]` section's value for one key in a preset file we wrote earlier, or
 *  null when the file has no such line.
 *
 *  WHY the GLOBAL section needs reading back: an engine-wide context change is
 *  deferred exactly as a per-model one is — `setConfig` writes config.json at
 *  once and queues the apply, because reloading mid-reply kills the answer. But
 *  `[*]` is what every model with no section of its own inherits, so rendering
 *  it from config on somebody ELSE'S reload (a finished download calls
 *  `refreshModels`) would apply that queued change anyway and cut the reply.
 *  This is how `[*]` gets held at what the engine actually read. */
export function presetGlobalValue(contents: string, key: string): string | null {
  let inGlobal = false;
  for (const raw of (contents ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) { inGlobal = header[1] === GLOBAL_SECTION; continue; }
    if (!inGlobal || line === '') continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    const value = line.slice(eq + 1).trim();
    return value === '' ? null : value;
  }
  return null;
}

/** The per-model sections of a preset file we wrote earlier, as their raw lines.
 *  `[*]` is deliberately NOT returned — it is rendered from config every time,
 *  and it is never the thing being held. The last `[id]` header wins, which is
 *  what llama.cpp's own parser does (a repeat RESETS the section). */
export function parsePresetSections(contents: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of (contents ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      const name = header[1];
      if (name === GLOBAL_SECTION) { current = null; continue; }
      current = [];
      out.set(name, current);
      continue;
    }
    if (line === '' || current === null) continue;
    current.push(line);
  }
  return out;
}

/** Render the whole file. Pure — `writePresetFile` does the I/O. */
export function renderPresetFile(input: PresetFileInput): string {
  const lines: string[] = [`[${GLOBAL_SECTION}]`];
  const ctx = intOrNull(input.contextSize);
  if (ctx !== null && ctx > 0) lines.push(`ctx-size = ${ctx}`);
  const sleep = intOrNull(input.sleepIdleSeconds);
  if (sleep !== null) lines.push(`sleep-idle-seconds = ${sleep}`);
  lines.push('');

  const written = new Set<string>();
  for (const id of input.modelIds) {
    // Duplicate ids are not merely redundant: a repeated `[id]` header makes
    // llama.cpp's parser RESET that section, so the second one silently erases
    // the first one's keys.
    if (written.has(id) || !isWritableSectionName(id)) continue;
    written.add(id);
    // A held model keeps the exact lines the running engine read; everything
    // else is rendered from config. See PresetFileInput.preserve.
    const held = input.preserve?.get(id);
    const body = held !== undefined
      ? [...held]
      : modelSectionEntries(lookupSettings(input.settings, id)).map((e) => `${e.key} = ${e.value}`);
    // WHY a model on all defaults gets NO section rather than an empty one: the
    // mere presence of a section flips that model's `source` to `preset` in
    // GET /models and marks it a custom preset in the engine's own log (probed).
    // That is a visible change of state bought for nothing, on every model the
    // user never touched.
    if (body.length === 0) continue;
    lines.push(`[${id}]`);
    for (const line of body) lines.push(line);
    lines.push('');
  }

  return lines.join('\n');
}

/** Write the file the way `download-manifest.ts` writes: temp file, then rename.
 *
 *  `~/.youcoded/` is shared between a dev instance and the built app
 *  (native-home.ts), so two supervisors can rewrite this file at the same moment
 *  — and a reader that catches a half-written one does not get a warning, it gets
 *  an engine that will not start. The temp name carries this process's pid so two
 *  writers never share one (scripts/ast-grep/atomic-tmp-name-per-process). */
export function writePresetFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

export type BinaryCheckResult = { ok: true } | { ok: false; message: string };

export interface BinaryCheckOptions {
  /** The installed llama-server. */
  binaryPath: string;
  /** The model the section belongs to — used as the section name so the engine's
   *  own error message names the model the user is editing. */
  modelId: string;
  entries: readonly PresetEntry[];
  /** How long to wait for a verdict before giving up and ACCEPTING (see below). */
  timeoutMs?: number;
  /** How long SIGTERM gets before SIGKILL, and again after it. Test seam. */
  killGraceMs?: number;
  /** Test seam. */
  spawnImpl?: typeof spawn;
  tmpRoot?: string;
}

/** Ask the BINARY whether these flags are real, by running it against a throwaway
 *  preset that holds only this one section and an empty models folder.
 *
 *  WHY not a shape check plus a denylist: those accept any plausible typo, and
 *  the router refuses to initialise on an unrecognised key in ANY section — so
 *  one typo saved here means every local model disappears at the next launch. The
 *  binary answers in ~50 ms and is the only thing that knows its own option list.
 *
 *  Only a NON-ZERO EXIT rejects the save, and the message is the binary's own
 *  stderr line. A timeout, a missing binary or a spawn failure accepts: this
 *  check could not reach a verdict, and refusing the user's flag would mean
 *  inventing a cause we never observed. */
export async function checkFlagsAgainstBinary(opts: BinaryCheckOptions): Promise<BinaryCheckResult> {
  const { binaryPath, modelId, entries } = opts;
  if (entries.length === 0) return { ok: true };

  // A section name that cannot be written safely would take the CHECK file down
  // instead of the flags, so an unwritable id checks under a neutral name. That
  // model gets no section in the real file either (isWritableSectionName).
  const section = isWritableSectionName(modelId) ? modelId : 'model';
  const spawnFn = opts.spawnImpl ?? spawn;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(opts.tmpRoot ?? os.tmpdir(), 'youcoded-preset-'));
  } catch {
    return { ok: true }; // no verdict, no rejection
  }

  try {
    const modelsDir = path.join(dir, 'models');
    fs.mkdirSync(modelsDir);
    const iniPath = path.join(dir, 'check.ini');
    fs.writeFileSync(
      iniPath,
      [`[${section}]`, ...entries.map((e) => `${e.key} = ${e.value}`), ''].join('\n')
    );

    // A port that is already taken makes llama-server exit non-zero for a reason
    // that has nothing to do with the user's flag — and we would then quote a
    // bind error at them. Ask the OS for a free one instead of guessing.
    const port = await freePort();

    let child: ReturnType<typeof spawn> | null = null;
    const result = await new Promise<BinaryCheckResult>((resolve) => {
      let settled = false;
      let stderr = '';
      let timer: NodeJS.Timeout | null = null;
      child = spawnFn(
        binaryPath,
        [
          '--host', '127.0.0.1', '--port', String(port), '--no-webui',
          '--models-dir', modelsDir, '--models-preset', iniPath,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );

      const finish = (outcome: BinaryCheckResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        // Kill THIS child object — never by a pattern, and never a pid
        // remembered from anywhere else. SIGTERM then SIGKILL, the shape
        // engine-supervisor already uses: llama-server can sit in a GPU
        // initialisation call and ignore TERM, and a check that timed out is
        // exactly when that is happening. A survivor here would be an orphan
        // holding a directory we are about to delete.
        try { child?.kill('SIGTERM'); } catch { /* already gone */ }
        resolve(outcome);
      };

      timer = setTimeout(() => finish({ ok: true }), timeoutMs);
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = `${stderr}${chunk}`.slice(-8000); // bounded: llama-server is chatty
        // The preset is parsed BEFORE this line is printed (verified: a bad key
        // exits at ~50 ms, a good one is listening at ~45 ms), so "listening"
        // means the file was accepted and there is nothing left to wait for.
        if (stderr.includes('listening on')) finish({ ok: true });
      });
      child.on('error', () => finish({ ok: true })); // could not run it — no verdict
      child.on('exit', (code) => {
        // `null` = killed by a signal, which is US killing it after a verdict.
        // Never a rejection: only a non-zero EXIT means the engine read the file
        // and refused it.
        if (code === 0 || code === null) return finish({ ok: true });
        finish({ ok: false, message: engineErrorLine(stderr, code) });
      });
    });
    // The temp directory is deleted the moment this returns, so wait for the
    // child to be gone first — escalating to SIGKILL, which cannot be ignored.
    if (child) await killAndWait(child, opts.killGraceMs);
    return result;
  } catch {
    return { ok: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** SIGTERM has already been sent; give it a moment, then SIGKILL the survivor and
 *  wait for the exit that SIGKILL guarantees. Bounded, and both timers unref'd so
 *  a settings save can never hold the app open. */
function killAndWait(child: ReturnType<typeof spawn>, graceMs = 1_500): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.once('exit', finish);
    const t1 = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      const t2 = setTimeout(finish, graceMs);
      if (typeof t2.unref === 'function') t2.unref();
    }, graceMs);
    if (typeof t1.unref === 'function') t1.unref();
  });
}

/** The engine's OWN last error line, with only its log prefix removed
 *  (`0.00.050.247 E srv  llama_server: `). Never a guessed cause: when the binary
 *  said nothing, the message says exactly that and quotes the exit code. */
export function engineErrorLine(stderr: string, exitCode: number): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const errorLine = [...lines].reverse().find((l) => / E /.test(l)) ?? lines[lines.length - 1];
  if (!errorLine) return `The local engine rejected this setting and exited with code ${exitCode}.`;
  return errorLine.replace(/^[\d.]+\s+[A-Z]\s+\S+\s+[^:]*:\s*/, '');
}

// --- small helpers -------------------------------------------------------

function intOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : null;
}

/** Own-property lookup only. Model ids are FILENAMES, so `constructor.gguf` is a
 *  file a user can create, and `settings.constructor` on a plain object answers
 *  with a Function rather than undefined. */
function lookupSettings(
  settings: Readonly<Record<string, Partial<ModelSettings>>> | null | undefined, id: string
): Partial<ModelSettings> | null {
  if (!settings || typeof settings !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(settings, id)) return null;
  const value = (settings as Record<string, unknown>)[id];
  return value && typeof value === 'object' ? (value as Partial<ModelSettings>) : null;
}

/** A port the OS just confirmed is free. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}
