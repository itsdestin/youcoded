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

/** Resolves with the first 'error' progress event (the fake fetch 500s, so the guard/route taken is what is under test). */
function nextError(mm: ModelManager): Promise<DownloadProgress> {
  return new Promise((resolve) => {
    mm.on('download-progress', (p: DownloadProgress) => { if (p.state === 'error') resolve(p); });
  });
}
/** A sparse file: statSync reports `bytes`, the disk holds nothing. */
function sparse(file: string, bytes: number | Buffer, size?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof bytes === 'number' ? '' : bytes);
  fs.truncateSync(file, size ?? (typeof bytes === 'number' ? bytes : bytes.length));
}
/** Write `<file>.download.json` with the common manifest fields plus `over`. */
function writeManifest(file: string, over: Record<string, unknown>) {
  fs.writeFileSync(`${file}.download.json`, JSON.stringify({ v: 1, sha256ByFile: {}, startedAt: 1, ...over }));
}
/** A manager over a fake installed engine, for the memory checks. */
function memManager(mem: { totalMemBytes: number; availableMemBytes: number }, liveModels?: Array<{ id: string; sizeBytes: number; loaded: boolean }>): ModelManager {
  const userData = path.join(root, 'userData');
  plantEngine(userData);
  const engine = new EngineManager(home, userData, 9999);
  if (liveModels) engine.liveModels = async () => liveModels.map((m) => ({ ...m, state: m.loaded ? 'loaded' as const : 'unloaded' as const }));
  return new ModelManager(home, engine, userData, { fetchImpl: recordingFetch, totalVramBytes: null, ...mem });
}

describe('ModelManager.resume', () => {
  it("starts a download of the manifest's repo and file set — with NO Hugging Face listing call", async () => {
    fs.writeFileSync(path.join(cacheDir, 'Half-UD-Q4_K_XL-00001-of-00002.gguf'), Buffer.alloc(10));
    writeManifest(path.join(cacheDir, 'Half-UD-Q4_K_XL-00001-of-00002.gguf'), {
      repo: 'unsloth/Half-GGUF', quant: 'UD-Q4_K_XL',
      files: ['a/Half-UD-Q4_K_XL-00001-of-00002.gguf', 'a/Half-UD-Q4_K_XL-00002-of-00002.gguf'],
      totalSizeBytes: 100,
    });
    const mm = manager();
    const settled = nextError(mm);
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
    writeManifest(path.join(cacheDir, 'Mystery-Q4_K_M.gguf'), { repo: null, quant: 'Q4_K_M', files: ['Mystery-Q4_K_M.gguf'], totalSizeBytes: 50 });
    await expect(manager().resume('Mystery-Q4_K_M')).rejects.toThrow(/where it came from/i);
    expect(urls).toEqual([]);
  });

  it('refuses a FINISHED download — a surviving manifest is not something to resume', async () => {
    // WHY: the manifest outlives the download, so its presence alone is not "more to fetch"; completedAt is the test.
    fs.writeFileSync(path.join(cacheDir, 'Done-Q4_K_M.gguf'), Buffer.alloc(50));
    writeManifest(path.join(cacheDir, 'Done-Q4_K_M.gguf'), { repo: 'unsloth/Done-GGUF', quant: 'Q4_K_M', files: ['a/Done-Q4_K_M.gguf'], totalSizeBytes: 50, completedAt: 2 });
    await expect(manager().resume('Done-Q4_K_M')).rejects.toThrow(/already finished/i);
    expect(urls).toEqual([]);   // no bytes asked for, no Hugging Face call
  });
});

