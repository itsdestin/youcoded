// Guards for the router's per-model settings file (design §C2).
//
// READ THIS BEFORE DELETING A GUARD THAT "LOOKS REDUNDANT". These assertions
// were broken deliberately and watched go red, 2026-09-05 — 47 mutations of the
// source and 5 of probe-presets.mjs. The exact tally, because a vague one is
// worse than none:
//
//   * 44 of the 47 turn this suite red on their own.
//   * TWO behaviours are defended TWICE, so breaking either half alone leaves
//     the suite green: a NaN context length is stopped by `Number.isFinite` AND
//     again by `> 0`, and the alias table's prototype hazard by its null
//     prototype AND again by a `typeof === 'string'` check. Break both halves
//     before concluding a guard is dead code — green here is not evidence.
//     (`lookupSettings`'s `hasOwnProperty` is NOT one of these: it reddens on
//     its own, against the inherited-settings fixture below.)
//   * ONE mutation cannot be caught and is documented at its site: the `claimed`
//     set in `modelSectionEntries` is unreachable while reserved names are
//     refused earlier. It stays because it is what keeps "the controls win" true
//     by construction. The `INI_KEY_RE` branch in `parseExtraFlags` is the same
//     shape, and the alias-shape test below is what its comment rests on.
//
// Everything asserted here about llama.cpp's INI grammar was MEASURED against
// the pinned binary (b10665) on 2026-09-05 and cross-read against its own
// `common/preset.cpp`; test-engine/probe-presets.mjs is the half that re-proves
// it on a real engine. The stakes are why the hostile cases are so many: a
// defect in this file is not a per-model failure, it is llama-server exiting 1
// at startup with every local model gone and nothing on screen to explain it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  renderPresetFile, writePresetFile, presetFilePath, parseExtraFlags, normaliseArgKey,
  isReservedKey, isWritableSectionName, modelSectionEntries, checkFlagsAgainstBinary, reservedReason, reservedMatch,
  engineErrorLine, RESERVED_KEYS,
} from '../src/main/engine/model-presets';
import type { ModelSettings } from '../src/shared/model-manager-types';
import { ARG_ALIASES } from '../src/main/engine/engine-pin';

const DEFAULTS: ModelSettings = {
  contextLength: null, keepLoaded: false, gpuLayers: 'auto', extraFlags: '',
};
const base = { contextSize: 32768, sleepIdleSeconds: 900 };

/** The section body for one id, as lines, or null when it got no section. */
function section(file: string, id: string): string[] | null {
  const lines = file.split('\n');
  const start = lines.indexOf(`[${id}]`);
  if (start === -1) return null;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('['); i++) {
    if (lines[i]) out.push(lines[i]);
  }
  return out;
}

describe('model-presets — the [*] global block', () => {
  it('writes the engine-wide context length and auto-sleep, and writes them FIRST', () => {
    const file = renderPresetFile({ ...base, modelIds: [] });
    expect(file.split('\n').slice(0, 3)).toEqual(['[*]', 'ctx-size = 32768', 'sleep-idle-seconds = 900']);
  });

  it('drops a context length that could not be a context length', () => {
    for (const contextSize of [0, -5]) {
      expect(renderPresetFile({ contextSize, sleepIdleSeconds: 900, modelIds: [] })).not.toMatch(/ctx-size/);
    }
  });

  it('drops a value that is not a real number rather than writing it', () => {
    // `ctx-size = NaN` is not a parse error — it is a std::stoi throw when the
    // model loads, which kills that model with a message no user can act on.
    const file = renderPresetFile({ contextSize: Number.NaN, sleepIdleSeconds: 900, modelIds: [] });
    expect(file).not.toMatch(/ctx-size/);
    expect(file).toMatch(/sleep-idle-seconds = 900/);
  });
});

