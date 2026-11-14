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
// The mechanisms behind those answers (so a new file knows what to use):
//   identity   index header, checkpoint slots and every small version file carry the version they belong to (chain.ts versionTag / the `version` field), so a foreign
//              copy is recognised as foreign;
//   freshness  what must be CURRENT (which lines were evicted on purpose) lives only in the checkpoint, which is rewritten in place at every acknowledgement; a file with no
//              freshness (evicted.json) is never decided from;
//   anchor     a file that can lose a whole tail without any bad byte (the control log, the extras folder) has a second record (anchor.json, manifest.bin) of what was
//              acknowledged, so a shorter file is REPORTED;
//   evidence   a destructive act (unlink of an evicted chunk, a body cut) needs CURRENT, cross-checked evidence, never a marker that was merely true once: an unlink of a body
//              happens only inside evictBody under a proof that was just verified (load never unlinks a body); a cut of surplus body happens only after the index has been checked
//              against the checkpoint, and the cut bytes are copied to torn/ first.
// HONEST LIMITS (the only places where a single fault costs something, and what is guaranteed anyway):
//   (1) a fault that destroys the ONLY copy of some bytes (a body chunk, a tail, a rejected park, a control log, an extra) destroys them; it is always REPORTED and never served wrong;
//   (2) after a successful eviction the chain values of the evicted lines exist only in index.bin (and its kept copies): a fault there that no kept copy can cover quarantines
//       the version (everything kept intact under aside/, nothing served until a peer re-sends);
//   (3) parked appends are provisional by definition (the caller keeps ownership until the head passes them); a lost parked file is not reported.
//
// `inventory.test.ts` fails when the store writes a name that has no row; `fuzz.test.ts` and `matrix.test.ts` apply each of the five faults to every file of a real folder.
//
// Paths are relative to the store root with `/` separators. Version files appear under versions/<vhex>/ and, moved whole, under aside/<name>/.
export interface InventoryAnswers { rotted: string; older: string; foreign: string; missing: string; truncated: string }
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
      'rebuilt from the bodies and confirmed by the checkpoint (limit 2: after an eviction the evicted lines\' chain values come only from kept copies)',
      'a cut inside a record is a torn tail (kept in torn/, then cut); a cut at a record boundary is an older copy (see older)')),
  VF('index.rebuild', 'index\\.rebuild', 'none (scratch, always re-derivable)', SCRATCH),
  VF('body', 'body-[0-9a-f]{16}\\.bin', 'every line is hashed into the chain stored in the index records and the checkpoint',
    A('the bad line is reported (read throws `corrupt`, head.damagedFromLine), its bytes stay, every other line is served, a resend heals it',
      'an older copy is shorter or the same bytes: lines past its end are a hole (see truncated)',
      'its lines fail their chain values one by one: reported like rot; nothing is served wrong; a resend heals them',
      'a hole: every line wholly inside another chunk file is served, the lines in the hole are reported damaged (never relabelled as evicted), nothing is set aside, a correct resend writes them back; below the evicted bytes it is an eviction and nothing',
      'lines up to the cut are served, the rest are a hole as above; appends start a new chunk at the head')),
  VF('checkpoint.bin', 'checkpoint\\.bin', 'two checksummed slots, each with a sequence number, the version tag, the head\'s chain values and the eviction state, rewritten in place before each acknowledgement',
    A('one bad slot: the other is used and the bad one rewritten at load', 'a lagging statement is read like a crash between index and checkpoint: the index (cross-checked) is newer, the file is rewritten level with it; an older eviction state that is still true (the bodies really are gone) is used; one that a restore undid is vetoed by the holders\' note and the lines are served; a newer eviction forgotten by an older statement reads the evicted prefix as damaged, never as served wrongly', 'a slot carrying another version\'s tag is not evidence (as missing)', 'no evidence: lines the index cannot vouch for are reported, never trusted, never dropped; the eviction state is unknown, so evicted lines are reported damaged until a resend or restoreBody', 'one slot cut off: the other; both cut: as missing')),
  VF('evicted.json', 'evicted\\.json', 'checksummed envelope carrying the version key; ONLY a record of who held the evicted lines',
    A('nothing is decided from this file', 'an older copy decides nothing (how review 4 found F1 and F5); the only thing the note can do is veto an eviction record whose bodies are ALL still on disk', 'nothing is decided from this file', 'nothing is decided from this file', 'nothing is decided from this file')),
  VF('summary.json', 'summary\\.json', 'checksummed envelope carrying the version key', A('recomputed from the index and bodies', 'lines after its count are replayed from the index', 'counts as bad: recomputed', 'recomputed', 'counts as bad: recomputed')),
  VF('scrub.json', 'scrub\\.json', 'checksummed envelope carrying the version key', A('the integrity scrub starts again at line 0', 'the scrub re-checks lines it already checked', 'counts as bad: starts again', 'starts again', 'counts as bad: starts again')),
  VF('partial.json', 'partial\\.(json|copy)', 'two checksummed copies (partial.json, partial.copy) carrying the version key; either alone is enough and the other is rewritten at load',
    A('the version is reported damaged from its head line until the next line lands', 'an older marker still reports until the head passes it (a false alarm at worst, never a loss)', 'counts as bad: reported damaged from the head until the next line lands', 'the other copy is used and this one rewritten; with both gone the report is lost (two faults: the lines stay in torn/ and the checkpoint was lowered)', 'counts as bad')),
  VF('stale-conv.json', 'stale-conv\\.json', 'existence only, and the checkpoint stamp carries the same bit', A('the checkpoint bit restores it; a bad body is irrelevant', 'harmless: the conversation chain is recomputed at load', 'as older: recomputed', 'the checkpoint bit restores it', 'as rotted')),
  VF('damaged.json', 'damaged\\.json', 'checksummed envelope carrying the version key; believed only while index.bin is absent (a quarantine moves it away)',
    A('the version still reports `damaged` (aside name unknown); setAsideDamaged clears it', 'an older marker next to a live index.bin is ignored and kept as damaged.json.bad-N (it would hide a healthy chat)', 'counts as bad; ignored when an index is live', 'the quarantined copy is already aside, intact; the version reads as empty and can be refilled', 'counts as bad')),
  VF('damaged.bad', 'damaged\\.json\\.bad-\\d+', 'none (kept raw copy)', KEPT),
  VF('aside.intent', 'aside\\.intent', 'checksummed envelope carrying the version key (exists only while a set-aside is in flight)',
    A('the set-aside is finished into a fresh aside name and the version reports `damaged`', 'a note whose aside folder carries the COMPLETE mark did its job: kept as aside.intent.bad-N and ignored', 'a note for another version is ignored and kept as aside.intent.bad-N', 'nothing in flight', 'counts as rotted')),
  VF('intent.bad', 'aside\\.intent\\.bad-\\d+', 'none (kept raw copy)', KEPT),
  VF('parked', 'parked/\\d{16}-[0-9a-f]{16}\\.park', 'a version-tag prefix, then length-framed lines with a CRC',
    A('moved to rejected/ (kept); a resend parks again', 'parked files never change: the same bytes', 'another version\'s tag: moved to rejected/ (kept), never applied', 'provisional by definition (limit 3): the caller keeps ownership until the head passes it', 'fails the CRC: as rotted')),
  VF('rejected', 'rejected/(older-\\d+-)?\\d{16}-[0-9a-f]{16}\\.park', 'length-framed lines with a CRC', KEPT),
  VF('tails', 'tails/[0-9a-f]{8,128}\\.tail', 'header CRC plus framed lines CRC; the header names the version',
    A('reads throw `corrupt`; the cut is never repeated on its word', 'a tail is written once and never changes: the same bytes', 'a tail of another version is returned as that version\'s (its header says so) and refused for this one', 'with a .done marker: tail() and a retry throw `corrupt`, nothing is written over the evidence; without one the first set-aside simply runs', 'fails its CRC: as rotted')),
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
