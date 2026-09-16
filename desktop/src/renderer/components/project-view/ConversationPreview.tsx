// ConversationPreview — a past conversation opened from Project View's
// Conversations tab, in the centered detail overlay.
//
// Laid out like the Resume browser's preview (Destin, 2026-09-16: "resume in
// claude should just say resume, and should allow the user to pick the model.
// the date banner should be at the bottom. we should have some of the same
// tag/complete/rename/other options shown in resume browser, in similar
// styling"):
//   header — the name (click to rename), the tag button, the Complete button
//   body   — SessionPreviewPane, the same preview every surface shows
//   foot   — an action card: tags, the details line with the date, then the
//            Resume browser's own model picker, switches and Resume button
//            (ResumeOptionsForm)
//
// IMPORTANT: This component NEVER spawns a Claude process by itself. Only the
// Resume button leads to a live session, through the parent's `onResume`.
import { useMemo, useRef, useState, useEffect } from 'react';
import type { PastSession } from '../../../shared/types';
import { ProjectDetailOverlay } from './ProjectDetailOverlay';
import SessionPreviewPane from '../SessionPreviewPane';
import SessionRenameDialog from '../SessionRenameDialog';
import { Button, ErrorState } from '../ui';
import { TagGlyph } from '../tags/glyphs';
import { TagNoteEditor } from '../tags/TagNoteEditor';
import { PRIORITY_TAG, PRIORITY_HINT } from '../tags/built-in-tags';
import { SessionCardTags, SessionCardMeta, CompleteToggle } from '../SessionCardDetails';
import { useResumeOptions, ResumeOptionsForm, type ResumeHandler } from '../ResumeOptions';
import { usePreviewMeta } from '../../hooks/usePreviewMeta';
import { useTagRegistry } from '../../hooks/useTagRegistry';
import { namingApi } from '../assistant-settings/naming-api';
import { useRenamedSessions } from '../assistant-settings/use-renamed-sessions';
import { COPY } from '../../../shared/chatsearch-refs';

interface ConversationPreviewProps {
  session: PastSession;
  onClose: () => void;
  onResume: ResumeHandler;
  defaultModel?: string;
  defaultSkipPermissions?: boolean;
}

export function ConversationPreview({ session, onClose, onResume, defaultModel, defaultSkipPermissions }: ConversationPreviewProps) {
  const registry = useTagRegistry();
  // Tags, note, Priority and Complete are read for THIS conversation: the
  // Projects list does not carry tags or notes, so the row alone would show
  // none and a tag toggle would start from a wrong picture.
  const meta = usePreviewMeta(session.sessionId);
  const options = useResumeOptions(defaultModel, defaultSkipPermissions);
  const [renaming, setRenaming] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  const sources = useMemo(() => ({ [session.sessionId]: session.name }), [session.sessionId, session.name]);
  const renamed = useRenamedSessions(sources);
  const name = renamed[session.sessionId] ?? session.name ?? '';

  // The row as the card parts draw it, with what the meta read found. Until
  // that read lands, the list's own flags stand in.
  const row: PastSession = {
    ...session,
    name,
    flags: meta.loading ? session.flags : { ...session.flags, ...meta.flags },
    tags: meta.tags,
    note: meta.note || undefined,
  };

  // Start the model picker on the model this conversation last used.
  useEffect(() => {
    options.resetFor(session);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resetFor is redefined every render; the row is what changes.
  }, [session.sessionId]);

  // Click-away closes the tags/note sheet, as the side panel's does.
  useEffect(() => {
    if (!sheetOpen) return;
    const onDown = (e: MouseEvent) => {
      if (sheetRef.current && !sheetRef.current.contains(e.target as Node)) setSheetOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [sheetOpen]);

  // The name renames on click, dotted-underlined with a pencil — the Resume
  // card's own title control. Without the naming service it is plain text.
  const title = namingApi() ? (
    <Button
      variant="ghost"
      size="sm"
      className="group inline-flex max-w-full items-center justify-start gap-1.5 min-w-0 -ml-2 px-2 py-1 rounded-md cursor-text hover:bg-well transition-colors"
      aria-label={`Rename ${name || COPY.untitled}`}
      aria-haspopup="dialog"
      onClick={() => setRenaming(true)}
    >
      <span className="truncate font-semibold text-fg decoration-dotted underline-offset-[3px] underline decoration-fg-muted">{name || 'Untitled'}</span>
      <span className="text-fg-muted shrink-0">
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </span>
    </Button>
  ) : (name || 'Untitled');

  // Tag and Complete, in the Resume card's order: Complete — the one that
  // changes what the Resume list shows — outermost.
  const tools = (
    <div ref={sheetRef} className="relative flex items-center">
      <button
        type="button"
        onClick={() => setSheetOpen((o) => !o)}
        aria-label={`Organize ${name || COPY.untitled}`}
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        className={`px-1 py-1.5 rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          sheetOpen ? 'text-fg' : 'text-fg-faint hover:text-fg-2'
        }`}
      >
        <TagGlyph className="w-4 h-4" />
      </button>
      <CompleteToggle
        done={!!row.flags?.complete}
        name={name || COPY.untitled}
        onToggle={(next) => void meta.toggleFlag('complete', next)}
        className="px-1 py-1.5"
      />
      {sheetOpen && (
        <div className="layer-surface absolute right-0 top-full mt-2 w-[280px] p-2 z-30" role="dialog" aria-label={COPY.tagsAndNoteLabel}>
          {/* An unreadable note is reported, never opened as an empty editor —
              a save writes the whole note (code review 2026-09-11, F1). */}
          {meta.unreadable ? (
            <ErrorState
              variant="inline"
              message={`Couldn't load this conversation's tags and note: ${meta.unreadable}`}
              onRetry={meta.reload}
            />
          ) : (
            <TagNoteEditor
              appliedIds={new Set(meta.tags)}
              onToggleTag={(id, next) => void meta.toggleTag(id, next)}
              registry={registry}
              note={meta.note}
              onNote={(text) => void meta.saveNote(text)}
              builtIns={[{
                tag: PRIORITY_TAG,
                hint: PRIORITY_HINT,
                applied: !!row.flags?.priority,
                onToggle: (next) => void meta.toggleFlag('priority', next),
              }]}
            />
          )}
        </div>
      )}
    </div>
  );

  return (
    <>
      <ProjectDetailOverlay title={title} onClose={onClose} tools={tools}>
        <div className="flex h-full min-h-0 flex-col preview-backdrop">
          <div className="min-h-0 flex-1">
            <SessionPreviewPane
              provider={session.provider === 'native' ? 'native' : 'claude'}
              id={session.sessionId}
              title={name}
              projectSlug={session.projectSlug}
              backdrop={false}
            />
          </div>
          {/* The Resume browser's action card, with the conversation's tags and
              details line (and so its date) on top — the date's new home. */}
          <div className="shrink-0 p-3 pt-0">
            <div className="rounded-lg border border-edge bg-panel shadow-[0_4px_16px_rgba(0,0,0,0.18)]">
              <div className="px-3 pt-2.5">
                <SessionCardTags session={row} tagsById={registry.byId} className="mb-1" />
                <SessionCardMeta session={row} showProject={false} />
              </div>
              <ResumeOptionsForm
                session={row}
                options={options}
                onResume={() => { void options.resume(row, onResume); }}
                flush
              />
            </div>
          </div>
        </div>
      </ProjectDetailOverlay>
      {renaming && <SessionRenameDialog id={session.sessionId} name={name} onClose={() => setRenaming(false)} />}
      {options.dialog}
    </>
  );
}