describe('model-presets — which models get a section', () => {
  it('writes a section only for an id the cache scan found', () => {
    const file = renderPresetFile({
      ...base,
      modelIds: ['present'],
      settings: { present: { ...DEFAULTS, contextLength: 8192 }, deleted: { ...DEFAULTS, contextLength: 4096 } },
    });
    expect(section(file, 'present')).toEqual(['ctx-size = 8192']);
    // A stale section resurrects a deleted model as a ghost row that can never
    // load and cannot be removed from inside the app (probed).
    expect(section(file, 'deleted')).toBeNull();
  });

  it('writes no section for a model that is on every default', () => {
    const file = renderPresetFile({ ...base, modelIds: ['plain'], settings: { plain: { ...DEFAULTS } } });
    expect(section(file, 'plain')).toBeNull();
  });

  it('writes each of the three per-model keys only when it is set', () => {
    const file = renderPresetFile({
      ...base,
      modelIds: ['m'],
      settings: { m: { contextLength: 16384, keepLoaded: true, gpuLayers: 24, extraFlags: '--temp 0.6' } },
    });
    expect(section(file, 'm')).toEqual([
      'ctx-size = 16384', 'n-gpu-layers = 24', 'sleep-idle-seconds = -1', 'temperature = 0.6',
    ]);
  });

  it("omits n-gpu-layers for 'auto' and writes 999 for all-layers", () => {
    const auto = renderPresetFile({ ...base, modelIds: ['m'], settings: { m: { ...DEFAULTS, gpuLayers: 'auto', keepLoaded: true } } });
    expect(section(auto, 'm')).toEqual(['sleep-idle-seconds = -1']);
    const all = renderPresetFile({ ...base, modelIds: ['m'], settings: { m: { ...DEFAULTS, gpuLayers: 999 } } });
    expect(section(all, 'm')).toEqual(['n-gpu-layers = 999']);
  });

  it('never reads a settings key it does not OWN', () => {
    // Model ids are FILENAMES, so `constructor.gguf` is a file a user can make,
    // and a plain-object lookup would answer with a Function.
    expect(section(renderPresetFile({ ...base, modelIds: ['constructor'], settings: {} }), 'constructor')).toBeNull();
    // The one that is not merely theoretical: settings reached through a
    // PROTOTYPE rather than the file's own keys. A plain lookup cannot tell the
    // two apart and would apply a setting config.json does not contain.
    const inherited = Object.create({ ghost: { ...DEFAULTS, contextLength: 4096 } });
    expect(section(renderPresetFile({ ...base, modelIds: ['ghost'], settings: inherited }), 'ghost')).toBeNull();
  });

  it('drops a context length that is zero or negative', () => {
    for (const contextLength of [0, -5]) {
      const file = renderPresetFile({ ...base, modelIds: ['m'], settings: { m: { ...DEFAULTS, contextLength } } });
      expect(section(file, 'm')).toBeNull();
    }
  });
});

describe('model-presets — hostile model ids (they are filenames)', () => {
  it.each([
    ['a]b', 'a `]` ends the header early and the WHOLE file fails to parse'],
    ['a\nb', 'a line break does the same'],
    [' leading', 'a leading space is eaten by the grammar, so it reads back as a different, ghost model'],
    ['\tleading', 'so is a leading tab'],
    ['', 'an empty header is not a header'],
  ])('refuses to write a section for %j (%s)', (id) => {
    expect(isWritableSectionName(id)).toBe(false);
    const file = renderPresetFile({ ...base, modelIds: [id], settings: { [id]: { ...DEFAULTS, contextLength: 4096 } } });
    expect(file).not.toContain(`[${id}]`);
    expect(file).not.toContain('4096');
  });

  it('refuses a model literally called "*" — a second [*] header RESETS the global block', () => {
    expect(isWritableSectionName('*')).toBe(false);
    const file = renderPresetFile({ ...base, modelIds: ['*'], settings: { '*': { ...DEFAULTS, contextLength: 4096 } } });
    expect(file.split('\n').filter((l) => l === '[*]')).toHaveLength(1); // the global one, and only it
    expect(file).not.toContain('4096');
  });

  it.each(['a[b', 'a#b', 'a=b', 'a\tb', 'trailing ', 'café-ø'])(
    'still writes a section for %j — verified to round-trip on b10665', (id) => {
      expect(isWritableSectionName(id)).toBe(true);
      const file = renderPresetFile({ ...base, modelIds: [id], settings: { [id]: { ...DEFAULTS, contextLength: 4096 } } });
      expect(section(file, id)).toEqual(['ctx-size = 4096']);
    }
  );

  it('writes a repeated id once — a duplicate header ERASES the first section', () => {
    const file = renderPresetFile({
      ...base, modelIds: ['dup', 'dup'], settings: { dup: { ...DEFAULTS, contextLength: 4096 } },
    });
    expect(file.split('\n').filter((l) => l === '[dup]')).toHaveLength(1);
  });
});

