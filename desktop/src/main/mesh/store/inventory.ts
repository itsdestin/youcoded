// Inventory of EVERY file the chat store writes under its root (review 3, class fix A.2; extended by reviews 4 and 5; rewritten by the "restructure" after review 8).
//
// ============================================================================================================================================================================
// THE INVARIANT (restructure, after four rounds of findings in one place): A VERSION FOLDER IS APPEND-ONLY IN HISTORY.
//   Its line N, once acknowledged, is the same bytes forever. A version never shortens, never has a line replaced and never changes history. A takeover (a new host continuing a chat from line N)
//   creates a NEW version folder holding lines [0, N) of the old one (store.ts forkVersion); the old folder is not touched and IS the kept "other ending" of design section 2. A version that is
//   damaged is RETIRED, never refilled under the same id (asides.ts); the replicator recopies into a new id.
// WHAT FOLLOWS: any OLDER copy of any file of a version folder (index, checkpoint, a body chunk, a park, the high-water record) is a PREFIX-STATE of the truth. It is already handled by what every file
//   carries anyway (checksums, chain values, the envelope, the high-water record outside the folder): an older file says LESS, never something DIFFERENT. So no file has to prove which history it
//   belongs to: a folder has exactly one. A file that disagrees with the verified bodies in a way no prefix-state can explain is not a copy of this version's past: the version is quarantined (retired).
// RECOVERY RULE (one rule): the BODIES, checked against their chain values, are the truth; the index, the checkpoint, the summary and the scrub mark are derivable from them. A file that agrees with a
//   prefix of the bodies is repaired (rewritten level with the head, or the shorter side reported as lines that are missing); a file that disagrees and cannot be re-derived from verified bodies means
//   quarantine. Nothing here ever picks between two histories, because there are never two.
// ============================================================================================================================================================================
//
// WHY this exists: review rounds 1-3 each found a critical bug because a fix added on-disk state that was neither protected nor tested. Round 4 found the NEXT shape of the same class: a file that is
// internally VALID but is the WRONG one, which no checksum can see. So every row now answers FIVE questions, and the answer to each is always "non-destructive": the store never deletes or hides
// something it holds, and never reports fewer acknowledged items without saying so.
//
//   rotted      some bytes are wrong (a flipped bit, a zeroed range, garbage)
//   older       an OLDER valid copy of the same file has been put back (a restored backup, a rollback): a prefix-state, see above
//   foreign     a valid copy that belongs to ANOTHER chat / version has been put in its place (a SIXTH wrong file: a valid file of the SAME KIND that is not this one, another park position, another chunk)
//   missing     the file is gone
//   truncated   the file was cut short at a clean boundary (a record, a slot, a line) so nothing in it fails a checksum
//
// THE ENVELOPE RULE (review 5): every small file the store writes goes through ONE helper (envelope.ts) and carries, inside its checksum, its ROLE, the VERSION KEY (or chat hash) it belongs to, the
// POSITION or ID it stands for (a park's line number and line hash) and where it applies a FRESHNESS counter (a slot's sequence number). The reader compares every field with what the caller expects; a
// mismatch is `foreign` (a typed result): the file is kept, never adopted, never deleted. The binary files are the same rule in fixed width: the index header and the checkpoint slots (magic = role,
// version tag, record position / count, sequence number), the body chunks (the chain values), the extras (the name IS the content hash) and the control log (entry id = hash of body, the entry names its chat).
// `matrix.test.ts` walks this table: for EVERY kind it swaps in a valid same-kind file from the same folder and from a differently-seeded folder, so a new kind cannot skip it.
//
// The other mechanisms behind the answers:
//   freshness  what must be CURRENT (which lines were evicted on purpose, the chain state at that boundary) lives only in the checkpoint, rewritten in place at every acknowledgement;
//   anchor     a file that can lose a whole tail without any bad byte (the control log, the extras folder) has a second record (control anchor, extras manifest) of what was acknowledged;
//   evidence   a destructive act (unlink of an evicted chunk, a body cut) needs CURRENT, cross-checked evidence: an unlink happens only inside evictBody under a proof just verified, a cut of
//              surplus body only after the index was checked against the checkpoint, and the cut bytes are copied to torn/ first;
//   witness    the HIGH-WATER record (highwater/<version>.hw, outside every chat folder) remembers the highest head the store ever stated: it makes a whole folder put back REPORTED, and proves an
//              eviction that an older checkpoint forgot. It only ever raises (a version never shortens), is written after the lines are durable, and a stale, missing or foreign one can only UNDER-report;
//   retirement the aside/<vhex>-<n>/ folder outside the version folder plus retired.json inside it say "this id is retired" (asides.ts); putting old files back changes neither.
//
// FILE KINDS (restructure: 35 kinds, down from 38; gone: tails/*.tail, *.begun, *.done, aside.intent, aside.intent.bad-N and the quarantine half of marks.bin; new: retired.json and forks/<childhex>/):
//   per version folder  meta.json meta.copy | index.bin | body-<offset>.bin | checkpoint.bin | summary.json scrub.json | marks.bin (the partial marker only) | retired.json (only once retired) |
//                       parked/ rejected/ (parks, kept) | torn/ healed/ replaced-index/ (kept raw bytes) | *.bad-N *.tmp-* (kept / scratch)
//   per store           FORMAT LOCK | highwater/<vhex>.hw | aside/<vhex>-<n>/ (+COMPLETE) | forks/<childhex>/ (an INVISIBLE half-built fork, cleared at open) | extras/ extras-bad/ | control/<chathash>/
//
// HONEST LIMITS (the only places where a single fault costs something, and what is guaranteed anyway):
//   (1) a fault that destroys the ONLY copy of some bytes (a body chunk, a rejected park, a control log, an extra) destroys them; it is always REPORTED and never served wrong;
//   (2) after an eviction AND the loss of the whole index (every kept copy too) the chain values of the evicted lines are gone for good: the checkpoint kept the state AT the boundary, so the kept lines
//       are re-derived from their bodies and served, hashAt(n) for an evicted n before the boundary answers `evicted`, and a restoreBody brings everything back and re-derives the index;
//   (3) parked appends are provisional by definition (the caller keeps ownership until the head passes them); a lost parked file is not reported;
//   (4) WHAT REMAINS UNDETECTABLE: a rollback of the WHOLE STORE ROOT (the high-water record and the aside folders go back with it), a rollback to a head the record never saw (it is raised at the END of an append call
//       once the head is HW_EVERY = 256 lines past the mark, at close and at every eviction and restore: after any ACKNOWLEDGED call the record is at most 255 lines behind; sixth-round.test.ts pins the 255/256 boundary),
//       and ALL of a version's files put back older TOGETHER with its high-water record lost or older: that is a whole-folder rollback and reads as a shorter, healthy chat. (Fewer lines, never different lines.)
//   (5) a retired id whose aside folder AND retired.json are both deleted is two faults.
// The two ways a version can be wrong are therefore: SHORTER (a prefix-state: reported through the high-water record, a hole, a partial marker, or not at all within limit 4) or DAMAGED (quarantined). The
// store never serves a different line at an index it once acknowledged, and `read()` refuses any line that `head().damagedFromLine` covers.
//
// RESUME NOTES (for a successor): restructure branch work is in commits "Mesh store restructure: ..." on session/64-mesh-sync-build; tests listed in the commit messages; fuzz oracle rewrite is the last step.
//
// `inventory.test.ts` fails when the store writes a name that has no row; `fuzz.test.ts` and `matrix.test.ts` apply each of the five faults to every file of a real folder.
//
// Paths are relative to the store root with `/` separators. Version files appear under versions/<vhex>/ and, moved whole, under aside/<name>/.
interface InventoryAnswers { rotted: string; older: string; foreign: string; missing: string; truncated: string }
export interface InventoryRow {
  id: string;
  pattern: RegExp;
  /** How damage is detected. */
  protection: string;
  /** What each kind of wrong file means. Always non-destructive. */
  answers: InventoryAnswers;
}

