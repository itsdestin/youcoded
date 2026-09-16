import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { EngineManager } from '../src/main/engine/engine-manager';
import { updateEngineConfig } from '../src/main/engine/engine-config';
import { ENGINE_VERSION } from '../src/main/engine/engine-pin';
import { ModelManager } from '../src/main/models/model-manager';
import type { DownloadProgress } from '../src/shared/model-manager-types';

let root: string;
let home: NativeHome;
let cacheDir: string;
let urls: string[];

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-mgr-'));
  home = new NativeHome(root);
  cacheDir = path.join(root, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  // Point the manager at the tmp cache — never at ~/.cache/llama.cpp.
  await updateEngineConfig(home, { cacheDir });
  urls = [];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

// Records every URL the downloader asks for, then fails — the test only needs
// to see WHERE resume went, not to move bytes.
const recordingFetch = (async (url: any) => {
  urls.push(String(url));
  return new Response(null, { status: 500 });
}) as typeof fetch;

function manager(opts: { freeDiskBytes?: number } = {}): ModelManager {
  const userData = path.join(root, 'userData');
  const engine = new EngineManager(home, userData, 9999);
  return new ModelManager(home, engine, userData, {
    fetchImpl: recordingFetch, totalVramBytes: null, ...opts,
  });
}

describe('ModelManager.resume', () => {
  it("starts a download of the manifest's repo and file set — with NO Hugging Face listing call", async () => {
    fs.writeFileSync(path.join(cacheDir, 'Half-UD-Q4_K_XL-00001-of-00002.gguf'), Buffer.alloc(10));
    fs.writeFileSync(path.join(cacheDir, 'Half-UD-Q4_K_XL-00001-of-00002.gguf.download.json'), JSON.stringify({
      v: 1, repo: 'unsloth/Half-GGUF', quant: 'UD-Q4_K_XL',
      files: ['a/Half-UD-Q4_K_XL-00001-of-00002.gguf', 'a/Half-UD-Q4_K_XL-00002-of-00002.gguf'],
      totalSizeBytes: 100, sha256ByFile: {}, startedAt: 1,
    }));
    const mm = manager();
    const settled = new Promise<DownloadProgress>((resolve) => {
      mm.on('download-progress', (p: DownloadProgress) => { if (p.state === 'error') resolve(p); });
    });
    const { downloadId } = await mm.resume('Half-UD-Q4_K_XL-00001-of-00002');
    expect(downloadId).toBeTruthy();
    await settled;
    // Part 1 is already published, so the ONLY request is part 2's resolve URL.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('unsloth/Half-GGUF');
    expect(urls[0]).toContain('Half-UD-Q4_K_XL-00002-of-00002.gguf');
  });

  it('names the real problem when there is no manifest', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Old-Q4_K_M.gguf.partial'), Buffer.alloc(10));
    await expect(manager().resume('Old-Q4_K_M')).rejects.toThrow(/where it came from/i);
    expect(urls).toEqual([]);
  });

  it('refuses a manifest whose repo was never found — repo: null is untraceable', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Mystery-Q4_K_M.gguf.partial'), Buffer.alloc(10));
    fs.writeFileSync(path.join(cacheDir, 'Mystery-Q4_K_M.gguf.download.json'), JSON.stringify({
      v: 1, repo: null, quant: 'Q4_K_M', files: ['Mystery-Q4_K_M.gguf'],
      totalSizeBytes: 50, sha256ByFile: {}, startedAt: 1,
    }));
    await expect(manager().resume('Mystery-Q4_K_M')).rejects.toThrow(/where it came from/i);
    expect(urls).toEqual([]);
  });

  it('refuses a FINISHED download — a surviving manifest is not something to resume', async () => {
    // The manifest outlives the download now, so its presence alone must not be
    // read as "there is more to fetch". completedAt is the test.
    fs.writeFileSync(path.join(cacheDir, 'Done-Q4_K_M.gguf'), Buffer.alloc(50));
    fs.writeFileSync(path.join(cacheDir, 'Done-Q4_K_M.gguf.download.json'), JSON.stringify({
      v: 1, repo: 'unsloth/Done-GGUF', quant: 'Q4_K_M', files: ['a/Done-Q4_K_M.gguf'],
      totalSizeBytes: 50, sha256ByFile: {}, startedAt: 1, completedAt: 2,
    }));
    await expect(manager().resume('Done-Q4_K_M')).rejects.toThrow(/already finished/i);
    expect(urls).toEqual([]);   // no bytes asked for, no Hugging Face call
  });
});

