import { useCallback, useEffect, useState } from 'react';
import type { SpecialistDefinitionView, DelegatedModelsView, SpecialistsListResult } from '../../shared/types';
import ModelPicker, { type ModelChoice } from './model/ModelPicker';
import { Button, Callout, EmptyState, ErrorState, FieldError, LoadingState, Pill, SectionLabel } from './ui';
import type { ExplainerSection } from './SettingsExplainer';
import { refreshSpecialistRoster, useSpecialistRoster, provenanceWithinGroup, NOT_IMPLEMENTED_ON_MOBILE } from '../hooks/useSpecialists';
import { AUTOMATIC_SPECIALIST_MODEL_COPY, SPECIALIST_DEFAULTS_CHANGED_EVENT } from './SpecialistModelUnavailable';

// Specialists 1c — Settings → Specialists. Two things, in the order a person
// needs them: (1) the two model tiers the assistant can hire onto (Destin's
// 2026-09-15 ruling: explicit choices are global overrides; otherwise use a
// reviewed model matching the conversation provider), and (2) the roster — every specialist
// the assistant can hire right now, where it came from, what it may do, and
// any narrowing the loader applied to a file (spec §2: a stripped tool is a
// VISIBLE warning, never a silent edit). No editor: that is later marketplace
// work; the folder is opened for you instead.

// WHY: the local SECTION_LABEL class string is retired here in favour of the
// shared `<SectionLabel>` primitive (fix batch 1, 2026-09-24 — design guide
// small label: normal case, no letter-spacing).

// Task 10: group labels per the approved design. A project's OWN
// .claude/agents/ file gets the same 'claude-code' source as the user-level
// ~/.claude/agents (only `path` tells them apart — see definedBy in
// hooks/useSpecialists.ts), so this ONE group covers both.
const SOURCE_LABEL: Record<SpecialistDefinitionView['source'], string> = {
  builtin: 'Built in',
  personal: 'Your specialists',
  'claude-code': 'Claude Code agents',
};

const SOURCE_ORDER: SpecialistDefinitionView['source'][] = ['builtin', 'personal', 'claude-code'];

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

export const SPECIALISTS_EXPLAINER_INTRO =
  'Specialists are helpers your assistant can hire for a piece of work — a search, a review, an edit — while it keeps talking to you. Each one runs on its own with only the tools its job needs.';

export const SPECIALISTS_EXPLAINER_SECTIONS: ExplainerSection[] = [
  {
    heading: 'The two model tiers',
    paragraphs: [
      'When your assistant hires a helper it can ask for the Budget model (fast and efficient for searching and reading) or the Frontier model (stronger for code reviews and judgment calls). If a tier is not set, YouCoded chooses a reviewed model that matches the conversation’s provider.',
      'A model you choose here overrides the automatic choice for every provider. If the reviewed model is unavailable, the helper does not start and its card brings you back here. The assistant may name a specific model only when you ask it to.',
    ],
  },
  {
    heading: 'Where specialists come from',
    bullets: [
      { term: 'Built in', text: 'Explorer, Researcher, Reviewer and Worker ship with the app.' },
      { term: 'Your specialists', text: 'Files in your specialists folder. Add one there and it appears here the moment it is saved.' },
      // Fix: was "the project's own specialists folder" — that folder doesn't
      // exist. A project's specialists come from its OWN .claude/agents
      // folder (Claude Code's format), same as the account-wide one below.
      { term: 'Claude Code agents', text: 'Files in a project’s own .claude/agents folder, or in your ~/.claude/agents folder. Those use Claude Code’s tool names, which are translated; anything that does not translate is removed and listed as a warning.' },
    ],
  },
  {
    heading: 'Read-only vs can edit',
    paragraphs: [
      // Destin's 2026-08-26/27 copy review: deleting is split out of the
      // "either way" clause, because a read-only helper cannot delete anything
      // — listing it for both charters overstated the read-only case.
      "A read-only helper can look at files and search the web, but can't change anything or run commands. A helper that can edit is limited to the folder it was hired for. Either way, secrets and anything outside that folder still ask you — and for helpers that can edit, so does deleting things. Approving a hire is what grants this; the card in the chat says exactly what before you say yes.",
    ],
  },
];