const A = (rotted: string, older: string, foreign: string, missing: string, truncated: string): InventoryAnswers => ({ rotted, older, foreign, missing, truncated });
const VF = (id: string, name: string, protection: string, answers: InventoryAnswers): InventoryRow => ({ id, pattern: new RegExp(`^${name}$`), protection, answers });
const SCRATCH = A('never read', 'never read', 'never read', 'nothing depends on it', 'never read');
const KEPT = A('never read back as truth', 'never read back as truth', 'never read back as truth', 'only a kept extra copy is gone; the live data is untouched', 'never read back as truth');

/** Rows for files that live inside one version folder (or one aside/<name>/ folder). */
export const VERSION_ROWS: InventoryRow[] = [
  VF('meta.json', 'meta\\.json', 'checksummed envelope carrying the version key; a second copy in meta.copy',
    A('the other copy is used and the bad one replaced (old bytes kept as *.bad-N)', 'identical: a registration never changes', 'a copy of another version\'s meta names another version key: counts as a bad copy, the other one is used', 'the other copy is used and this one rewritten', 'a cut envelope fails its checksum: as rotted')),
  VF('meta.copy', 'meta\\.copy', 'checksummed envelope carrying the version key; second copy of meta.json', A('as meta.json', 'as meta.json', 'as meta.json', 'as meta.json', 'as meta.json')),
  VF('meta.bad', 'meta\\.(json|copy)\\.bad-\\d+', 'none (kept raw copy of a bad meta file)', KEPT),
  VF('index.bin', 'index\\.bin', 'a header with a checksum and the version tag; a CRC per record; chained hashes; cross-checked with the checkpoint at every load',
    A('bad header or classifier stamp: rebuilt KEEPING every valid record; a bad record: re-derived from the body and confirmed by the next valid record or the checkpoint; the old file is kept in replaced-index/',
      'shorter than the checkpoint: re-derived from the bodies and confirmed by the checkpoint\'s chain value; never shorter than what was acknowledged without that being repaired',
      'the header tag names another version: none of its records is used; the index is re-derived from this version\'s own bodies and confirmed by its own checkpoint; no body is cut (the check against the checkpoint comes before any surplus is moved)',
      'rebuilt from the bodies and confirmed by the checkpoint; after an eviction the checkpoint\'s boundary state stands in for the lost evicted-lines records (limit 2): every kept line is served',
      'a cut inside a record is a torn tail (kept in torn/, then cut); a cut at a record boundary is an older copy (see older)')),
  VF('index.rebuild', 'index\\.rebuild', 'none (scratch, always re-derivable)', SCRATCH),
  VF('body', 'body-[0-9a-f]{16}\\.bin', 'every line is hashed into the chain stored in the index records and the checkpoint',
    A('the bad line is reported (read throws `corrupt`, head.damagedFromLine), its bytes stay, every other line is served, a resend heals it',
      'an older copy is shorter or the same bytes: lines past its end are a hole (see truncated)',
      'its lines fail their chain values one by one: reported like rot; nothing is served wrong; a resend heals them',
      'a hole: every line wholly inside another chunk file is served, the lines in the hole are reported damaged (never relabelled as evicted), nothing is set aside, a correct resend writes them back; below the evicted bytes it is an eviction and nothing',
      'lines up to the cut are served, the rest are a hole as above; appends start a new chunk at the head')),
  VF('checkpoint.bin', 'checkpoint\\.bin', 'two checksummed slots, each with a sequence number, the version tag, the head\'s chain values, the eviction state AND the chain state at the eviction boundary (review 5), rewritten in place before each acknowledgement',
    A('one bad slot: the other is used and the bad one rewritten at load', 'an older statement is a PREFIX-STATE (shorter, agreeing with the index at its own count): read like a crash between index and checkpoint, the index (cross-checked) is newer and the file is rewritten level with it; an older eviction state that is still true (the bodies really are gone) is used; one that a restore undid is vetoed by the holders\' note and the lines are served; a newer eviction forgotten by an older statement reads the evicted prefix as damaged, never as served wrongly', 'a slot carrying another version\'s tag is not evidence (as missing)', 'no evidence: lines the index cannot vouch for are reported, never trusted, never dropped; the eviction state is unknown, so evicted lines are reported damaged until a resend or restoreBody', 'one slot cut off: the other; both cut: as missing')),
  VF('summary.json', 'summary\\.json', 'checksummed envelope carrying the version key', A('recomputed from the index and bodies', 'lines after its count are replayed from the index', 'counts as bad: recomputed', 'recomputed', 'counts as bad: recomputed')),
  VF('scrub.json', 'scrub\\.json', 'checksummed envelope carrying the version key', A('the integrity scrub starts again at line 0', 'the scrub re-checks lines it already checked', 'counts as bad: starts again', 'starts again', 'counts as bad: starts again')),
  VF('marks.bin', 'marks\\.bin', 'ONE two-slot file written in place like the checkpoint (slotfile.ts), each slot inside the envelope: role, version key, sequence number; holds the partial marker only',
    A('one bad slot: the other is used and the next write replaces the bad one; no valid slot: the version is reported damaged from its head (partial)', 'a lower sequence number loses to the newer slot; an older whole file says an older marker: a false alarm at worst, never a loss', 'another version\'s marks file is `foreign`: counts as bad', 'a lost partial marker is two faults (the lines stay in torn/)', 'a slot cut short is bad: the other slot is used')),
  VF('marks.bad', 'marks\\.bin\\.bad-\\d+', 'none (kept raw copy)', KEPT),
  VF('retired', 'retired\\.json', 'checksummed envelope carrying the version key; written once, right after the aside/ folder is made (asides.ts); only its EXISTENCE counts, its content (the aside name, the reason) is for humans',
    A('still retired (a damaged note of this name is still the signal; the aside folder is found by name)', 'the same statement: retirement never changes', 'a note sealed for another version still retires this one (loud and typed, nothing is lost: the id just needs a recopy)', 'the aside/ folder (outside this folder, never deleted) still says retired: a lost note is one fault', 'counts as rotted')),
  VF('parked', 'parked/\\d{16}-[0-9a-f]{16}\\.park', 'the envelope: role, version key and an id of POSITION and LINE HASH sealed inside the checksum; the drain compares the id with the name and the hash with the lines. A park belongs to ONE version id; its history cannot change',
    A('moved to rejected/ (kept); a resend parks again', 'parked files never change: the same bytes', 'another version, another position or another lines-hash than the name says: a swapped or overwritten park: moved to rejected/ (kept), never applied; the head stays where it is, so the true lines are still wanted', 'provisional by definition (limit 3): the caller keeps ownership until the head passes it', 'fails the CRC: as rotted')),
  VF('rejected', 'rejected/((conflict|damaged|released)--)?(older-\\d+-)?\\d{16}-[0-9a-f]{16}\\.park', 'length-framed lines with a CRC', KEPT),
  VF('torn', 'torn/\\d{6}-(index-tail|body|checkpoint)', 'none (raw bytes the store moved out of the way; only ever copies of unacknowledged or damaged bytes)', KEPT),
  VF('healed', 'healed/line-\\d+-\\d+\\.bin', 'none (raw bytes of a line a resend replaced)', KEPT),
  VF('replaced-index', 'replaced-index/index-\\d{4}\\.bin', 'a CRC per record and the same header as an index (it is a former index)', A('only one more source of chain values for a rebuild, read through its own checksums', 'as rotted', 'a foreign one is skipped by its header tag', 'only a kept extra copy is gone', 'as rotted')),
  VF('tmp', '.+\\.tmp-\\d+-\\d+', 'none (an interrupted atomic write)', A('swept at open', 'swept at open', 'swept at open', 'n/a', 'swept at open')),
];

