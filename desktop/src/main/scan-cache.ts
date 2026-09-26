// A remembered answer per conversation file, kept across app restarts.
//
// WHY (2026-09-26): every Resume open read the head of every conversation file —
// 1,018 native session files and 1,096 Claude Code transcripts on a big history —
// and nothing survived a restart, so the FIRST open after launch (the one people
// notice) always paid in full: measured 3–4 s. A file whose size and modified time
// are unchanged holds the same answer, so the answer is kept on disk beside the
// app's other private state and reused until the file changes.
//
// It is only ever a cache: a missing, corrupt or foreign-version file is ignored
// and rebuilt; two app copies sharing one home (the dev instance and the built
// app) may overwrite each other's copy, which costs a re-read, never a wrong row,
// because every entry is checked against the file's CURRENT size and time.
import fs from 'fs';
import path from 'path';

interface Entry<V> { size: number; mtimeMs: number; v: V }
interface OnDisk<V> { schema: number; entries: Record<string, Entry<V>> }

const SAVE_DELAY_MS = 2000;

export interface ScanCache<V> {
  /** The remembered value for this file, or undefined when it changed or was never seen. */
  get(key: string, stat: { size: number; mtimeMs: number }): Promise<V | undefined>;
  set(key: string, stat: { size: number; mtimeMs: number }, v: V): void;
  /** Forget files a full scan no longer found, then write the cache out soon. */
  prune(seen: Set<string>): void;
  /** Write now if anything changed (tests; shutdown is not required — a lost save is a re-read). */
  flush(): Promise<void>;
}

export function createScanCache<V>(file: string, schema: number): ScanCache<V> {
  let map: Map<string, Entry<V>> | null = null;
  let loading: Promise<Map<string, Entry<V>>> | null = null;
  let dirty = false;
  let timer: NodeJS.Timeout | null = null;
  let saving: Promise<void> = Promise.resolve();

  const load = () => {
    loading ??= fs.promises.readFile(file, 'utf8').then((raw) => {
      const parsed = JSON.parse(raw) as OnDisk<V>;
      if (parsed?.schema !== schema || !parsed.entries || typeof parsed.entries !== 'object') return new Map();
      return new Map(Object.entries(parsed.entries));
    }).catch(() => new Map<string, Entry<V>>()).then((m) => (map = m));
    return loading;
  };

  const save = async () => {
    if (!dirty || !map) return;
    dirty = false;
    const body: OnDisk<V> = { schema, entries: Object.fromEntries(map) };
    // tmp + rename: a reader (another app copy) never sees a half-written file.
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      // Only the cache folder itself is created — never its parents. The app's
      // private home always exists; a home that has gone (a finished test's
      // temp folder) must not be recreated by a late save.
      await fs.promises.mkdir(path.dirname(file)).catch((e) => { if (e?.code !== 'EEXIST') throw e; });
      await fs.promises.writeFile(tmp, JSON.stringify(body));
      await fs.promises.rename(tmp, file);
    } catch {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
  };

  const scheduleSave = () => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; saving = saving.then(save); }, SAVE_DELAY_MS);
    timer.unref?.();
  };

  return {
    async get(key, stat) {
      const m = map ?? await load();
      const e = m.get(key);
      return e && e.size === stat.size && e.mtimeMs === stat.mtimeMs ? e.v : undefined;
    },
    set(key, stat, v) {
      if (!map) return; // only after a load — never clobber an unread file with a partial map
      map.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, v });
      scheduleSave();
    },
    prune(seen) {
      if (!map) return;
      let removed = false;
      for (const k of map.keys()) if (!seen.has(k)) { map.delete(k); removed = true; }
      if (removed) scheduleSave();
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      saving = saving.then(save);
      await saving;
    },
  };
}