export default function SpecialistsSection({ cwd }: {
  /** The active conversation's working folder, when one exists — threaded
   *  down from App.tsx (SettingsPanel has no session state of its own).
   *  Omitting it is not a bug, just narrower: the roster shows only the two
   *  global sources (built-ins + your specialists folder), never a project's
   *  own .claude/agents. */
  cwd?: string;
}) {
  // Fix (Task 10 review, finding 2): ensurePersonalFolder now rides the
  // hook's OWN auto-load effect (see the WHY at useSpecialistRoster) instead
  // of a second, separate mount effect that raced it — that used to fire two
  // concurrent specialists:list calls on every Settings open. Spec §2's one
  // deliberate exception to "the folder appears on first write": Settings
  // wants somewhere for Open Folder to open even before the user has ever
  // saved a specialist.
  const roster = useSpecialistRoster(cwd, { ensurePersonalFolder: true });
  const [tiers, setTiers] = useState<DelegatedModelsView | null>(null);
  // Task 13: two DIFFERENT failure moments, kept as separate state so each
  // renders correctly — a load failure means there's nothing to show (the
  // rows disappear, replaced by ErrorState + Retry); a write failure means
  // the rows are already showing a real value that must revert and stay
  // visible, with the refusal shown alongside it.
  const [tierLoadError, setTierLoadError] = useState<string | null>(null);
  const [tierWriteError, setTierWriteError] = useState<string | null>(null);
  // Task 13: the not-implemented-on-mobile shape can come back from
  // getDelegatedModels independently of the roster call — tracked here so
  // the single top-of-component check below covers both.
  const [tiersUnavailable, setTiersUnavailable] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const folders = roster.status === 'ready' ? roster.result.folders : undefined;

  // Fix (Task 10 review, fix pass 2): shell.openPath resolves with an EMPTY
  // string on success and an ERROR STRING on failure — the click handler used
  // to discard that with `void`, so a permissions problem or a folder removed
  // between render and click failed with no feedback at all. Reuses the same
  // ErrorState surface (recoverable + Retry) the roster load failure already
  // uses just below, rather than inventing a new one.
  const openFolder = useCallback(() => {
    if (!folders) return;
    setFolderError(null);
    void window.claude.shell.openPath(folders.personal).then(result => {
      if (result) setFolderError(result);
    });
  }, [folders]);

  const loadTiers = useCallback(async () => {
    try {
      const t = await window.claude.specialists.getDelegatedModels();
      if (t && typeof t === 'object' && 'budget' in t) {
        setTiers(t as DelegatedModelsView);
        setTierLoadError(null);
        return;
      }
      // Fix (Task 13): a not-implemented-on-mobile reply is ALSO a truthy
      // object without 'budget' — the roster hook already has a name for
      // this exact shape. Route it to the same "whole section is
      // desktop-only" outcome the roster uses, instead of a generic error.
      const err = t && typeof t === 'object' ? (t as { error?: unknown }).error : undefined;
      if (err === NOT_IMPLEMENTED_ON_MOBILE) { setTiersUnavailable(true); return; }
      // Fix (Task 13): this used to fall back to `{ budget: null, frontier:
      // null }`, which renders as "Not set" — a real error read as a fact
      // about the user's OWN configuration. Show the real text instead of
      // guessing, and leave `tiers` alone so the rows don't lie either.
      setTierLoadError(typeof err === 'string' ? err : 'Could not load the model settings — unexpected response.');
    } catch (e) {
      // Fix (Task 13): same bug as above, via the exception path.
      setTierLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => { void loadTiers(); }, [loadTiers]);

  const setTier = async (tier: 'budget' | 'frontier', choice: ModelChoice | null) => {
    if (choice && choice.runtime !== 'native') return; // specialists run natively
    const binding = choice ? { providerId: choice.providerId, modelId: choice.modelId, label: choice.modelId } : null;
    const prev = tiers;
    // Optimistic; revert if the write is refused.
    setTiers(t => t ? { ...t, [tier]: binding } : t);
    setTierWriteError(null);
    try {
      const res = await window.claude.specialists.setDelegatedModel(tier, binding);
      if (res && res.ok === false) { setTiers(prev); setTierWriteError(`Couldn’t save the ${tier} model. ${res.error ?? ''}`.trim()); return; }
      await loadTiers();
      if (binding) {
        // WHY the failed Task card waits for confirmed persistence, not the
        // optimistic picker value, before it offers to try the hire again.
        window.dispatchEvent(new CustomEvent(SPECIALIST_DEFAULTS_CHANGED_EVENT, { detail: { tier } }));
      }
    } catch (e) { setTiers(prev); setTierWriteError((e as Error).message); }
  };

  // Task 13: a host where the native specialists harness doesn't exist yet
  // (a phone, today) must never be shown as "nothing here" — that reads as
  // "you have no specialists" when the truth is "this feature isn't on
  // this device yet". ONE check, after every hook above has already run,
  // covering both signals the two backend calls can report — so nothing
  // downstream has to guess which half of the screen is broken.
  if (roster.status === 'unavailable' || tiersUnavailable) {
    return (
      <section className="space-y-5">
        <EmptyState message="Specialists run on the desktop app. Open Settings there to add or edit them." />
      </section>
    );
  }

  const definitions = roster.status === 'ready' ? roster.result.definitions : [];
  const skipped = roster.status === 'ready' ? roster.result.skipped : [];

  const bySource = new Map<SpecialistDefinitionView['source'], SpecialistDefinitionView[]>();
  for (const d of definitions) {
    const arr = bySource.get(d.source) ?? [];
    arr.push(d);
    bySource.set(d.source, arr);
  }
  const skippedBySource = new Map<'personal' | 'claude-code', typeof skipped>();
  for (const s of skipped) {
    const arr = skippedBySource.get(s.source) ?? [];
    arr.push(s);
    skippedBySource.set(s.source, arr);
  }
  const skippedFor = (src: SpecialistDefinitionView['source']) =>
    src === 'builtin' ? [] : (skippedBySource.get(src) ?? []);
  const warningCount = definitions.reduce((n, d) => n + d.warnings.length, 0);

  return (
    // space-y-4: the guide's 16px between groups (fix batch 2; was 20px, off
    // the 4·8·12·16·24 scale).
    <section className="space-y-4">
      {/* ── 1. Models for specialists ─────────────────────────────────────── */}
      {/* Destin's copy (workbench pass): the panel opens by saying what this
          screen is for and pointing at the ⓘ for the long version, so neither
          block below has to carry an explainer of its own.
          WHY -mt-2 (fix batch 2, 2026-09-26): this is the "Specialists"
          heading's own intro, so it sits 8px under it (the scale's step for
          things that belong together), not 16px. The page shell spaces every
          block 16px apart, which is right between groups but read as a big gap
          between a heading and its first line — Destin, B1-4: "the large gap
          after the specialists header before the copy". */}
      <p className="-mt-2 text-2xs text-fg-dim leading-relaxed">
        Your assistant may utilize “specialists” to help it accomplish some tasks. This menu allows you to configure which specialists your assistant has access to. Click the (i) above for additional information.
      </p>

      <div>
        <SectionLabel className="mb-2">Specialist intelligence tiers</SectionLabel>
        {/* Destin (workbench pass): the intro paragraph is GONE, wrapper and
            all — not just emptied, or the box would keep its padding and read
            as a blank gap. The heading plus each row's own hint carry it; the
            (i) explainer holds the longer version for anyone who wants it. */}
        <div className="rounded-lg bg-inset/50">
          {tierLoadError ? (
            <div className="p-2.5">
              <ErrorState mode="recoverable" message={tierLoadError} onRetry={() => void loadTiers()} variant="inline" />
            </div>
          ) : (
            <>
              {/* No `border-t` any more — the paragraph that used to sit above
                  it is gone, so it would have drawn a stray rule across the top
                  of the box. */}
              <div className="divide-y divide-edge-dim">
                <TierRow
                  tier="budget"
                  title="Budget"
                  hint="(best for searching, reading, and summarizing)"
                  value={tiers?.budget ?? null}
                  loaded={tiers !== null}
                  onPick={(c) => setTier('budget', c)}
                  onClear={() => setTier('budget', null)}
                />
                <TierRow
                  tier="frontier"
                  title="Frontier"
                  hint="(best for nuanced tasks, code reviews, and judgment calls)"
                  value={tiers?.frontier ?? null}
                  loaded={tiers !== null}
                  onPick={(c) => setTier('frontier', c)}
                  onClear={() => setTier('frontier', null)}
                />
              </div>
              {/* Fix (review): was a hand-rolled <div className="… text-danger">
                  — no role="alert", so a screen reader never announced a
                  refused save, and it did not look like any other error in
                  the app. FieldError (components/ui/states.tsx) is the
                  component built for exactly this shape: a short inline line
                  next to the picker it belongs to, not a card — the roster's
                  full ErrorState below is deliberately heavier because it
                  replaces a whole missing list, not one field. */}
              {tierWriteError && (
                <div className="border-t border-edge-dim px-3 py-2">
                  <FieldError>{tierWriteError}</FieldError>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── 2. The roster ─────────────────────────────────────────────────── */}
      <div>
        {/* WHY this shape (fix batch 2 — design guide "Text and numbers"): a
            count beside a label is the word then a smaller, fainter number
            ("Available specialists 7"), never "· 7 ·". The warnings are a
            status, so they are the tinted pill ("1 warning"), not more text. */}
        <div className="mb-2 flex items-center gap-2">
          <SectionLabel>
            Available specialists
            {roster.status === 'ready' && <span className="ml-1.5 text-3xs font-normal text-fg-dim">{definitions.length}</span>}
          </SectionLabel>
          {warningCount > 0 && <Pill tone="warning">{warningCount} warning{warningCount === 1 ? '' : 's'}</Pill>}
        </div>
        {/* Fix (UX review 1, U27): an empty padded div sat here above the first
            group and read as a missing row; the first group's top border now
            starts the card. */}
        <div className="rounded-lg bg-inset/50">
          {roster.status === 'loading' ? (
            <div className="border-t border-edge-dim px-3 py-3">
              <LoadingState what="specialists" variant="inline" />
            </div>
          ) : roster.status === 'failed' ? (
            <div className="border-t border-edge-dim p-2.5">
              <ErrorState mode="recoverable" message={roster.error} onRetry={() => void refreshSpecialistRoster(cwd)} variant="inline" />
            </div>
          ) : definitions.length === 0 && skipped.length === 0 ? (
            <div className="border-t border-edge-dim p-2.5">
              <EmptyState message="No specialists found — even the built-ins are missing, which is a bug worth reporting." variant="inline" />
            </div>
          ) : (
            SOURCE_ORDER.filter(src => bySource.has(src) || skippedFor(src).length > 0).map(src => (
              <div key={src} className="border-t border-edge-dim">
                {/* WHY SectionLabel, not the old eyebrow class (fix batch 1,
                    2026-09-24): design guide small label — normal case, no
                    letter-spacing. Was `text-3xs ... tracking-wider uppercase`.
                    Padding on the wrapper: SectionLabel owns only margin
                    (design-lint no-restyle). */}
                <div className="px-3 pt-2 pb-1">
                  <SectionLabel>{SOURCE_LABEL[src]}</SectionLabel>
                </div>
                <ul className="pb-1">
                  {(bySource.get(src) ?? []).map(d => <RosterRow key={`${d.source}-${d.id}`} d={d} folders={folders} />)}
                  {skippedFor(src).map(s => <SkippedRow key={s.path} s={s} />)}
                </ul>
              </div>
            ))
          )}
          <div className="border-t border-edge-dim px-2 py-1.5 flex items-center justify-between gap-2">
            {/* Footer copy per Task 13 brief, verbatim. */}
            <span className="text-3xs text-fg-muted px-1">Files are re-read each time you send a message; Refresh to re-read now.</span>
            <div className="flex items-center gap-1 shrink-0">
              <Button size="sm" variant="ghost" onClick={() => void refreshSpecialistRoster(cwd)}>Refresh</Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!folders}
                title={folders ? undefined : 'Not available until the specialists folder has been read'}
                onClick={openFolder}
              >
                Open folder
              </Button>
            </div>
          </div>
          {folderError && (
            <div className="border-t border-edge-dim p-2.5">
              <ErrorState mode="recoverable" message={folderError} onRetry={openFolder} variant="inline" />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function TierRow({ tier, title, hint, value, loaded, onPick, onClear }: {
  tier: 'budget' | 'frontier';
  title: string;
  hint: string;
  value: DelegatedModelsView['budget'];
  loaded: boolean;
  onPick: (c: ModelChoice) => void;
  onClear: () => void;
}) {
  const choice: ModelChoice | null = value ? { runtime: 'native', providerId: value.providerId, modelId: value.modelId } : null;
  // Stacked, not side-by-side: the panel dialog is ~420px wide and the picker
  // trigger is wide, so a row layout squeezed the hint into a one-word column.
  return (
    <div className="px-3 py-2.5 space-y-1.5" data-testid={`tier-row-${tier}`}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-xs font-medium text-fg-2">{title}</span>
        <span className="text-2xs text-fg-muted">{hint}</span>
      </div>
      {/* Destin (workbench pass): Clear sits BENEATH the picker at the same
          width, not beside it. Side-by-side made two competing controls on one
          line and shrank the picker — the destructive one should read as
          secondary to the thing it undoes, not as its equal. */}
      <div className="space-y-1.5">
        <ModelPicker
          value={choice}
          onSelect={onPick}
          includeClaude={false}
          emptyLabel={loaded ? AUTOMATIC_SPECIALIST_MODEL_COPY : 'Loading models…'}
        />
        {value && (
          // Outlined, not bare text (fix batch 2 — decisions.md "Secondary
          // buttons"/"Follow-up actions": never bare text as a button).
          <Button size="sm" variant="secondary" className="w-full" onClick={onClear} title={`Unset the ${tier} model`}>Clear</Button>
        )}
      </div>
      {/* Destin (2026-09-15 review): the unset explanation belongs INSIDE the
          selector as its current value, not on a separate line beneath it.
          The status line below therefore exists only while loading or when a
          concrete override is selected. */}
      {(!loaded || value) && (
        <div className="text-2xs">
          {!loaded
            ? <LoadingState what={`the ${tier} model`} variant="inline" />
            : <span className="text-fg-dim">Set to <span className="text-fg-2">{value!.label}</span></span>}
        </div>
      )}
    </div>
  );
}

function RosterRow({ d, folders }: { d: SpecialistDefinitionView; folders?: SpecialistsListResult['folders'] }) {
  const [open, setOpen] = useState(false);
  const canShell = d.allowedTools.includes('Bash');
  return (
    <li
      className={`px-3 py-1.5 ${d.offered ? '' : 'opacity-50'}`}
      data-testid={`specialist-row-${d.id}`}
    >
      <button type="button" onClick={() => setOpen(v => !v)} className="w-full text-left rounded-md px-1 -mx-1 state-layer" aria-expanded={open}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-fg-2">{d.displayName}</span>
          {/* Destin (workbench pass): the read-write badge was amber. Now the
              same neutral styling as read-only — the words already say what the
              helper can do, and colouring one capability as a hazard made the
              list read as a warning rather than a roster. */}
          {/* WHY Pill (fix batch 2, 2026-09-26): the guide's tinted pill in
              normal case ("Read-only", "Can edit & run commands") — these were
              9px spaced-out capitals in a hairline box. Both capabilities keep
              ONE tint (Destin's earlier call: colouring read-write as a hazard
              made the roster read as a warning); only a real warning is amber. */}
          <Pill tone="info">
            {d.charter === 'read-write' ? (canShell ? 'Can edit & run commands' : 'Can edit files') : 'Read-only'}
          </Pill>
          {d.modelPreference && d.modelPreference !== 'parent' && (
            <Pill tone="info">Prefers {d.modelPreference}</Pill>
          )}
          {d.warnings.length > 0 && (
            <Pill tone="warning">{d.warnings.length} warning{d.warnings.length === 1 ? '' : 's'}</Pill>
          )}
        </div>
        {/* Task 10: provenance — where this row's definition actually came
            from, so "which .claude/agents is this" is never a guess.
            Destin (workbench pass): provenanceWithinGroup returns '' when the
            group heading above already said it — render nothing rather than an
            empty line, or the row keeps a blank gap where the text used to be.
            NOT definedBy: the hire card in chat has no heading and needs the
            full string. */}
        {provenanceWithinGroup(d, folders) && (
          <div className="text-2xs text-fg-muted">{provenanceWithinGroup(d, folders)}</div>
        )}
        {/* Fix (Task 13): d.description is the CLAMPED text the assistant's
            tool list actually gets (MAX_DESCRIPTION_CHARS); Settings should
            show what the file author actually wrote. The warning list below
            already says a description was shortened and why. */}
        <div className="text-2xs text-fg-dim leading-relaxed">{d.fullDescription ?? d.description}</div>
      </button>
      {open && (
        <div className="mt-1 pl-2 border-l-2 border-edge-dim space-y-1 text-2xs">
          <div className="text-fg-muted">Tools: <span className="text-fg-dim">{d.allowedTools.join(', ')}</span></div>
          {d.path && <div className="text-fg-muted">File: <span className="font-mono text-fg-dim break-all">{d.path}</span></div>}
        </div>
      )}
      {/* WHY a warning Callout inside the row (fix batch 2 — decisions.md
          "Problem on a list item"): a warning about this specialist is the
          shared tinted box inside its own row, text grey — it was amber text
          with a ⚠. Closed: the first warning; open: all of them. */}
      {d.warnings.length > 0 && (
        <Callout tone="warning" className="mt-1.5">
          {open
            ? <ul className="space-y-0.5">{d.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            : d.warnings[0]}
        </Callout>
      )}
    </li>
  );
}

/** Task 10: a file the loader could NOT place (parse failure or an id that
 *  collides with one already loaded — spec: no shadowing, first loaded wins).
 *  Rendered greyed under its source group, next to the definitions that DID
 *  load, so "why isn't my file showing up" has an answer right there. */
function SkippedRow({ s }: { s: { path: string; source: 'personal' | 'claude-code'; error: string } }) {
  return (
    <li className="px-3 py-1.5 opacity-50" data-testid={`specialist-skipped-${basename(s.path)}`}>
      <div className="text-xs font-medium text-fg-2 font-mono truncate">{basename(s.path)}</div>
      <div className="text-2xs text-amber-700">⚠ {s.error} — not offered to the assistant.</div>
    </li>
  );
}
