// The parts a past-conversation card is made of: the tag row, the dotted
// details line (project · model · size … date) and the Complete button. Shared
// by the Resume browser, Project View's Conversations tab and its preview.
//
// WHY one file (2026-09-16): Destin asked for the Projects page's conversation
// cards to look like the Resume browser's. Copying these lines would give two
// cards that agree today and drift the first time one is touched.
import type { PastSession } from '../../shared/types';
import type { TagRecord } from '../../shared/tags';
import { TagChip } from './tags/TagChip';
import { PRIORITY_TAG } from './tags/built-in-tags';
import { ModelIcon } from './model/ModelPicker';
import { resolveModelBrand } from './provider-brand';
import { ProviderIcon } from './ProviderIcon';

export function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString();
}

// WHY shared card surface + title (render-cost consolidation 2026-09-18): the
// Resume browser and the Projects → Conversations tab draw the same card, and
// both spelled these classes out by hand — two copies that agree today and
// drift the first time one is touched. The BASE is split out because the Resume
// card swaps its border colour (accent when selected, no hover when inert), so
// it cannot take the resting border + hover pair; everything else it shares.
export const SESSION_CARD_SURFACE_BASE = 'rounded-lg border bg-inset transition-colors';
export const SESSION_CARD_SURFACE = `${SESSION_CARD_SURFACE_BASE} border-edge-dim hover:border-edge`;

/** The card's bold one-line title (Conversations tab). */
export function SessionCardTitle({ title }: { title: string }) {
  return <span className="block py-1 text-sm-tight font-semibold text-fg truncate">{title}</span>;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = Math.round(bytes / 1024);
  if (kb < 1024) return `${kb}KB`;
  return `${(kb / 1024).toFixed(1)}MB`;
}

// Claude Code model ids carry a release date — `claude-sonnet-4-5-20250929`.
// The date is noise on a card that already shows when the conversation last
// ran, and it is the difference between the chip fitting and truncating. Only a
// TRAILING 8-digit group is stripped, so a native id that happens to contain
// digits (`gpt-5.6-sol`, `qwen3-coder-30b-a3b-instruct`) is untouched. The full
// id stays in the chip's title attribute.
function formatModelId(id: string): string {
  return id.replace(/-\d{8}$/, '');
}

/** Tag chips after the name. Priority is FIRST and rendered with the same
 *  TagChip as everything else — it is a built-in tag, not a separate species of
 *  label (built-in-tags.ts). Complete has no chip: its state is the hide icon
 *  on the Resume card. Renders nothing when there is nothing to show.
 *  `tagsById` is passed in, not read from useTagRegistry here: that hook loads
 *  the registry, and one load per card would be one per row. */
export function SessionCardTags({ session: s, tagsById, className = '' }: {
  session: PastSession;
  tagsById: ReadonlyMap<string, TagRecord>;
  className?: string;
}) {
  if (!(s.flags?.priority || (s.tags && s.tags.length > 0) || s.note)) return null;
  return (
    <div className={`flex items-center gap-1 mt-0.5 flex-wrap ${className}`}>
      {s.flags?.priority && <TagChip tag={PRIORITY_TAG} />}
      {(s.tags ?? []).map((id) => {
        const t = tagsById.get(id);
        return t ? <TagChip key={id} tag={t} /> : null;
      })}
      {s.note && <span className="text-4xs text-fg-muted" title={s.note}>📝 note</span>}
    </div>
  );
}

/**
 * Bottom line: one dotted trail of context on the left — project, model, size —
 * then the timestamp on the right.
 * The model sits INSIDE that trail rather than floating right beside the date:
 * it is another fact ABOUT the conversation, and pinning it to the right edge
 * grouped it with the timestamp instead (reported 2026-07-31 with a screenshot).
 * Built as segments joined by "·" rather than a template string, because two of
 * the three are conditional — a grouped list or a single project's page drops
 * the project, and a conversation with no recorded model drops that — and a
 * literal separator would leave stray dots on either.
 */
