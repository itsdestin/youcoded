// Handoff-only exact evidence. Ordinary transcript mirroring intentionally remains size-gated.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MAX_SYNC_FILE_BYTES, validateSyncName } from '../sync-spaces/guards';
import type { ConversationRecord } from './store-core';
import { matchesHandoffReceipt, parseHandoffReceipt, type TransferContext, type HandoffReceipt } from './handoff-receipt';
import { runSerializedTranscriptDestination } from './transcript-mirror';
import { ccProjectSlug, nativeStoreSlug } from '../slug-encoding';

const fsp = fs.promises;
type Provider = TransferContext['provider'];
export type FreshnessCheck = { status: 'confirmed'; receipt: HandoffReceipt } | { status: 'incomplete'; reason: string };
export type Publication = { status: 'published'; receipt: HandoffReceipt } | { status: 'incomplete'; reason: string };
type Base = {
  context: TransferContext; record: ConversationRecord; conversationsRoot: string; personalRoot: string;
  runtimeRoot: string;
  // Re-read mapping after every async operation; a store remap or /clear rotation invalidates evidence.
  resolveRecord: () => Promise<ConversationRecord | null>;
};
export type SenderSnapshot = Base & {
  writer: { provider: Provider; sessionId: string; transcriptPath: string; projectCwd: string };
  // Supplied by Task 3's proven stop barrier, NOT inferred from size/quiescence.
  stopped: () => boolean;
  currentWriter: () => boolean;
};
export type ReceiverImport = Base & {
  destination: string;
  projectPath: string | null;
  // Task 4 owns the pending-start pin and cancellation token.
  mayCommit: () => boolean;
};
const incomplete = (reason: string): { status: 'incomplete'; reason: string } => ({ status: 'incomplete', reason });
const safeSegment = (s: string): boolean => /^[A-Za-z0-9._-]{1,100}$/.test(s) && validateSyncName(s) === null;

function paths(base: Base): { mirror: string; receipt: string } | null {
  const { context: c, record: r } = base;
  if (!parseHandoffReceipt({ ...c, v: 1, byteLength: 1, sha256: '0'.repeat(64) }) ||
      r.id !== c.sessionId || r.provider !== c.provider || !safeSegment(r.projectName) ||
      r.transcriptRef !== `${c.provider}/transcripts/${r.projectName}/${c.sessionId}.jsonl` ||
      path.resolve(base.conversationsRoot) !== path.resolve(base.personalRoot, 'Conversations')) return null;
  return {
    mirror: path.resolve(base.conversationsRoot, r.transcriptRef),
    receipt: path.resolve(base.personalRoot, 'Handoffs', c.provider, `${c.sessionId}.json`),
  };
}

// WHY: lexical containment alone allows a synced symlink to redirect reads or writes.
// Existing ancestors must be real directories, and existing leaves regular files.
async function contained(root: string, target: string, leafMayBeMissing = false): Promise<boolean> {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  let cursor = path.parse(path.resolve(root)).root;
  for (const part of path.resolve(root).slice(cursor.length).split(path.sep).filter(Boolean).concat(rel.split(path.sep))) {
    cursor = path.join(cursor, part);
    try {
      const stat = await fsp.lstat(cursor);
      if (stat.isSymbolicLink()) return false;
      if (cursor === path.resolve(target) ? !stat.isFile() : !stat.isDirectory()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !leafMayBeMissing) return false;
      // A missing parent is acceptable for a new destination; mkdir happens after validation.
    }
  }
  return true;
}