describe('model-presets — the extra-flag tokeniser', () => {
  it('turns --key value into key = value and a bare --key into key = 1', () => {
    const r = parseExtraFlags('--temperature 0.6 --flash-attn');
    expect(r).toEqual({ ok: true, entries: [{ key: 'temperature', value: '0.6' }, { key: 'flash-attn', value: '1' }] });
  });

  it('reads a negative number as a VALUE, not as another option', () => {
    // `--n-predict -1` is a real thing to type; a tokeniser that treats one dash
    // as an option name refuses it for no reason.
    expect(parseExtraFlags('--n-predict -1')).toEqual({ ok: true, entries: [{ key: 'n-predict', value: '-1' }] });
  });

  it('keeps the last value when the same option is typed twice, however it is spelled', () => {
    const r = parseExtraFlags('--temp 0.6 --temperature 0.9');
    expect(r).toEqual({ ok: true, entries: [{ key: 'temperature', value: '0.9' }] });
  });

  it('rejects a value that does not follow an option', () => {
    const r = parseExtraFlags('0.6');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain('does not follow an option');
  });

  it.each(['-c 4096', '--1st 2', '---x 1', '--a.b] 1'])('rejects the badly-shaped %j', (raw) => {
    const r = parseExtraFlags(raw);
    expect(r.ok).toBe(false);
  });

  it.each([
    ['--chat-template a#b', '#'],
    ['--chat-template x;y', ';'],
  ])('rejects %j, because the engine SILENTLY cuts the value at the %s', (raw) => {
    const r = parseExtraFlags(raw);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain('comment');
  });

  it('rejects a control character in a value', () => {
    const r = parseExtraFlags('--chat-template a\u0007b');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain('control characters');
  });
});

