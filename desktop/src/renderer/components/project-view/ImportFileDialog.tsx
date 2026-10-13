// ImportFileDialog — the Move/Copy dialog behind "+ Add file" (Task 6).
//
// "+ Add file" used to write a sidecar "pin" — a tracked record pointing at a
// file elsewhere on disk — and never touched the filesystem. This dialog is
// what makes it a REAL import: the user explicitly picks Copy (source stays
// put) or Move (source is gone), and — for a batch that collides with names
// already in the destination folder — resolves every collision in the batch
// with ONE choice (Replace / Keep both / Skip) rather than being asked once
// per file. Built on the shared popup (Dialog) like every other popup.
import { useState } from 'react';
import { Button, CARD_LEVEL_1, Dialog, SegmentedTabs } from '../ui';
import { getPlatform } from '../../platform';

export type ImportMode = 'move' | 'copy';
export type CollisionMode = 'replace' | 'keep-both' | 'skip';

export interface ImportFileDialogProps {
  /** Absolute source paths picked from the native file dialog. */
  sources: string[];
  /** Absolute destination folder the files will land in (used by the caller
   *  to build the request; this dialog only ever shows destLabel). */
  destDir: string;
  /** Human label for destDir — the folder currently being browsed, or the
   *  project name at the root — so the target is named, never a guess. */
  destLabel: string;
  /** Basenames among `sources` that already exist in destDir, computed by the
   *  caller from the current folder listing BEFORE this dialog opens. Empty
   *  (default) means no collisions and no Replace/Keep both/Skip choice.
   *  This list is DISCLOSED to the user by name below and forwarded to main,
   *  which will only ever apply 'replace' to a name that appears in it — the
   *  listing it is derived from can miss files (noise-file skips, discovery
   *  caps), and an overwrite the user was never shown is data loss. */
  collisions?: string[];
  onConfirm: (args: { mode: ImportMode; onCollision: CollisionMode }) => void;
  onCancel: () => void;
}

// How many colliding filenames to spell out before the "…and N more" line.
const MAX_NAMED_COLLISIONS = 8;

const COLLISION_LABEL: Record<CollisionMode, string> = {
  replace: 'Replace',
  'keep-both': 'Keep both',
  skip: 'Skip',
};

export function ImportFileDialog({
  sources,
  destLabel,
  collisions = [],
  onConfirm,
  onCancel,
}: ImportFileDialogProps) {
  // Default 'keep-both' — the only one of the three that loses nothing. A
  // default of 'replace' would silently destroy a file on a batch the user
  // never individually reviewed.
  const [onCollision, setOnCollision] = useState<CollisionMode>('keep-both');

  // Move deletes the source; Android's picker already copied the selection
  // into ~/attachments/ before the renderer ever saw a path, so "the source"
  // there is a temp copy — moving it would delete the temp and leave the
  // user's real original untouched, which is a lie. Defensive today: every
  // artifacts:* channel is a not-implemented-on-mobile stub (mobile Project
  // View is v2), so this tab has no data on Android at all — the gate just
  // keeps the wrong affordance from waiting when v2 lands.
  const isAndroid = getPlatform() === 'android';
  const multiple = sources.length > 1;
  const hasCollisions = collisions.length > 0;

  const confirm = (mode: ImportMode) => onConfirm({ mode, onCollision });

  // WHY the shared popup (final review F16; decisions "Popup and side-panel titles", "Closing
  // popups"): this was hand-built — an 18px title (the shared one is 16px), no ✕ and no tapered
  // line. Now: the shared title and ✕ (Esc = Cancel, the Dialog's own), the question and the
  // collision choice in one card, and the buttons stacked full width in the narrow popup's footer
  // with the one filled button on top (guide "Buttons": two or more in a narrow popup stack).
  // The Replace / Keep both / Skip choice is the shared tab strip (guide "Settings": 2–4 short
  // choices) in its nested look, not three buttons where the picked one was filled.
  const title = `Add ${multiple ? `${sources.length} files` : 'file'}`;
  return (
    <Dialog
      open
      onClose={onCancel}
      title={title}
      size="prompt"
      noScreen="Opens only after files are picked in the system file picker (Projects → + Add file)."
      footer={(
        <div className="flex flex-col gap-2">
          <Button variant="primary" className="w-full" onClick={() => confirm('copy')}>Copy</Button>
          {!isAndroid && (
            <Button variant="secondary" className="w-full" onClick={() => confirm('move')}>Move</Button>
          )}
          <Button variant="secondary" className="w-full" onClick={onCancel}>Cancel</Button>
        </div>
      )}
    >
      <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-3`}>
        <p className="text-sm text-fg">
          Copy or move {multiple ? 'these files' : 'this file'} into{' '}
          <span className="font-medium font-mono">{destLabel}</span>?
        </p>

        {hasCollisions && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-fg-2">
              {collisions.length} file{collisions.length === 1 ? '' : 's'} already
              exist{collisions.length === 1 ? 's' : ''} in this folder:
            </p>
            {/* NAME them. Replace is one choice applied to the whole batch, so a
                bare count ("2 files already exist") asks the user to approve an
                overwrite of files they cannot see — and the caller's collision
                list can be incomplete, which is why main refuses to replace
                anything not listed here (see import-file.ts). Capped list with
                an overflow line so a 50-file batch can't push the buttons off
                screen. */}
            <ul className="max-h-24 overflow-y-auto text-xs font-mono text-fg-2 flex flex-col gap-0.5">
              {collisions.slice(0, MAX_NAMED_COLLISIONS).map((name) => (
                <li key={name} className="truncate">{name}</li>
              ))}
              {collisions.length > MAX_NAMED_COLLISIONS && (
                <li className="text-fg-muted font-sans">
                  …and {collisions.length - MAX_NAMED_COLLISIONS} more
                </li>
              )}
            </ul>
            <SegmentedTabs
              aria-label="Files that already exist"
              variant="nested"
              value={onCollision}
              onChange={(id) => setOnCollision(id as CollisionMode)}
              tabs={(['replace', 'keep-both', 'skip'] as const).map((m) => ({ id: m, label: COLLISION_LABEL[m] }))}
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}
