// Office's Recent list (design section 3, R5): the files opened in Office, newest first.
// Kept in <userData>/office-recent.json as { updatedAt, files }.
//
// WHY "opened in Office", not "changed": the start screen's Recent is what the person worked on
// here. office:open's success is the one place that adds to it (office-ipc.ts).
//
// WHY through casWrite with an updatedAt token: the dev app and the built app can share a
// userData folder's neighbours, and two windows can open files at once — a plain read-then-write
// would let the second writer drop the first one's entry. casWrite refuses a write whose token
// no longer matches, and add() then re-reads and tries again.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { OfficeFile, OfficeKind } from '../../shared/office-types';
import { casWrite, CAS_REPLACE_ANY, type CasExpectation } from '../artifacts/cas-write';
import { log } from '../logger';

/** How many files Recent keeps (design section 3). */
const RECENT_MAX = 12;
const FILE = 'office-recent.json';
/** WHY a few tries: a refusal means someone else wrote meanwhile; re-reading merges with them.
 *  Past this the entry is dropped (logged) — Recent is a convenience, never worth failing an open. */
const MAX_TRIES = 5;

const KINDS: ReadonlySet<OfficeKind> = new Set(['document', 'spreadsheet', 'presentation']);

interface Stored { updatedAt: string; files: OfficeFile[] }

const target = (userData: string) => path.join(userData, FILE);

/** Only well-formed entries count. WHY: the file is on disk, where anything can end up in it; a
 *  relative path in particular would be resolved against the app's own folder when opened. */
function isFile(v: unknown): v is OfficeFile {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return typeof f.path === 'string' && path.isAbsolute(f.path)
    && typeof f.name === 'string' && typeof f.folder === 'string' && typeof f.at === 'string'
    && typeof f.kind === 'string' && KINDS.has(f.kind as OfficeKind);
}

/** What is on disk, and the token a write must expect to find. */
async function read(userData: string): Promise<{ files: OfficeFile[]; expect: CasExpectation }> {
  let raw: string;
  try {
    raw = await fsp.readFile(target(userData), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { files: [], expect: null };
    throw e;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Stored>;
    const files = Array.isArray(parsed?.files) ? parsed.files.filter(isFile) : [];
    // A file without a token can only be replaced deliberately (it was written by something else).
    return { files, expect: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : CAS_REPLACE_ANY };
  } catch {
    // WHY start over rather than fail: an unreadable Recent file must not break the start screen
    // or an open. It is replaced by the next add.
    log('WARN', 'Office', 'Recent list was unreadable; starting it over');
    return { files: [], expect: CAS_REPLACE_ANY };
  }
}

const extractUpdatedAt = (json: string): string | undefined => {
  const v = (JSON.parse(json) as Partial<Stored>)?.updatedAt;
  return typeof v === 'string' ? v : undefined;
};

// WHY one add at a time in this process: several files opening together would otherwise all
// race casWrite and spend their tries refusing each other. Other processes are still handled
// by the token.
let queue: Promise<unknown> = Promise.resolve();

/** Put a file at the top of Recent (one entry per path; at most RECENT_MAX). */
export function add(userData: string, file: OfficeFile): Promise<void> {
  const run = queue.then(() => addNow(userData, file));
  queue = run.catch(() => {});
  return run;
}

async function addNow(userData: string, file: OfficeFile): Promise<void> {
  for (let i = 0; i < MAX_TRIES; i++) {
    const { files, expect } = await read(userData);
    const next: Stored = {
      // WHY unique beyond the millisecond: two writes in the same ms must still differ as tokens.
      updatedAt: `${new Date().toISOString()}#${process.pid}.${Math.random().toString(36).slice(2, 10)}`,
      files: [file, ...files.filter((f) => f.path !== file.path)].slice(0, RECENT_MAX),
    };
    const r = await casWrite(target(userData), expect, JSON.stringify(next, null, 2), extractUpdatedAt);
    if (r.committed) return;
  }
  log('WARN', 'Office', 'Recent list could not be updated (kept being changed elsewhere)');
}

/** Recent, newest first, leaving out files that no longer exist. */
export async function list(userData: string): Promise<OfficeFile[]> {
  const { files } = await read(userData);
  const here = await Promise.all(files.map((f) => fsp.stat(f.path).then((s) => s.isFile(), () => false)));
  return files.filter((_, i) => here[i]);
}
