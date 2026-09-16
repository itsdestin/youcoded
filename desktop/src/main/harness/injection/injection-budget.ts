// Bounding model-facing content by token budget (program §4 item 5, §7 item 3).
//
// A 600-word rule, a long SKILL.md, or a nested CLAUDE.md can consume a
// meaningful slice of a small model's window. Everything injected as a message
// passes through fitInjection; the ROOT project-instruction file, which lives in
// the byte-stable system prompt rather than in a message, passes through
// fitProjectInstructions. Both live here so they share one chars-per-token
// constant — two of those would drift, and drift here is silent.
//
// WHY they always announce the cut: a silently truncated procedure is worse than
// no procedure at all. The model follows the half it received believing it has
// the whole thing, and nothing anywhere signals that it is working from a
// fragment. Saying so costs a line and turns a silent failure into a recoverable one.
//
// WHY the notice NAMES THE FILE (2026-09-10): "recoverable" was a claim the old
// wording could not cash. It said "Ask for the rest if you need it" — naming no
// file and no one to ask, so on a small model, where the model-invoked Skill tool
// is not even attached, a cut skill was LOST rather than deferred. The root
// project-instruction fitter below has always named its file; this one now does
// too, which is the whole difference between a dead end and a next step.
// error-message-standards.md: specific and accurate, or general and
// non-committal — never advice the reader cannot act on. With no path to give,
// it says only that the cut happened.
const APPROX_CHARS_PER_TOKEN = 4;

function injectionNotice(sourcePath?: string): string {
  return sourcePath
    ? `\n\n[...truncated to fit this model's context window. Read ${sourcePath} for the rest.]`
    : "\n\n[...truncated to fit this model's context window.]";
}

/** Cut back to a line boundary, preferring a paragraph break, with a 50% floor so
 *  tidiness never costs most of the budget. Same rule as headCut() below, and for
 *  the same reason: a slice at an exact character offset lands mid-word, and a
 *  half-written instruction reads as a whole one. */
function cutOnLineBoundary(text: string, room: number): string {
  const candidate = text.slice(0, room);
  for (const sep of ['\n\n', '\n']) {
    const at = candidate.lastIndexOf(sep);
    if (at > candidate.length * 0.5) return text.slice(0, at);
  }
  return candidate;
}

/** `sourcePath` is the file this text came from, named in the notice so the model
 *  can go and read what it did not get. Optional only because a caller may
 *  genuinely have no file to point at; prefer passing it. */
export function fitInjection(text: string, budgetTokens: number, sourcePath?: string): { text: string; truncated: boolean } {
  const budgetChars = Math.max(0, budgetTokens) * APPROX_CHARS_PER_TOKEN;
  if (text.length <= budgetChars) return { text, truncated: false };
  // Reserve room for the notice itself, so the thing announcing the cut is never
  // the thing that gets cut, and the result still fits the budget it was given.
  // A budget too small to hold even the notice yields the notice alone — honest,
  // and never a bare empty string the caller would mistake for "nothing to say".
  const notice = injectionNotice(sourcePath);
  const room = Math.max(0, budgetChars - notice.length);
  return { text: cutOnLineBoundary(text, room) + notice, truncated: true };
}

// --- Root project instructions (AGENTS.md / CLAUDE.md) ----------------------
//
// This one is NOT injected as a message: it is baked into the byte-stable system
// prompt (prompt-assembly.ts), assembled once per session and never rewritten —
// that is what makes project rules immortal, safe from compaction. So it needs
// its own fitter rather than fitInjection.
//
// WHY it outlines instead of cutting: the obvious implementation keeps whole
// sections from the top and drops the tail, but a section the model cannot SEE
// is a section it cannot know to go read — the rules in it simply stop existing,
// silently, and no amount of "truncated" prose fixes that. So the OUTLINE is the
// floor: every heading survives at every budget, giving the model the file's full
// shape and something concrete to Read for. What scales with the budget is the
// body text under those headings — full text from the top while there is room,
// then heading-plus-first-lines for the rest.
//
// It replaced a bare `.slice(0, 20_000)` — a CHARACTER cap, unscaled by model,
// silent, and cut at a byte offset — on 2026-08-10 (program §7 item 3).
const HEADING_LINE = /^#{1,6} /;
// Trails an outlined section. One glyph, so 30 of them cost ~30 chars of budget,
// and the notice below explains what it means exactly once.
const OUTLINE_MARK = '…';
// Preview depths tried, richest first. Capped at 3: past that an "outline" is
// just a slower cut, and the budget is better spent promoting whole sections.
const PREVIEW_DEPTHS = [3, 2, 1, 0];
// Each preview line is elided to roughly a sentence. WHY this cap exists: a real
// instruction file's "first line" under a heading is usually a 500-1500 char
// paragraph, so uncapped previews cost more than they inform — measured on this
// workspace's own CLAUDE.md, one full-paragraph preview per section did not fit
// at ANY depth, collapsing the outline to bare headings. A gist per section beats
// a paragraph for three sections and nothing for the rest.
const PREVIEW_LINE_CHARS = 200;

interface Section { heading: string; body: string[] }

function parseSections(text: string): { preamble: string[]; sections: Section[] } {
  const preamble: string[] = [];
  const sections: Section[] = [];
  for (const line of text.split('\n')) {
    if (HEADING_LINE.test(line)) sections.push({ heading: line, body: [] });
    else if (sections.length === 0) preamble.push(line);
    else sections[sections.length - 1].body.push(line);
  }
  return { preamble, sections };
}

