import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { ModelDownloader } from '../src/main/models/model-downloader';
import type { DownloadProgress, QuantOption } from '../src/shared/model-manager-types';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const PART1 = Buffer.from('part-one-bytes');
const PART2 = Buffer.from('part-two-bytes!!');
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** Serves resolve URLs by trailing filename, honoring Range. */
function fetchServing(bodies: Record<string, Buffer>): typeof fetch {
  return (async (url: any, init?: any) => {
    const name = decodeURIComponent(String(url).split('/').pop()!);
    const buf = bodies[name];
    if (!buf) return new Response(null, { status: 404 });
    let start = 0;
    const range = init?.headers?.Range as string | undefined;
    if (range) start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
    const body = buf.subarray(start);
    return new Response(new Blob([body]).stream(), {
      status: start > 0 ? 206 : 200,
      headers: { 'content-length': String(body.length) },
    });
  }) as typeof fetch;
}

function quantOpt(withSha = true): QuantOption {
  return {
    quant: 'UD-Q4_K_XL', description: 'x',
    files: ['sub/M-UD-Q4_K_XL-00001-of-00002.gguf', 'sub/M-UD-Q4_K_XL-00002-of-00002.gguf'],
    totalSizeBytes: PART1.length + PART2.length,
    sha256ByFile: {
      'sub/M-UD-Q4_K_XL-00001-of-00002.gguf': withSha ? sha(PART1) : null,
      'sub/M-UD-Q4_K_XL-00002-of-00002.gguf': withSha ? sha(PART2) : null,
    },
  };
}
const bodies = {
  'M-UD-Q4_K_XL-00001-of-00002.gguf': PART1,
  'M-UD-Q4_K_XL-00002-of-00002.gguf': PART2,
};