const GB = 1024 ** 3;
/** A vision quant with deliberately different weight and projector sizes, so a guard counting only one cannot pass. */
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
    // WHY: the old guard reserved `totalSizeBytes` alone and ran the disk out partway through the projector; the refusal must quote 4.0 GB, the whole job.
    await expect(manager({ freeDiskBytes: 3.5 * GB }).download('unsloth/V-GGUF', visionQuant as any)).rejects.toThrow(
      'Not enough free space: this download needs about 4.0 GB but only 3.5 GB is free.');
    expect(urls).toEqual([]);          // nothing was fetched
    expect(fs.existsSync(path.join(cacheDir, 'V-Q4_K_M'))).toBe(false);
  });

  it('allows it when both really do fit', async () => {
    const mm = manager({ freeDiskBytes: 9 * GB });
    const settled = nextError(mm);
    const { downloadId } = await mm.download('unsloth/V-GGUF', visionQuant as any);
    expect(downloadId).toBeTruthy();
    await settled;                     // the fake fetch 500s; the guard is what was tested
  });

  // WHY: charging the whole job for what is already on disk tells the user to delete the very .partial that made it fit.
  it.each([
    ['the PROJECTOR already on disk (3 GB left of 4 GB; 3.4 GB free clears it with the 5% margin)', 'mmproj-F16.gguf', GB, 3.4 * GB],
    ['a half-fetched model file in the folder (1 GB left of 4 GB; 1.2 GB free)', 'V-Q4_K_M.gguf', 3 * GB, 1.2 * GB],
  ])('credits %s', async (_n, file, bytes, free) => {
    sparse(path.join(cacheDir, 'V-Q4_K_M', file), bytes);
    const mm = manager({ freeDiskBytes: free });
    const settled = nextError(mm);
    await expect(mm.download('unsloth/V-GGUF', visionQuant as any)).resolves.toBeTruthy();
    await settled;
  });
});

describe('ModelManager.resume — a vision download resumes into its folder', () => {
  it('reads the manifest INSIDE the folder and keeps the projector on the job', async () => {
    const folder = path.join(cacheDir, 'V-Q4_K_M');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'V-Q4_K_M.gguf.partial'), Buffer.alloc(10));
    writeManifest(path.join(folder, 'V-Q4_K_M.gguf'), {
      repo: 'unsloth/V-GGUF', quant: 'Q4_K_M', files: ['V-Q4_K_M.gguf'], totalSizeBytes: 50,
      visionFile: { path: 'mmproj-F16.gguf', size: 900, sha256: null },
    });
    const mm = manager();
    const settled = nextError(mm);
    await mm.resume('V-Q4_K_M');
    const err = await settled;
    // WHY: dropping visionFile would send the remaining bytes FLAT, beside the folder holding the rest, where the engine serves neither.
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
  sparse(path.join(folder, `${id}.gguf`), weightBytes);
  sparse(path.join(folder, 'mmproj-F16.gguf'), projectorBytes);
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
    // WHY: a projector loads WITH its model and reaches 2.6 GB (five times the working cushion); leaving it out could say a model fits when it does not.
    plantVisionFolder('V-Q4_K_M', 4 * GB, 2 * GB);
    const verdict = await memManager({ totalMemBytes: 16 * GB, availableMemBytes: 5 * GB }).memoryCheck('V-Q4_K_M');
    // Exact string: a substring match on "vision" would stay green if the size were wrong.
    expect(verdict.headline).toContain('4.0 GB model + 2.0 GB vision file');
  });
});

/** A minimal real GGUF v3 header: enough for the reader to answer EXACTLY rather than with a ceiling, the only observable proof the header was read from the right path. */
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
    // WHY: localHeader once built `<cacheDir>/<id>.gguf`, wrong for a vision model; the read throws silently and the KV estimate becomes a ceiling.
    const folder = path.join(cacheDir, 'V-Q4_K_M');
    sparse(path.join(folder, 'V-Q4_K_M.gguf'), miniGguf(), 4 * GB);   // real header, real size, sparse
    sparse(path.join(folder, 'mmproj-F16.gguf'), GB);
    const headline = (await memManager({ totalMemBytes: 16 * GB, availableMemBytes: 4 * GB }).memoryCheck('V-Q4_K_M')).headline;
    expect(headline).not.toContain('up to');
    expect(headline).toContain('4.0 GB model + 1.0 GB vision file');
  });

  it("counts a RESIDENT model's projector in what is already loaded", async () => {
    // WHY: `sizeBytes` is the weights alone, so without the projector term a resident vision model is under-counted by up to 2.6 GB, and that number decides whether the NEXT model is refused.
    plantVisionFolder('R-Q4_K_M', 3 * GB, GB);           // the resident one
    plantVisionFolder('V-Q4_K_M', 4 * GB, 2 * GB);       // the one being checked
    // No engine really runs here, so state the residency directly to exercise the `loaded` branch of loadedBytes.
    const mm = memManager({ totalMemBytes: 64 * GB, availableMemBytes: 4 * GB }, [
      { id: 'R-Q4_K_M', sizeBytes: 3 * GB, loaded: true },
      { id: 'V-Q4_K_M', sizeBytes: 4 * GB, loaded: false },
    ]);
    const loadedGb = (h: string) => Number(/([\d.]+) GB already loaded/.exec(h)![1]);
    const withProjector = loadedGb((await mm.memoryCheck('V-Q4_K_M')).headline);

    // Remove the resident projector and re-ask: an exact delta, because the absolute figure also carries an estimated KV cache.
    fs.rmSync(path.join(cacheDir, 'R-Q4_K_M', 'mmproj-F16.gguf'));
    const withoutProjector = loadedGb((await mm.memoryCheck('V-Q4_K_M')).headline);
    expect(withProjector - withoutProjector).toBeCloseTo(1.0, 5);
  });
});