type Fingerprint = { byteLength: number; sha256: string; identity: string };
// 64 KiB reads; pre/post fd and pathname identity checks detect replacement and mutation.
async function fingerprint(file: string, root: string): Promise<Fingerprint | null> {
  if (!(await contained(root, file))) return null;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_SYNC_FILE_BYTES) return null;
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, before.size - offset), offset);
      if (!bytesRead) return null;
      hash.update(buf.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        after.ino !== before.ino || !(await contained(root, file))) return null;
    const named = await fsp.stat(file);
    if (named.ino !== before.ino || named.dev !== before.dev || named.size !== before.size || named.mtimeMs !== before.mtimeMs) return null;
    return { byteLength: offset, sha256: hash.digest('hex'), identity: `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}` };
  } catch { return null; }
  finally { await handle?.close(); }
}
// WHY: copyFile may follow a replacement or grow without limit after the initial
// fingerprint. Read from one no-follow fd, never past the signed receipt length,
// then verify that fd AND its pathname still name exactly the expected bytes.
async function stageReceiptBytes(mirror: string, root: string, tmp: string, receipt: HandoffReceipt, expected: Fingerprint): Promise<boolean> {
  if (receipt.byteLength < 1 || receipt.byteLength > MAX_SYNC_FILE_BYTES || !(await contained(root, mirror))) return false;
  const input = await fsp.open(mirror, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = await input.stat();
    const identity = (s: fs.Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
    if (!before.isFile() || before.size !== receipt.byteLength || identity(before) !== expected.identity) return false;
    const output = await fsp.open(tmp, 'wx');
    try {
      const buf = Buffer.allocUnsafe(64 * 1024);
      const hash = createHash('sha256');
      let offset = 0;
      while (offset < receipt.byteLength) {
        const count = Math.min(buf.length, receipt.byteLength - offset);
        const { bytesRead } = await input.read(buf, 0, count, offset);
        if (bytesRead < 1) return false;
        hash.update(buf.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(buf, written, bytesRead - written, offset + written);
          if (!result.bytesWritten) return false;
          written += result.bytesWritten;
        }
        offset += bytesRead;
      }
      const extra = await input.read(buf, 0, 1, receipt.byteLength);
      if (extra.bytesRead || identity(await input.stat()) !== expected.identity ||
          hash.digest('hex') !== receipt.sha256 || !(await contained(root, mirror))) return false;
      const named = await fsp.stat(mirror);
      return identity(named) === expected.identity;
    } finally { await output.close(); }
  } finally { await input.close(); }
}

const same = (a: Fingerprint | null, b: Fingerprint | null): boolean => !!a && !!b && a.byteLength === b.byteLength && a.sha256 === b.sha256;
const matches = (f: Fingerprint | null, r: HandoffReceipt): boolean => !!f && f.byteLength === r.byteLength && f.sha256 === r.sha256;
// No await between these metadata probes and rename. This catches mutations by
// normal local writers during the last awaited prefix/record/receipt checks;
// it is not an atomic guarantee against a hostile process swapping a path.
function identityNow(file: string): string | null {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && !st.isSymbolicLink()
      ? `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}` : null;
  } catch { return null; }
}
function statIdentity(st: fs.Stats | null): string | null {
  return st ? `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}` : null;
}
async function current(base: Base): Promise<boolean> {
  try {
    const now = await base.resolveRecord();
    return !!now && !!paths({ ...base, record: now }) && now.transcriptRef === base.record.transcriptRef &&
      now.projectName === base.record.projectName && now.originalPath === base.record.originalPath;
  } catch { return false; }
}
async function unambiguous(receipt: string): Promise<boolean> {
  try {
    const names = await fsp.readdir(path.dirname(receipt));
    const stem = path.basename(receipt, '.json').toLowerCase();
    // git-transport.freeCopyName uses guards.conflictCopyName: '<id> (from
    // <device>, <date>).json', including numbered device labels. Other id-prefix
    // files aren't copies of this receipt; case-fold collisions still are.
    return !names.some((n) => n !== path.basename(receipt) &&
      (n.toLowerCase() === `${stem}.json` ||
        (n.toLowerCase().startsWith(`${stem} (from `) && n.toLowerCase().endsWith(').json'))));
  } catch { return false; }
}
async function receiptFor(base: Base, file: string): Promise<HandoffReceipt | null> {
  if (!(await contained(base.personalRoot, file)) || !(await unambiguous(file))) return null;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const st = await handle.stat();
    if (!st.isFile() || st.size < 1 || st.size > 2048) return null;
    // WHY: stat followed by readFile can read an unbounded replacement; cap
    // even a receipt growing during this read to one byte past the 2 KiB limit.
    const buf = Buffer.alloc(2049);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead !== st.size || statIdentity(await handle.stat()) !== statIdentity(st) ||
        identityNow(file) !== statIdentity(st)) return null;
    const receipt = parseHandoffReceipt(JSON.parse(buf.toString('utf8', 0, bytesRead)));
    return receipt && matchesHandoffReceipt(receipt, base.context) ? receipt : null;
  } catch { return null; }
  finally { await handle?.close(); }
}

