import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  EmptyState,
  ErrorState,
  FieldError,
  FOCUS_RING,
  LoadingState,
  SettingRow,
  SETTING_ROW_BASE,
} from './ui';
import { BugReportPopup } from './development/BugReportPopup';
import type { ReportContext } from './development/ReportDesign';
import {
  describeRule,
  broadNote,
  ruleKind,
  RULE_KIND_ORDER,
  RULE_KIND_LABEL,
  type RuleKind,
} from './permissions/describe-rule';
import { CROSS_PROJECT_SLUG } from '../../shared/permission-types';
import type {
  NativePermissionMode,
  PermissionRule,
  StoredProject,
  StoredRule,
} from '../../shared/permission-types';

// ═══════════════════════════════════════════════════════════════════════════
// Settings → Permissions (M5 item 2a) — "one screen, real containment".
//
// Everything the app knows about how much a NATIVE session checks with you:
// what the three permission modes mean, what it will never stop asking about,
// and every "Always allow" it remembered — with a way to take each one back.
// Everything lives on ONE screen: no drill-in, no mode-switching, no second
// surface to get lost in.
//
// THIS IS AN OVERVIEW, NOT A LOG. The first version listed every approval ever
// granted as one flat line each and was rejected for exactly that: "i don't
// want a separate line for every single permission i've ever approved". The
// rows are now two levels down, behind a folder you opened and a kind you were
// looking for, and the screen opens on orientation instead.
//
// Three failures of that first version were fixed in place, and the fixes are
// what the layout below is:
//
//   SCOPE     — the screen now opens with how much the assistant checks with
//               you and what it will never stop checking about, and only THEN
//               lists what you've already waved through. The approvals list is
//               one section of a permissions screen instead of being the whole
//               of it.
//   NAMING    — "Approved folders" is gone. The two list headings are a matched
//               pair a stranger can read cold: "Things it always asks about"
//               and "Things it no longer asks about" — the first is now a band
//               header inside the explanation card rather than a section of its
//               own (see LAYOUT), but the words are unchanged.
//   CONTAINMENT — the rejected version indented an expanded folder by `pl-2` and
//               did nothing else, so its rows floated free of the heading above
//               them. Here each folder is ONE BORDERED CARD: the folder row is
//               that card's top band, a rule divides it from the body, and the
//               body sits on its own `bg-well` plane. See FOLDER_HEADER below.
//
// Shapes follow the settings family, NOT ProvidersSection.tsx. That file
// hand-rolls its rows and is grandfathered as legacy — it is an explicit
// exemption in setting-row-authority.test.tsx — so modelling on it (which the
// rejected first version did) inherits drift that the guards will not catch.
// The exemplars actually followed:
//   · card         SyncPanel.tsx:1117 — rounded-lg border border-edge bg-well
//                  overflow-hidden, header band then divided body
//   · rows         SettingsPanel Connected Devices — <SettingRow variant="item">
//   · destructive  SyncPanel DevicesTab — outline opens, filled commits, in
//                  place, autoFocus + Escape-to-cancel
//   · tail         LocalModelsSection.tsx:418-422 — "Show all N"
//
// DELIBERATELY NOT gated on window.claude.native.supported, unlike
// ProvidersSection. remote-shim.ts hardcodes that flag false, so copying the
// gate would render nothing over remote access — killing the one transport
// where revoking a grant from a phone matters. Spec 2026-08-11, "Open item for
// Phase 1 review".
//
// COPY DENSITY. The body is controls and data; the prose is behind the (i).
// Everything explanatory that used to print here — the intro, the mode caption,
// the framing around the always-asks list, how far one approval reaches — is a
// section of permissions-explainer.ts, which the dialog renders via `showInfo`.
// The closing paragraph about Claude Code was deleted rather than moved,
// because that explainer already had it word for word.
//
// A second cut (owner review, 2026-08-11) went further and then spent the
// savings deliberately. GONE: the approvals summary line, the Refresh button
// (the screen remounts on open, so it reloads anyway), and the default-open
// heuristic. BOUGHT with that budget: each mode's definition is two short
// sentences instead of one clause, AND all three print at once instead of only
// the selected one — three modes cannot be compared one at a time, which is the
// only thing a first-time reader is trying to do here. What is left in the body
// is the three mode definitions, the four always-asks items (the only place in
// the app that names them), and the approvals themselves.
//
// LAYOUT — two blocks, not three:
//
//   1. ONE explanation card, split into bands by rules: the three mode
//      definitions, then the always-asks list under Full auto, then the line
//      naming where the mode is actually changed.
//   2. The approvals themselves.
//
// The modes and the always-asks list used to be two separate sections. They
// were merged after a three-way comparison of containment (own card / no
// container / one shared card — CompareView surface `permissions-mode-control`,
// round 3), and the shared card won: Full auto's definition ends by pointing at
// the list, and that sentence should point at something the eye already reads as
// part of the same statement rather than at a section one heading away. Both
// headings survive as band headers, the way the folder cards below carry a
// header band inside a card. The cost was accepted knowingly: this is the
// tallest object on the screen and it breaks the one-section-per-idea rhythm the
// rest of the screen keeps.
//
// THERE IS NO MODE CONTROL, and there never was one that worked. Every selector
// shape tried — a radio list, a segmented control, and a "state first" row with
// a Change button — read as a live setting that changed something, and nothing
// on this screen can change it: mode is per-CONVERSATION state owned by
// NativeSessionHost and set from the status-bar chip at the bottom of the chat,
// so there is no app-wide value for this screen to write. See MODES below.
//
// No `sm:` breakpoints: the dialog is size="panel" (420px) and never gets
// wider, so a breakpoint that only fires above 640px is dead code that merely
// looks responsive. Long text truncates or wraps instead.
// ═══════════════════════════════════════════════════════════════════════════

