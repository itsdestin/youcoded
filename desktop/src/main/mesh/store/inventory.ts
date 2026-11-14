// Inventory of EVERY file the chat store writes under its root (review 3, class fix A.2).
//
// WHY this exists: three review rounds each found a new critical bug because a fix round added on-disk state that was
// neither protected nor tested (evicted.json, partial.json, meta.json, FORMAT...). The rule now: a file the store writes
// has a row here, with (1) how a damaged copy is DETECTED and (2) what a damaged or missing copy MEANS, and that meaning
// is always non-destructive (it never makes the store delete or hide something it holds). `inventory.test.ts` fails when
// the store writes a name that has no row, and `fuzz.test.ts` rots a random file from the real folder with no exclusions.
//
// In words (the table the store.ts header used to carry):
//   file -> protection -> meaning when corrupt or missing (always non-destructive):
//   FORMAT                one line + CRC                      kept as FORMAT.bad-N and rewritten; a good CRC with another number refuses to open
//   LOCK, LOCK.takeover   JSON with a token                   unreadable: treated as stale after 30 s; not data
//   versions/<vhex>/
//     meta.json, meta.copy      checksummed envelope, kept twice    the other copy is used and the bad one replaced (old kept as *.bad-N); both bad: `corrupt`, nothing touched
//     index.bin                 CRC per record + chained hashes     header bad/stamp changed: rebuild KEEPING valid records; bad record: re-derived and confirmed by the next valid record or the checkpoint
//     body-<start>.bin          chain hashes in index + checkpoint  the bad line is reported (read throws corrupt, damagedFromLine), bytes stay, other lines served, a resend heals
//     checkpoint.bin            two CRC slots + sequence, written in place before EVERY acknowledgement   one bad slot: the other; both bad: no evidence (lines the index cannot vouch for are reported, never trusted, never dropped)
//     evicted.json              checksummed + cross-checked with the index record of its last line         ignored: eviction state derived from which body chunk files exist; nothing deleted on its word
//     summary.json, scrub.json  checksummed                         recomputed / the scrub starts again
//     partial.json              checksummed                         bad = damaged from the head line until the next line lands
//     stale-conv.json           existence only (+ checkpoint stamp bit)   restored from the stamp
//     damaged.json, aside.intent  checksummed                       still damaged (name unknown) / finished into a fresh aside name, reported damaged
//     parked/, rejected/        length frame + CRC                  bad: moved to rejected/ (kept), a resend parks again
//     tails/*.tail, *.done      header CRC + framed CRC / existence  bad tail: `corrupt`, never cut on its word; the cut re-checks the head before repeating
//     torn/, healed/, replaced-index/   raw kept bytes (never overwritten: names are max+1 and checked absent)   only ever read as extra independent evidence, through their own checksums
//     index.rebuild, *.tmp-*    scratch                             re-derived / swept
//   aside/<name>/               moved version files, same rows      kept, never read as truth
//   extras/aa/<sha256>          name = SHA-256 of content           moved to extras-bad/ (kept), reads as absent
//   control/<h>/log.bin ...     per-record header CRC, payload CRC, id = SHA-256 of body    bad record skipped and reported, later entries served; a zero tail is a torn write (kept, cut)
//
//
// Paths are relative to the store root with `/` separators. Version files appear under versions/<vhex>/ and, moved
// whole, under aside/<name>/.
interface InventoryRow {
  id: string;
  pattern: RegExp;
  /** How damage is detected. */
  protection: string;
  /** What a corrupt, truncated, zero-length or missing instance means. Always non-destructive. */
  whenBad: string;
}

const VF = (id: string, name: string, protection: string, whenBad: string): InventoryRow => ({ id, pattern: new RegExp(`^${name}$`), protection, whenBad });