// ── The vision folder reaches ModelManager too (design §E2) ─────────────────

const GB = 1024 ** 3;
/** A vision quant whose weights and projector are deliberately different
 *  sizes, so a guard that counts only one of them cannot accidentally pass. */
const visionQuant = {
  quant: 'Q4_K_M', description: '',
  files: ['V-Q4_K_M.gguf'],
  totalSizeBytes: 3 * GB,
  sha256ByFile: { 'V-Q4_K_M.gguf': null },
  visionBytes: GB,
  visionFile: { path: 'mmproj-F16.gguf', size: GB, sha256: null },
};

describe('ModelManager.download — the disk guard reserves the projector', () => {
  it('refuses when weights + projector do not fit, though the weights alone would', async () => {
    // 3.5 GB free against a 3 GB model: the old guard, which reserved
    // `totalSizeBytes` alone, let this through and the download then ran the
    // disk out partway through the projector (T15 handoff 2). The refusal has
    // to quote 4.0 GB — the whole job — not 3.0.
    await expect(manager({ freeDiskBytes: 3.5 * GB }).download('unsloth/V-GGUF', visionQuant as any)).rejects.toThrow(
      'Not enough free space: this download needs about 4.0 GB but only 3.5 GB is free.');
    expect(urls).toEqual([]);          // nothing was fetched
    expect(fs.existsSync(path.join(cacheDir, 'V-Q4_K_M'))).toBe(false);
  });

  it('allows it when both really do fit', async () => {
    const mm = manager({ freeDiskBytes: 9 * GB });
    const settled = new Promise<DownloadProgress>((resolve) => {
      mm.on('download-progress', (p: DownloadProgress) => { if (p.state === 'error') resolve(p); });
    });
    const { downloadId } = await mm.download('unsloth/V-GGUF', visionQuant as any);
    expect(downloadId).toBeTruthy();
    await settled;                     // the fake fetch 500s; the guard is what was tested
  });

  it('credits the PROJECTOR already on disk, not only the weights', async () => {
    // The projector is the half that was missing from bytesOnDiskFor's path
    // list: with only it on disk, the guard has to see 3 GB left of a 4 GB job.
    // Charging the whole 4 GB here would refuse a download that fits, and the
    // obvious reaction — delete the .partial — destroys what made it fit.
    fs.mkdirSync(path.join(cacheDir, 'V-Q4_K_M'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'V-Q4_K_M', 'mmproj-F16.gguf'), '');
    fs.truncateSync(path.join(cacheDir, 'V-Q4_K_M', 'mmproj-F16.gguf'), GB);
    // 3.4 GB free: clears the 3 GB that is left (plus the guard's 5% margin),
    // and does not clear the whole 4 GB job.
    const mm = manager({ freeDiskBytes: 3.4 * GB });
    const settled = new Promise<DownloadProgress>((resolve) => {
      mm.on('download-progress', (p: DownloadProgress) => { if (p.state === 'error') resolve(p); });
    });
    await expect(mm.download('unsloth/V-GGUF', visionQuant as any)).resolves.toBeTruthy();
    await settled;
  });

  it('credits a half-fetched model file in the folder, so a resume is judged on what is LEFT', async () => {
    // The 2026-08-26 trap: charging a resume the full size tells the user to
    // delete the very .partial that made it fit.
    fs.mkdirSync(path.join(cacheDir, 'V-Q4_K_M'), { recursive: true });
    // Sparse — statSync reports 3 GB, the disk holds nothing.
    fs.writeFileSync(path.join(cacheDir, 'V-Q4_K_M', 'V-Q4_K_M.gguf'), '');
    fs.truncateSync(path.join(cacheDir, 'V-Q4_K_M', 'V-Q4_K_M.gguf'), 3 * GB);
    const mm = manager({ freeDiskBytes: 1.2 * GB });
    const settled = new Promise<DownloadProgress>((resolve) => {
      mm.on('download-progress', (p: DownloadProgress) => { if (p.state === 'error') resolve(p); });
    });
    // 4 GB job, 3 GB of it already on disk in the FOLDER: 1 GB left, 1.2 free.
    await expect(mm.download('unsloth/V-GGUF', visionQuant as any)).resolves.toBeTruthy();
    await settled;
  });
});