describe('model-presets — alias normalisation and the reserved list', () => {
  it('collapses short, long and environment spellings onto one canonical name', () => {
    expect(normaliseArgKey('--c')).toBe('ctx-size');
    expect(normaliseArgKey('ctx-size')).toBe('ctx-size');
    expect(normaliseArgKey('LLAMA_ARG_CTX_SIZE')).toBe('ctx-size');
    expect(normaliseArgKey('--ngl')).toBe('n-gpu-layers');
    expect(normaliseArgKey('--temp')).toBe('temperature');
  });

  it('resolves every alias to a name the INI grammar can actually hold', () => {
    // What the unreachable INI_KEY_RE branch in parseExtraFlags rests on: if any
    // canonical name were not ident-shaped, writing it would make the WHOLE file
    // unparseable rather than refusing one option.
    const ident = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
    const offenders = Object.values(ARG_ALIASES).filter((v) => !ident.test(v));
    expect(offenders).toEqual([]);
  });

  it('cannot be fooled into returning a Function for an inherited name', () => {
    // engine-pin's table is prototype-less on purpose; copying it into a plain
    // object would make `--valueOf` resolve to Function.prototype.valueOf, sail
    // past a string denylist, and be stringified into the file.
    for (const name of ['valueOf', 'constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(normaliseArgKey(`--${name}`)).toBe(name);
    }
    expect(parseExtraFlags('--valueOf 1')).toEqual({ ok: true, entries: [{ key: 'valueOf', value: '1' }] });
  });

  it('keeps the whole reserved list accounted for, by reason', () => {
    // A count, so the list cannot quietly shrink. Every one of these 45 is
    // verified to be a REAL llama-server option by probe-presets.mjs — a
    // phantom entry would refuse a flag that never existed and would mean the
    // real option's name had moved out from under the guard.
    const byReason = new Map<string, number>();
    for (const key of RESERVED_KEYS) {
      const reason = reservedReason(key);
      expect(reason, key).not.toBeNull();
      byReason.set(reason!, (byReason.get(reason!) ?? 0) + 1);
    }
    expect(Object.fromEntries(byReason)).toEqual({
      controls: 3,     // ctx-size, n-gpu-layers, sleep-idle-seconds — the ones with a control
      managed: 8,      // the rest of the design's signed list, with no control to point at
      'engine-wide': 2, // cache-type-k/-v — the app sets them for every model on the router CLI
      network: 18,     // anything that fetches: hf-*, model-url, docker-repo, mmproj-url, 11 model presets
      remote: 1,       // rpc — the model's work leaves the computer
      writes: 4,       // log-file, log-prompts-dir, slot-save-path, lookup-cache-dynamic
      runs: 6,         // tools, tools-runtime, agent, the two mcp-servers-*, video-ffmpeg-dir
      exposes: 3,      // media-path, path, ui-mcp-proxy
      connection: 2,   // api-key-file, api-prefix
    });
  });

  it('rejects every reserved option, including through an alias', () => {
    for (const key of RESERVED_KEYS) expect(isReservedKey(key)).toBe(true);
    for (const [raw, expected] of [
      // The three with a control get sent to it…
      ['--ctx-size 8192', 'set from the controls above'],
      ['--c 8192', 'set from the controls above'],
      ['--LLAMA_ARG_CTX_SIZE 8192', 'set from the controls above'],
      ['--ngl 20', 'set from the controls above'],
      // …and the ones with NO control must not be, because there is no host,
      // model or mmproj control to go and look for.
      ['--m /tmp/x.gguf', 'set by YouCoded and cannot be changed here'],
      ['--alias x', 'set by YouCoded and cannot be changed here'],
      ['--host 0.0.0.0', 'set by YouCoded and cannot be changed here'],
      // …and the two the app sets for EVERY model say so, because the mechanism
      // is different: llama.cpp merges the router's command line over every
      // preset, so a per-model value here is read and then silently overridden.
      // "cannot be changed here" would be a half-truth; "would have no effect"
      // is the thing the user needs to know. Alias too — `--ctk` is the same option.
      ['--cache-type-k f16', 'for every model at once, so setting it for one model here would have no effect'],
      ['--ctk f16', 'for every model at once, so setting it for one model here would have no effect'],
      ['--cache-type-v f16', 'for every model at once, so setting it for one model here would have no effect'],
    ] as Array<[string, string]>) {
      const r = parseExtraFlags(raw);
      expect(r.ok, raw).toBe(false);
      expect(r.ok === false && r.message, raw).toContain(expected);
    }
  });

  it('never describes a NEGATED spelling as doing what its positive does', () => {
    // `--no-agent` turns OFF the built-in tools; telling the user it "would let
    // the engine start other programs" is the reverse of what they typed, and a
    // message that describes the opposite is worse than no message at all.
    // The distinction the message rests on, asserted directly.
    expect(reservedMatch('agent')).toEqual({ reason: 'runs', viaNegation: false });
    expect(reservedMatch('no-agent')).toEqual({ reason: 'runs', viaNegation: true });
    expect(reservedMatch('no-mmproj-auto')).toBeNull();
    for (const raw of ['--no-agent', '--no-ui-mcp-proxy', '--no-host']) {
      const r = parseExtraFlags(raw);
      expect(r.ok, raw).toBe(false);
      const message = r.ok === false ? r.message : '';
      expect(message, raw).toContain('neither spelling can be set here');
      expect(message, raw).not.toContain('would let the engine start');
      expect(message, raw).not.toContain('would open a way');
      expect(message, raw).not.toContain('controls above');
    }
  });

  it('refuses every option that would make the engine reach the network, the disk or another program', () => {
    // The list is 43 keys, all verified to be real options on b10665 by
    // probe-presets.mjs. These are one per REASON, with the sentence the user
    // reads — the sentence must describe what the option does, never guess at
    // why they typed it.
    const cases: Array<[string, string]> = [
      ['--hf-repo unsloth/x-GGUF', 'fetch files from the internet'],
      ['--hfd unsloth/x-GGUF', 'fetch files from the internet'],          // through an alias
      ['--model-url https://example.com/x.gguf', 'fetch files from the internet'],
      ['--gpt-oss-20b-default', 'fetch files from the internet'],         // a one-word model preset
      ['--log-prompts-dir /tmp/p', 'write files outside your models folder'],
      ['--tools all', 'start other programs'],
      ['--video-ffmpeg-dir /tmp/bin', 'start other programs'],
      ['--media-path /home/me', 'read or reach files through the engine'],
      ['--api-key-file /tmp/keys', 'how YouCoded connects to this model'],
      ['--api-prefix /x', 'how YouCoded connects to this model'],
      // The most network-exposing option llama.cpp has: --rpc offloads the
      // weights AND the computation to another machine over TCP, on a backend
      // upstream itself calls "fragile and insecure". Its own sentence, because
      // "downloads from the internet" is not what happens — the user's own work
      // leaves the computer.
      ['--rpc 10.0.0.5:50052', 'to another computer over the network'],
    ];
    for (const [raw, expected] of cases) {
      const r = parseExtraFlags(raw);
      expect(r.ok, raw).toBe(false);
      expect(r.ok === false && r.message, raw).toContain(expected);
    }
  });

  it('still allows the options that only read one local file the user named', () => {
    // Deliberately available: each reads a file the user typed the path to, and
    // its effect stays inside that one model's own generation — no fetch, no
    // write, nothing started. A power user with an unusual GGUF needs these.
    for (const raw of [
      '--lora /tmp/a.gguf', '--control-vector /tmp/v.gguf', '--spec-draft-model /tmp/d.gguf',
      '--chat-template-file /tmp/t.jinja', '--grammar-file /tmp/g.gbnf',
      '--json-schema-file /tmp/s.json', '--lookup-cache-static /tmp/l.bin', '--offline',
    ]) {
      expect(parseExtraFlags(raw).ok, raw).toBe(true);
    }
  });

  it('strips a leading no- before the reserved check, and only then', () => {
    // A negative spelling normalises to its OWN canonical key, so without the
    // strip `--no-host` walks straight past a list that only knows `host`.
    expect(isReservedKey('no-host')).toBe(true);
    expect(parseExtraFlags('--no-host').ok).toBe(false);
    // …but the strip must not swallow options that merely start with "no-":
    // `--no-mmap` is the user asking for the opposite of `--mmap`, and llama.cpp
    // keeps it as its own key.
    expect(parseExtraFlags('--no-mmap')).toEqual({ ok: true, entries: [{ key: 'no-mmap', value: '1' }] });
    // And the OFF short forms do not look negative at all until they are
    // normalised, which is the other half of why the order matters.
    expect(normaliseArgKey('--nkvo')).toBe('no-kv-offload');
    expect(parseExtraFlags('--nkvo')).toEqual({ ok: true, entries: [{ key: 'no-kv-offload', value: '1' }] });
    // The strip covers the new safety entries too: `--no-agent` is a real flag.
    expect(parseExtraFlags('--no-agent').ok).toBe(false);
    // …and `--no-mmproj` still is not `mmproj`: it normalises to `no-mmproj-auto`,
    // whose stripped form is `mmproj-auto`, which nobody manages.
    expect(parseExtraFlags('--no-mmproj')).toEqual({ ok: true, entries: [{ key: 'no-mmproj-auto', value: '1' }] });
  });

  it('drops an unsaveable extra-flags string rather than writing it into the file', () => {
    // Reaching this means config.json was hand-edited or written by an older
    // build: the flags cost that one user their customisation, the file costs
    // EVERY model on the next spawn.
    const file = renderPresetFile({
      ...base, modelIds: ['m'], settings: { m: { ...DEFAULTS, contextLength: 4096, extraFlags: '--alias a#b' } },
    });
    expect(section(file, 'm')).toEqual(['ctx-size = 4096']);
  });

  it('a managed option typed into the extra-flags box cannot change what is written', () => {
    // It is refused as reserved long before this point; the assertion is that the
    // section still reflects the Context length control and nothing else.
    expect(modelSectionEntries({ contextLength: 4096, keepLoaded: false, gpuLayers: 'auto', extraFlags: '--ctx-size 99' }))
      .toEqual([{ key: 'ctx-size', value: '4096' }]);
  });
});

describe('model-presets — writing the file', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-presets-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('creates ~/.youcoded/engine/ and lands the file whole', () => {
    const target = presetFilePath(root);
    expect(target).toBe(path.join(root, 'engine', 'models.ini'));
    writePresetFile(target, renderPresetFile({ ...base, modelIds: [] }));
    expect(fs.readFileSync(target, 'utf8')).toContain('ctx-size = 32768');
    // Temp file + rename, never a partial file: ~/.youcoded is shared between a
    // dev instance and the built app, and a reader that catches half of this
    // file gets an engine that will not start.
    expect(fs.readdirSync(path.join(root, 'engine'))).toEqual(['models.ini']);
  });

  it('uses a per-process temp name so two writers never share one', () => {
    // A directory where the file goes makes the rename — and only the rename —
    // fail, which leaves the temp file on disk under its real name.
    const target = presetFilePath(root);
    fs.mkdirSync(target, { recursive: true });
    expect(() => writePresetFile(target, 'x')).toThrow();
    expect(fs.existsSync(`${target}.${process.pid}.tmp`)).toBe(true);
  });
});