// WHY: an identical session filename under a different project is not this
// record's final history. Bind the watcher/host's captured cwd to the record's
// local project and its exact provider slug; realpath permits an alias in the
// stored record without trusting a stale cwd or a same-ID file elsewhere.
async function writerProject(opts: SenderSnapshot): Promise<string | null> {
  const { writer, record, runtimeRoot } = opts;
  if (!path.isAbsolute(writer.projectCwd) || !path.isAbsolute(record.originalPath) ||
      path.basename(record.originalPath) !== record.projectName) return null;
  try {
    const actual = await fsp.realpath(writer.projectCwd);
    if ((await fsp.realpath(record.originalPath)) !== actual ||
        !(await fsp.stat(actual)).isDirectory()) return null;
    const slug = writer.provider === 'claude' ? ccProjectSlug(writer.projectCwd) : nativeStoreSlug(writer.projectCwd);
    const realSlug = writer.provider === 'claude' ? ccProjectSlug(actual) : slug;
    const folder = path.dirname(path.resolve(writer.transcriptPath));
    if (folder !== path.resolve(runtimeRoot, slug) && folder !== path.resolve(runtimeRoot, realSlug)) return null;
    return actual;
  } catch { return null; }
}

export async function publishHandoffTranscript(opts: SenderSnapshot): Promise<Publication> {
  const p = paths(opts);
  if (!p || opts.writer.provider !== opts.context.provider || opts.writer.sessionId !== opts.context.sessionId ||
      path.basename(opts.writer.transcriptPath) !== `${opts.context.sessionId}.jsonl` ||
      !opts.stopped() || !opts.currentWriter() || !(await current(opts))) return incomplete('writer identity or stop not proven');
  const project = await writerProject(opts);
  if (!project || !opts.stopped() || !opts.currentWriter()) return incomplete('writer project differs from record');
  // WHY: ordinary mirrorIn also targets this path. Hold its destination chain
  // across the evidence read and publication; otherwise a late rename can make
  // the newly published receipt describe bytes no longer at the mirror path.
  return runSerializedTranscriptDestination(p.mirror, async () => {
  const source = await fingerprint(opts.writer.transcriptPath, opts.runtimeRoot);
  if (!source || !opts.stopped() || !opts.currentWriter()) return incomplete('source unavailable');
  let mirror = await fingerprint(p.mirror, opts.conversationsRoot);
  if (!same(source, mirror)) {
    // WHY: ordinary mirroring is grow-only by size; handoff needs exact final
    // bytes, but may extend ONLY a byte-prefix predecessor (or an absent mirror).
    // Keep the destination serialization across copy, verification and receipt.
    if (!(await contained(opts.conversationsRoot, p.mirror, true))) return incomplete('unsafe mirror');
    const old = mirror ? await fsp.stat(p.mirror).catch(() => null) : null;
    if (old && (old.size >= source.byteLength || !(await prefix(p.mirror, opts.writer.transcriptPath, old.size))))
      return incomplete('divergent mirror');
    if (!opts.stopped() || !opts.currentWriter() || !(await current(opts)) || (await writerProject(opts)) !== project ||
        identityNow(opts.writer.transcriptPath) !== source.identity || identityNow(p.mirror) !== (mirror?.identity ?? null))
      return incomplete('snapshot changed');
    const tmp = `${p.mirror}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsp.mkdir(path.dirname(p.mirror), { recursive: true });
      const receipt: HandoffReceipt = { ...opts.context, v: 1, byteLength: source.byteLength, sha256: source.sha256 };
      if (!(await stageReceiptBytes(opts.writer.transcriptPath, opts.runtimeRoot, tmp, receipt, source)) ||
          identityNow(p.mirror) !== (mirror?.identity ?? null) || !opts.stopped() || !opts.currentWriter() ||
          !(await current(opts)) || (await writerProject(opts)) !== project)
        return incomplete('mirror staging changed');
      if (identityNow(opts.writer.transcriptPath) !== source.identity) return incomplete('source changed');
      await fsp.rename(tmp, p.mirror);
    } catch { return incomplete('mirror copy failed'); }
    finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
    mirror = await fingerprint(p.mirror, opts.conversationsRoot);
  }
  if (!same(source, mirror) || !opts.stopped() || !opts.currentWriter() || !(await current(opts)) ||
      (await writerProject(opts)) !== project) return incomplete('source and mirror differ');
  if (!(await contained(opts.personalRoot, p.receipt, true))) return incomplete('unsafe receipt path');
  try { await fsp.mkdir(path.dirname(p.receipt), { recursive: true }); }
  catch { return incomplete('receipt directory unavailable'); }
  if (!(await unambiguous(p.receipt))) return incomplete('conflicting receipt');
  const receipt: HandoffReceipt = { ...opts.context, v: 1, byteLength: source!.byteLength, sha256: source!.sha256 };
  const tmp = `${p.receipt}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(receipt), { flag: 'wx' });
    if (source?.identity !== (await fingerprint(opts.writer.transcriptPath, opts.runtimeRoot))?.identity ||
        mirror?.identity !== (await fingerprint(p.mirror, opts.conversationsRoot))?.identity ||
        !(await current(opts)) || (await writerProject(opts)) !== project ||
        !(await unambiguous(p.receipt))) return incomplete('snapshot changed');
    // WHY: current/unambiguous await disk work; stop or mapping can change there.
    if (!opts.stopped() || !opts.currentWriter() || (await writerProject(opts)) !== project ||
        identityNow(opts.writer.transcriptPath) !== source?.identity || identityNow(p.mirror) !== mirror?.identity) return incomplete('snapshot changed');
    await fsp.rename(tmp, p.receipt);
    return { status: 'published', receipt };
  } catch { return incomplete('receipt publication failed'); }
  finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
  });
}