describe('ModelDownloader', () => {
  it('downloads all parts FLAT into the cache dir (basenames), verifies sha256, reports done', async () => {
    const dl = new ModelDownloader(dir, fetchServing(bodies));
    const events: DownloadProgress[] = [];
    const id = dl.start('unsloth/M-GGUF', quantOpt(), (p) => events.push(p));
    await dl.wait(id);
    // Flat basenames → cache-scan/router discovery sees them (Plan B convention).
    expect(fs.readFileSync(path.join(dir, 'M-UD-Q4_K_XL-00001-of-00002.gguf'))).toEqual(PART1);
    expect(fs.readFileSync(path.join(dir, 'M-UD-Q4_K_XL-00002-of-00002.gguf'))).toEqual(PART2);
    const last = events[events.length - 1];
    expect(last.state).toBe('done');
    expect(last.receivedBytes).toBe(PART1.length + PART2.length);
    expect(events.some((e) => e.state === 'verifying')).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.partial'))).toEqual([]);
  });

  it('resumes a part from its .partial file via Range', async () => {
    fs.writeFileSync(path.join(dir, 'M-UD-Q4_K_XL-00001-of-00002.gguf.partial'), PART1.subarray(0, 5));
    const fetchImpl = vi.fn(fetchServing(bodies));
    const dl = new ModelDownloader(dir, fetchImpl as any);
    const id = dl.start('unsloth/M-GGUF', quantOpt(), () => {});
    await dl.wait(id);
    expect(fs.readFileSync(path.join(dir, 'M-UD-Q4_K_XL-00001-of-00002.gguf'))).toEqual(PART1);
    const firstCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('00001'));
    expect((firstCall![1] as any).headers.Range).toBe('bytes=5-');
  });

  it('sha256 mismatch → error state, bad file deleted, nothing published', async () => {
    const bad = quantOpt();
    bad.sha256ByFile['sub/M-UD-Q4_K_XL-00001-of-00002.gguf'] = '0'.repeat(64);
    const dl = new ModelDownloader(dir, fetchServing(bodies));
    const events: DownloadProgress[] = [];
    const id = dl.start('unsloth/M-GGUF', bad, (p) => events.push(p));
    await expect(dl.wait(id)).rejects.toThrow(/integrity/);
    expect(events[events.length - 1].state).toBe('error');
    expect(fs.existsSync(path.join(dir, 'M-UD-Q4_K_XL-00001-of-00002.gguf'))).toBe(false);
  });

  it('cancel: stops the stream, emits cancelled, KEEPS the .partial for resume', async () => {
    // A fetch whose body streams 4 bytes every 20ms until the abort signal
    // fires. The fake MUST honor init.signal (K3) — real fetch rejects the
    // in-flight read on abort; without this the loop never breaks and the test
    // hangs to timeout instead of asserting cancellation.
    const fetchImpl = (async (_url: any, init?: any) => {
      const signal: AbortSignal = init.signal;
      return new Response(new ReadableStream({
        pull(c) {
          if (signal.aborted) { c.error(new DOMException('Aborted', 'AbortError')); return; }
          c.enqueue(new Uint8Array(4));
          return new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 20);
            signal.addEventListener('abort',
              () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); },
              { once: true });
          });
        },
      }), { status: 200, headers: { 'content-length': '99999' } });
    }) as any;
    const dl = new ModelDownloader(dir, fetchImpl);
    const events: DownloadProgress[] = [];
    const id = dl.start('unsloth/M-GGUF', quantOpt(false), (p) => events.push(p));
    await new Promise((r) => setTimeout(r, 60));
    dl.cancel(id);
    await expect(dl.wait(id)).rejects.toThrow(/cancel/i);
    expect(events[events.length - 1].state).toBe('cancelled');
    expect(fs.existsSync(path.join(dir, 'M-UD-Q4_K_XL-00001-of-00002.gguf.partial'))).toBe(true);
  });

  it('refuses a second concurrent download of the same repo+quant', async () => {
    const dl = new ModelDownloader(dir, fetchServing(bodies));
    const id = dl.start('unsloth/M-GGUF', quantOpt(), () => {});
    expect(() => dl.start('unsloth/M-GGUF', quantOpt(), () => {})).toThrow(/already/i);
    await dl.wait(id);
  });

  // A fetch that drips bytes until the abort signal fires. Copied from the
  // cancel test above for the same reason it exists there: a fake that never
  // resolves cannot be cancelled, and the test hangs to timeout instead of
  // asserting anything.
  const dripUntilAbort = (async (_url: any, init?: any) => {
    const signal: AbortSignal = init.signal;
    return new Response(new ReadableStream({
      pull(c) {
        if (signal.aborted) { c.error(new DOMException('Aborted', 'AbortError')); return; }
        c.enqueue(new Uint8Array(4));
        return new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 20);
          signal.addEventListener('abort',
            () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); },
            { once: true });
        });
      },
    }), { status: 200, headers: { 'content-length': '99999' } });
  }) as typeof fetch;
  const MANIFEST = 'M-UD-Q4_K_XL-00001-of-00002.gguf.download.json';

  it('writes the manifest BEFORE the first byte, and STAMPS it on clean completion', async () => {
    const seen: string[] = [];
    const watching: typeof fetch = (async (url: any, init?: any) => {
      // Record whether the manifest already exists at the moment of each fetch.
      seen.push(fs.existsSync(path.join(dir, MANIFEST)) ? 'yes' : 'no');
      return fetchServing(bodies)(url, init);
    }) as typeof fetch;
    const dl = new ModelDownloader(dir, watching);
    const id = dl.start('unsloth/M-GGUF', quantOpt(), () => {});
    await dl.wait(id);
    expect(seen).toEqual(['yes', 'yes']);   // present for every part's fetch
    // Was: the manifest was DELETED here. It now survives, carrying the repo
    // and (later) the vision projector a finished model still needs — and
    // completedAt is what marks it finished.
    expect(fs.existsSync(path.join(dir, MANIFEST))).toBe(true);
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    expect(typeof m.completedAt).toBe('number');
    expect(m.repo).toBe('unsloth/M-GGUF');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a re-download of a FINISHED model keeps its vision file and is in flight again', async () => {
    const dl = new ModelDownloader(dir, fetchServing(bodies));
    await dl.wait(dl.start('unsloth/M-GGUF', quantOpt(), () => {}));
    // Stand in for the vision projector §E1 will record on the finished download.
    const done = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    done.visionFile = { path: 'mmproj-F16.gguf', size: 900, sha256: null };
    fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(done));
    // Delete the published parts, the way the user would before fetching again.
    for (const n of Object.keys(bodies)) fs.rmSync(path.join(dir, n));

    await dl.wait(dl.start('unsloth/M-GGUF', quantOpt(), () => {}));
    const after = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    expect(after.visionFile).toEqual({ path: 'mmproj-F16.gguf', size: 900, sha256: null });
    expect(typeof after.completedAt).toBe('number');   // it finished again
  });

  it('a FINISHED download from another repo is not "already partly downloaded"', async () => {
    // The old guard fired on the manifest's mere presence. A stamped manifest
    // means the bytes on disk are WHOLE, so there is no half-fetched file to
    // protect — the user may take the same filename from a different publisher.
    const dl = new ModelDownloader(dir, fetchServing(bodies));
    await dl.wait(dl.start('unsloth/M-GGUF', quantOpt(), () => {}));
    let second = '';
    expect(() => { second = dl.start('bartowski/M-GGUF', quantOpt(), () => {}); }).not.toThrow();
    await dl.wait(second);
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    expect(m.repo).toBe('bartowski/M-GGUF');
    expect(m.visionFile).toBeUndefined();   // and it inherits nothing from unsloth
  });

  it('an untraceable record (repo: null) blocks nothing', async () => {
    // §E3 writes this when it cannot work out where a pre-existing model came
    // from. It is not a rival publisher, so the same-filename guard must ignore it.
    fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify({
      v: 1, repo: null, quant: 'UD-Q4_K_XL', files: quantOpt().files,
      totalSizeBytes: 30, sha256ByFile: {}, startedAt: 1,
    }));
    const dl = new ModelDownloader(dir, fetchServing(bodies));
    let id = '';
    expect(() => { id = dl.start('unsloth/M-GGUF', quantOpt(), () => {}); }).not.toThrow();
    // Awaited, not fire-and-forget: the fixture dir is deleted in afterEach, and
    // a download still writing into it fails as an unhandled rejection.
    await dl.wait(id);
  });

  it('keeps the manifest when the download is cancelled — that is what makes resume possible', async () => {
    const dl = new ModelDownloader(dir, dripUntilAbort);
    const id = dl.start('unsloth/M-GGUF', quantOpt(false), () => {});
    await new Promise((r) => setTimeout(r, 60));
    dl.cancel(id);
    await dl.wait(id).catch(() => {});
    expect(fs.existsSync(path.join(dir, MANIFEST))).toBe(true);
  });

  it('keeps the manifest when the download errors', async () => {
    const dead: typeof fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    const dl = new ModelDownloader(dir, dead);
    const id = dl.start('unsloth/M-GGUF', quantOpt(), () => {});
    await dl.wait(id).catch(() => {});
    expect(fs.existsSync(path.join(dir, MANIFEST))).toBe(true);
  });

  it('records the repo and the whole file set, so resume needs no network', async () => {
    const dead: typeof fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    const dl = new ModelDownloader(dir, dead);
    const id = dl.start('unsloth/M-GGUF', quantOpt(), () => {});
    await dl.wait(id).catch(() => {});
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    expect(m.repo).toBe('unsloth/M-GGUF');
    expect(m.quant).toBe('UD-Q4_K_XL');
    expect(m.files).toEqual(quantOpt().files);
    expect(m.totalSizeBytes).toBe(quantOpt().totalSizeBytes);
  });

  it('refuses to continue a file that a DIFFERENT repo left behind', async () => {
    // Six+ Hugging Face accounts publish byte-identical filenames with different
    // builds (spec §1b). Range-continuing repo A's bytes with repo B's would
    // only be discovered when the integrity check fails at the very end.
    const dead: typeof fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    const dl = new ModelDownloader(dir, dead);
    const id = dl.start('unsloth/M-GGUF', quantOpt(), () => {});
    await dl.wait(id).catch(() => {});
    expect(() => dl.start('bartowski/M-GGUF', quantOpt(), () => {}))
      .toThrow(/already partly downloaded from unsloth\/M-GGUF/);
    // The same repo may continue. Awaited (not fire-and-forget) because the
    // dead fetch rejects, and an unawaited rejection here surfaces as an
    // unhandled error that fails the whole run.
    let second = '';
    expect(() => { second = dl.start('unsloth/M-GGUF', quantOpt(), () => {}); }).not.toThrow();
    await dl.wait(second).catch(() => {});
  });
});

