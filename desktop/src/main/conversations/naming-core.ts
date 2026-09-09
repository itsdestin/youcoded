// desktop/src/main/conversations/naming-core.ts
//
// PURE record logic for session NAME OWNERSHIP — who chose a conversation's
// name, the user or the assistant. No fs/path/os imports; the IO shell
// (naming-store.ts) does disk work. Same pure-core/IO-shell split as
// store-core.ts / conversation-store.ts.
//
// WHY a record of its own, rather than fields on ConversationRecord: that
// record's parseRecord (store-core.ts) reconstructs a fixed whitelist of
// fields, so an OLDER client that reads and rewrites a record silently drops
// any field it has never heard of. Ownership added there would survive only
// until the first write from a build that predates it — exactly the case
// (mixed-version devices syncing) it exists to protect. A separate file in a
// directory older clients never open cannot be rewritten by them at all.
// ConversationRecord.title stays the compatibility PROJECTION of the name so
// old clients still display it; this record is the authority on who owns it.
//
// The merge is a lattice join like mergeRecords: commutative, associative and
// content-tiebroken, so two devices folding the same pair converge byte for
// byte regardless of order.
import { laterOf, ts } from './store-core';

export const NAMING_SCHEMA_VERSION = 1;

const EPOCH = '1970-01-01T00:00:00.000Z';

/** Longest manual name we will store. The dialog caps input at 160 too. */
export const MANUAL_NAME_MAX = 160;
/** Longest Basic/AI-derived name. Matches session-store's DERIVED_TITLE_MAX. */
export const AUTO_NAME_MAX = 60;
/** Basic mode cuts the opening request shorter than that — it is a raw quote,
 *  not a summary, so it needs the ellipsis to read as one. Matches
 *  session-browser's FALLBACK_TITLE_MAX. */
const BASIC_NAME_MAX = 48;

export interface NamingRecord {
  schema: number;
  id: string;
  provider: string;
  /** The name the USER chose. '' means none — never set, or cleared. */
  manual: string;
  /** ISO — when `manual` last CHANGED, set OR cleared. A clear is a real
   *  event with its own timestamp, which is what lets "I cleared this on my
   *  laptop" beat "I named it yesterday on my phone" instead of losing to it. */
  manualAt: string;
  /** The most recent automatic name. Kept even while a manual name is set, so
   *  clearing the manual name can reveal it immediately instead of waiting for
   *  the next review. */
  auto: string;
  autoAt: string;
  /** Completed assistant replies seen for this conversation. Tool steps are
   *  not replies. Monotonic; merges by max so a device that was offline for
   *  ten replies cannot rewind the schedule. */
  replies: number;
  /** `replies` as of the last automatic naming ATTEMPT — the schedule cursor.
   *  Also merges by max: a review that happened must not un-happen. */
  reviewed: number;
}

export function emptyNamingRecord(id: string, provider: string): NamingRecord {
  return {
    schema: NAMING_SCHEMA_VERSION,
    id,
    provider,
    manual: '',
    // Epoch, not "now": a record that has never carried a user choice must
    // LOSE every merge against one that has, no matter which device wrote it
    // last. Stamping it with the current time would let an untouched record
    // from a second device erase a name the user typed a minute ago.
    manualAt: EPOCH,
    auto: '',
    autoAt: EPOCH,
    replies: 0,
    reviewed: 0,
  };
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
// An unparseable timestamp becomes EPOCH rather than staying garbage: ts()
// maps garbage to 0, which would silently behave like EPOCH in comparisons
// but round-trip the corrupt text to peers forever.
const when = (v: unknown): string => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : EPOCH);
const count = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

/** Parse + validate one naming file. Returns null on anything invalid, so a
 *  corrupt file costs exactly one conversation's ownership, never the list. */
export function parseNamingRecord(json: string): NamingRecord | null {
  let raw: any;
  try { raw = JSON.parse(json); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  if (raw.schema !== NAMING_SCHEMA_VERSION) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.provider !== 'string' || !raw.provider) return null;
  return {
    schema: NAMING_SCHEMA_VERSION,
    id: raw.id,
    provider: raw.provider,
    manual: str(raw.manual).slice(0, MANUAL_NAME_MAX),
    manualAt: when(raw.manualAt),
    auto: str(raw.auto).slice(0, AUTO_NAME_MAX),
    autoAt: when(raw.autoAt),
    replies: count(raw.replies),
    reviewed: count(raw.reviewed),
  };
}

