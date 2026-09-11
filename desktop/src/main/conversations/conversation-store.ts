// IO shell for Conversation Store records (Phase 2a design §1). All disk access
// for records lives HERE; every DECISION (what a merge resolves to, what a
// conflict copy folds to) lives in store-core.ts (pure). This is the same
// pure-core / IO-shell split used by local-theme-synthesizer.ts.
//
// Records are one-file-per-conversation so the sync engine's generic
// conflict-copy policy stays out of our way (design decision 6) — and the
// healer below cleans up the rare record-level conflict copies it does produce.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mutateFileUnderLock } from '../artifacts/cas-write';
import {
  ConversationRecord,
  RECORD_SCHEMA_VERSION,
  parseRecord,
  mergeRecords,
  isConflictCopyName,
  extractConflictBase,
  foldConflictCopies,
  FlagState,
  PortableModelRef,
} from './store-core';

export interface ConversationStore {
  upsert(partial: UpsertInput): Promise<ConversationRecord>;
  get(provider: string, id: string): Promise<ConversationRecord | null>;
  list(provider: string): Promise<ConversationRecord[]>;
  setFlag(provider: string, id: string, flag: string, value: boolean): Promise<void>;
  setTitle(provider: string, id: string, title: string): Promise<void>;
  setNote(provider: string, id: string, note: string): Promise<void>;
  remove(provider: string, id: string): Promise<boolean>;
  root(): string;
}

// The activity/metadata fields a caller can supply. `lastActive` decides how
// the merge RANKS the two sides (omit it for metadata-only upserts so they
// never masquerade as fresh activity) — but caller-provided metadata fields
// (projectName / originalPath / title / transcriptRef) are LOCAL TRUTH and
// always land regardless of merge ranking: the merge exists for cross-device
// convergence, not for arguing with the caller. `lastActive`/`device` are
// activity-coupled and stay merge-decided (a caller with newer activity lands
// them via the merge anyway).
export interface UpsertInput {
  id: string;
  provider: string;
  projectName?: string;
  originalPath?: string;
  title?: string;
  lastActive?: string;   // ISO — REQUIRED for activity updates; omitted for metadata-only
  device?: string;
  transcriptRef?: string;
  // Portable model reference (store-core.ts). An explicit local observation
  // lands post-merge without fabricating activity. Cross-device mergeRecords
  // ranking is unchanged. noteModelUsed must never seed a model-only record.
  lastUsedModel?: PortableModelRef;
}

// Epoch sentinel for lastActive on metadata-only seeds. Date.parse maps it to 0,
// so a seed always LOSES a "newest wins" merge against any real turn — a flag
// set before the first turn can never fabricate activity that outranks it.
const EPOCH = '1970-01-01T00:00:00.000Z';

// Quarantine marker the healer appends when it atomically CLAIMS a conflict
// copy (see heal()). Files carrying it are healer-private intermediates.
const HEALING_MARKER = '.healing-';

function originalConflictName(name: string): string {
  // WHY: device labels may contain the marker. Discovery and healing must
  // agree: only strip a claim suffix after the original record extension.
  if (isConflictCopyName(name)) return name;
  const h = name.lastIndexOf('.json' + HEALING_MARKER);
  return h < 0 ? name : name.slice(0, h + 5);
}

// SECURITY (review fix 1): `provider` and `id` become path segments, and this
// store sits near IPC/remote surfaces, so raw strings could traverse out of the
// store root ('../../escape'). Allowlist charset — letters, digits, dot,
// underscore, hyphen — contains no separators and no NUL; '.' and '..' are
// rejected exactly. CC ids are UUIDs, which pass untouched. Same house pattern
// as the artifacts GET/SAVE root-escape refusal.
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
// Windows reserved device names pass the charset check but map to DEVICES on
// older Windows ('con.json' → the console). Mirrors the module-private
// WINDOWS_RESERVED in sync-spaces/guards.ts:5 — keep the two in sync.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const isSafeSegment = (s: string) =>
  SAFE_SEGMENT_RE.test(s) && s !== '.' && s !== '..' && !WINDOWS_RESERVED.test(s);