describe('ModelManager.resume — a vision download resumes into its folder', () => {
  it('reads the manifest INSIDE the folder and keeps the projector on the job', async () => {
    const folder = path.join(cacheDir, 'V-Q4_K_M');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'V-Q4_K_M.gguf.partial'), Buffer.alloc(10));
    fs.writeFileSync(path.join(folder, 'V-Q4_K_M.gguf.download.json'), JSON.stringify({
      v: 1, repo: 'unsloth/V-GGUF', quant: 'Q4_K_M', files: ['V-Q4_K_M.gguf'],
      totalSizeBytes: 50, sha256ByFile: {}, startedAt: 1,
      visionFile: { path: 'mmproj-F16.gguf', size: 900, sha256: null },
    }));
    const mm = manager();
    const settled = new Promise<DownloadProgress>((resolve) => {
      mm.on('download-progress', (p: DownloadProgress) => { if (p.state === 'error') resolve(p); });
    });
    await mm.resume('V-Q4_K_M');
    const err = await settled;
    // Dropping visionFile here would send the remaining bytes FLAT, beside the
    // folder that holds the rest of them — where the engine serves neither.
    expect(err.totalBytes).toBe(950);
    expect(err.parts).toBe(2);
    expect(fs.existsSync(path.join(cacheDir, 'V-Q4_K_M.gguf.partial'))).toBe(false);
    expect(fs.existsSync(path.join(folder, 'V-Q4_K_M.gguf.partial'))).toBe(true);
  });
});

/** A foldered vision model on disk: `<cacheDir>/<id>/<id>.gguf` + its projector,
 *  both sparse so the sizes are real and the disk holds nothing. */
function plantVisionFolder(id: string, weightBytes: number, projectorBytes: number) {
  const folder = path.join(cacheDir, id);
  fs.mkdirSync(folder, { recursive: true });
  for (const [name, bytes] of [[`${id}.gguf`, weightBytes], ['mmproj-F16.gguf', projectorBytes]] as const) {
    fs.writeFileSync(path.join(folder, name), '');
    fs.truncateSync(path.join(folder, name), bytes);
  }
  return folder;
}

/** An installed engine, so liveModels() falls back to the engine-off cache scan
 *  instead of returning [] (which makes every memory number silently zero). */
function plantEngine(userData: string) {
  const dir = path.join(userData, 'engine', `${ENGINE_VERSION}-cpu`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'llama-server'), 'fake');
  fs.writeFileSync(path.join(dir, '.complete'),
    JSON.stringify({ version: ENGINE_VERSION, backend: 'cpu', binaryRelPath: 'llama-server' }));
}

describe('ModelManager.memoryCheck — the projector is memory too', () => {
  it("counts an installed model's projector, and names it in the numbers line", async () => {
    // A projector is loaded WITH its model (--mmproj) and reaches 2.6 GB on
    // Qwen2.5-Omni — five times the working-memory cushion — so leaving it out
    // could tell a user a model fits when it does not.
    const folder = path.join(cacheDir, 'V-Q4_K_M');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'V-Q4_K_M.gguf'), '');
    fs.truncateSync(path.join(folder, 'V-Q4_K_M.gguf'), 4 * GB);
    fs.writeFileSync(path.join(folder, 'mmproj-F16.gguf'), '');
    fs.truncateSync(path.join(folder, 'mmproj-F16.gguf'), 2 * GB);

    const userData = path.join(root, 'userData');
    // memoryCheck reads the model list, which is empty until an engine is
    // installed — plant a fake one so the ENGINE-OFF cache scan is used.
    const engineDir = path.join(userData, 'engine', `${ENGINE_VERSION}-cpu`);
    fs.mkdirSync(engineDir, { recursive: true });
    fs.writeFileSync(path.join(engineDir, 'llama-server'), 'fake');
    fs.writeFileSync(path.join(engineDir, '.complete'),
      JSON.stringify({ version: ENGINE_VERSION, backend: 'cpu', binaryRelPath: 'llama-server' }));
    const engine = new EngineManager(home, userData, 9999);
    const mm = new ModelManager(home, engine, userData, {
      fetchImpl: recordingFetch, totalVramBytes: null,
      totalMemBytes: 16 * GB, availableMemBytes: 5 * GB,
    });
    const verdict = await mm.memoryCheck('V-Q4_K_M');
    // Exact string: the headline is the ONLY thing the warning row draws, and a
    // substring match on "vision" would stay green if the size were wrong.
    expect(verdict.headline).toContain('4.0 GB model + 2.0 GB vision file');
  });
});