/** First `n` NON-BLANK body lines. Blank-skipping matters: markdown puts a blank
 *  line under every heading, so taking raw lines would spend the whole preview
 *  budget on whitespace. */
function previewLines(body: string[], n: number): string[] {
  const out: string[] = [];
  for (const line of body) {
    if (out.length === n) break;
    if (line.trim() === '') continue;
    out.push(line.length <= PREVIEW_LINE_CHARS ? line : elide(line));
  }
  return out;
}

/** Cut a long line back to ~PREVIEW_LINE_CHARS on a word boundary. The trailing
 *  ellipsis is inline, not the standalone OUTLINE_MARK — one means "this line
 *  continues", the other means "this section continues". */
function elide(line: string): string {
  const head = line.slice(0, PREVIEW_LINE_CHARS);
  const lastSpace = head.lastIndexOf(' ');
  return `${(lastSpace > PREVIEW_LINE_CHARS * 0.6 ? head.slice(0, lastSpace) : head).trimEnd()}…`;
}

function renderOutline(preamble: string[], sections: Section[], fullCount: number, depth: number): string {
  const parts: string[] = [];
  const intro = preamble.join('\n').trim();
  if (intro !== '') parts.push(intro);
  sections.forEach((s, i) => {
    const lines = i < fullCount
      ? [s.heading, ...s.body]
      : [s.heading, ...previewLines(s.body, depth), OUTLINE_MARK];
    parts.push(lines.join('\n').trimEnd());
  });
  return parts.join('\n\n');
}

/** `depth` is load-bearing, not decoration: at depth 0 there are no preview lines
 *  at all, and claiming "heading + first lines" would describe output that does
 *  not exist (error-message-standards.md — specific and accurate, or general and
 *  non-committal, never a guess about what happened). */
function outlineNotice(outlined: number, total: number, fileName: string, depth: number): string {
  const shape = depth > 0 ? 'heading + first line(s)' : 'heading only';
  return `\n\n[${outlined} of ${total} sections above are shown as ${shape}, marked ${OUTLINE_MARK}, to fit this model's context window. Every heading is present — Read ${fileName} for the full text of any section you need.]`;
}

function headCutNotice(omitted: number, total: number, fileName: string): string {
  // Two shapes, because these are different facts and conflating them would be a
  // lie in one direction or the other: `total > 0` means headings themselves had
  // to be dropped (content genuinely gone); `total === 0` is a heading-less file
  // with nothing to outline, so only the tail is missing.
  const scope = total > 0 ? ` — ${omitted} of ${total} section headings omitted entirely` : '';
  return `\n\n[...truncated to fit this model's context window${scope}. Read ${fileName} directly for the rest.]`;
}

/** Bounded head cut on a line boundary — the fallback for a file with no headings
 *  to outline, and for the extreme where naming every heading would itself blow
 *  the budget. Prefers a paragraph break, then any line end, with a 50% floor so
 *  tidiness never costs most of the budget. */
function headCut(text: string, budgetChars: number, omitted: number, total: number, fileName: string) {
  const room = Math.max(0, budgetChars - headCutNotice(omitted, total, fileName).length);
  if (room === 0) return { text: headCutNotice(omitted, total, fileName).trimStart(), truncated: true };
  const candidate = text.slice(0, room);
  let cut = candidate.length;
  for (const sep of ['\n\n', '\n']) {
    const at = candidate.lastIndexOf(sep);
    if (at > candidate.length * 0.5) { cut = at; break; }
  }
  return { text: text.slice(0, cut) + headCutNotice(omitted, total, fileName), truncated: true };
}

export function fitProjectInstructions(
  text: string,
  budgetTokens: number,
  fileName: string,
): { text: string; truncated: boolean } {
  const budgetChars = Math.max(0, budgetTokens) * APPROX_CHARS_PER_TOKEN;
  if (text.length <= budgetChars) return { text, truncated: false };

  const { preamble, sections } = parseSections(text);
  const total = sections.length;
  if (total === 0) return headCut(text, budgetChars, 0, 0, fileName);

  // Reserve against the LONGEST notice this call could produce (outlined ===
  // total has the most digits) so the real notice, rendered once the counts are
  // known, always still fits. Sizing the reservation from the real notice would
  // be circular — its counts depend on how much we managed to keep.
  const room = budgetChars - Math.max(
    outlineNotice(total, total, fileName, 1).length,
    outlineNotice(total, total, fileName, 0).length,
  );

  // Richest preview depth first; within a depth, the most full-body sections.
  // Full-vs-preview is NOT monotonic per section (a one-line section costs more
  // as a preview, because of the mark), so this scans rather than binary-searches.
  // Bounded work: 4 depths x (sections + 1) renders, once per session.
  for (const depth of PREVIEW_DEPTHS) {
    for (let fullCount = total; fullCount >= 0; fullCount--) {
      const body = renderOutline(preamble, sections, fullCount, depth);
      if (body.length <= room) {
        const outlined = total - fullCount;
        return { text: body + outlineNotice(outlined, total, fileName, depth), truncated: true };
      }
    }
  }

  // Even naming every heading does not fit. This is the ONE path where content
  // truly disappears, so it says so with a real count instead of implying the
  // outline is complete.
  const headingsOnly = sections.map((s) => s.heading).join('\n');
  const kept = headCut(headingsOnly, budgetChars, total, total, fileName);
  const survivors = kept.text.split('\n').filter((l) => HEADING_LINE.test(l)).length;
  return survivors === total
    ? kept
    : { text: kept.text.replace(`${total} of ${total} section headings`, `${total - survivors} of ${total} section headings`), truncated: true };
}