// Compare the existing local bytes, not lengths. A shorter *divergent* predecessor is never replaced.
async function prefix(local: string, source: string, size: number): Promise<boolean> {
  if (!size) return true;
  const a = await fsp.open(local, 'r'); const b = await fsp.open(source, 'r');
  try {
    const left = Buffer.allocUnsafe(64 * 1024), right = Buffer.allocUnsafe(64 * 1024);
    for (let pos = 0; pos < size; pos += left.length) {
      const count = Math.min(left.length, size - pos);
      const x = await a.read(left, 0, count, pos), y = await b.read(right, 0, count, pos);
      if (x.bytesRead !== count || y.bytesRead !== count || !left.subarray(0, count).equals(right.subarray(0, count))) return false;
    }
    return true;
  } finally { await a.close(); await b.close(); }
}

export async function importHandoffTranscript(opts: ReceiverImport): Promise<FreshnessCheck> {
  const p = paths(opts);
  const project = opts.projectPath;
  if (!p || !project || path.basename(project) !== opts.record.projectName ||
      !(await fsp.lstat(project).then((st) => st.isDirectory(), () => false)) ||
      path.resolve(opts.destination) !== path.resolve(opts.runtimeRoot,
        opts.context.provider === 'native' ? nativeStoreSlug(project) : ccProjectSlug(project), `${opts.context.sessionId}.jsonl`) ||
      !opts.mayCommit() || !(await current(opts)) ||
      !(await contained(opts.runtimeRoot, opts.destination, true))) return incomplete('unavailable destination or mapping');
  // WHY: share the ordinary mirror's destination chain so neither direction can commit over a pinned startup.
  return runSerializedTranscriptDestination(opts.destination, async () => {
    const receipt = await receiptFor(opts, p.receipt);
    if (!receipt || !opts.mayCommit()) return incomplete('missing or mismatched receipt');
    const receiptIdentity = identityNow(p.receipt);
    if (!receiptIdentity) return incomplete('receipt changed');
    const source = await fingerprint(p.mirror, opts.conversationsRoot);
    if (!matches(source, receipt)) return incomplete('mirror does not match receipt');
    const existing = await fingerprint(opts.destination, opts.runtimeRoot);
    const initialStat = await fsp.lstat(opts.destination).catch(() => null);
    if (matches(existing, receipt)) {
      const mapping = await current(opts);
      const stillReceipt = await receiptFor(opts, p.receipt);
      const actual = await fingerprint(opts.destination, opts.runtimeRoot);
      // WHY: the last fingerprint and receipt reads await I/O; cancellation or
      // a same-sized rewrite can occur during either, before confirmation returns.
      return mapping && JSON.stringify(stillReceipt) === JSON.stringify(receipt) && matches(actual, receipt) &&
        opts.mayCommit() && identityNow(opts.destination) === existing?.identity &&
        identityNow(p.mirror) === source?.identity && identityNow(p.receipt) === receiptIdentity
        ? { status: 'confirmed', receipt } : incomplete('confirmation changed');
    }
    if (existing) {
      if (existing.byteLength >= receipt.byteLength) return incomplete('divergent destination');
      try { if (!await prefix(opts.destination, p.mirror, existing.byteLength)) return incomplete('divergent destination'); }
      catch { return incomplete('predecessor changed'); }
    }
    if (!existing && initialStat && (!initialStat.isFile() || initialStat.size !== 0)) return incomplete('unsafe destination');
    const tmp = `${opts.destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsp.mkdir(path.dirname(opts.destination), { recursive: true });
      if (!await stageReceiptBytes(p.mirror, opts.conversationsRoot, tmp, receipt, source!)) return incomplete('copy or admission changed');
      // WHY: retain the exact staged inode/size/timestamps validated against
      // receipt bytes; existence alone at commit cannot exclude an intervening
      // same-size rewrite of this temp file during the final awaited checks.
      const staged = await fingerprint(tmp, opts.runtimeRoot);
      if (!matches(staged, receipt) ||
          !same(source, await fingerprint(p.mirror, opts.conversationsRoot)) ||
          !opts.mayCommit() || !(await current(opts)) || !(await contained(opts.runtimeRoot, opts.destination, true)) ||
          JSON.stringify(await receiptFor(opts, p.receipt)) !== JSON.stringify(receipt)) return incomplete('copy or admission changed');
      const now = await fingerprint(opts.destination, opts.runtimeRoot);
      const finalStat = await fsp.lstat(opts.destination).catch(() => null);
      if (now?.identity !== existing?.identity ||
          finalStat?.ino !== initialStat?.ino || finalStat?.mtimeMs !== initialStat?.mtimeMs ||
          finalStat?.size !== initialStat?.size || (now && !matches(now, receipt) &&
          (now.byteLength >= receipt.byteLength || !await prefix(opts.destination, tmp, now.byteLength))) ||
          (finalStat !== null && !finalStat.isFile())) return incomplete('destination changed');
      // WHY: prefix() and the checks above await disk work. A same-sized local
      // rewrite after prefix() returned true must not be overwritten by rename.
      // Only bounded metadata checks run synchronously in this commit window.
      if (!opts.mayCommit() || identityNow(opts.destination) !== statIdentity(initialStat) ||
          identityNow(p.mirror) !== source?.identity || identityNow(p.receipt) !== receiptIdentity ||
          identityNow(tmp) !== staged?.identity) return incomplete('commit changed');
      await fsp.rename(tmp, opts.destination);
      return matches(await fingerprint(opts.destination, opts.runtimeRoot), receipt)
        ? { status: 'confirmed', receipt } : incomplete('runtime bytes changed');
    } catch { return incomplete('import failed'); }
    finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
  });
}
