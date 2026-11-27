// The backstop for what no local gate can see (review 3, design decision of the lead): a writer that has signed TWO different histories for one version (the usual cause: it was restored from an old backup and
// chatted before it could hear the other devices). Nothing is discarded anywhere, and nothing waits for a person:
//   * the history the peers hold under earlier signatures STAYS under version V;
//   * the writer moves its newer lines (from the first line where the histories part, `p`) into a second version V2 = fork of V at p, announces V2 with an ordinary writer-signed announcement whose token
//     marks it a SELF-FORK, then brings its own copy of V back to the peers' history (verified like any receiver would), and goes on as the writer of both;
//   * a peer that holds a contradicted copy keeps it under a named, non-calm state and resolves it on the writer's announcement: a peer that held the old history just carries on; a peer that held only the newer
//     history replaces it under V (setting its copy aside, never deleting) once it holds the same lines verified under V2.
// Which version is "current" is NOT decided here (the control log will); both are exposed (`Replicator.selfForks`).
// WHY an announcement is the statement: it is signed by V's writer, names V (parent), the divergence point and the chain value there (forkLine, forkHash) and V2 (the id is derived from all of them), and its
// token carries the writer's id and the domain word below. A non-writer cannot sign it; a replay in another version, chat or incarnation changes the derived id or the signed text.
import { createHash } from 'node:crypto';

const SELF_FORK = 'selffork';

/** The token of a self-fork announcement: the writer's id, the domain word, then the chat id (so the same divergence point in another chat derives another version). */
export const selfForkToken = (writer: Buffer, chatId: string, tail = ''): string => `${writer.toString('hex')}:${SELF_FORK}:${createHash('sha256').update(chatId).digest('hex').slice(0, 16)}${tail ? `:${tail}` : ''}`;
export const isSelfForkToken = (writer: Buffer, token: string | null): boolean => token !== null && token.startsWith(`${writer.toString('hex')}:${SELF_FORK}:`);

/** What the writer keeps on disk while it moves lines, so a crash at any file operation can be finished (never repeated wrongly): `inc` is V's incarnation when the move began. */
export interface SelfForkJournal { p: number; hp: string; v2: string; token: string; inc: number; stage: 'start' | 'copied' | 'done' }
// WHY THE TARGET IS CHOSEN, NOT ASSUMED (review 4, F1): the id of the second version depends on the writer's head (a tail in the token) and, when a version with that id already exists here, on a counter, and the copy
// into it is only ever made onto a version that is empty or whose content is EXACTLY the prefix being copied (same chain value at its head). Content that differs is never appended onto: a fresh id is derived instead.
