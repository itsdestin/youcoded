import { remotePlaceHost } from './remote-place';

interface RecoveryDraft { text: string; attachments?: string[]; mtimeMs?: number | null; name?: string }
const PREFIX = 'youcoded-draft-v1:';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const MAX_CHARS = 2_250_000; // below the usual 5 MiB UTF-16 storage quota
const MAX_ENTRIES = 32;
const pending = new Map<string, RecoveryDraft>();
let timer: ReturnType<typeof setTimeout> | undefined;
let listening = false;
const keyFor = (key: string) => `${PREFIX}${encodeURIComponent(remotePlaceHost())}:${key}`;

function valid(value: unknown): value is RecoveryDraft {
  if (!value || typeof value !== 'object') return false;
  const d = value as RecoveryDraft;
  return typeof d.text === 'string'
    && (d.attachments === undefined || (Array.isArray(d.attachments) && d.attachments.length <= 100 && d.attachments.every((p) => typeof p === 'string')))
    && (d.mtimeMs === undefined || d.mtimeMs === null || (typeof d.mtimeMs === 'number' && Number.isFinite(d.mtimeMs)))
    && (d.name === undefined || typeof d.name === 'string');
}

/** Per-window storage survives the renderer; nothing is shared with another window or sent. */
export function readRecoveryDraft(key: string): RecoveryDraft | null {
  try {
    const full = keyFor(key);
    const queued = pending.get(full);
    if (queued) return queued;
    const raw = window.sessionStorage.getItem(full);
    if (!raw || raw.length > MAX_CHARS) return null;
    const record = JSON.parse(raw);
    if (record.v === 1 && typeof record.at === 'number' && Date.now() - record.at <= MAX_AGE && valid(record.draft)) return record.draft;
    window.sessionStorage.removeItem(full);
  } catch { /* denied or damaged storage must not stop editing */ }
  return null;
}

export function clearRecoveryDraft(key: string): void {
  try {
    const full = keyFor(key);
    pending.delete(full); // WHY: a delayed write must not resurrect a submitted/discarded draft.
    window.sessionStorage.removeItem(full);
  } catch { /* editing still works without browser storage */ }
}

export function writeRecoveryDraft(key: string, draft: RecoveryDraft): void {
  // Empty composer means sent/cleared; an empty file draft can mean select-all/delete.
  if (!key.startsWith('file:') && !draft.text && !draft.attachments?.length) { clearRecoveryDraft(key); return; }
  try {
    pending.set(keyFor(key), draft);
    if (!listening) { window.addEventListener('pagehide', flushRecoveryDrafts); listening = true; }
    // WHY: no storage serialization on every keystroke; at most one small batch per 250 ms.
    if (!timer) timer = setTimeout(flushRecoveryDrafts, 250);
  } catch { /* no window/storage in an unavailable browser context */ }
}

export function flushRecoveryDrafts(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  for (const [key, draft] of pending) {
    try {
      const store = window.sessionStorage;
      const record = JSON.stringify({ v: 1, at: Date.now(), draft });
      if (record.length > MAX_CHARS) continue;
      const older: Array<{ key: string; at: number; size: number }> = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (!k?.startsWith(PREFIX) || k === key) continue;
        const raw = store.getItem(k) ?? '';
        let at = 0;
        try { at = JSON.parse(raw).at ?? 0; } catch { /* discard malformed records first */ }
        older.push({ key: k, at, size: raw.length + k.length });
      }
      older.sort((a, b) => a.at - b.at);
      let size = record.length + key.length + older.reduce((n, r) => n + r.size, 0);
      while (older.length && (size > MAX_CHARS || older.length >= MAX_ENTRIES || Date.now() - older[0].at > MAX_AGE)) {
        const removed = older.shift()!;
        store.removeItem(removed.key);
        size -= removed.size;
      }
      store.setItem(key, record);
    } catch { /* quota/private mode: keep the existing in-memory editor behavior */ }
  }
  pending.clear();
}
