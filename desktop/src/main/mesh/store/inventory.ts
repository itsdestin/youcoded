// Inventory of EVERY file the chat store writes under its root (review 3, class fix A.2; extended by review 4).
//
// WHY this exists: review rounds 1-3 each found a critical bug because a fix added on-disk state that was neither protected nor tested. Round 4 found the NEXT
// shape of the same class: a file that is internally VALID but is the WRONG one, which no checksum can see. So every row now answers FIVE questions, and the answer to
// each is always "non-destructive": the store never deletes or hides something it holds, and never reports fewer acknowledged items without saying so.
//
//   rotted      some bytes are wrong (a flipped bit, a zeroed range, garbage)
//   older       an OLDER valid copy of the same file has been put back (a restored backup, a rollback)
//   foreign     a valid copy that belongs to ANOTHER chat / version has been put in its place
//   missing     the file is gone
//   truncated   the file was cut short at a clean boundary (a record, a slot, a line) so nothing in it fails a checksum
//
// A SIXTH wrong file (review 5): a valid file of the SAME KIND that is not this one (another park position, another tail id, another chunk). It is covered by the same rule, below.
//
// THE ENVELOPE RULE (review 5, the end of five rounds of "a file that does not state what it is"): every small file the store writes goes through ONE helper (envelope.ts) and carries, inside its
// checksum, its ROLE, the VERSION KEY (or chat hash) it belongs to, the POSITION or ID it stands for (a park's line number and line hash, a tail's takeover id), and where it applies a FRESHNESS
// counter (a slot's sequence number). The reader compares every field with what the caller expects; a mismatch is `foreign` (a typed result): the file is kept, never adopted, never deleted.
// No file is interpreted from its name alone. The binary files are the same rule in fixed width: the index header and the checkpoint slots (magic = role, version tag, record position / count,
// sequence number), the body chunks (the chain values), the extras (the name IS the content hash) and the control log (entry id = hash of body, the entry names its chat).
// `matrix.test.ts` walks this table: for EVERY kind it swaps in a valid same-kind file from the same folder and from a differently-seeded folder, so a new kind cannot skip it.
//
// The other mechanisms behind the answers:
//   freshness  what must be CURRENT (which lines were evicted on purpose, the chain state at that boundary) lives only in the checkpoint, rewritten in place at every acknowledgement;
//   anchor     a file that can lose a whole tail without any bad byte (the control log, the extras folder) has a second record (control anchor, extras manifest) of what was acknowledged;
//   evidence   a destructive act (unlink of an evicted chunk, a body cut) needs CURRENT, cross-checked evidence: an unlink happens only inside evictBody under a proof just verified, a cut of
//              surplus body only after the index was checked against the checkpoint, and the cut bytes are copied to torn/ first;
//   witness    the HIGH-WATER record (highwater/<version>.hw, outside every chat folder) remembers the highest head the store ever stated: it makes a whole folder put back REPORTED, and proves an
//              eviction that an older checkpoint forgot. It only ever raises (except where the store itself shortens a version), is written after the lines are durable, and a stale, missing or
//              foreign one can only UNDER-report.
// HONEST LIMITS (the only places where a single fault costs something, and what is guaranteed anyway):
//   (1) a fault that destroys the ONLY copy of some bytes (a body chunk, a tail, a rejected park, a control log, an extra) destroys them; it is always REPORTED and never served wrong;
//   (2) after an eviction AND the loss of the whole index (every kept copy too) the chain values of the evicted lines are gone for good: the checkpoint kept the state AT the boundary, so the kept lines
//       are re-derived from their bodies and served, hashAt(n) for an evicted n before the boundary answers `evicted`, and a restoreBody brings everything back and re-derives the index;
//   (3) parked appends are provisional by definition (the caller keeps ownership until the head passes them); a lost parked file is not reported;
//   (4) WHAT REMAINS UNDETECTABLE: a rollback of the WHOLE STORE ROOT (the high-water record goes back with it), a rollback to a head the record never saw (it is raised at the END of an append call once the head is
//       HW_EVERY = 256 lines past the mark, at close and at every eviction and restore: after any ACKNOWLEDGED call the record is at most 255 lines behind, and a snapshot taken while a call is still in flight can be 255 plus that call's
//       size ahead of it; review 6 B3 corrected the old wording "up to 255"; sixth-round.test.ts pins the 255/256 boundary), and a set-aside tail or extra created after a rolled-back folder's state (they go with the folder;
//       the rolled-back HEAD is the report), plus (round 7) ALL of a version's files put back older together with its tails/ also gone and the high-water record also lost or older, and a restore from before a
//       quarantine (the quarantine resets the high-water head to 0 on purpose).
//
// THE HISTORY RULE (review 6, B1; widened in round 7): a version's line N can change only through a takeover (setAsideTail) or a quarantine / set-aside followed by a recopy, and a parked append is only
// ever drained onto the history it was parked against. The history is named by the takeovers' `.begun` markers AND the version's aside folders (tails.ts readEpoch, read from disk), sealed into every park, and
// checked at every drain; at a takeover or a quarantine the old parks are also moved to rejected/ (kept, with the reason in the file name: takeover, quarantine, stale-history, conflict, damaged, released; head().rejectedParks
// counts them). Eviction and restore refill the SAME lines, so they are not history changes. (Rounds 6 and earlier said a quarantine and a recopy were not history changes: that was wrong, a peer's recopy can be another history.)
// What the store does NOT know: who sent a late park (the replicator must fence a deposed host before append(), store.ts).
// The tail's own rule (B2): the intent marker is written after the tail is durable and BEFORE the cut or any park is touched. Round 7 (F3): the takeover is also COUNTED in the high-water record (outside the chat
// folder) before the cut, so losing the tail and its markers, or the whole tails/ folder, is seen as "recorded more than shown" (head().lostTakeovers) and answered with `corrupt`, never with an empty tail.
// THE OVERRIDE RULE (round 7, F1): when a rebuild serves something that a valid file contradicts (it ignores a valid index record, or overrules the checkpoint) it must prove the head it serves is not a point of a
// history a takeover replaced (recovery.ts, tails.ts cutAwayBranchHit); if it cannot prove it, the version is quarantined. A single older index or checkpoint is repaired; two older files put back together are loud.
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
  VF('checkpoint.bin', 'checkpoint\\.bin', 'two checksummed slots, each with a sequence number, the version tag, the head\'s chain values, the eviction state AND the chain state at the eviction boundary (review 5), rewritten in place before each acknowledgement, and (round 7) the HISTORY COUNT it was written under (takeovers begun + aside folders, in the upper bits of the flags word) so an older statement can be told from a current one',
    A('one bad slot: the other is used and the bad one rewritten at load', 'a lagging statement is read like a crash between index and checkpoint: the index (cross-checked) is newer, the file is rewritten level with it; an older eviction state that is still true (the bodies really are gone) is used; one that a restore undid is vetoed by the holders\' note and the lines are served; a newer eviction forgotten by an older statement reads the evicted prefix as damaged, never as served wrongly', 'a slot carrying another version\'s tag is not evidence (as missing)', 'no evidence: lines the index cannot vouch for are reported, never trusted, never dropped; the eviction state is unknown, so evicted lines are reported damaged until a resend or restoreBody', 'one slot cut off: the other; both cut: as missing')),
  VF('summary.json', 'summary\\.json', 'checksummed envelope carrying the version key', A('recomputed from the index and bodies', 'lines after its count are replayed from the index', 'counts as bad: recomputed', 'recomputed', 'counts as bad: recomputed')),
  VF('scrub.json', 'scrub\\.json', 'checksummed envelope carrying the version key', A('the integrity scrub starts again at line 0', 'the scrub re-checks lines it already checked', 'counts as bad: starts again', 'starts again', 'counts as bad: starts again')),
  VF('marks.bin', 'marks\\.bin', 'ONE two-slot file written in place like the checkpoint (slotfile.ts), each slot inside the envelope: role, version key, sequence number; holds the partial and the damaged marker',
    A('one bad slot: the other is used and the next write replaces the bad one; no valid slot: the version is reported damaged from its head (partial) or `damaged` with an unknown aside name (quarantined, no index)', 'a lower sequence number loses to the newer slot; an older whole file says an older marker: a false alarm at worst, never a loss; a damaged marker next to a live index.bin is ignored and cleared by a newer statement', 'another version\'s marks file is `foreign`: counts as bad', 'a version that was quarantined (a COMPLETE aside/<key>-q<n>/ exists, no index, no body) is still reported `damaged`; a lost partial marker is two faults (the lines stay in torn/)', 'a slot cut short is bad: the other slot is used')),
  VF('marks.bad', 'marks\\.bin\\.bad-\\d+', 'none (kept raw copy)', KEPT),
  VF('aside.intent', 'aside\\.intent', 'checksummed envelope carrying the version key (exists only while a set-aside is in flight)',
    A('the set-aside is finished into a fresh aside name and the version reports `damaged`', 'a note whose aside folder carries the COMPLETE mark did its job: kept as aside.intent.bad-N and ignored', 'a note for another version is ignored and kept as aside.intent.bad-N', 'nothing in flight', 'counts as rotted')),
  VF('intent.bad', 'aside\\.intent\\.bad-\\d+', 'none (kept raw copy)', KEPT),
  VF('parked', 'parked/\\d{16}-[0-9a-f]{16}\\.park', 'the envelope: role, version key and an id of POSITION, LINE HASH and HISTORY (the takeover epoch, tails.ts) sealed inside the checksum; the drain compares the id with the name and the current epoch, and the hash with the lines',
    A('moved to rejected/ (kept); a resend parks again', 'parked files never change: the same bytes', 'another version, another position, another lines-hash than the name says, or ANOTHER HISTORY (parked before a takeover, review 6 B1): a swapped, overwritten or stale park: moved to rejected/ (kept), never applied; the head stays where it is, so the true lines are still wanted', 'provisional by definition (limit 3): the caller keeps ownership until the head passes it', 'fails the CRC: as rotted')),
  VF('rejected', 'rejected/((takeover|quarantine|stale-history|conflict|damaged|released)--)?(older-\\d+-)?\\d{16}-[0-9a-f]{16}\\.park', 'length-framed lines with a CRC', KEPT),
  VF('tails', 'tails/[0-9a-f]{8,128}\\.tail', 'the envelope: role, version key and TAKEOVER ID sealed inside the checksum, then a header and framed lines (own CRC)',
    A('reads throw `corrupt`; the cut is never repeated on its word', 'a tail is written once and never changes: the same bytes', 'a tail of another version OR another takeover id (review 5, F2) is refused with `corrupt` for this id; nothing is moved', 'with a .begun or .done marker (the intent is written before the cut): tail() and every retry throw `corrupt`, nothing is written over the evidence; with no marker nothing was cut yet and the set-aside simply runs', 'fails its CRC: as rotted')),
  VF('begun', 'tails/[0-9a-f]{8,128}\\.begun', 'existence only; written AFTER the tail is durable and read back and BEFORE the cut or any park is touched (review 6, B2); the sorted names of these markers are the version\'s history identity (tails.ts readEpoch)',
    A('not read', 'not read', 'not read', 'a missing marker next to a present tail: the retry writes it again and goes on (one fault); a missing tail with this marker is REPORTED (`corrupt`); losing this marker changes the history identity, so parked appends are refused (kept in rejected/), never applied', 'not read')),
  VF('done', 'tails/[0-9a-f]{8,128}\\.done', 'existence only', A('not read', 'not read', 'not read', 'a retried set-aside re-checks that the version still holds exactly the saved tail before cutting', 'not read')),
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
  { id: 'highwater', pattern: /^highwater\/[0-9a-f]{2,128}\.hw$/, protection: 'a two-slot file written in place (slotfile.ts) inside the envelope: role, version key, sequence; per version the highest line count the store ever stated and the chain value at a few earlier counts, and (round 7) how many takeovers began (compared with what tails/ shows: head().lostTakeovers); kept OUTSIDE the chat folders so a folder put back cannot take it along',
    answers: A('one bad slot: the other is used; none: no evidence (the record can only under-report)', 'an older record names a lower count: it can only under-report', 'another version\'s record is `foreign`: no evidence', 'no evidence: a rolled-back folder is then NOT reported (documented limit)', 'a cut slot is bad: no evidence') },
  { id: 'versions', pattern: new RegExp(`^versions/[0-9a-f]{2,128}/(${versionAlt})$`), protection: 'see the version rows', answers: A('see the version rows', 'see the version rows', 'see the version rows', 'see the version rows', 'see the version rows') },
  { id: 'aside', pattern: new RegExp(`^aside/[0-9a-f]+-q?\\d+/(${versionAlt})$`), protection: 'moved version files, same rows', answers: KEPT },
  { id: 'aside-complete', pattern: /^aside\/[0-9a-f]+-q?\d+\/COMPLETE$/, protection: 'existence only; written last, just before the set-aside note is removed', answers: A('n/a', 'n/a', 'n/a', 'a note that survives is then finished again (every step is repeatable)', 'n/a') },
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
export const ALL_KIND_IDS: string[] = [...VERSION_ROWS.map((r) => r.id), ...ROOT_ROWS.filter((r) => r.id !== 'versions' && r.id !== 'aside').map((r) => r.id)];