// ── The two numbers that only a FOLDERED model can get wrong ────────────────

/** A minimal real GGUF v3 header (scalars only, no tokenizer tail) — enough for
 *  the reader to answer EXACTLY rather than with a ceiling. That difference is
 *  the only observable proof that the header was read from the right path. */
function miniGguf(): Buffer {
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (v: string) => { const b = Buffer.from(v, 'utf8'); return Buffer.concat([u64(b.length), b]); };
  const kvs: Array<[string, number, Buffer]> = [
    ['general.architecture', 8, str('llama')],
    ['llama.block_count', 4, u32(32)],
    ['llama.attention.head_count', 4, u32(32)],
    ['llama.attention.head_count_kv', 4, u32(8)],
    ['llama.attention.key_length', 4, u32(128)],
    ['llama.attention.value_length', 4, u32(128)],
  ];
  return Buffer.concat([
    Buffer.from('GGUF', 'ascii'), u32(3), u64(0), u64(kvs.length),
    ...kvs.flatMap(([k, t, v]) => [str(k), u32(t), v]),
  ]);
}

describe('a foldered model is found by the header reader and by the loaded-memory sum', () => {
  it("reads the model's HEADER from its folder — a wrong path degrades every estimate to 'up to'", async () => {
    // localHeader used to build `<cacheDir>/<id>.gguf`, which for a vision model
    // is not where the file is. The failure is silent: the read throws, the
    // catch turns it into "header unknown", and the KV estimate quietly becomes
    // a ceiling — the model card then reads "up to 8.0 GB for 32k context" for
    // a file the app could have measured exactly.
    const folder = path.join(cacheDir, 'V-Q4_K_M');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'V-Q4_K_M.gguf'), miniGguf());
    fs.truncateSync(path.join(folder, 'V-Q4_K_M.gguf'), 4 * GB);   // real header, real size, sparse
    fs.writeFileSync(path.join(folder, 'mmproj-F16.gguf'), '');
    fs.truncateSync(path.join(folder, 'mmproj-F16.gguf'), GB);

    const userData = path.join(root, 'userData');
    plantEngine(userData);
    const mm = new ModelManager(home, new EngineManager(home, userData, 9999), userData, {
      fetchImpl: recordingFetch, totalVramBytes: null,
      totalMemBytes: 16 * GB, availableMemBytes: 4 * GB,
    });
    const headline = (await mm.memoryCheck('V-Q4_K_M')).headline;
    // "up to" is the reader saying it could not understand the file. Reading the
    // right path removes it; reading the flat path puts it back.
    expect(headline).not.toContain('up to');
    expect(headline).toContain('4.0 GB model + 1.0 GB vision file');
  });

  it("counts a RESIDENT model's projector in what is already loaded", async () => {
    // loadedBytes sums the models holding memory right now. `sizeBytes` is the
    // weights alone, so without the projector term a resident vision model is
    // under-counted by up to 2.6 GB — and the number it feeds is the one that
    // decides whether the NEXT model is refused.
    plantVisionFolder('R-Q4_K_M', 3 * GB, GB);           // the resident one
    plantVisionFolder('V-Q4_K_M', 4 * GB, 2 * GB);       // the one being checked
    const userData = path.join(root, 'userData');
    plantEngine(userData);
    const engine = new EngineManager(home, userData, 9999);
    // No engine is really running here, so state the residency directly — this
    // is the only way to exercise the `loaded` branch of loadedBytes.
    engine.liveModels = async () => ([
      { id: 'R-Q4_K_M', sizeBytes: 3 * GB, loaded: true, state: 'loaded' as const },
      { id: 'V-Q4_K_M', sizeBytes: 4 * GB, loaded: false, state: 'unloaded' as const },
    ]);
    const mm = new ModelManager(home, engine, userData, {
      fetchImpl: recordingFetch, totalVramBytes: null,
      totalMemBytes: 64 * GB, availableMemBytes: 4 * GB,
    });
    const loadedGb = (h: string) => Number(/([\d.]+) GB already loaded/.exec(h)![1]);
    const withProjector = loadedGb((await mm.memoryCheck('V-Q4_K_M')).headline);

    // Take the resident model's projector away and re-ask. Everything else is
    // identical, so the whole difference is that one file — asserted as an exact
    // delta, because the absolute figure also carries an estimated KV cache.
    fs.rmSync(path.join(cacheDir, 'R-Q4_K_M', 'mmproj-F16.gguf'));
    const withoutProjector = loadedGb((await mm.memoryCheck('V-Q4_K_M')).headline);
    expect(withProjector - withoutProjector).toBeCloseTo(1.0, 5);
  });
});