/** The one canonical section-label spelling (section-label-authority). */
const SECTION_LABEL = 'text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2';

/**
 * The folder card's top band.
 *
 * Derived from SETTING_ROW_BASE by REPLACEMENT rather than by copying the
 * string, so there is still exactly one definition of settings-row geometry —
 * copying it is what setting-row-authority exists to stop. The only thing
 * removed is the tile radius: this row is the card's top EDGE, and its own
 * 12px corners would leave a visible notch inside the card's border. The
 * `bg-inset/50` tint stays, and is load-bearing — it is what makes the header
 * read as a title band over the body rather than as one more row in a stack.
 *
 * It cannot be a <SettingRow>: SettingRowProps has no `aria-expanded`
 * pass-through, its <button> branch appends a static right-chevron that cannot
 * express open/closed, and passing a caret via `control` demotes the row to a
 * non-focusable <div>.
 */
const FOLDER_HEADER = `${SETTING_ROW_BASE.replace('rounded-lg', 'rounded-none')} hover:bg-inset cursor-pointer ${FOCUS_RING}`;

/** Rows shown per kind before "Show all N". Hiding a single row behind a click
 *  does not pay for the click, so the cut only applies above ROWS_PER_KIND + 1. */
const ROWS_PER_KIND = 5;

// ── The three modes ──────────────────────────────────────────────────────────
//
// Wording follows the chip at the bottom of the chat exactly (StatusBar's
// PERMISSION_DISPLAY: ASK FIRST / AUTO EDIT / FULL AUTO), so this names the
// same three things the user can already see and click.
//
// THIS IS REFERENCE CONTENT, NOT A CONTROL, AND IT MUST STAY THAT WAY.
// Mode is per-conversation state owned by NativeSessionHost and set from the
// status-bar chip; there is no app-wide default for this screen to own. Three
// selector shapes were tried here — a radio list, a segmented control, and a
// "state first" row with a Change button — and every one of them read as a live
// setting that changed something. A control that sets nothing is a lie in the
// shape of a control, so the modes are rendered as definitions, the same way
// ALWAYS_ASKS below is rendered as facts rather than as rows. The
// permissions-section test asserts that this block contains no focusable or
// interactive element at all — that is the pin, not this paragraph.
//
// Each `line` says what a mode costs or buys the reader, in the terms a
// non-developer already has: getting interrupted, or not. All three print at
// once — a reader is comparing them, not choosing one here.
//
// The fuller version — which tools never ask, where to change the mode
// mid-conversation, and what happens if you "Always allow" one of the
// always-asks items — is a section of the (i) explainer
// (permissions-explainer.ts), which is where explanation lives in this app.
const MODES: readonly { id: NativePermissionMode; label: string; line: string }[] = [
  {
    id: 'ask',
    label: 'Ask first',
    // "Reading and searching never ask" is the explainer's own wording, and it
    // is the fact that stops this reading as "asks about everything".
    // Destin's 2026-08-26/27 copy review: gerunds, one clause shorter.
    line: 'Checks with you before changing a file or running a command. Reading and searching never interrupt you.',
  },
  {
    id: 'auto-edit',
    label: 'Auto edit',
    line: 'Changes files without asking. Still checks before running a command.',
  },
  {
    id: 'full-auto',
    label: 'Full auto',
    // "The list below is the exception" — NOT "the list below cannot be turned
    // off". Those entries are `ask`, not `deny`, and a remembered "Always
    // allow" is the last layer the engine applies
    // (native-session-host.ts:291-301), so it does outrank them. Naming the
    // list as the exception to the mode is true either way; claiming it can
    // never be overridden would not be.
    line: 'Works without checking with you, so you can leave it running. It still asks before:',
  },
];

