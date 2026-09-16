// ContextEditorOverlay — view/edit an agent-context file in the shared centered
// overlay (Task 4.4). Opens in a read-only rendered VIEW (markdown rendered;
// other formats shown as monospace text); the header "Edit" tool swaps in a
// textarea. A blast-radius banner sits at the top of the body so the user
// understands the reach of an edit BEFORE saving: AMBER + a Confirm step for
// global files (they affect every project on the device), neutral + direct-save
// for project files. Action buttons (Edit/Save/Cancel, Reveal, Copy path) live
// in the overlay header; a meta strip (scope · load timing · size) sits below it.
//
// Renderer-only: reads/writes via the already-allow-listed
// project:read-context-file / project:write-context-file IPC. Errors from the
// write path (the main-process allow-list can reject) surface inline rather
// than being swallowed.
import { useEffect, useState } from 'react';
import type { ContextFile, ContextScope } from '../../../shared/project-context-types';
import { ProjectDetailOverlay } from './ProjectDetailOverlay';
import MarkdownContent from '../MarkdownContent';
import {
  TOOL_BTN_ACCENT, TOOL_BTN_NEUTRAL, PencilIcon, CheckIcon, FolderIcon, LinkIcon,
} from './detail-tool-icons';
// Plain-text load-timing label — shared with ContextTab (context-labels.ts).
import { timingLabel } from './context-labels';
import { getPlatform } from '../../platform';
import { Textarea } from '../ui';

interface ContextEditorOverlayProps {
  project: { path: string };
  file: ContextFile;
  onClose: () => void;
}

// Scope label for the meta strip (mirrors ContextTab's GROUP_META labels).
const SCOPE_LABEL: Record<ContextScope, string> = {
  project: 'Project instructions',
  global: 'Global instructions',
  memory: 'Memory',
};