// ── The remembered memory warning (design §D4) ──────────────────────────────
//
// The rule these pin, end to end through config.json: "don't warn me about this
// model again" is a promise made AT ONE CONTEXT LENGTH. The same model at four
// times the context needs about four times the memory, so the promise cannot
// outlive a change to that length — the model's own setting or the engine-wide
// default it inherits. fit-estimator.test.ts pins the same rule on the pure
// function, which takes the context length as an argument; only these can reach
// the half the design note is actually about, where nothing about the MODEL
// changed and the engine-wide number moved underneath it.

/** A model on disk with a real GGUF header, so its context memory is measured
 *  rather than guessed — the whole rule turns on a context length, so the number
 *  it turns on has to be a real reading of this file. Sparse: no bytes written. */
function plantModel(id: string, bytes: number): void {
  const file = path.join(cacheDir, `${id}.gguf`);
  fs.writeFileSync(file, miniGguf());
  fs.truncateSync(file, bytes);
}

/** A manager for a machine with plenty of memory in total but little free right
 *  now — the `tight` tier, which is the ONLY verdict §D4 lets anyone dismiss.
 *  Rebuilt per call because the settings are read from config.json at each
 *  check, and a stale instance would answer from the file as it was. */
function warnMachine(ids: string[], sizeBytes = 8 * GB): ModelManager {
  const userData = path.join(root, 'userData');
  plantEngine(userData);
  const engine = new EngineManager(home, userData, 9999);
  engine.liveModels = async () => ids.map((id) => ({
    id, sizeBytes, loaded: false, state: 'unloaded' as const,
  }));
  return new ModelManager(home, engine, userData, {
    fetchImpl: recordingFetch, totalVramBytes: null,
    totalMemBytes: 64 * GB, availableMemBytes: 4 * GB,
  });
}

/** Write one model's `engine.models` entry, as the settings save will. */
async function writeModelSettings(modelId: string, entry: unknown): Promise<void> {
  await updateEngineConfig(home, { models: { [modelId]: entry } } as any);
}

const dismissedAt = (contextLength: number) => ({ at: 1_757_000_000_000, contextLength });