/** The hardcoded always-ask list (DESTRUCTIVE_DENY_LIST), in the user's words.
 *  Named by consequence rather than by command, because the deny-list entries
 *  are shell patterns and this screen never shows rule syntax.
 *
 *  These four items STAY in the body: they are the only place in the app that
 *  says what the app itself will not wave through, and a user cannot go find
 *  them anywhere else. Only the prose around them moved to the explainer. */
const ALWAYS_ASKS: readonly string[] = [
  'Deleting files or folders',
  'Sending your work to a shared code repository',
  "Throwing away changes you haven't saved anywhere else",
  "Anything needing your computer's administrator password",
];

// ── Small helpers ────────────────────────────────────────────────────────────

/** A readable name per folder, disambiguated ACROSS the whole list.
 *
 *  WHY not a bare basename: a worktree and its parent repo routinely share one
 *  (`…/youcoded-dev/youcoded` and `…/youcoded-dev/worktrees/youcoded`), which
 *  would render two identical names over two genuinely different rule sets and
 *  the user would revoke from whichever they guessed. Colliding names grow by
 *  one parent folder at a time until unique, so the common case stays a bare
 *  folder name. Folders with no recorded cwd are absent — the caller falls back
 *  to the slug and says the path was never recorded. */
function folderNames(projects: StoredProject[]): Map<string, string> {
  // Split on BOTH separators — a cwd recorded on Windows uses backslashes.
  const segments = new Map<string, string[]>();
  for (const project of projects) {
    if (!project.cwd) continue;
    const parts = project.cwd.split(/[\\/]+/).filter(Boolean);
    if (parts.length > 0) segments.set(project.slug, parts);
  }

  const depth = new Map<string, number>();
  for (const slug of segments.keys()) depth.set(slug, 1);

  const nameOf = (slug: string): string => {
    const parts = segments.get(slug)!;
    const want = Math.min(depth.get(slug)!, parts.length);
    return parts.slice(parts.length - want).join('/');
  };

  // Bounded by the deepest path, so this can never spin forever.
  const deepest = Math.max(1, ...[...segments.values()].map((parts) => parts.length));
  for (let pass = 0; pass < deepest; pass++) {
    const bySlug = new Map<string, string[]>();
    for (const slug of segments.keys()) {
      const name = nameOf(slug);
      bySlug.set(name, [...(bySlug.get(name) ?? []), slug]);
    }
    let widened = false;
    for (const colliding of bySlug.values()) {
      if (colliding.length < 2) continue;
      for (const slug of colliding) {
        const room = segments.get(slug)!.length;
        const current = depth.get(slug)!;
        if (current < room) {
          depth.set(slug, current + 1);
          widened = true;
        }
      }
    }
    if (!widened) break;
  }

  const names = new Map<string, string>();
  for (const slug of segments.keys()) names.set(slug, nameOf(slug));
  return names;
}

/** "Approved Jul 27, 2026", or nothing at all. Rules written before this screen
 *  existed carry no date, and a missing date is shown as missing, never as today. */