export function ContextEditorOverlay({ project, file, onClose }: ContextEditorOverlayProps) {
  // content = the on-disk text (the "saved" baseline); draft = the editable copy.
  // Save is disabled while draft === content so we never write a no-op edit.
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Open in read-only view; the header Edit tool flips this on.
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Inline confirm gate for global files — clicking Save first swaps the header
  // tools to Confirm/Cancel (matches the prototype + is testable without a modal).
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);

  const isGlobal = file.blastRadius === 'global';
  const isMarkdown = /\.(md|markdown)$/i.test(file.absolutePath);

  // Load the file content on open and whenever the target path changes. A
  // `cancelled` flag guards against a late response from a previous file
  // overwriting the current one (the overlay is keyed by absolutePath upstream,
  // but this is defensive).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    setEditing(false);
    setConfirming(false);
    (async () => {
      try {
        const res = await (window.claude as any).project.readContextFile(
          project.path, file.absolutePath,
        );
        if (cancelled) return;
        if (res && res.ok) {
          const text = res.content ?? '';
          setContent(text);
          setDraft(text);
        } else {
          setContent(null);
          setLoadError(res?.error || 'Could not read this file.');
        }
      } catch (e: any) {
        if (cancelled) return;
        setContent(null);
        setLoadError(e?.message || 'Could not read this file.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [project.path, file.absolutePath]);

  const dirty = content !== null && draft !== content;

  // Performs the actual write. For global files this only runs after the inline
  // confirm; for project files it runs directly from the Save click.
  const doSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await (window.claude as any).project.writeContextFile(
        project.path, file.absolutePath, draft,
      );
      if (res && res.ok) {
        // Success: close the overlay (simplest contract — Save disables again
        // would also be valid, but closing avoids a stale-on-screen editor).
        onClose();
        return;
      }
      // Surface the rejection reason; keep the overlay open with the draft intact.
      setSaveError(res?.error || 'Could not save this file.');
    } catch (e: any) {
      setSaveError(e?.message || 'Could not save this file.');
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  };

  const handleSaveClick = () => {
    if (!dirty || saving) return;
    // Global files get a confirm step (blast-radius gate); project files save now.
    if (isGlobal) setConfirming(true);
    else doSave();
  };

  const handleStartEdit = () => {
    setEditing(true);
    setSaveError(null);
  };

  const handleCancelEdit = () => {
    // Leave edit mode and discard in-progress changes.
    setDraft(content ?? '');
    setEditing(false);
    setConfirming(false);
    setSaveError(null);
  };

  const handleReveal = () => {
    (window.claude as any).shell?.showItemInFolder?.(file.absolutePath);
  };

  const handleCopyPath = () => {
    navigator.clipboard?.writeText(file.absolutePath).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard unavailable — ignore */ });
  };

  // Header tools — Edit ↔ Save/Cancel (or Confirm/Cancel for the global gate),
  // plus Reveal + Copy path. Hidden entirely when the file failed to load.
  const tools = loadError ? null : (
    <>
      {!editing ? (
        <button type="button" className={TOOL_BTN_ACCENT} onClick={handleStartEdit} disabled={loading}>
          <PencilIcon size={13} />
          Edit
        </button>
      ) : confirming ? (
        <>
          <button type="button" className={TOOL_BTN_ACCENT} onClick={doSave} disabled={saving}>
            <CheckIcon size={13} />
            {saving ? 'Saving…' : 'Confirm'}
          </button>
          <button
            type="button"
            className={TOOL_BTN_NEUTRAL}
            onClick={() => setConfirming(false)}
            disabled={saving}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <button type="button" className={TOOL_BTN_ACCENT} onClick={handleSaveClick} disabled={!dirty || saving}>
            <CheckIcon size={13} />
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className={TOOL_BTN_NEUTRAL} onClick={handleCancelEdit} disabled={saving}>
            Cancel
          </button>
        </>
      )}
      {/* Desktop-only (shell.showItemInFolder) — gate so it can't render dead
          on remote/Android, matching SessionDrawer + FilesTab. */}
      {getPlatform() === 'electron' && (
        <button type="button" className={TOOL_BTN_NEUTRAL} onClick={handleReveal}>
          <FolderIcon size={13} />
          Reveal
        </button>
      )}
      <button type="button" className={TOOL_BTN_NEUTRAL} onClick={handleCopyPath}>
        <LinkIcon size={13} />
        {copied ? 'Copied' : 'Copy path'}
      </button>
    </>
  );

  // Meta strip: scope badge · load timing · size.
  const meta = (
    <>
      <span className="inline-flex items-center text-3xs uppercase tracking-wide font-medium text-fg-dim bg-inset border border-edge-dim rounded px-1.5 py-0.5">
        {SCOPE_LABEL[file.scope]}
      </span>
      <span className="text-fg-faint">·</span>
      <span>{timingLabel(file)}</span>
      {file.size && (
        <>
          <span className="text-fg-faint">·</span>
          <span>{file.size}</span>
        </>
      )}
    </>
  );

  return (
    <ProjectDetailOverlay title={file.label} onClose={onClose} tools={tools} meta={meta}>
      <div className="flex flex-col h-full min-h-0 px-5 py-4 gap-3">
        {/* Blast-radius banner — always visible at the top of the body. Global
            uses prototype inline colors so the amber warning reads clearly
            regardless of theme; project uses neutral theme tokens. */}
        {!loadError && (isGlobal ? (
          <div
            className="border rounded-lg px-3 py-2 text-xs leading-relaxed shrink-0"
            style={{ color: '#9a6a00', background: '#FFF6E5', borderColor: '#E8C170' }}
          >
            <strong>Global file — affects every project.</strong> Editing this changes how Claude
            works in every folder on this machine, not just this project.
          </div>
        ) : (
          <div className="bg-inset border border-edge rounded-lg px-3 py-2 text-xs text-fg-2 shrink-0">
            <strong>Project instructions.</strong> Editing this changes how Claude behaves across
            every session in this project.
          </div>
        ))}

        {/* Inline write error — surfaces the allow-list rejection reason. */}
        {saveError && (
          <div className="text-xs text-destructive-fg shrink-0">{saveError}</div>
        )}

        {/* Body: loading / error / view / edit */}
        {loading ? (
          <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-fg-muted">
            Loading…
          </div>
        ) : loadError ? (
          <div className="flex-1 min-h-0 flex items-center justify-center">
            <p className="text-sm text-destructive-fg max-w-md text-center">{loadError}</p>
          </div>
        ) : editing ? (
          /* Shared Textarea (change 20). Retires the `focus:ring-1` focus ring
             for the app-wide border-colour focus; resize-none is the
             primitive's default so it no longer needs stating. Layout
             (flex-1/min-h-0) and the monospace treatment stay — this edits a
             raw context file. */
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            aria-label={`Edit ${file.label}`}
            className="flex-1 min-h-0 w-full font-mono leading-relaxed"
          />
        ) : (
          <div className="flex-1 min-h-0 overflow-auto">
            {isMarkdown
              ? <MarkdownContent content={content ?? ''} />
              : <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg-2 m-0">{content}</pre>}
          </div>
        )}
      </div>
    </ProjectDetailOverlay>
  );
}
