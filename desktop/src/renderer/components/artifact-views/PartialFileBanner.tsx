import { getPlatform } from '../../platform';
import { Button } from '../ui';
import { EDIT_MAX_BYTES, FULL_READ_MAX_BYTES } from '../../../shared/artifacts/editable-path-policy';

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * Shown when the pane is holding only the first EDIT_MAX_BYTES of a larger file.
 *
 * Position and styling deliberately mirror the floating Edit ↔ Save cluster
 * (SessionDrawer.tsx) and effectively take its place: a file this large is
 * read-only, so the Edit pill is gone and this bar occupies the same spot.
 * Panel-width rather than a compact pill, because it carries a sentence — with
 * the action as the pressable region on its right end (Destin, 2026-08-25).
 *
 * Floating over the bottom of the viewer, NOT inside the scroll container, so
 * it cannot scroll away: a partial view that looks complete after two screens
 * of scrolling is the failure mode this whole approach exists to avoid.
 *
 * States a size because the size is information the user can act on — never as
 * the reason the app "won't" do something (docs/error-message-standards.md).
 */
export function PartialFileBanner({ sizeBytes, onLoadFull, onOpenExternally }: {
  sizeBytes: number;
  onLoadFull: () => void;
  onOpenExternally: () => void;
}) {
  const canLoadFull = sizeBytes <= FULL_READ_MAX_BYTES;
  // shell.openPath is desktop-only — the remote shim stubs it as a no-op and
  // Android has no handler, so the button would silently do nothing there.
  // Offering a button that does nothing is worse than offering none, so on
  // those platforms the bar states the fact and carries no action at all.
  const isElectron = getPlatform() === 'electron';
  const action = canLoadFull
    ? { label: 'Load the whole file', onClick: onLoadFull }
    : isElectron
      ? { label: 'Open externally', onClick: onOpenExternally }
      : null;

  return (
    <div className="absolute bottom-4 left-4 right-4 z-20 flex items-center gap-3
                    rounded-full bg-panel border border-edge shadow-lg
                    pl-4 pr-1.5 py-1.5">
      {/* Terse on purpose: the bar shares its width with a button, so the
          sentence has to survive a narrow pane. "Large file" is the label, the
          fraction is the fact (Destin, 2026-08-25). */}
      <span className="flex-1 min-w-0 truncate text-sm text-fg-2">
        <span className="font-semibold text-fg">Large file</span>
        {' — '}Showing {mb(EDIT_MAX_BYTES)}/{mb(sizeBytes)} MB
      </span>
      {action && (
        // The house Button primitive, never a hand-rolled bg-accent (design
        // rule 1). rounded-full overrides the standard radius to match the
        // floating Edit/Save pills this bar stands in for — the same documented
        // exception those already use.
        <Button size="md" onClick={action.onClick} className="shrink-0 rounded-full">
          {action.label}
        </Button>
      )}
    </div>
  );
}
