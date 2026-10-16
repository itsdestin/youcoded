// Task 12 (spec §8 OQ, plan Task 12): pin how the mirror-in sweep BUCKETS a
// materialized transcript when a session already has a conversation record.
//
// Investigation verdict (Step 1, DONE): reconciler.ts's resolveProjectName
// (~lines 63-69) resolves in this order:
//   1. existing?.projectName        — the session's RECORD wins
//   2. slugToName.get(slug.toLower) — known-folder exact basename (re-slug match)
//   3. projectNameFromSlug(slug)    — lossy last-segment fallback
// RECORD-KEYED, not directory-keyed. A planned data repair (case-C aftermath,
// spec §6.0) builds on "record wins" — this test is the guard that keeps it
// true. Fixture style mirrors tests/conversation-reconciler.test.ts (real tmp
// dirs, real store, no fs mocking).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { reconcile } from '../src/main/conversations/reconciler';
import { ccProjectSlug } from '../src/main/slug-encoding';
import {
  createConversationStore,
  type ConversationStore,
} from '../src/main/conversations/conversation-store';

const SID = '33333333-3333-4333-8333-333333333333';

function jsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n';
}

// Same shape as conversation-reconciler.test.ts's writeTranscript: a >500-byte
// transcript with a parseable tail timestamp, so it clears both the junk gate
// and the corrupt-transcript guard.
function writeTranscript(projectsDir: string, slug: string, sid: string, lastTimestamp: string): string {
  const dir = path.join(projectsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  let content = '';
  content += jsonlLine({ type: 'user', isMeta: true, uuid: 'm1', timestamp: '2026-06-01T10:00:00Z', message: { content: 'meta noise' } });
  content += jsonlLine({
    type: 'user', uuid: 'u1', promptId: 'p1', timestamp: '2026-06-01T10:00:01Z',
    message: { content: 'fix the slug repair sweep' },
  });
  content += jsonlLine({
    type: 'assistant', uuid: 'a1', timestamp: lastTimestamp,
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done. '.repeat(40) }] },
  });
  fs.writeFileSync(file, content);
  return file;
}

let tmp: string;
let projectsDir: string;
let topicsDir: string;
let store: ConversationStore;
let mirror: ReturnType<typeof vi.fn<(localJsonlPath: string, projectKey: string, sessionId: string) => void>>;

// Anchor everything to a CONSTRUCTED tree: the slug dir name is
// ccProjectSlug(knownFolderPath), and the known folder's basename is
// deliberately DIFFERENT from any slug-derived name ('wronghint'), so tier 2
// (slugToName) and tier 3 (last-segment truncation) would both disagree with
// tier 1 (the record). Every expected value below is a literal from this
// construction, never something read back from the reconciler's own output.
const KNOWN_FOLDER = path.join('C:', 'Users', 'someone', 'wronghint');
const SLUG = ccProjectSlug(KNOWN_FOLDER); // e.g. 'C--Users-someone-wronghint'
const TRANSCRIPT_TIMESTAMP = '2026-06-20T12:00:00Z';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-sweep-keying-'));
  projectsDir = path.join(tmp, '.claude', 'projects');
  topicsDir = path.join(tmp, '.claude', 'topics');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(topicsDir, { recursive: true });
  store = createConversationStore(path.join(tmp, 'conversations'));
  mirror = vi.fn<(localJsonlPath: string, projectKey: string, sessionId: string) => void>();
});

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe('reconcile — sweep bucketing keys off the record, not the slug directory', () => {
  it('tier 1: an existing record\'s projectName wins over a competing tier-2 known-folder hint', async () => {
    // Pre-seed a record for this session with a DIFFERENT project name than
    // both the known-folder basename ('wronghint') and anything slug-derived,
    // and an OLDER lastActive than the transcript, so the upsert branch runs
    // (not the freshness-skip branch) and resolveProjectName is exercised on
    // the live path, not just the mirror-only skip path.
    await store.upsert({
      id: SID, provider: 'claude', projectName: 'RealProj',
      device: 'OldDevice', lastActive: '2026-06-01T00:00:00.000Z', title: 'Existing',
    });
    writeTranscript(projectsDir, SLUG, SID, TRANSCRIPT_TIMESTAMP);

    const n = await reconcile({
      projectsDir, topicsDir, store, device: 'NewDevice', mirror,
      // A known folder whose ccProjectSlug ALSO equals SLUG but whose basename
      // is 'wronghint' — stresses the `||` short-circuit: with a genuine
      // tier-2 candidate present, only real tier-1 preference (existing
      // record truthy) should stop resolveProjectName from falling through.
      knownFolders: [KNOWN_FOLDER],
    });

    expect(n).toBe(1);
    const rec = await store.get('claude', SID);
    expect(rec).not.toBeNull();
    expect(rec!.projectName).toBe('RealProj');
    expect(rec!.transcriptRef).toBe(`claude/transcripts/RealProj/${SID}.jsonl`);

    // The injected mirror callback must receive the SAME record-derived key —
    // not the known-folder basename, not a slug-derived name.
    expect(mirror).toHaveBeenCalledTimes(1);
    expect(mirror).toHaveBeenCalledWith(
      path.join(projectsDir, SLUG, `${SID}.jsonl`),
      'RealProj',
      SID,
    );
  });

  it('tier 2: with NO existing record, the same known-folder hint DOES win (proves tier 1 genuinely engaged above)', async () => {
    // No pre-existing record this time — resolveProjectName's tier 1
    // (existing?.projectName) is falsy, so it must fall through to tier 2
    // (slugToName from knownFolders), landing 'wronghint'. If this variant
    // did NOT bucket under 'wronghint', variant A's 'RealProj' result would be
    // ambiguous (it could mean tier 1 never even got a chance to compete).
    writeTranscript(projectsDir, SLUG, SID, TRANSCRIPT_TIMESTAMP);

    const n = await reconcile({
      projectsDir, topicsDir, store, device: 'NewDevice', mirror,
      knownFolders: [KNOWN_FOLDER],
    });

    expect(n).toBe(1);
    const rec = await store.get('claude', SID);
    expect(rec).not.toBeNull();
    expect(rec!.projectName).toBe('wronghint');
    expect(rec!.transcriptRef).toBe(`claude/transcripts/wronghint/${SID}.jsonl`);
    expect(mirror).toHaveBeenCalledWith(
      path.join(projectsDir, SLUG, `${SID}.jsonl`),
      'wronghint',
      SID,
    );
  });
});