describe('ModelManager.memoryCheck — the remembered warning (§D4)', () => {
  it('a dismissal made at 32k silences the warning at 32k', async () => {
    plantModel('M-Q4_K_M', 8 * GB);
    // Before: this machine really does warn about this model. Without this
    // line the test below would pass on a fixture that never warned at all.
    expect((await warnMachine(['M-Q4_K_M']).memoryCheck('M-Q4_K_M')).verdict).toBe('tight');

    await writeModelSettings('M-Q4_K_M', { memoryWarningDismissed: dismissedAt(32768) });
    const after = await warnMachine(['M-Q4_K_M']).memoryCheck('M-Q4_K_M');
    expect(after.verdict).toBe('ok');
    // A silenced warning draws nothing — the row is hidden, not emptied of text.
    expect(after.headline).toBe('');
  });

  it("raising the ENGINE-WIDE context asks again, though this model's own setting never moved", async () => {
    // The case the whole design note is about (R3-4/R3-23). This model is on the
    // engine-wide default, so its own `contextLength` stays null throughout —
    // storing THAT number, or a bare timestamp, would keep the dismissal alive
    // for exactly the model that now needs four times the memory.
    plantModel('M-Q4_K_M', 8 * GB);
    await writeModelSettings('M-Q4_K_M', {
      contextLength: null, memoryWarningDismissed: dismissedAt(32768),
    });
    expect((await warnMachine(['M-Q4_K_M']).memoryCheck('M-Q4_K_M')).verdict).toBe('ok');

    await updateEngineConfig(home, { contextSize: 131072 });
    const after = await warnMachine(['M-Q4_K_M']).memoryCheck('M-Q4_K_M');
    expect(after.verdict).toBe('tight');
    // Still the same tier, scored at the NEW length: had the raise pushed it to
    // a hard block instead, this test would pass for a reason that has nothing
    // to do with the dismissal.
    expect(after.headline).toContain('for 128k context');
  });

  it("a model's own context setting moving asks again too", async () => {
    plantModel('M-Q4_K_M', 8 * GB);
    await writeModelSettings('M-Q4_K_M', {
      contextLength: 32768, memoryWarningDismissed: dismissedAt(32768),
    });
    expect((await warnMachine(['M-Q4_K_M']).memoryCheck('M-Q4_K_M')).verdict).toBe('ok');

    await writeModelSettings('M-Q4_K_M', {
      contextLength: 131072, memoryWarningDismissed: dismissedAt(32768),
    });
    const after = await warnMachine(['M-Q4_K_M']).memoryCheck('M-Q4_K_M');
    expect(after.verdict).toBe('tight');
    expect(after.headline).toContain('for 128k context');
  });

  it('a dismissal belongs to ONE model and does not answer for another', async () => {
    plantModel('A-Q4_K_M', 8 * GB);
    plantModel('B-Q4_K_M', 8 * GB);
    await writeModelSettings('A-Q4_K_M', { memoryWarningDismissed: dismissedAt(32768) });
    const mm = warnMachine(['A-Q4_K_M', 'B-Q4_K_M']);
    expect((await mm.memoryCheck('A-Q4_K_M')).verdict).toBe('ok');
    expect((await mm.memoryCheck('B-Q4_K_M')).verdict).toBe('tight');
  });

  it('a too-large model is never silenced — it is a hard block, not a warning', async () => {
    // 8 GB of weights on an 8 GB machine: too large before a single byte of
    // context cache is counted, so the "KV may reach tight, never too-large"
    // clamp does not rescue it either. RuntimeBinding refuses to create the
    // session on this verdict, so a dismissal must not be able to reach it.
    plantModel('H-Q4_K_M', 8 * GB);
    await writeModelSettings('H-Q4_K_M', { memoryWarningDismissed: dismissedAt(32768) });
    const userData = path.join(root, 'userData');
    plantEngine(userData);
    const engine = new EngineManager(home, userData, 9999);
    engine.liveModels = async () => ([
      { id: 'H-Q4_K_M', sizeBytes: 8 * GB, loaded: false, state: 'unloaded' as const },
    ]);
    const mm = new ModelManager(home, engine, userData, {
      fetchImpl: recordingFetch, totalVramBytes: null,
      totalMemBytes: 8 * GB, availableMemBytes: 1 * GB,
    });
    expect((await mm.memoryCheck('H-Q4_K_M')).verdict).toBe('too-large');
  });

  it('a stored dismissal missing EITHER half is no dismissal', async () => {
    // config.json is a plain file a person can edit and an older build can have
    // written. A record without the length it was made at cannot answer "is this
    // the same length?", and one without a time is not a record of an answer —
    // both mean "ask again", never "assume yes".
    plantModel('M-Q4_K_M', 8 * GB);
    const broken = [
      { contextLength: 32768 },                    // no `at`
      { at: 1_757_000_000_000 },                   // no length
      1_757_000_000_000,                           // the bare timestamp R3-4 rejects
      { at: 1_757_000_000_000, contextLength: 0 }, // a length no model runs at
      null,
    ];
    for (const record of broken) {
      await writeModelSettings('M-Q4_K_M', { memoryWarningDismissed: record });
      expect((await warnMachine(['M-Q4_K_M']).memoryCheck('M-Q4_K_M')).verdict).toBe('tight');
    }
    // The positive control: the SAME fixture with a well-formed record does go
    // quiet. Without it, every line above would pass on a dismissal path that
    // was wired to nothing at all.
    await writeModelSettings('M-Q4_K_M', { memoryWarningDismissed: dismissedAt(32768) });
    expect((await warnMachine(['M-Q4_K_M']).memoryCheck('M-Q4_K_M')).verdict).toBe('ok');
  });
});