const versionAlt = VERSION_ROWS.map((r) => r.pattern.source.slice(1, -1)).join('|');

export const ROOT_ROWS: InventoryRow[] = [
  { id: 'FORMAT', pattern: /^FORMAT$/, protection: 'one line with a CRC', answers: A('kept as FORMAT.bad-N and rewritten (a different format number with a good CRC still refuses to open)', 'a constant: the same bytes', 'another store\'s FORMAT with a good CRC and another number refuses to open; the same number is identical', 'rewritten', 'fails its CRC: as rotted') },
  { id: 'FORMAT.bad', pattern: /^FORMAT\.bad-\d+$/, protection: 'none (kept raw copy)', answers: KEPT },
  { id: 'LOCK', pattern: /^LOCK(\.takeover|\.new-\d+-[0-9a-f]+)?$/, protection: 'JSON with a token, written whole through a hard link', answers: A('unreadable: treated as stale after 30 s; never data', 'a lock from before: its holder is checked, then stale', 'as older', 'no lock held', 'as rotted') },
  { id: 'highwater', pattern: /^highwater\/[0-9a-f]{2,128}\.hw$/, protection: 'a two-slot file written in place (slotfile.ts) inside the envelope: role, version key, sequence; per version the highest line count the store ever stated and the chain value at a few earlier counts; kept OUTSIDE the chat folders so a folder put back cannot take it along',
    answers: A('one bad slot: the other is used; none: no evidence (the record can only under-report)', 'an older record names a lower count: it can only under-report', 'another version\'s record is `foreign`: no evidence', 'no evidence: a rolled-back folder is then NOT reported (documented limit)', 'a cut slot is bad: no evidence') },
  { id: 'versions', pattern: new RegExp(`^versions/[0-9a-f]{2,128}/(${versionAlt})$`), protection: 'see the version rows', answers: A('see the version rows', 'see the version rows', 'see the version rows', 'see the version rows', 'see the version rows') },
  { id: 'forks', pattern: new RegExp(`^forks/[0-9a-f]{2,128}/(${versionAlt})$`), protection: 'an invisible work folder of forkVersion (store.ts crash table): never listed, loaded or read; every file in it is cleared at open and by a retry', answers: A('cleared', 'cleared', 'cleared', 'n/a', 'cleared') },
  { id: 'retired-root', pattern: /^retired\/[0-9a-f]{2,128}\.ret$/, protection: 'checksummed envelope carrying the version key; written once when an id is retired (asides.ts); only its EXISTENCE counts', answers: A('still retired (a damaged record of this name is still the signal)', 'the same statement: retirement never changes', 'a record sealed for another version still retires this one (loud and typed, nothing is lost)', 'the aside folder and retired.json still say retired: a lost record is one fault, and a retention job removing aside folders and retired version folders cannot bring the id back', 'counts as rotted') },
  { id: 'aside', pattern: new RegExp(`^aside/[0-9a-f]+-q?\\d+/(${versionAlt})$`), protection: 'moved version files, same rows', answers: KEPT },
  { id: 'aside-complete', pattern: /^aside\/[0-9a-f]+-q?\d+\/COMPLETE$/, protection: 'existence only (its text is the reason, for humans); written last, after every file has moved into the aside folder', answers: A('n/a', 'n/a', 'n/a', 'the move is finished again (every step is repeatable); the version stays retired', 'n/a') },
  { id: 'extras', pattern: /^extras\/[0-9a-f]{2}\/[0-9a-f]{64}$/, protection: 'the file name is the SHA-256 of its bytes; extras/manifest.bin records that it was stored',
    answers: A('moved to extras-bad/ (kept), reported `corrupt` once, then reads as absent until a peer copy is put', 'the same bytes (content-addressed)', 'a blob filed under another name fails its hash: as rotted', 'recorded in the manifest as stored: reads throw `corrupt` (typed), never "never had it"; a peer copy put back repairs it', 'fails its hash: as rotted') },
  { id: 'extras-manifest', pattern: /^extras\/manifest\.bin$/, protection: 'checksummed 37-byte records (add or remove, one hash each)', answers: A('that record is skipped: only the evidence for one blob is lost', 'records only ever add or remove: the blobs found in the folder are added back at the first read in a run', 'every blob it names is checked by its own hash; unknown names are harmless', 'rebuilt from the folder at the first read in a run (limit 1 for a blob deleted at the same time)', 'a cut record is ignored; the folder scan adds back what is missing') },
  { id: 'extras-bad', pattern: /^extras-bad\/[0-9a-f]{64}-\d+$/, protection: 'none (kept raw copy)', answers: KEPT },
  { id: 'extras-tmp', pattern: /^extras\/[0-9a-f]{2}\/[0-9a-f]{64}\.tmp-\d+-\d+$/, protection: 'none (interrupted write)', answers: A('swept', 'swept', 'swept', 'n/a', 'swept') },
  { id: 'control-log', pattern: /^control\/[0-9a-f]{64}\/log\.bin$/, protection: 'each record: header CRC, payload CRC, entry id = SHA-256 of its body, and the entry names its chat; plus anchor.json (count and id-hash sum of what was acknowledged)',
    answers: A('a bad record is skipped and reported (controlDamage), later records are served; a zero-filled tail is a torn write (cut, kept)', 'fewer entries than the anchor: REPORTED by controlDamage as lost entries; the entries that are there are served', 'a record that names another chat is skipped and reported; the entries missing from this log are reported against the anchor', 'a missing log against an anchor that counts entries: REPORTED (limit 1: the entries are gone); quarantineControl clears the report', 'a cut at a record boundary is an older copy; a cut inside a record is a torn tail (kept, then cut); both REPORTED against the anchor') },
  { id: 'control-anchor', pattern: /^control\/[0-9a-f]{64}\/anchor\.(json|copy)$/, protection: 'two checksummed copies (anchor.json, anchor.copy) naming the chat; replaced atomically after every append; the copy that counts more entries is the newer', answers: A('the other copy is used and the bad one rewritten (a reported loss stays reported); with neither: no evidence, rewritten from the log', 'the newer copy wins; behind the log: rewritten forward (the log is intact)', 'names another chat: counts as bad, the other copy is used', 'the other copy is used and this one rewritten', 'counts as rotted') },
  { id: 'control-kept', pattern: /^control\/[0-9a-f]{64}\/(torn-\d+|quarantine-\d+)\.bin$/, protection: 'none (kept raw bytes)', answers: KEPT },
  { id: 'control-parked', pattern: /^control\/[0-9a-f]{64}\/parked\/[0-9a-f]{64}\.ent$/, protection: 'length + CRC frame, entry id = SHA-256 of its body, the entry names its chat', answers: A('not applied, left in place', 'parked entries never change', 'an entry that names another chat is not applied, left in place', 'provisional by definition (limit 3)', 'fails its CRC: as rotted') },
  { id: 'control-tmp', pattern: /^control\/[0-9a-f]{64}\/(parked\/)?.+\.tmp-\d+-\d+$/, protection: 'none (interrupted write)', answers: A('swept', 'swept', 'swept', 'n/a', 'swept') },
];