export function createConversationStore(conversationsRoot: string): ConversationStore {
  const rootResolved = path.resolve(conversationsRoot);

  // Resolve <root>/<provider>, refusing anything that escapes the root.
  // The resolve+startsWith check is defense-in-depth behind the charset guard —
  // both must hold for a path to be used.
  function providerDir(provider: string): string {
    const dir = path.resolve(rootResolved, provider);
    if (!isSafeSegment(provider) || !dir.startsWith(rootResolved + path.sep)) {
      throw new Error(`conversation-store: invalid provider '${provider}'`);
    }
    return dir;
  }

  // Resolve <root>/<provider>/<id>.json with the same escape refusal for id.
  function recordPath(provider: string, id: string): string {
    const dir = providerDir(provider);
    const target = path.resolve(dir, `${id}.json`);
    if (!isSafeSegment(id) || !target.startsWith(dir + path.sep)) {
      throw new Error(`conversation-store: invalid conversation id '${id}'`);
    }
    return target;
  }

  // Build a full record from a partial. Missing string fields default to '' so
  // a record on disk never carries undefined. `lastActive` defaults to EPOCH
  // (see above) so metadata-only partials don't outrank real activity, and
  // `createdAt` is anchored to the supplied activity when present, else "now"
  // (a fresh conversation is born when we first see it).
  function toRecord(p: UpsertInput): ConversationRecord {
    const la = p.lastActive ?? EPOCH;
    return {
      schema: RECORD_SCHEMA_VERSION,
      id: p.id,
      provider: p.provider,
      projectName: p.projectName ?? '',
      originalPath: p.originalPath ?? '',
      title: p.title ?? '',
      lastActive: la,
      device: p.device ?? '',
      flags: {},
      transcriptRef: p.transcriptRef ?? '',
      createdAt: p.lastActive ?? new Date().toISOString(),
      note: '',
      noteUpdatedAt: p.lastActive ?? new Date().toISOString(),
      // Conditional: an absent lastUsedModel must leave the key OFF the fresh
      // record (matches parseRecord's absent-key convention), not `undefined`.
      ...(p.lastUsedModel ? { lastUsedModel: p.lastUsedModel } : {}),
    };
  }

  // Read-modify-write one record file atomically. The callback sees the parsed
  // on-disk record (null when absent) and returns the record to persist.
  //
  // mutateFileUnderLock gives read-modify-write atomicity under a mkdir lock:
  // the dev instance and the built app both point at the same ~/YouCoded, so
  // cross-process interleaving is a NORMAL state (same reasoning as the artifact
  // central index — a read-outside-then-write loses updates).
  async function mutateRecord(
    provider: string,
    id: string,
    fn: (onDisk: ConversationRecord | null) => ConversationRecord,
    strictExisting = false,
  ): Promise<ConversationRecord> {
    // recordPath validates provider + id and THROWS on traversal — this is the
    // single chokepoint every write path funnels through (review fix 1).
    const target = recordPath(provider, id);
    // mutateFileUnderLock also mkdirs the parent, but doing it here keeps the
    // "provider dir created on demand" guarantee obvious at the call site.
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let result: ConversationRecord | undefined;
    // The mutate callback is SYNCHRONOUS (see cas-write.ts) — we compute the
    // next record and stringify it in one shot; the lock is held across the
    // whole read+compute+write.
    const committed = await mutateFileUnderLock(target, (onDisk) => {
      const existing = onDisk ? parseRecord(onDisk) : null;
      // WHY: healing may seed only an absent canonical, never replace evidence
      // it cannot interpret. Check inside the lock, including present empty files.
      if (strictExisting && onDisk !== null &&
          (!existing || existing.id !== id || existing.provider !== provider)) {
        throw new Error(`conversation-store: cannot heal invalid canonical ${provider}/${id}`);
      }
      result = fn(existing);
      return JSON.stringify(result, null, 2);
    });
    // mutateFileUnderLock returns false (and skips the write) when it can't
    // acquire the lock within its timeout. Throwing surfaces the rare
    // contention failure instead of silently returning a bogus record.
    if (!committed || !result) {
      throw new Error(`conversation-store: could not write ${provider}/${id} (lock timeout)`);
    }
    return result;
  }

  // Heal engine conflict copies for ONE record id: atomically CLAIM each copy
  // via quarantine-rename, fold the claimed content field-level into the
  // canonical record, then delete the quarantine files. Runs opportunistically
  // on the read paths (get/list) and before an upsert.
  //
  // WHY quarantine-rename (review fix 2): deleting a copy by its ORIGINAL name
  // races the sync engine — between our read and our unlink, another process's
  // heal can remove the copy and the engine can write NEW conflict content at
  // the very same name (its free-name probe sees the name free; the date suffix
  // is day-granular). Our unlink would then destroy unfolded data. Renaming to
  // '<copy>.healing-<pid>-<nonce>' gives each claim a private name, including
  // recovery of another healer's claim. Cleanup cannot delete a recreated copy
  // or a later claim; the bytes actually claimed are revalidated before folding.
  async function heal(provider: string, id: string): Promise<void> {
    const dir = providerDir(provider);
    let names: string[];
    // The provider dir may not exist yet — nothing to heal.
    try { names = fs.readdirSync(dir); } catch { return; }
    const baseName = `${id}.json`;

    const validated: { path: string; record: ConversationRecord }[] = [];
    for (const n of names) {
      // Recover claims regardless of age/PID, without accumulating suffixes.
      const original = originalConflictName(n);
      if (!isConflictCopyName(original) || extractConflictBase(original) !== baseName) continue;
      const full = path.join(dir, n);
      // WHY: read/parse failure is not proof of disposable data. Preflight also
      // leaves unreadable or rejected old claims in place rather than renaming
      // them on every read. It is NOT proof of the bytes we will actually claim.
      let peek: ConversationRecord | null;
      try { peek = parseRecord(fs.readFileSync(full, 'utf8')); } catch { continue; }
      if (!peek || peek.id !== id || peek.provider !== provider) continue;
      const quarantine = path.join(dir, original) + HEALING_MARKER + process.pid + '-' + randomUUID();
      try { fs.renameSync(full, quarantine); } catch { continue; }
      // Another live healer may reclaim this private path. If it already read
      // the bytes, both folds are safe; if not, ENOENT skips its contribution.
      // Never restore over an original name that the engine may have recreated.
      let record: ConversationRecord | null;
      try { record = parseRecord(fs.readFileSync(quarantine, 'utf8')); } catch { continue; }
      if (!record || record.id !== id || record.provider !== provider) continue;
      validated.push({ path: quarantine, record });
    }
    if (validated.length === 0) return;
    const parsed = validated.map(({ record }) => record);
    await mutateRecord(provider, id, (existing) =>
      // Preserve field selection over ORIGINAL inputs, including copies-only seeding.
      foldConflictCopies(existing ?? parsed[0], existing ? parsed : parsed.slice(1)), true);
    // Only successfully incorporated private paths are disposable. A failed
    // commit leaves all evidence; a failed unlink leaves an idempotent retry.
    for (const { path: q } of validated) {
      try { fs.unlinkSync(q); } catch { /* retained or reclaimed — retry later */ }
    }
  }

  return {
    root: () => conversationsRoot,

    async upsert(partial) {
      // Validate FIRST so a traversal id/provider throws before any disk work
      // (heal would otherwise silently no-op on a bad provider).
      recordPath(partial.provider, partial.id);
      // Fold away any conflict copies first so we merge into the true canonical.
      await heal(partial.provider, partial.id);
      const incoming = toRecord(partial);
      return mutateRecord(partial.provider, partial.id, (existing) => {
        if (!existing) return incoming;
        // Overlay the provided fields onto the existing record so mergeRecords
        // can rank the two sides by activity (lastActive is `incoming`'s —
        // EPOCH when the caller omitted it, so metadata-only never outranks).
        const overlay: ConversationRecord = {
          ...existing,
          ...(partial.projectName !== undefined && { projectName: partial.projectName }),
          ...(partial.originalPath !== undefined && { originalPath: partial.originalPath }),
          ...(partial.title !== undefined && { title: partial.title }),
          ...(partial.device !== undefined && { device: partial.device }),
          ...(partial.transcriptRef !== undefined && { transcriptRef: partial.transcriptRef }),
          ...(partial.lastUsedModel !== undefined && { lastUsedModel: partial.lastUsedModel }),
          lastActive: incoming.lastActive,
        };
        const merged = mergeRecords(existing, overlay);
        // Review fix 3 — LOCAL TRUTH: the merge ranks by activity, so a
        // metadata-only upsert (EPOCH lastActive) loses wholesale and every
        // provided field would silently vanish. Re-apply the caller's explicit
        // metadata POST-merge: these fields are facts the caller just observed,
        // not cross-device claims to arbitrate. lastActive/device deliberately
        // stay merge-decided (activity-coupled); title lands only when it's a
        // REAL name — non-empty AND not the literal 'Untitled' placeholder
        // (same rule as store-core's realTitle). Callers normally normalize
        // placeholders away, but the store is self-defending: a placeholder
        // must never clobber a real title.
        return {
          ...merged,
          // WHY: noteModelUsed writes without lastActive; the EPOCH overlay
          // loses to existing activity but this explicit local model must land.
          ...(partial.lastUsedModel !== undefined && { lastUsedModel: partial.lastUsedModel }),
          ...(partial.projectName !== undefined && { projectName: partial.projectName }),
          ...(partial.originalPath !== undefined && { originalPath: partial.originalPath }),
          ...(partial.transcriptRef !== undefined && { transcriptRef: partial.transcriptRef }),
          ...(partial.title && partial.title !== 'Untitled' ? { title: partial.title } : null),
        };
      });
    },

    async get(provider, id) {
      // Fail-soft reads (review fix 1): an invalid name can't address a record
      // — answer "not found", don't throw (reads promise to degrade, not break).
      if (!isSafeSegment(provider) || !isSafeSegment(id)) return null;
      // Heal-on-read is OPPORTUNISTIC (review fix 4): a contended/stale lock on
      // the canonical must not reject the read — serve the un-healed canonical
      // and let the next read retry (claimed quarantine files survive a failed
      // fold, so nothing is lost).
      try { await heal(provider, id); } catch { /* heal retries on next read */ }
      try {
        return parseRecord(fs.readFileSync(recordPath(provider, id), 'utf8'));
      } catch {
        // Missing file → null. (A corrupt file is handled by parseRecord
        // returning null above; either way we never delete on a read.)
        return null;
      }
    },

    async list(provider) {
      // Fail-soft reads: invalid provider → empty listing, never a throw.
      if (!isSafeSegment(provider)) return [];
      let dir: string;
      try { dir = providerDir(provider); } catch { return []; }
      let names: string[];
      // No provider dir → no conversations.
      try { names = fs.readdirSync(dir); } catch { return []; }
      // Heal any conflict copies (and stale quarantine files) found in this
      // listing pass, then read clean. Heal failures are swallowed per fix 4 —
      // a stuck lock on ONE record must not empty the whole list.
      for (const n of names) {
        // A stale quarantine name maps back to its original conflict-copy name.
        const original = originalConflictName(n);
        if (isConflictCopyName(original)) {
          const base = extractConflictBase(original);
          if (base) {
            try { await heal(provider, base.replace(/\.json$/, '')); }
            catch { /* opportunistic — next list retries */ }
          }
        }
      }
      const out: ConversationRecord[] = [];
      // Re-read the dir (heal may have deleted copies) — guarded like the
      // first read: a dir that vanished mid-list yields [] not a crash.
      let finalNames: string[];
      try { finalNames = fs.readdirSync(dir); } catch { return []; }
      for (const n of finalNames) {
        if (!n.endsWith('.json') || isConflictCopyName(n)) continue;
        try {
          const r = parseRecord(fs.readFileSync(path.join(dir, n), 'utf8'));
          // A corrupt record damages exactly ONE conversation, never the list.
          if (r) out.push(r);
        } catch { /* unreadable file — skip */ }
      }
      return out;
    },

    async setFlag(provider, id, flag, value) {
      await mutateRecord(provider, id, (existing) => {
        // Seed a flag-only record when the conversation isn't on disk yet — a
        // flag can legitimately be set before the first turn is recorded.
        const base = existing ?? toRecord({ id, provider });
        const flags: Record<string, FlagState> = {
          ...base.flags,
          // Fresh updatedAt so this flag wins any future merge against an older
          // value for the same key.
          [flag]: { value, updatedAt: new Date().toISOString() },
        };
        return { ...base, flags };
      });
    },

    async setTitle(provider, id, title) {
      // Empty title is a no-op — never overwrite a real name with nothing, and
      // never seed an empty-titled record just to store "".
      if (!title) return;
      await mutateRecord(provider, id, (existing) => {
        const base = existing ?? toRecord({ id, provider });
        return { ...base, title };
      });
    },

    /**
     * Delete a record outright. Returns true if anything was removed.
     *
     * The ONLY destructive operation on this store, added 2026-07-18 for the
     * native phantom-record cleanup — nothing else deletes records, and nothing
     * else should without a comparably narrow justification. The deletion syncs
     * (the transport stages the whole tree), which is the point: the junk must
     * clear on every device, not just the one that noticed.
     *
     * WHY it also sweeps conflict copies and quarantine files: heal() seeds a
     * canonical FROM a conflict copy when none exists ("Without one (only
     * conflict copies exist): seed from the first copy"). Deleting the canonical
     * alone would let the very next get()/list() resurrect the record from a
     * surviving copy — the delete would look successful and silently undo itself.
     */
    async remove(provider, id) {
      if (!isSafeSegment(provider) || !isSafeSegment(id)) return false;
      let dir: string;
      try { dir = providerDir(provider); } catch { return false; }
      let names: string[];
      try { names = fs.readdirSync(dir); } catch { return false; }
      const baseName = `${id}.json`;
      // Canonical + every conflict copy + every quarantine file for this id.
      // Same name-matching rules heal() uses, so the two agree on what "belongs
      // to this id" means.
      const targets = names.filter((n) => {
        if (n === baseName) return true;
        const h = n.indexOf(HEALING_MARKER);
        const original = h >= 0 ? n.slice(0, h) : n;
        return isConflictCopyName(original) && extractConflictBase(original) === baseName;
      });
      let removed = false;
      for (const n of targets) {
        try { fs.unlinkSync(path.join(dir, n)); removed = true; }
        catch { /* already gone / raced another remover — treat as removed by someone */ }
      }
      return removed;
    },

    async setNote(provider, id, note) {
      // Unlike setTitle, an EMPTY note is a valid value — clearing a note. So we
      // do not early-return on '' (that's how a user erases a note).
      await mutateRecord(provider, id, (existing) => {
        const base = existing ?? toRecord({ id, provider });
        return { ...base, note, noteUpdatedAt: new Date().toISOString() };
      });
    },
  };
}