/** Rows for files that live inside one version folder (or one aside/<name>/ folder). */
const VERSION_ROWS: InventoryRow[] = [
  VF('meta.json', 'meta\\.json', 'checksummed envelope; a second copy in meta.copy', 'the other copy is used and the bad one is replaced (old bytes kept as *.bad-N); both bad: the version reports `corrupt`, nothing is touched'),
  VF('meta.copy', 'meta\\.copy', 'checksummed envelope; second copy of meta.json', 'as meta.json'),
  VF('meta.bad', 'meta\\.(json|copy)\\.bad-\\d+', 'none (kept raw copy of a bad meta file)', 'never read'),
  VF('index.bin', 'index\\.bin', 'a CRC per record, chained hashes; the 16-byte header (magic, format, stamp) has no CRC', 'a bad header or classifier stamp: rebuild that KEEPS every valid record; a bad record: re-derived from the body and checked against the next valid record or the checkpoint; the old file is kept in replaced-index/'),
  VF('index.rebuild', 'index\\.rebuild', 'none (scratch, always re-derivable)', 'recreated from scratch by the next rebuild'),
  VF('body', 'body-[0-9a-f]{16}\\.bin', 'every line is hashed into the chain stored in the index records and the checkpoint', 'the bad line is reported damaged (read throws `corrupt`, head.damagedFromLine), its bytes stay, every other line is served, a correct resend heals it'),
  VF('checkpoint.bin', 'checkpoint\\.bin', 'two checksummed slots with a sequence number, rewritten in place before each acknowledgement', 'one bad slot: the other is used; both bad or file missing: no evidence, so lines the index cannot vouch for are reported damaged (never trusted, never dropped)'),
  VF('evicted.json', 'evicted\\.json', 'checksummed envelope, and its numbers are cross-checked against the index record of the last evicted line', 'ignored: the evicted prefix is derived from which body chunk files are present; nothing is deleted on its word'),
  VF('summary.json', 'summary\\.json', 'checksummed envelope', 'recomputed from the index and bodies'),
  VF('scrub.json', 'scrub\\.json', 'checksummed envelope', 'the integrity scrub starts again at line 0'),
  VF('partial.json', 'partial\\.json', 'checksummed envelope', 'the version is reported damaged from its head line until the next line lands (lines may have been set aside)'),
  VF('stale-conv.json', 'stale-conv\\.json', 'existence only, and the checkpoint stamp carries the same bit', 'the checkpoint bit restores it; a bad body is irrelevant'),
  VF('damaged.json', 'damaged\\.json', 'checksummed envelope', 'the version still reports `damaged` (aside name unknown); setAsideDamaged clears it'),
  VF('damaged.bad', 'damaged\\.json\\.bad-\\d+', 'none (kept raw copy)', 'never read'),
  VF('aside.intent', 'aside\\.intent', 'checksummed envelope (exists only while a set-aside is in flight)', 'the set-aside is finished into a fresh aside name and the version reports `damaged`'),
  VF('parked', 'parked/\\d{16}-[0-9a-f]{16}\\.park', 'length-framed lines with a CRC', 'moved to rejected/ (kept); a resend parks again'),
  VF('rejected', 'rejected/(older-\\d+-)?\\d{16}-[0-9a-f]{16}\\.park', 'length-framed lines with a CRC', 'kept as is; listed by rejectedList'),
  VF('tails', 'tails/[0-9a-f]{8,128}\\.tail', 'header CRC plus framed lines CRC', 'reads throw `corrupt`; the cut is never repeated on its word'),
  VF('done', 'tails/[0-9a-f]{8,128}\\.done', 'existence only', 'missing: a retried set-aside re-checks that the version still holds exactly the saved tail before cutting'),
  VF('torn', 'torn/\\d{6}-(index-tail|body|checkpoint)', 'none (raw bytes the store moved out of the way; only ever copies of unacknowledged or damaged bytes)', 'never read back as truth'),
  VF('healed', 'healed/line-\\d+-\\d+\\.bin', 'none (raw bytes of a line a resend replaced)', 'never read back as truth'),
  VF('replaced-index', 'replaced-index/index-\\d{4}\\.bin', 'a CRC per record (it is a former index)', 'used only as one more source of independent chain values by a rebuild'),
  VF('tmp', '.+\\.tmp-\\d+-\\d+', 'none (an interrupted atomic write)', 'swept at open; the target it was replacing is untouched'),
];

const versionAlt = VERSION_ROWS.map((r) => r.pattern.source.slice(1, -1)).join('|');

const ROOT_ROWS: InventoryRow[] = [
  { id: 'FORMAT', pattern: /^FORMAT$/, protection: 'one line with a CRC', whenBad: 'kept as FORMAT.bad-N and rewritten (a different format number with a good CRC still refuses to open)' },
  { id: 'FORMAT.bad', pattern: /^FORMAT\.bad-\d+$/, protection: 'none (kept raw copy)', whenBad: 'never read' },
  { id: 'LOCK', pattern: /^LOCK(\.takeover|\.new-\d+-[0-9a-f]+)?$/, protection: 'JSON with a token, written whole through a hard link', whenBad: 'unreadable: treated as stale after 30 s; never data' },
  { id: 'versions', pattern: new RegExp(`^versions/[0-9a-f]{2,256}/(${versionAlt})$`), protection: 'see the version rows', whenBad: 'see the version rows' },
  { id: 'aside', pattern: new RegExp(`^aside/[0-9a-f]+-q?\\d+/(${versionAlt})$`), protection: 'moved version files, same rows', whenBad: 'never read; kept' },
  { id: 'extras', pattern: /^extras\/[0-9a-f]{2}\/[0-9a-f]{64}$/, protection: 'the file name is the SHA-256 of its bytes', whenBad: 'moved to extras-bad/ (kept); reads as absent until a peer copy is put' },
  { id: 'extras-bad', pattern: /^extras-bad\/[0-9a-f]{64}-\d+$/, protection: 'none (kept raw copy)', whenBad: 'never read' },
  { id: 'extras-tmp', pattern: /^extras\/[0-9a-f]{2}\/[0-9a-f]{64}\.tmp-\d+-\d+$/, protection: 'none (interrupted write)', whenBad: 'swept' },
  { id: 'control-log', pattern: /^control\/[0-9a-f]{64}\/log\.bin$/, protection: 'each record: header CRC, payload CRC, entry id = SHA-256 of its body', whenBad: 'a bad record is skipped and reported (controlDamage), later records are served; a zero-filled tail is a torn write (cut, kept)' },
  { id: 'control-kept', pattern: /^control\/[0-9a-f]{64}\/(torn-\d+|quarantine-\d+)\.bin$/, protection: 'none (kept raw bytes)', whenBad: 'never read' },
  { id: 'control-parked', pattern: /^control\/[0-9a-f]{64}\/parked\/[0-9a-f]{64}\.ent$/, protection: 'length + CRC frame, entry id = SHA-256 of its body', whenBad: 'not applied, left in place' },
  { id: 'control-tmp', pattern: /^control\/[0-9a-f]{64}\/(parked\/)?.+\.tmp-\d+-\d+$/, protection: 'none (interrupted write)', whenBad: 'swept' },
];

/** The id of the first row that names `rel`, or null when the store should never have written such a file. */
export function inventoryRow(rel: string): string | null {
  const r = rel.split('\\').join('/');
  for (const row of ROOT_ROWS) if (row.pattern.test(r)) return row.id;
  return null;
}