/** The id of the first row that names `rel`, or null when the store should never have written such a file. */
export function inventoryRow(rel: string): string | null {
  const r = rel.split('\\').join('/');
  for (const row of ROOT_ROWS) if (row.pattern.test(r)) return row.id;
  return null;
}

/**
 * The FINE row id of a file: for a file inside a version folder (or a moved aside copy) the id of its version row ('parked', 'tails', 'marks.bin', ...), not just 'versions'.
 * WHY (review 5): the generic sibling-swap test walks this to swap in a valid sibling of the SAME kind for every kind the scenario wrote, so a future file kind cannot skip the test.
 */
export function inventoryKind(rel: string): string | null {
  const r = rel.split('\\').join('/');
  const m = /^(?:versions\/[0-9a-f]{2,128}|aside\/[0-9a-f]+-q?\d+)\/(.+)$/.exec(r);
  if (m) { for (const row of VERSION_ROWS) if (row.pattern.test(m[1])) return row.id; return null; }
  return inventoryRow(r);
}

/** Every row id (version rows and root rows) a file can have. */
export const ALL_KIND_IDS: string[] = [...VERSION_ROWS.map((r) => r.id), ...ROOT_ROWS.filter((r) => r.id !== 'versions' && r.id !== 'aside' && r.id !== 'forks').map((r) => r.id)];
