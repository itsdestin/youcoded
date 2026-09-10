// Binds the two pure readers to THIS device's folders.
//
// One place on purpose: the Electron IPC handler and the remote WebSocket case
// both call these, and if each did its own path assembly they would drift —
// which on this feature means a conversation that previews over the desktop and
// refuses over the phone, with nothing to say why.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { chatsearchDir } from './index-store';
import { readMetaFile, resolveShortIds } from './meta-reader';
import { readTranscriptSlice, type ParsedCacheEntry } from './transcript-reader';
import { buildLocalProjectResolver } from '../conversations/service';
import { getManagedRoots } from '../sync-spaces/service';
import { ccProjectSlug, nativeStoreSlug } from '../slug-encoding';
import { NativeHome } from '../native-home';
import type {
  ChatsearchProvider, ChatsearchReadRequest, ChatsearchReadResponse, ResolvedConversation,
} from '../../shared/chatsearch-refs';

const CLAUDE_PROJECTS = () => path.join(os.homedir(), '.claude', 'projects');
const NATIVE_SESSIONS = () => path.join(new NativeHome().root, 'sessions');

// Lives for the process, not the request: "Load older" is a second call for the
// same file, and re-parsing a large transcript per page is the cost this exists
// to avoid. Bounded inside readTranscriptSlice.
const parseCache = new Map<string, ParsedCacheEntry>();

function localTranscriptPath(provider: ChatsearchProvider, localPath: string, id: string): string {
  return provider === 'native'
    ? path.join(NATIVE_SESSIONS(), nativeStoreSlug(localPath), `${id}.jsonl`)
    : path.join(CLAUDE_PROJECTS(), ccProjectSlug(localPath), `${id}.jsonl`);
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
// scan is one existsSync per project folder and only ever runs on a miss.
function findLocalTranscript(provider: ChatsearchProvider, id: string): string | null {
  const root = provider === 'native' ? NATIVE_SESSIONS() : CLAUDE_PROJECTS();
  let slugs: string[];
  try { slugs = fs.readdirSync(root); } catch { return null; }
  for (const slug of slugs) {
    const p = path.join(root, slug, `${id}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
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
  const resolveLocal = buildLocalProjectResolver();
  // The space root is user-configurable, so resolve it NOW rather than at
  // module load — a root captured at startup would be the wrong one for anyone
  // who set up sync after launching.
  const personalRoot = getManagedRoots()?.personalRoot;
  const roots = [
    CLAUDE_PROJECTS(),
    NATIVE_SESSIONS(),
    ...(personalRoot ? [path.join(personalRoot, 'Conversations')] : []),
  ];
  const entryOf = (p: ChatsearchProvider, id: string) => readMetaFile(dir, p)?.conversations[id];
  return readTranscriptSlice(
    {
      provider: req.provider,
      id: req.id,
      tail: Number(req.tail) || 40,
      ...(req.before !== undefined ? { before: Number(req.before) } : {}),
    },
    {
      entryFor: (p, id) => {
        const e = entryOf(p, id);
        if (e) return { transcriptPath: e.transcriptPath, tombstone: !!e.tombstone };
        // Not indexed — see findLocalTranscript. No tombstone: a tombstone is a
        // fact the index records, and its absence here means nobody said so,
        // not that the conversation was checked and found alive.
        const local = findLocalTranscript(p, id);
        return local ? { transcriptPath: local, tombstone: false } : null;
      },
      localPathFor: (p, id) => {
        const e = entryOf(p, id);
        const local = e ? resolveLocal({ projectName: e.projectName, originalPath: e.originalPath }) : null;
        return local ? localTranscriptPath(p, local, id) : null;
      },
      roots,
      cache: parseCache,
    },
  );
}
