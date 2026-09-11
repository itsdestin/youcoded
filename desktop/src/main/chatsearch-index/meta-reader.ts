// The app-side READER of the meta index the app writes.
//
// Until now the only consumer was the standalone chatsearch CLI, which parses
// this JSON in its own process. The session-reference cards need the same
// lookup in-process, keyed by the short id PREFIXES the CLI prints in its
// table — the renderer only ever sees those four-or-so characters, so this is
// where they become whole conversations again.
//
// Nothing here touches a transcript. It answers "which conversation is this,
// and could you resume it from this device?" and stops.
import fs from 'node:fs';
import { metaPath } from './index-store';
import type { ChatsearchMetaEntry, ChatsearchMetaFile } from './index-format';
import type { ResolvedConversation, ChatsearchProvider } from '../../shared/chatsearch-refs';

const PROVIDERS: ChatsearchProvider[] = ['claude', 'native'];
// An id and nothing else. The CLI prints hex prefixes, so anything carrying a
// slash, a dot or a letter past `f` is not a short id and must not be used to
// go looking through a directory.
const QUERY_RE = /^[0-9a-f-]{4,36}$/;

/** The shape check both readers apply — refs-service keeps a cached async copy
 *  of this same file, and the two must agree on what counts as an index. */
export function asMetaFile(parsed: unknown): ChatsearchMetaFile | null {
  const p = parsed as ChatsearchMetaFile;
  return p && typeof p === 'object' && p.conversations && typeof p.conversations === 'object' ? p : null;
}

export function readMetaFile(dir: string, provider: string): ChatsearchMetaFile | null {
  try {
    return asMetaFile(JSON.parse(fs.readFileSync(metaPath(dir, provider), 'utf8')));
  } catch {
    // No index yet, or a refresh caught mid-write. Both are ordinary states,
    // and the caller reports every query as "unknown" rather than failing the
    // whole card.
    return null;
  }
}

export interface ResolveDeps {
  dir: string;
  /** buildLocalProjectResolver() from the conversations service, bound per call. */
  resolveLocal: (rec: { projectName: string; originalPath: string }) => string | null;
  /** Is the transcript materialized on THIS device under the local root? */
  transcriptExistsLocally: (provider: ChatsearchProvider, localPath: string, id: string) => boolean;
  /** ccProjectSlug for claude, nativeStoreSlug for native. */
  slugFor: (provider: ChatsearchProvider, localPath: string) => string;
}

export function resolveShortIds(queries: string[], deps: ResolveDeps): ResolvedConversation[] {
  const all: Array<{ provider: ChatsearchProvider; entry: ChatsearchMetaEntry }> = [];
  for (const provider of PROVIDERS) {
    const file = readMetaFile(deps.dir, provider);
    if (!file) continue;
    // The key is authoritative when the record's own id is missing — a
    // half-written entry must not resolve to the empty string and then match
    // every prefix query.
    for (const [id, entry] of Object.entries(file.conversations)) {
      all.push({ provider, entry: { ...entry, id: String(entry.id || id) } });
    }
  }
  return queries.map((q): ResolvedConversation => {
    if (!QUERY_RE.test(q)) return { status: 'unknown', query: q };
    // Same rule as the CLI: an exact id wins outright, otherwise a prefix has
    // to be unique. Without the exact-first pass, a full id that happens to
    // prefix a longer one would come back ambiguous.
    const exact = all.filter((c) => c.entry.id === q);
    const hits = exact.length ? exact : all.filter((c) => c.entry.id.startsWith(q));
    if (hits.length === 0) return { status: 'unknown', query: q };
    if (hits.length > 1) return { status: 'ambiguous', query: q, candidates: hits.map((h) => h.entry.id).sort() };
    const { provider, entry } = hits[0];
    const localPath = deps.resolveLocal({ projectName: entry.projectName, originalPath: entry.originalPath });
    const here = localPath ? deps.transcriptExistsLocally(provider, localPath, entry.id) : false;
    return {
      status: 'ok',
      id: entry.id,
      provider,
      title: entry.title || '',
      projectName: entry.projectName || '',
      originalPath: entry.originalPath || '',
      lastActive: entry.lastActive || '',
      createdAt: entry.createdAt || '',
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      complete: !!entry.complete,
      tombstone: !!entry.tombstone,
      projectSlug: localPath ? deps.slugFor(provider, localPath) : '',
      projectPath: localPath ?? '',
      // Two DISTINCT blocked states, worded by the renderer exactly as the
      // Resume Browser words them: the project folder is not on this device at
      // all, versus the folder is here but this conversation has not arrived.
      missingProject: !localPath,
      notSyncedYet: !!localPath && !here,
    };
  });
}