// A stand-in for the spawned llama-server: exactly the surface the check uses.
class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  signals: string[] = [];
  exitCode: number | null = null;
  signalCode: string | null = null;
  get killed(): boolean { return this.signals.length > 0; }
  kill(signal?: string): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    // A real child ends when it is killed; without this the post-verdict wait
    // would sit out its whole grace period on every test.
    this.signalCode = signal ?? 'SIGTERM';
    setTimeout(() => this.emit('exit', null), 0);
    return true;
  }
}

describe('model-presets — asking the binary whether a flag is real', () => {
  const entries = [{ key: 'not-a-real-flag', value: '7' }];

  function run(drive: (child: FakeChild) => void, extra: Record<string, unknown> = {}) {
    const child = new FakeChild();
    let spawnArgs: string[] = [];
    // The check file is deleted the moment the promise settles, so the only
    // place to read it is here, while the "process" is being started.
    let ini = '';
    const spawnImpl = vi.fn((_bin: string, args: string[]) => {
      spawnArgs = args;
      ini = fs.readFileSync(args[args.indexOf('--models-preset') + 1], 'utf8');
      return child;
    }) as any;
    const promise = checkFlagsAgainstBinary({
      binaryPath: '/fake/llama-server', modelId: 'gemma-4-E2B-it-Q8_0', entries, spawnImpl, timeoutMs: 50, ...extra,
    });
    // Wait for the spawn rather than sleeping at it: the check does real I/O
    // (mkdtemp, and asking the OS for a free port) before the child exists.
    const spawned = vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled()).then(() => drive(child));
    return { promise, child, spawnImpl, spawned, args: () => spawnArgs, ini: () => ini };
  }

  it('rejects on a non-zero exit and quotes the engine, not a guess', async () => {
    const { promise } = run((child) => {
      child.stderr.emit('data', "0.00.050.247 E srv  llama_server: failed to initialize router models: option 'not-a-real-flag' not recognized in preset 'gemma-4-E2B-it-Q8_0'\n");
      child.emit('exit', 1);
    });
    await expect(promise).resolves.toEqual({
      ok: false,
      message: "failed to initialize router models: option 'not-a-real-flag' not recognized in preset 'gemma-4-E2B-it-Q8_0'",
    });
  });

  it('accepts the INSTANT the engine says it is listening — not when the timeout runs out', async () => {
    // The timeout is 10 s here and the assertion is SYNCHRONOUS: right after the
    // "listening" line, the child must already have been signalled. Only the
    // early-accept branch can do that. With a short timeout both paths return an
    // identical {ok:true}, so deleting that branch — or llama.cpp rewording
    // "listening on" — would leave this green while every settings save with an
    // extra flag stalled the dialog for the full timeout.
    const { promise, child, spawned } = run(
      (c) => c.stderr.emit('data', '0.00.045.005 I srv  llama_server: listening on http://127.0.0.1:9317\n'),
      { timeoutMs: 10_000 }
    );
    await spawned;
    expect(child.signals).toEqual(['SIGTERM']);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('escalates to SIGKILL rather than leaving an orphan holding a deleted folder', async () => {
    // llama-server can sit in a GPU init call and ignore SIGTERM, which is
    // exactly the state a timed-out check is in. The temp folder is removed the
    // moment this returns, so a survivor would be an orphan holding it open.
    const child = new FakeChild();
    child.kill = function (signal?: string) { this.signals.push(signal ?? 'SIGTERM'); return true; }; // ignores TERM
    const spawnImpl = vi.fn(() => child) as any;
    const promise = checkFlagsAgainstBinary({
      binaryPath: '/fake/llama-server', modelId: 'm', entries, spawnImpl, timeoutMs: 10, killGraceMs: 20,
    });
    await expect(promise).resolves.toEqual({ ok: true });
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reads an exit with no code as our own kill, never as a rejection', async () => {
    const { promise } = run((c) => c.emit('exit', null));
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('accepts when the check could not run at all — a verdict we did not reach is not a rejection', async () => {
    await expect(run((c) => c.emit('error', new Error('ENOENT'))).promise).resolves.toEqual({ ok: true });
    await expect(run(() => { /* silence until the timeout */ }).promise).resolves.toEqual({ ok: true });
  });

  it('does not spawn anything when there is nothing to check', async () => {
    const spawnImpl = vi.fn();
    await expect(checkFlagsAgainstBinary({
      binaryPath: '/fake/llama-server', modelId: 'm', entries: [], spawnImpl: spawnImpl as any,
    })).resolves.toEqual({ ok: true });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("checks under the model's own name, so the engine's message names the model", async () => {
    const { promise, ini } = run((c) => c.emit('exit', 1), { modelId: 'tiny-model-Q4' });
    await promise;
    expect(ini().split('\n')[0]).toBe('[tiny-model-Q4]');
  });

  it('checks under a neutral name when the model id cannot be written as a section', async () => {
    // Otherwise a user with `a]b.gguf` on disk saves a perfectly good --temp 0.6
    // and gets told the config file could not be parsed — an error about the
    // check file itself, with nothing to do with what they typed.
    const { promise, ini } = run((c) => c.emit('exit', 1), { modelId: 'a]b' });
    await promise;
    expect(ini().split('\n')[0]).toBe('[model]');
    expect(ini()).toContain('not-a-real-flag = 7');
  });
});

describe('model-presets — the message the user is shown', () => {
  it('strips only the log prefix from the engine\'s own line', () => {
    expect(engineErrorLine("0.00.050.247 E srv  llama_server: failed to initialize router models: option 'x' not recognized in preset 'y'", 1))
      .toBe("failed to initialize router models: option 'x' not recognized in preset 'y'");
  });

  it('takes the LAST error line, not the first, and never the chatter around them', () => {
    // Real stderr carries several E lines and the last one is the failure that
    // actually stopped the engine; an earlier one is a symptom on the way there.
    const stderr = [
      '0.00.049.485 I srv   load_models: Loaded 0 cached model presets',
      '0.00.049.900 E srv   load_models: failed to load model preset',
      '0.00.050.247 E srv  llama_server: failed to parse server config file: /tmp/x.ini',
      '0.00.050.900 I srv    operator(): cleaning up before exit...',
    ].join('\n');
    expect(engineErrorLine(stderr, 1)).toBe('failed to parse server config file: /tmp/x.ini');
  });

  it('says only what it knows when the engine said nothing', () => {
    expect(engineErrorLine('', 1)).toBe('The local engine rejected this setting and exited with code 1.');
  });
});