export function SessionCardMeta({ session: s, showProject }: { session: PastSession; showProject: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-3xs text-fg-muted">
      {s.missingProject || s.notSyncedYet ? (
        // Plain words, no glyphs (house rule). Resume needs the project folder
        // AND its transcript present on this device — the two notes say which
        // one is missing.
        <span className="truncate flex-1 min-w-0">
          {s.notSyncedYet ? 'Not synced to this device yet' : 'Project folder not on this device'}
        </span>
      ) : (
        <span className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden">
          {[
            // Same folder glyph as the project picker (FolderSwitcher.tsx) so
            // "which project" looks the same wherever it is answered.
            showProject ? (
              <span key="project" className="flex items-center gap-1 min-w-0">
                <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <span className="truncate">{s.projectPath.replace(/\\/g, '/').split('/').pop()}</span>
              </span>
            ) : null,
            // Last model this conversation actually RAN on. Rendered only when
            // the record has one — showing the app default here would be a
            // guess dressed as history (see PastSession.lastUsedModel).
            s.lastUsedModel ? (
              <span
                key="model"
                className="flex items-center gap-1 min-w-0"
                title={`Last used ${s.lastUsedModel.modelId} (${s.lastUsedModel.providerLabel})`}
              >
                {/* Company mark instead of the generic glyph. The mark carries
                    the brand colour; the model NAME stays muted like the rest
                    of the line, so the model is not promoted above the project
                    and the date. */}
                {(() => {
                  const b = resolveModelBrand(s.lastUsedModel.modelId, s.lastUsedModel.providerType);
                  return b?.icon
                    ? <span className="shrink-0 inline-flex" style={{ color: b.color }}><ProviderIcon icon={b.icon} size={12} /></span>
                    : <ModelIcon className="w-3 h-3 shrink-0" />;
                })()}
                <span className="truncate">{formatModelId(s.lastUsedModel.modelId)}</span>
              </span>
            ) : null,
            // Size only when known: the side panel's conversation comes from the
            // search index, which does not record it (0), and "0B" would be a lie.
            s.size > 0 ? <span key="size" className="shrink-0">{formatSize(s.size)}</span> : null,
          ]
            .filter(Boolean)
            // Separators go between surviving segments, so a missing project or
            // model never leaves a dangling dot.
            .flatMap((node, i) => (i === 0
              ? [node]
              : [<span key={`sep-${i}`} className="shrink-0">·</span>, node]))}
        </span>
      )}
      <span className="shrink-0 ml-auto">{formatRelativeTime(s.lastModified)}</span>
    </div>
  );
}

/** Mark a conversation complete, or undo it. The Resume card and the Projects
 *  preview both carry it. Hover copy is a question ("Mark this session
 *  complete?") so the icon reads as an action, not a status badge. */
export function CompleteToggle({ done, name, onToggle, className = '' }: {
  done: boolean;
  name: string;
  onToggle: (next: boolean) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onToggle(!done); }}
      aria-pressed={done}
      title={done ? 'Marked complete — hidden unless Show Complete is on. Click to undo.' : 'Mark this session complete?'}
      aria-label={done ? `Mark ${name} not complete` : `Mark ${name} complete`}
      className={`rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        done ? 'text-accent' : 'text-fg-faint hover:text-fg-2'
      } ${className}`}
    >
      {/* Check-in-a-circle: "done" is what the user is saying; hiding the row is
          a consequence the Show Complete toggle already explains. Filled when
          set so the state reads at a glance. */}
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="9" fill={done ? 'currentColor' : 'none'} />
        {/* Knocked out of the fill when set — var(--canvas), not a hardcoded
            white, so it survives a dark or community theme. */}
        <path d="M8 12.5l2.5 2.5L16 9.5" stroke={done ? 'var(--canvas)' : 'currentColor'} />
      </svg>
    </button>
  );
}