function grantedLabel(grantedAt?: string): string | null {
  if (!grantedAt) return null;
  const when = new Date(grantedAt);
  if (Number.isNaN(when.getTime())) return null;
  return `Approved ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

/** React list key. remember() dedupes exact repeats, so the sameRule QUINT
 *  (tool, pattern, action, match, specialist) is unique within a project —
 *  the same identity the removal API matches on. Both `match` and
 *  `specialist` must be in the key: `specialist` (Task 11) so a root grant
 *  and a specialist-keyed grant sharing the same tool/pattern/action still
 *  render as two distinct rows instead of colliding on one React key, and
 *  `match` so an exact grant and a wide (glob) grant sharing the same
 *  pattern don't collide either. Rules come from list(), which already
 *  normalizes `match` via normalizeRule — so a legacy row reads 'exact' here
 *  exactly as sameRule would compare it. */
function ruleKey(rule: PermissionRule): string {
  return `${rule.tool}::${rule.pattern ?? ''}::${rule.action}::${rule.match ?? ''}::${rule.specialist ?? ''}`;
}

/** Hand the backend a bare PermissionRule, not the StoredRule the list returned:
 *  grantedAt is provenance the matcher never reads, and sending it invites a
 *  future exact-shape comparison to silently stop matching. `match` and
 *  `specialist` DO ride along — the remove matcher (sameRule) needs both to
 *  tell rules apart: dropping `specialist` would revoke a same-triple root
 *  grant instead of (or as well as) the specialist-keyed one; dropping `match`
 *  would make a wide (glob) grant compare as 'exact' once stripped, so
 *  sameRule would never find it on disk and the revoke would silently no-op. */
function toPermissionRule(rule: StoredRule): PermissionRule {
  return {
    tool: rule.tool,
    ...(rule.pattern !== undefined ? { pattern: rule.pattern } : {}),
    action: rule.action,
    ...(rule.match !== undefined ? { match: rule.match } : {}),
    ...(rule.specialist !== undefined ? { specialist: rule.specialist } : {}),
  };
}

/** One short sentence naming an approval, for the accessible names on its
 *  buttons — twenty buttons all announcing "Revoke permission" is unusable with
 *  a screen reader, which is why DevicesTab labels its own the same way. */
function plainName(rule: StoredRule): string {
  const described = describeRule(rule);
  return described.subject !== undefined ? `${described.verb} ${described.subject}` : described.verb;
}

/** Split a folder's approvals into the four kind buckets, preserving order. */
function groupByKind(rules: StoredRule[]): Record<RuleKind, StoredRule[]> {
  const out: Record<RuleKind, StoredRule[]> = { commands: [], files: [], connections: [], other: [] };
  for (const rule of rules) out[ruleKind(rule)].push(rule);
  return out;
}

// ── The screen ───────────────────────────────────────────────────────────────

export default function PermissionsSection() {
  const [projects, setProjects] = useState<StoredProject[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Both of the general ErrorState's actions land on the app's existing
  // bug-report surface, exactly as Remote Access does: "Report bug" files it and
  // "Diagnose with the assistant" is the same popup's summarize path. One destination,
  // no invented flow. It portals, so nesting it here is safe.
  const [reportContext, setReportContext] = useState<ReportContext | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await window.claude.permissions.list();
      setProjects(Array.isArray(list) ? list : []);
      setLoadFailed(false);
    } catch {
      // No guessed cause in the copy — we do not know why it failed, so the
      // general two-action card is the honest surface
      // (docs/error-message-standards.md).
      setLoadFailed(true);
      setProjects((prev) => prev ?? []);
    }
  }, []);

  // THE ONLY LOAD TRIGGER, and it is enough — there is no Refresh button.
  // <Dialog> is `if (!open) return null` (Dialog.tsx:185), so this component is
  // unmounted while the dialog is closed and mounted again every time it opens;
  // this effect therefore re-runs on every open and the list is always read
  // fresh. `refresh` is a useCallback with no deps, so it never re-fires within
  // one visit. The internal reload after a successful removal is separate and
  // stays — that one is not an open.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const names = projects ? folderNames(projects) : new Map<string, string>();
  const withRules = (projects ?? []).filter((project) => project.rules.length > 0);
  // D2 (2026-08-26): the cross-project bucket is not a folder and it outranks
  // every folder — the grants in it are in force wherever the user is working,
  // so it reads first rather than sorted in among places it does not belong to.
  const ordered = [
    ...withRules.filter((project) => project.slug === CROSS_PROJECT_SLUG),
    ...withRules.filter((project) => project.slug !== CROSS_PROJECT_SLUG),
  ];

  return (
    // No opening paragraph. The dialog is titled "Permissions", the section
    // labels below say what each part is, and everything the intro used to
    // explain now lives behind the (i) — see SettingsExplainer's module header:
    // this app puts prose in the explainer and controls in the body.
    <section className="space-y-5">
      {/* ── 1. One explanation, both bands ────────────────────────────────── */}
      {/* The modes and the always-asks list share ONE bg-inset/50 card, divided
          by rules into bands. This is the whole point of the merge: Full auto's
          definition ends by pointing at the list, and here that list is inside
          the same box instead of a section away, so the sentence points at
          something the eye already reads as part of the same statement.

          REFERENCE, NOT A CONTROL — and deliberately so, for the modes as much
          as for the list. No selected state, nothing clickable, no hover
          affordance: the mode belongs to a CONVERSATION and is set from the
          status-bar chip in the chat, so a control here would set nothing (see
          the module header). The card closes by saying exactly that, which is
          why the note is the LAST band rather than part of the modes: by then it
          is the one thing left to say about the whole card. */}
      <div>
        {/* Heading matches the explainer's own "How much it asks" section, so
            the (i) reads as the long version of what is on screen. */}
        {/* Destin's 2026-08-26/27 copy review: the label is a name, not a
            sentence — the card underneath already does the explaining. */}
        <h3 className={SECTION_LABEL}>Permission modes</h3>
        <div className="rounded-lg bg-inset/50">
          <div className="px-3 py-2.5 space-y-2">
            {MODES.map((m) => (
              <div key={m.id}>
                <p className="text-2xs text-fg-2 leading-relaxed">
                  <span className="font-medium text-fg">{m.label}</span>
                  {' — '}
                  {m.line}
                </p>
                {/* The always-asks list hangs off FULL AUTO and nowhere else,
                    because that is the only mode it changes anything for. All
                    four items are commands, and Ask first and Auto edit both
                    already stop before every command — so under those two the
                    list is not an exception, it is a restatement. Under Full
                    auto it is the whole exception, and Full auto's own last
                    sentence now points at the very next thing on screen.

                    Indented rather than carded, and not <SettingRow>s: there is
                    nothing here to toggle or remove, and a row would promise a
                    control that does not exist.

                    What this deliberately does NOT say is "this cannot be turned
                    off" — an earlier draft claimed that and it was false. These
                    entries are `ask`, not `deny`, and rememberedRules are the
                    last layer the engine applies (native-session-host.ts:291-301),
                    so an explicit "Always allow" on one of them outranks it. The
                    (i) explainer states that accurately. */}
                {m.id === 'full-auto' && (
                  <ul className="mt-1.5 text-2xs text-fg-2 leading-relaxed list-disc pl-4 space-y-1">
                    {ALWAYS_ASKS.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
          <div className="border-t border-edge-dim px-3 py-2">
            <p className="text-3xs text-fg-muted">
              Each conversation has its own mode. Change it from the bar at the bottom of the chat.
            </p>
          </div>
        </div>
      </div>

      {/* ── 2. What you already waved through ─────────────────────────────── */}
      <div>
        <h3 className={SECTION_LABEL}>Always allowed</h3>

        {/* What "Always allow" actually buys you differs per mode, and the
            difference is not obvious — so it is stated rather than left to be
            inferred.

            Ask first / Auto edit: the entry simply stops that one thing asking.
            Full auto: it already asks about nothing EXCEPT the four items above,
            so an entry only changes anything there if it is one of those four —
            in which case it switches off the last check that mode still had.
            That is not a rhetorical flourish: remembered rules are the final
            layer the engine applies (native-session-host.ts:291-301), so they
            outrank the always-asks list. Saying "these can never be overridden"
            would be the comfortable sentence and the false one.

            "Things", not "commands": the list also holds file edits and
            connections to other services, not just commands.

            ONE card for the whole section, matching the explanation card above:
            same `rounded-lg bg-inset/50`, copy in its own band, a rule, then the
            folders. Both sections read as one object under their label instead
            of a paragraph and a loose stack of cards. */}
        <div className="rounded-lg bg-inset/50">
          <div className="px-3 py-2.5">
            <p className="text-2xs text-fg-dim leading-relaxed">
              {/* Destin's 2026-08-26/27 copy review: one promise for every mode
                  instead of a per-mode breakdown; the Full auto exception keeps
                  its own clause because it is the only one that changes. */}
              Things you chose &ldquo;Always allow&rdquo; for. Your assistant stops asking before each of
              these. Full auto never asks anyway, except for the four above &mdash; and an
              &ldquo;Always allow&rdquo; on one of those removes even that check.
            </p>
          </div>

          <div className="border-t border-edge-dim p-2.5">
            {projects === null ? (
              <LoadingState what="what you've approved" variant="inline" />
            ) : loadFailed ? (
              <ErrorState
                mode="general"
                title="Unable to show what you've approved."
                explainer="Nothing was changed. Diagnosing will collect the app's logs so the assistant can look at what happened."
                onReportBug={() => setReportContext({ surface: 'Settings → Permissions' })}
                onDiagnose={() => setReportContext({ surface: 'Settings → Permissions', diagnose: true })}
              />
            ) : withRules.length === 0 ? (
              <EmptyState
                // Reads as first-run rather than as an error, and names the one
                // action that fills this list. Where those approvals apply and
                // how to take one back is the explainer's job.
                message={'Nothing yet. When you choose “Always allow” on a request, it shows up here.'}
              />
            ) : (
              // Nothing between the band and the cards, on purpose. The summary
              // line and the Refresh button both went: the count is already on
              // every folder's own band, and the list reloads on open (see the
              // effect above). A card that begins directly under its label is
              // the family's normal rhythm, not an absence.
              <div className="space-y-2">
                {ordered.map((project) => (
                  <FolderCard
                    key={project.slug}
                    project={project}
                    name={names.get(project.slug) ?? null}
                    onChanged={refresh}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* The Claude Code boundary paragraph that used to close the screen is
          gone — PERMISSIONS_EXPLAINER_SECTIONS already carries it verbatim under
          "Approvals you gave Claude Code", so the body was printing a second
          copy of explainer content. */}

      <BugReportPopup open={!!reportContext} onClose={() => setReportContext(null)} context={reportContext ?? undefined} />
    </section>
  );
}

// ── One folder, as one contained card ────────────────────────────────────────

function FolderCard({
  project,
  name,
  onChanged,
}: {
  project: StoredProject;
  name: string | null;
  onChanged: () => Promise<void>;
}) {
  // ALWAYS COLLAPSED on arrival — no "open it when it's small" heuristic. A
  // screen whose height depends on how much you happened to approve is a
  // different screen every time you open it, and the count on each band already
  // says how much is inside without opening anything.
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const count = project.rules.length;
  // D2: the bucket's slug is a storage key ('all projects'), never a folder
  // name — printing it raw would put a place-shaped label on something that is
  // not a place. Its title and its one-line description are fixed copy.
  const everyProject = project.slug === CROSS_PROJECT_SLUG;
  const label = everyProject ? 'All projects' : (name ?? project.slug);
  const groups = groupByKind(project.rules);

  const confirmClear = async () => {
    setBusy(true);
    setNote(null);
    try {
      const hit = await window.claude.permissions.removeProject(project.slug);
      setConfirming(false);
      if (hit) {
        await onChanged();
      } else {
        // Same honesty rule as the per-approval remove: false means the list on
        // screen was already out of date, so say that rather than report a
        // success that did not happen. It no longer names a Refresh button —
        // that button is gone, and copy pointing at a control that does not
        // exist is exactly the drift item-list-authority pins. Closing and
        // reopening this screen remounts it and re-reads the list.
        setNote("These couldn't be found — they may already be gone. Reopen this screen for the current list.");
      }
    } catch {
      setNote('These could not be removed. Nothing was changed.');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    // THE CONTAINMENT. One bordered surface holds the folder and everything
    // inside it, so the boundary is drawn on all four sides instead of being
    // implied by 8px of indent. `overflow-hidden` lets the header band run edge
    // to edge inside the border.
    <div className="rounded-lg border border-edge bg-well overflow-hidden">
      {/* The card's top band. A ROW, not a section label: the folder name is
          user data, and putting it through a label's `tracking-wider uppercase`
          destroys its real casing and makes a legacy slug read as shouting. */}
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={FOLDER_HEADER}>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-fg truncate">{label}</div>
          {/* The path belongs with the name, so it is the row's description. It
              truncates because folderNames() has already guaranteed the NAME is
              unique — the path is supporting detail, and letting it wrap would
              make a list of collapsed folders tall again. The never-recorded
              line is a sentence, not data, so it wraps. */}
          {everyProject ? (
            // NOT the never-recorded sentence below: nothing is missing here.
            // This card has no path because it never had one, so it says what it
            // holds instead of apologising for an absence that isn't one.
            <p className="text-3xs -mt-0.5 text-fg-muted">
              Your own specialists that you always allow. These apply in every folder.
            </p>
          ) : project.cwd ? (
            <p className="text-3xs -mt-0.5 text-fg-muted truncate">{project.cwd}</p>
          ) : (
            // Says the path is missing rather than inventing one — it just does
            // not explain what is shown instead, which the row already shows.
            <p className="text-3xs -mt-0.5 text-fg-muted">
              {"This folder's location wasn't recorded."}
            </p>
          )}
        </div>
        {/* Count + caret: a collapsed card still says how much is inside it. The
            caret is the one sanctioned status glyph on this screen. */}
        <span className="text-3xs text-fg-muted shrink-0">
          {count} {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        // The body: divided from the band above it, and sitting on the card's
        // own `bg-well` plane rather than on the dialog's. Two cues plus the
        // border, and NO indent — the box is what says "inside", so the rows can
        // use the card's full width, which matters at 420px.
        <div className="border-t border-edge-dim px-2 pt-2.5 pb-2 space-y-3">
          {RULE_KIND_ORDER.filter((kind) => groups[kind].length > 0).map((kind) => (
            <KindGroup key={kind} kind={kind} rules={groups[kind]} slug={project.slug} onChanged={onChanged} />
          ))}

          {/* Per-folder bulk removal, at the BOTTOM of the open card so it can
              never be hit while aiming at the disclosure band, and `ghost` —
              the family's lightest variant — because it is the widest-reaching
              action on this screen and has no settings precedent to inherit
              weight from. Only above one approval: "Revoke all 1" is just the
              row's own button wearing a scarier label.
              px-0.5 + the ghost button's own px-2.5 lands this label on the same
              left edge as every row title above it. */}
          {count > 1 && (
            <div className="px-0.5">
              {!confirming ? (
                <Button
                  variant="ghost"
                  size="sm"
                  // The visible label lost "for this folder", so the folder name
                  // moves into the accessible name — a screen reader reads this
                  // button without the card around it.
                  aria-label={`Revoke all ${count} permissions for ${label}`}
                  onClick={() => {
                    setConfirming(true);
                    setNote(null);
                  }}
                >
                  {/* "for this folder" was redundant — the button is inside
                      that folder's card, under its name and path. */}
                  Revoke all {count}
                </Button>
              ) : (
                <div
                  className="space-y-2 rounded-lg bg-inset border border-edge-dim p-2.5"
                  // Escape cancels, matching DevicesTab — the trigger has just
                  // unmounted, so there is nothing else to escape back to.
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setConfirming(false);
                  }}
                >
                  <p className="text-2xs text-fg-dim leading-relaxed">
                    {`Revoke all ${count} for ${label}? You'll be asked again the next time any of them comes up.`}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => setConfirming(false)}
                      aria-label={`Keep everything approved for ${label}`}
                      className="flex-1 py-2"
                    >
                      Cancel
                    </Button>
                    {/* autoFocus: the trigger just unmounted, so without this a
                        keyboard user drops to <body> and re-tabs from the top. */}
                    <Button
                      variant="danger"
                      autoFocus
                      disabled={busy}
                      onClick={() => void confirmClear()}
                      aria-label={`Confirm removing everything approved for ${label}`}
                      className="flex-1 py-2"
                    >
                      {busy ? 'Revoking…' : 'Revoke all'}
                    </Button>
                  </div>
                </div>
              )}
              {note && <FieldError as="p" className="mt-1">{note}</FieldError>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── One kind of approval, inside a folder ────────────────────────────────────

function KindGroup({
  kind,
  rules,
  slug,
  onChanged,
}: {
  kind: RuleKind;
  rules: StoredRule[];
  slug: string;
  onChanged: () => Promise<void>;
}) {
  const [showAll, setShowAll] = useState(false);
  // Never hide a single row behind a click — the cut only pays for itself once
  // there is more than one row on the other side of it. The stress fixture's
  // 40-rule folder is what this exists for.
  const visible = showAll || rules.length <= ROWS_PER_KIND + 1 ? rules : rules.slice(0, ROWS_PER_KIND);

  return (
    <div>
      {/* THIS is a section label and takes the canonical treatment: "Commands"
          is authored copy that classifies the rows under it, unlike the folder
          name above, which is data. px-3 puts it on the same left edge as the
          row titles beneath it. */}
      <h3 className={`${SECTION_LABEL} px-3`}>{RULE_KIND_LABEL[kind]}</h3>
      <div className="space-y-1">
        {visible.map((rule) => (
          <RuleRow key={ruleKey(rule)} slug={slug} rule={rule} onChanged={onChanged} />
        ))}
        {visible.length < rules.length && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-3xs text-fg-2 hover:underline px-3"
          >
            Show all {rules.length}
          </button>
        )}
      </div>
    </div>
  );
}