/**
 * Field-level merge. The two name slots travel with their OWN timestamps and
 * never with conversation activity — the whole point of this record is that a
 * name you typed on an idle device must not lose to a busier device's newer
 * turn (which is exactly how ConversationRecord.title merges, and exactly why
 * title alone cannot carry ownership).
 */
export function mergeNamingRecords(a: NamingRecord, b: NamingRecord): NamingRecord {
  const manual = laterOf(
    { v: a.manual, at: a.manualAt }, { v: b.manual, at: b.manualAt },
    ts(a.manualAt), ts(b.manualAt),
  );
  const auto = laterOf(
    { v: a.auto, at: a.autoAt }, { v: b.auto, at: b.autoAt },
    ts(a.autoAt), ts(b.autoAt),
  );
  return {
    schema: NAMING_SCHEMA_VERSION,
    id: a.id || b.id,
    provider: a.provider || b.provider,
    manual: manual.v,
    manualAt: manual.at,
    auto: auto.v,
    autoAt: auto.at,
    replies: Math.max(a.replies, b.replies),
    reviewed: Math.max(a.reviewed, b.reviewed),
  };
}

/** True when the user owns this conversation's name right now. */
export function isManuallyNamed(rec: NamingRecord | null | undefined): boolean {
  return !!rec && rec.manual !== '';
}

/**
 * The name to display. Manual wins outright; otherwise the stored automatic
 * name; otherwise whatever the caller already had (store title, transcript
 * fallback, placeholder). `fallback` is never overridden by an EMPTY slot —
 * an untouched naming record must not blank out a name the old pipeline set.
 */
export function effectiveName(
  rec: NamingRecord | null | undefined,
  fallback: string,
): { name: string; manual: boolean } {
  if (rec && rec.manual) return { name: rec.manual, manual: true };
  if (rec && rec.auto) return { name: rec.auto, manual: false };
  return { name: fallback, manual: false };
}

/**
 * Trim a name the user typed. Returns '' for blank/whitespace-only input,
 * which callers must REFUSE rather than store — clearing is a separate,
 * explicitly-requested operation, so a stray Save on an empty box must not
 * silently hand the conversation back to automatic naming.
 */
export function normalizeManualName(raw: string): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MANUAL_NAME_MAX);
}

/** Clean one generated line into a single-line title. Strips one layer of
 *  wrapping quotes (models add them despite being told not to), collapses
 *  newlines so it renders on one line in a pill, and caps length. */
export function sanitizeAutoName(raw: string): string {
  let t = String(raw ?? '').trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) t = t.slice(1, -1).trim();
  }
  return t.replace(/\s+/g, ' ').trim().slice(0, AUTO_NAME_MAX);
}

/**
 * Basic mode's whole algorithm: quote the opening request, shortened to a word
 * boundary. No model call, no summary, no pretence of understanding the
 * conversation — which is exactly what the settings copy promises.
 */
export function basicNameFrom(firstMessage: string): string {
  const collapsed = String(firstMessage ?? '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= BASIC_NAME_MAX) return collapsed;
  const cut = collapsed.slice(0, BASIC_NAME_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  // Same word-boundary rule as session-browser's cleanTitle: back off to the
  // last space, unless that leaves a stub, in which case hard-cut.
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + '…';
}

/**
 * The reply count at which the NEXT automatic review is due, given the count
 * at the last one. The approved cadence is replies 1, 3, then every 25 —
 * 1, 3, 28, 53, 78 … — with tool steps excluded upstream.
 *
 * WHY a cursor rather than an equality test on the live count: completion
 * events can be replayed (takeover/resume replays a terminal event) and can be
 * missed (the app was closed for three replies of a session another device
 * ran). `replies === 28` would double-fire on the first and never fire on the
 * second. A "have we passed the next mark" comparison does the right thing in
 * both cases.
 */
export function nextReviewAt(reviewed: number): number {
  if (reviewed < 1) return 1;
  if (reviewed < 3) return 3;
  return 3 + 25 * (Math.floor((reviewed - 3) / 25) + 1);
}

/** True when this conversation has reached its next scheduled review. */
export function isReviewDue(rec: NamingRecord): boolean {
  return rec.replies >= nextReviewAt(rec.reviewed);
}
