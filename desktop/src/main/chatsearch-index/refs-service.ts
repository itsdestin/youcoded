// Binds the two pure readers to THIS device's folders.
//
// One place on purpose: the Electron IPC handler and the remote WebSocket case
// both call these, and if each did its own path assembly they would drift —
// which on this feature means a conversation that previews over the desktop and
// refuses over the phone, with nothing to say why.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { chatsearchDir, metaPath } from './index-store';
import { asMetaFile, readMetaFile, resolveShortIds } from './meta-reader';
import { readTranscriptSlice, type SliceCacheEntry } from './transcript-reader';
import type { ChatsearchMetaFile } from './index-format';
import { buildLocalProjectResolver } from '../conversations/service';
import { getManagedRoots } from '../sync-spaces/service';
import { ccProjectSlug, nativeStoreSlug } from '../slug-encoding';
import { NativeHome } from '../native-home';
import type {
  ChatsearchProvider, ChatsearchReadRequest, ChatsearchReadResponse, ResolvedConversation,
} from '../../shared/chatsearch-refs';

const CLAUDE_PROJECTS = () => path.join(os.homedir(), '.claude', 'projects');
const NATIVE_SESSIONS = () => path.join(new NativeHome().root, 'sessions');

// Lives for the process, not the request: hovering a row and then clicking it,
// or going back to a conversation read a minute ago, asks for the same slice of
// an unchanged file. Bounded inside readTranscriptSlice.
const sliceCache = new Map<string, SliceCacheEntry>();

const transcriptPathForSlug = (provider: ChatsearchProvider, slug: string, id: string) =>
  path.join(provider === 'native' ? NATIVE_SESSIONS() : CLAUDE_PROJECTS(), slug, `${id}.jsonl`);

function localTranscriptPath(provider: ChatsearchProvider, localPath: string, id: string): string {
  return transcriptPathForSlug(provider, provider === 'native' ? nativeStoreSlug(localPath) : ccProjectSlug(localPath), id);
}

// A slug is one folder name. Anything that could step out of the root — a
// separator, `.`/`..`, a NUL — is not a hint and is ignored rather than refused:
// the caller asked for a conversation by id, and the lookup can still find it.
const isSafeSlug = (s: unknown): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= 255 && s !== '.' && s !== '..' && !/[\\/\0]/.test(s);

const exists = (p: string) => fs.promises.access(p).then(() => true, () => false);

// The meta index is a 1.5 MB JSON file (measured 2026-09-11) that every preview
// used to read and parse TWICE, synchronously, on the main process. One parsed
// copy per file, reused until its mtime or size changes — the readSidecarShared
// pattern (artifacts/artifact-store.ts). Stat, not trust: another app instance
// shares ~/.youcoded and can rewrite the file under this one.
const metaCache = new Map<string, { stamp: string; file: ChatsearchMetaFile | null }>();
const metaInFlight = new Map<string, Promise<ChatsearchMetaFile | null>>();

async function readMetaCached(dir: string, provider: ChatsearchProvider): Promise<ChatsearchMetaFile | null> {
  const p = metaPath(dir, provider);
  let st: fs.Stats;
  try { st = await fs.promises.stat(p); } catch { metaCache.delete(p); return null; }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const slot = metaCache.get(p);
  if (slot && slot.stamp === stamp) return slot.file;
  const key = `${p}|${stamp}`;
  let pending = metaInFlight.get(key);
  if (!pending) {
    // Cached under the stamp taken BEFORE the read: if the file changes
    // mid-read, the next call's stat differs and it is read again.
    pending = fs.promises.readFile(p, 'utf8')
      .then((text) => asMetaFile(JSON.parse(text)), () => null)
      .catch(() => null)
      .then((file) => { metaCache.set(p, { stamp, file }); return file; })
      .finally(() => metaInFlight.delete(key));
    metaInFlight.set(key, pending);
  }
  return pending;
}