// ── One remembered approval ──────────────────────────────────────────────────

function RuleRow({
  slug,
  rule,
  onChanged,
}: {
  slug: string;
  rule: StoredRule;
  onChanged: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const described = describeRule(rule);
  const name = plainName(rule);
  // Plain words under the title, never a status glyph or a badge. Only a
  // genuinely TOOL-WIDE grant gets the note: describeRule already reports MCP
  // grants as exact, and a scoped Bash grant ("Pushing to master") is narrow by
  // construction and says what it covers in its own sentence — putting the scary
  // note on it would teach the user to ignore it where it is true.
  const detail = [described.width === 'tool-wide' ? broadNote(rule.tool) : null, grantedLabel(rule.grantedAt)]
    .filter(Boolean)
    .join(' · ');

  const confirmRemove = async () => {
    setBusy(true);
    setNote(null);
    try {
      // The SLUG, never the cwd: nativeStoreSlug collapses ':', '\', '/' and
      // spaces all to '-', so a path cannot be reconstructed from a slug and the
      // store is keyed by the slug alone.
      const hit = await window.claude.permissions.remove(slug, toPermissionRule(rule));
      setConfirming(false);
      if (hit) {
        await onChanged();
      } else {
        // The rule was NOT on disk, so the row on screen came from a stale read.
        // Keep the row and say so — reporting success here would teach the user
        // to trust a list that lied to them. Reopening the screen is what re-reads
        // it now that the Refresh button is gone.
        setNote("This one couldn't be found — it may already be gone. Reopen this screen for the current list.");
      }
    } catch {
      setNote('This could not be removed. Nothing was changed.');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <SettingRow
        variant="item"
        title={
          <>
            {described.verb}
            {described.subject !== undefined && (
              <>
                {' '}
                <span className="font-mono text-fg-2 break-all">{described.subject}</span>
              </>
            )}
          </>
        }
        description={detail || undefined}
        // The trigger unmounts while the confirm is open, exactly as DevicesTab
        // does — two revoke buttons for one row would be ambiguous.
        // Destin's 2026-08-26/27 copy review: the visible label is just "Revoke"
        // — the row above already names what is being revoked. The aria-label
        // keeps the full sentence, so the button still stands on its own out of
        // context (a screen reader reads it without the row around it).
        control={
          confirming ? undefined : (
            <Button
              variant="danger-outline"
              size="sm"
              className="shrink-0"
              aria-label={`Revoke permission: ${name}`}
              onClick={() => {
                setConfirming(true);
                setNote(null);
              }}
            >
              Revoke
            </Button>
          )
        }
      />

      {confirming && (
        <div
          className="mt-1.5 space-y-2 rounded-lg bg-inset border border-edge-dim p-2.5"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setConfirming(false);
          }}
        >
          <p className="text-2xs text-fg-dim leading-relaxed">
            {"You'll be asked the next time this comes up."}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => setConfirming(false)}
              aria-label={`Keep permission: ${name}`}
              className="flex-1 py-2"
            >
              Cancel
            </Button>
            {/* Filled danger commits; the outline opened it. */}
            <Button
              variant="danger"
              autoFocus
              disabled={busy}
              onClick={() => void confirmRemove()}
              aria-label={`Confirm revoking permission: ${name}`}
              className="flex-1 py-2"
            >
              {busy ? 'Revoking…' : 'Revoke'}
            </Button>
          </div>
        </div>
      )}

      {note && <FieldError as="p" className="mt-1 px-3">{note}</FieldError>}
    </div>
  );
}