describe('ModelManager.addVision — the projector arrives on the ordinary download stream', () => {
  const PROJECTOR = Buffer.from('an-eye-for-this-model');

  /** Serves the mmproj by trailing filename; anything else is a 404, so a fetch
   *  of the WEIGHTS (which are already on disk and must not be re-downloaded)
   *  would fail the download loudly rather than pass unnoticed. */
  const servingProjector = (async (url: any) => {
    urls.push(String(url));
    if (!String(url).endsWith('mmproj-F16.gguf')) return new Response(null, { status: 404 });
    return new Response(new Blob([PROJECTOR]).stream(), {
      status: 200, headers: { 'content-length': String(PROJECTOR.length) },
    });
  }) as typeof fetch;

  it('moves the model into its folder, fetches the projector beside it, and the row becomes vision-ready', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Eye-Q4_K_M.gguf'), Buffer.alloc(64));
    fs.writeFileSync(path.join(cacheDir, 'Eye-Q4_K_M.gguf.download.json'), JSON.stringify({
      v: 1, repo: 'unsloth/Eye-GGUF', quant: 'Q4_K_M', files: ['Eye-Q4_K_M.gguf'],
      totalSizeBytes: 64, sha256ByFile: {}, startedAt: 1, completedAt: 2,
      visionFile: { path: 'mmproj-F16.gguf', size: PROJECTOR.length, sha256: null },
    }));
    const userData = path.join(root, 'userData');
    const engine = new EngineManager(home, userData, 9999);
    const mm = new ModelManager(home, engine, userData, {
      fetchImpl: servingProjector, totalVramBytes: null, freeDiskBytes: 1_000_000_000,
    });
    const events: DownloadProgress[] = [];
    mm.on('download-progress', (p: DownloadProgress) => events.push(p));
    // The event, not a timer: the download is started by addVision and finishes
    // later, and asserting against the fixture before it settles is how a test
    // reads green while the work it is checking never happened.
    const settled = new Promise<DownloadProgress>((resolve) => {
      mm.on('download-progress', (p: DownloadProgress) => {
        if (p.state === 'done' || p.state === 'error') resolve(p);
      });
    });

    const { downloadId } = await mm.addVision('Eye-Q4_K_M');
    const last = await settled;

    expect(last.state).toBe('done');
    expect(last.downloadId).toBe(downloadId);
    // The SAME stream every other download uses, carrying the repo + quant the
    // Local Models row matches a live download on.
    expect(events.every((e) => e.repo === 'unsloth/Eye-GGUF' && e.quant === 'Q4_K_M')).toBe(true);
    expect(events.some((e) => e.state === 'downloading')).toBe(true);
    // Only the projector is fetched: the weights were already published.
    expect(urls).toEqual(['https://huggingface.co/unsloth/Eye-GGUF/resolve/main/mmproj-F16.gguf']);
    // On disk: the folder holds both files and the flat copy is gone, so there
    // is no pair for the engine to pick between.
    expect(fs.existsSync(path.join(cacheDir, 'Eye-Q4_K_M.gguf'))).toBe(false);
    expect(fs.readFileSync(path.join(cacheDir, 'Eye-Q4_K_M', 'mmproj-F16.gguf'))).toEqual(PROJECTOR);
    expect(fs.existsSync(path.join(cacheDir, 'Eye-Q4_K_M', 'Eye-Q4_K_M.gguf'))).toBe(true);
    // And the app now reports the state the eye is drawn from.
    const rows = await engine.installedModels();
    expect(rows.map((r) => [r.id, r.status, r.vision]))
      .toEqual([['Eye-Q4_K_M', 'complete', 'ready']]);
  });
});