// An index miss is not "no such conversation". The chatsearch index is built by
// the bundled search plugin; the Resume browser's list is built from a scan of
// ~/.claude/projects plus the Conversation Store, so it routinely shows
// conversations the index has not reached yet — a fresh install has no index at
// all. Previewing one of those used to answer errNotIndexed, which reads to the
// user as "this conversation is broken" when the transcript is sitting right
// there on disk.
//
// So on a miss, look for the file itself. Both roots are <root>/<project
// slug>/<id>.jsonl, and `id` has already been checked against SESSION_UUID_RE by
// the time this runs (transcript-reader.ts), so it cannot escape the root. The
// scan is one existence check per project folder and only ever runs on a miss.
async function findLocalTranscript(provider: ChatsearchProvider, id: string): Promise<string | null> {
  const root = provider === 'native' ? NATIVE_SESSIONS() : CLAUDE_PROJECTS();
  let slugs: string[];
  try { slugs = await fs.promises.readdir(root); } catch { return null; }
  const hits = await Promise.all(slugs.map(async (slug) => {
    const p = path.join(root, slug, `${id}.jsonl`);
    return (await exists(p)) ? p : null;
  }));
  return hits.find((p): p is string => !!p) ?? null;
}

export function resolveConversations(shortIds: unknown): { ok: true; results: ResolvedConversation[] } | { ok: false; error: string } {
  // A card resolves the ids from one search. A hundred is far past anything the
  // CLI prints, so a larger list is a caller bug, not a big search.
  if (!Array.isArray(shortIds) || shortIds.length > 100) return { ok: false, error: 'Expected up to 100 ids' };
  const resolveLocal = buildLocalProjectResolver();
  return {
    ok: true,
    results: resolveShortIds(shortIds.map(String), {
      dir: chatsearchDir(os.homedir()),
      resolveLocal,
      transcriptExistsLocally: (p, local, id) => fs.existsSync(localTranscriptPath(p, local, id)),
      slugFor: (p, local) => (p === 'native' ? nativeStoreSlug(local) : ccProjectSlug(local)),
    }),
  };
}

export async function readConversation(req: ChatsearchReadRequest): Promise<ChatsearchReadResponse> {
  if (!req || (req.provider !== 'claude' && req.provider !== 'native') || typeof req.id !== 'string') {
    return { ok: false, error: 'Bad request' };
  }
  const dir = chatsearchDir(os.homedir());
  // The space root is user-configurable, so resolve it NOW rather than at
  // module load — a root captured at startup would be the wrong one for anyone
  // who set up sync after launching.
  const personalRoot = getManagedRoots()?.personalRoot;
  const roots = [
    CLAUDE_PROJECTS(),
    NATIVE_SESSIONS(),
    ...(personalRoot ? [path.join(personalRoot, 'Conversations')] : []),
  ];
  // Fast path: a Resume list row already knows its project folder, so the
  // transcript is at <root>/<slug>/<id>.jsonl and neither the index nor the
  // project resolver is needed. Containment is still enforced by the reader.
  // (`id` is only interpolated after the reader's uuid check has passed —
  // entryFor runs after it.)
  const hinted = isSafeSlug(req.projectSlug) ? transcriptPathForSlug(req.provider, req.projectSlug, req.id) : null;
  let hintFound: Promise<boolean> | null = null;
  const hintedFileExists = () => (hinted ? (hintFound ??= exists(hinted)) : Promise.resolve(false));
  // Built only when the index path is actually taken: it reads the saved
  // folders file and lists the managed projects.
  let resolveLocal: ReturnType<typeof buildLocalProjectResolver> | null = null;
  const entryOf = async (p: ChatsearchProvider, id: string) => (await readMetaCached(dir, p))?.conversations[id];
  return readTranscriptSlice(
    {
      provider: req.provider,
      id: req.id,
      tail: Number(req.tail) || 40,
      ...(req.before !== undefined ? { before: Number(req.before) } : {}),
    },
    {
      entryFor: async (p, id) => {
        if (await hintedFileExists()) return { transcriptPath: hinted!, tombstone: false };
        const e = await entryOf(p, id);
        if (e) return { transcriptPath: e.transcriptPath, tombstone: !!e.tombstone };
        // Not indexed — see findLocalTranscript. No tombstone: a tombstone is a
        // fact the index records, and its absence here means nobody said so,
        // not that the conversation was checked and found alive.
        const local = await findLocalTranscript(p, id);
        return local ? { transcriptPath: local, tombstone: false } : null;
      },
      localPathFor: async (p, id) => {
        if (await hintedFileExists()) return hinted;
        const e = await entryOf(p, id);
        if (!e) return null;
        resolveLocal ??= buildLocalProjectResolver();
        const local = resolveLocal({ projectName: e.projectName, originalPath: e.originalPath });
        return local ? localTranscriptPath(p, local, id) : null;
      },
      roots,
      cache: sliceCache,
    },
  );
}