// "Don't warn me about this model again" is a promise made AT ONE CONTEXT LENGTH (the same model at 4x context needs ~4x memory), so it cannot
// outlive a change to the model's own setting or the engine-wide default it inherits. fit-estimator.test.ts pins the pure function; only these
// reach the engine-wide half, end to end through config.json.

/** A model on disk with a real GGUF header so its context memory is measured. WHY header only (no sparse padding to the model's size): padding
 *  is free on Linux/macOS but Windows CI measured one truncate at 226-3,133 ms, timing out the six-check test at 30 s. */
function plantModel(id: string): void {
  fs.writeFileSync(path.join(cacheDir, `${id}.gguf`), miniGguf());
}

/** A machine with plenty of memory in total but little free (the `tight` tier, the ONLY dismissable verdict). Rebuilt per call: settings are read from config.json at each check. */
function warnMachine(ids: string[], sizeBytes = 8 * GB): ModelManager {
  return memManager({ totalMemBytes: 64 * GB, availableMemBytes: 4 * GB }, ids.map((id) => ({ id, sizeBytes, loaded: false })));
}

/** Write one model's `engine.models` entry, as the settings save will. */
async function writeModelSettings(modelId: string, entry: unknown): Promise<void> {
  await updateEngineConfig(home, { models: { [modelId]: entry } } as any);
}

const dismissedAt = (contextLength: number) => ({ at: 1_757_000_000_000, contextLength });

describe('ModelManager.memoryCheck — the remembered warning', () => {
  it('a dismissal made at 32k silences the warning at 32k', async () => {
    plantModel('M-Q4_K_M');
    // Non-vacuity: this machine really does warn about this model.
    expect((await warnMachine(['M-Q4_K_M']).memoryCheck('M-Q4_K_M')).verdict).toBe('tight');

    await writeModelSettings('M-Q4_K_M', { memoryWarningDismissed: dismissedAt(32768) });
    const after = await warnMachine(['M-Q4_K_M']).memoryCheck('M-Q4_K_M');
    expect(after.verdict).toBe('ok');
    expect(after.headline).toBe('');
  });

  it("raising the ENGINE-WIDE context asks again, though this model's own setting never moved", async () => {
    // WHY: this model is on the engine-wide default, so its own `contextLength` stays null; storing THAT number or a bare timestamp would keep the dismissal alive for a model needing 4x memory.
    plantModel('M-Q4_K_M');
    await writeModelSettings('M-Q4_K_M', {
      contextLength: null, memoryWarningDismissed: dismissedAt(32768),
    });
    expect((await warnMachine(['M-Q4_K_M']).memoryCheck('M-Q4_K_M')).verdict).toBe('ok');

    await updateEngineConfig(home, { contextSize: 131072 });
    const after = await warnMachine(['M-Q4_K_M']).memoryCheck('M-Q4_K_M');
    expect(after.verdict).toBe('tight');
    // Still the same tier at the NEW length (a hard block would pass for an unrelated reason).
    expect(after.headline).toContain('for 128k context');
  });

  it("a model's own context setting moving asks again too", async () => {
    plantModel('M-Q4_K_M');
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
    plantModel('A-Q4_K_M');
    plantModel('B-Q4_K_M');
    await writeModelSettings('A-Q4_K_M', { memoryWarningDismissed: dismissedAt(32768) });
    const mm = warnMachine(['A-Q4_K_M', 'B-Q4_K_M']);
    expect((await mm.memoryCheck('A-Q4_K_M')).verdict).toBe('ok');
    expect((await mm.memoryCheck('B-Q4_K_M')).verdict).toBe('tight');
  });

  it('a too-large model is never silenced — it is a hard block, not a warning', async () => {
    // 8 GB of weights on an 8 GB machine is too large before any context cache, so the KV clamp does not rescue it; RuntimeBinding refuses the session on this verdict.
    plantModel('H-Q4_K_M');
    await writeModelSettings('H-Q4_K_M', { memoryWarningDismissed: dismissedAt(32768) });
    const mm = memManager({ totalMemBytes: 8 * GB, availableMemBytes: 1 * GB }, [{ id: 'H-Q4_K_M', sizeBytes: 8 * GB, loaded: false }]);
    expect((await mm.memoryCheck('H-Q4_K_M')).verdict).toBe('too-large');
  });

  it('a stored dismissal missing EITHER half is no dismissal', async () => {
    // WHY: config.json is hand-editable and older builds wrote it; a record missing its length or time means "ask again", never "assume yes".
    plantModel('M-Q4_K_M');
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
    // Positive control: a well-formed record does go quiet.
    await writeModelSettings('M-Q4_K_M', { memoryWarningDismissed: dismissedAt(32768) });
    expect((await warnMachine(['M-Q4_K_M']).memoryCheck('M-Q4_K_M')).verdict).toBe('ok');
  });
});