// ── A vision model downloads BOTH files, in one job, into one folder (§E2) ──
// Contract R3: a model with a vision file "always downloads its vision file;
// there is no switch to skip it". One downloadId, totalBytes summed over the
// pair, both files into <cacheDir>/<id>/ — which is the only layout in which
// llama-server pairs them (probed on b10665, 2026-09-05).

const MMPROJ = Buffer.from('mmproj-bytes-here!');

/** A single-file vision quant. `<cacheDir>/V-Q4_K_M/` is where it must land. */
function visionQuant(): QuantOption {
  return {
    quant: 'Q4_K_M', description: 'x',
    files: ['V-Q4_K_M.gguf'],
    totalSizeBytes: PART1.length,
    sha256ByFile: { 'V-Q4_K_M.gguf': sha(PART1) },
    visionBytes: MMPROJ.length,
    visionFile: { path: 'mmproj-F16.gguf', size: MMPROJ.length, sha256: sha(MMPROJ) },
  };
}
const visionBodies = { 'V-Q4_K_M.gguf': PART1, 'mmproj-F16.gguf': MMPROJ };
const folder = () => path.join(dir, 'V-Q4_K_M');

describe('ModelDownloader — the vision folder', () => {
  it('fetches weights AND projector in ONE job, into the folder, with both sizes in the total', async () => {
    const dl = new ModelDownloader(dir, fetchServing(visionBodies));
    const events: DownloadProgress[] = [];
    const id = dl.start('unsloth/V-GGUF', visionQuant(), (p) => events.push(p));
    await dl.wait(id);

    expect(fs.readFileSync(path.join(folder(), 'V-Q4_K_M.gguf'))).toEqual(PART1);
    expect(fs.readFileSync(path.join(folder(), 'mmproj-F16.gguf'))).toEqual(MMPROJ);
    // Nothing flat: a stray copy beside the folder would WIN the id and hide
    // the paired one from the engine entirely.
    expect(fs.readdirSync(dir)).toEqual(['V-Q4_K_M']);

    // ONE download id across both legs, and one percentage that covers both.
    expect(new Set(events.map((e) => e.downloadId))).toEqual(new Set([id]));
    const last = events[events.length - 1];
    expect(last.state).toBe('done');
    expect(last.totalBytes).toBe(PART1.length + MMPROJ.length);
    expect(last.receivedBytes).toBe(PART1.length + MMPROJ.length);
    expect(last.parts).toBe(2);
    expect(fs.readdirSync(folder()).filter((f) => f.endsWith('.partial'))).toEqual([]);
  });

  it('writes visionFile into the manifest — the only thing that can reach the Add-vision state', async () => {
    // T15 handoff 1: writeManifest used to carry a projector forward only from
    // a PRIOR manifest, so a first-ever download of a vision repo recorded none
    // and `vision: 'available'` was unreachable for the life of that model.
    const dl = new ModelDownloader(dir, fetchServing(visionBodies));
    await dl.wait(dl.start('unsloth/V-GGUF', visionQuant(), () => {}));
    const written = JSON.parse(
      fs.readFileSync(path.join(folder(), 'V-Q4_K_M.gguf.download.json'), 'utf8'));
    expect(written.visionFile).toEqual({ path: 'mmproj-F16.gguf', size: MMPROJ.length, sha256: sha(MMPROJ) });
    expect(typeof written.completedAt).toBe('number');
    // NOT a member of `files`: several readers judge "this download finished"
    // from that list alone, and a projector in it would make a half-fetched one
    // read as a published part.
    expect(written.files).toEqual(['V-Q4_K_M.gguf']);
  });

  it('a failed projector leg leaves the MODEL complete, and says so', async () => {
    const dl = new ModelDownloader(dir, fetchServing({ 'V-Q4_K_M.gguf': PART1 })); // no projector served
    const events: DownloadProgress[] = [];
    const id = dl.start('unsloth/V-GGUF', visionQuant(), (p) => events.push(p));
    await expect(dl.wait(id)).rejects.toThrow();

    // The weights are published and the manifest is stamped: this model works.
    expect(fs.readFileSync(path.join(folder(), 'V-Q4_K_M.gguf'))).toEqual(PART1);
    const written = JSON.parse(
      fs.readFileSync(path.join(folder(), 'V-Q4_K_M.gguf.download.json'), 'utf8'));
    expect(typeof written.completedAt).toBe('number');
    expect(written.visionFile.path).toBe('mmproj-F16.gguf');   // -> vision: 'available'

    // The message forwards the REAL failure and adds only what the user cannot
    // see — that the model itself arrived. Exact string: a substring match here
    // would stay green if the wrapper were dropped and the bare HTTP error
    // shown on a model that actually works.
    const last = events[events.length - 1];
    expect(last.state).toBe('error');
    expect(last.message).toBe(
      'The model downloaded, but its vision file did not: Hugging Face responded with HTTP 404. '
      + "You can add it later from the model's row in Local Models.");
  });

  it('closes an unpunctuated error before continuing the sentence', async () => {
    // Node's own network failures read "socket hang up" — no full stop — and the
    // wrapper adds a sentence after it. Without this the user reads a run-on.
    const rude = (async (url: any) => {
      if (String(url).includes('mmproj')) throw new Error('socket hang up');
      return new Response(new Blob([PART1]).stream(), { status: 200 });
    }) as typeof fetch;
    const dl = new ModelDownloader(dir, rude);
    const events: DownloadProgress[] = [];
    const id = dl.start('unsloth/V-GGUF', { ...visionQuant(), sha256ByFile: { 'V-Q4_K_M.gguf': null } }, (p) => events.push(p));
    await expect(dl.wait(id)).rejects.toThrow();
    expect(events[events.length - 1].message).toBe(
      'The model downloaded, but its vision file did not: socket hang up. '
      + "You can add it later from the model's row in Local Models.");
  });

  it('a failed WEIGHTS leg reports the real error unwrapped', async () => {
    // The wrapper must not creep onto failures that are not the projector's:
    // "the model downloaded" would be a lie here.
    const dl = new ModelDownloader(dir, fetchServing({ 'mmproj-F16.gguf': MMPROJ }));
    const events: DownloadProgress[] = [];
    const id = dl.start('unsloth/V-GGUF', visionQuant(), (p) => events.push(p));
    await expect(dl.wait(id)).rejects.toThrow();
    const last = events[events.length - 1];
    expect(last.state).toBe('error');
    expect(last.message).toBe('Hugging Face responded with HTTP 404.');
  });

  // ── The flat/folder name collision, refused from BOTH ends ────────────────
  // `<cacheDir>/X.gguf` and `<cacheDir>/X/` are ONE model id to the engine: it
  // serves one of the two and silently drops the other, and WHICH ONE IS NOT
  // PREDICTABLE (probed on b10665, 2026-09-05 — the same pair created in
  // opposite orders gave opposite winners on one server). The pair also puts two
  // rows with the same id in Local Models, where one absorbs the other's
  // progress and Delete removes only one of them. It can be created from either
  // end, so both ends refuse.

  it('refuses a folder download when the model is already installed FLAT', async () => {
    fs.writeFileSync(path.join(dir, 'V-Q4_K_M.gguf'), PART1);
    const dl = new ModelDownloader(dir, fetchServing(visionBodies));
    // Exact string, and it LEADS WITH DELETE on purpose: "Add vision" only
    // appears on a row whose manifest names a projector, and every download made
    // before this feature has no manifest at all — so pointing at that link
    // first would tell some users to click something that is not on the row.
    expect(() => dl.start('unsloth/V-GGUF', visionQuant(), () => {})).toThrow(
      'V-Q4_K_M.gguf is already downloaded without its vision file. '
      + 'Delete it in Local Models and download it again. '
      + 'If its row offers "Add vision", that adds the vision file on its own and keeps the model you have.');
    expect(fs.existsSync(folder())).toBe(false);
  });

  it('refuses a TEXT-ONLY download when that filename is already a vision folder', async () => {
    // Publisher A ships this filename with an mmproj (so it lives in a folder);
    // publisher B ships the same filename without one (so it would land flat).
    // The flat path cannot even SEE the folder's manifest — it is inside the
    // folder — so the different-publisher guard never fires for this pair.
    fs.mkdirSync(folder(), { recursive: true });
    fs.writeFileSync(path.join(folder(), 'V-Q4_K_M.gguf'), PART1);
    const textOnly = { ...visionQuant(), visionBytes: undefined, visionFile: undefined };
    const dl = new ModelDownloader(dir, fetchServing(visionBodies));
    expect(() => dl.start('other/V-GGUF', textOnly as any, () => {})).toThrow(
      'V-Q4_K_M.gguf is already downloaded as a model that can see images. '
      + 'Delete it in Local Models and download it again. '
      + 'If its row offers "Add vision", that adds the vision file on its own and keeps the model you have.');
    // Nothing flat was created, and no manifest was written beside it.
    expect(fs.readdirSync(dir)).toEqual(['V-Q4_K_M']);
  });

  it('a same-named FILE, not a directory, does not trip the folder guard', async () => {
    // The guard tests for a DIRECTORY at `<cacheDir>/V-Q4_K_M`. A file of that
    // exact name (no .gguf) is junk, not a model folder, and must not block a
    // legitimate download.
    fs.writeFileSync(path.join(dir, 'V-Q4_K_M'), 'not a folder');
    const textOnly = { ...visionQuant(), visionBytes: undefined, visionFile: undefined };
    const dl = new ModelDownloader(dir, fetchServing(visionBodies));
    await dl.wait(dl.start('other/V-GGUF', textOnly as any, () => {}));
    expect(fs.readFileSync(path.join(dir, 'V-Q4_K_M.gguf'))).toEqual(PART1);
  });

  it('resumes into the SAME folder, crediting the projector already fetched', async () => {
    fs.mkdirSync(folder(), { recursive: true });
    fs.writeFileSync(path.join(folder(), 'V-Q4_K_M.gguf'), PART1);
    fs.writeFileSync(path.join(folder(), 'mmproj-F16.gguf.partial'), MMPROJ.subarray(0, 6));
    const fetchImpl = vi.fn(fetchServing(visionBodies));
    const dl = new ModelDownloader(dir, fetchImpl as any);
    await dl.wait(dl.start('unsloth/V-GGUF', visionQuant(), () => {}));
    expect(fs.readFileSync(path.join(folder(), 'mmproj-F16.gguf'))).toEqual(MMPROJ);
    const projectorCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('mmproj'));
    expect((projectorCall![1] as any).headers.Range).toBe('bytes=6-');
  });
});