describe('ModelManager.addVision — the projector arrives on the ordinary download stream', () => {
  const PROJECTOR = Buffer.from('an-eye-for-this-model');

  /** Serves only the mmproj; anything else is a 404, so re-fetching the already-published WEIGHTS fails loudly. */
  const servingProjector = (async (url: any) => {
    urls.push(String(url));
    if (!String(url).endsWith('mmproj-F16.gguf')) return new Response(null, { status: 404 });
    return new Response(new Blob([PROJECTOR]).stream(), {
      status: 200, headers: { 'content-length': String(PROJECTOR.length) },
    });
  }) as typeof fetch;

  it('moves the model into its folder, fetches the projector beside it, and the row becomes vision-ready', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Eye-Q4_K_M.gguf'), Buffer.alloc(64));
    writeManifest(path.join(cacheDir, 'Eye-Q4_K_M.gguf'), {
      repo: 'unsloth/Eye-GGUF', quant: 'Q4_K_M', files: ['Eye-Q4_K_M.gguf'], totalSizeBytes: 64, completedAt: 2,
      visionFile: { path: 'mmproj-F16.gguf', size: PROJECTOR.length, sha256: null },
    });
    const userData = path.join(root, 'userData');
    const engine = new EngineManager(home, userData, 9999);
    const mm = new ModelManager(home, engine, userData, {
      fetchImpl: servingProjector, totalVramBytes: null, freeDiskBytes: 1_000_000_000,
    });
    const events: DownloadProgress[] = [];
    mm.on('download-progress', (p: DownloadProgress) => events.push(p));
    // The event, not a timer: asserting before the download settles reads green while the work never happened.
    const settled = new Promise<DownloadProgress>((resolve) => {
      mm.on('download-progress', (p: DownloadProgress) => {
        if (p.state === 'done' || p.state === 'error') resolve(p);
      });
    });

    const { downloadId } = await mm.addVision('Eye-Q4_K_M');
    const last = await settled;

    expect(last.state).toBe('done');
    expect(last.downloadId).toBe(downloadId);
    expect(events.every((e) => e.repo === 'unsloth/Eye-GGUF' && e.quant === 'Q4_K_M')).toBe(true);
    expect(events.some((e) => e.state === 'downloading')).toBe(true);
    // Only the projector is fetched: the weights were already published.
    expect(urls).toEqual(['https://huggingface.co/unsloth/Eye-GGUF/resolve/main/mmproj-F16.gguf']);
    // The folder holds both files and the flat copy is gone, so the engine has no pair to pick between.
    expect(fs.existsSync(path.join(cacheDir, 'Eye-Q4_K_M.gguf'))).toBe(false);
    expect(fs.readFileSync(path.join(cacheDir, 'Eye-Q4_K_M', 'mmproj-F16.gguf'))).toEqual(PROJECTOR);
    expect(fs.existsSync(path.join(cacheDir, 'Eye-Q4_K_M', 'Eye-Q4_K_M.gguf'))).toBe(true);
    const rows = await engine.installedModels();
    expect(rows.map((r) => [r.id, r.status, r.vision]))
      .toEqual([['Eye-Q4_K_M', 'complete', 'ready']]);
  });
});
