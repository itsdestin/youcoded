import type { ArtifactViewProps } from './types';
import { getPlatform } from '../../platform';
import { Button } from '../ui';
import { READ_BINARY_MAX_BYTES } from '../../../shared/artifacts/editable-path-policy';

export function BinaryFallback({ path, absolutePath, contentInfo, sniffedBinaryTextFile }: ArtifactViewProps) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const size = contentInfo?.sizeBytes;
  // State the TRUE reason. Size is the reason ONLY when the file is genuinely
  // past what we can load; otherwise the reason is the format — and saying "too
  // large" about a 2.3 MB PNG is the bug that started all this (spec §4.5).
  const message = size !== undefined && size > READ_BINARY_MAX_BYTES
    // Size is the reason.
    ? `This file is ${(size / (1024 * 1024)).toFixed(1)} MB — larger than YouCoded can display.`
    : sniffedBinaryTextFile
      // The FORMAT is supported; this particular file isn't text. Saying
      // "can't display .md files" here would be plainly false.
      ? `This ${ext ? `.${ext} ` : ''}file contains data that isn’t text, so it can’t be shown here.`
      : path.includes('.') && ext
        // The format is the reason. "yet" is deliberate (Destin, 2026-09-05):
        // every file type is now clickable in chat, so this panel is the app
        // admitting a gap rather than refusing a file — and the way out of it
        // is the button below.
        ? `YouCoded can’t display .${ext} files yet.`
        : 'YouCoded can’t display this kind of file yet.';
  // shell.openPath is desktop-only — the remote shim stubs it as a no-op and
  // Android has no handler, so showing the button there would silently do
  // nothing. Gate on the platform like SessionDrawer's toolbar does.
  const isElectron = getPlatform() === 'electron';
  const openExternally = () => {
    // Open with the OS default app via shell.openPath (HTML→browser, etc.).
    (window.claude as any).shell?.openPath?.(absolutePath);
  };
  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-fg-muted">
      <p className="mb-4">{message}</p>
      <p className="mb-4 font-mono text-sm">{path}</p>
      {isElectron && (
        <Button
          // `primary` (the default) + lg reproduces the old accent fill and
          // px-4 py-2 sizing; the primitive owns radius, hover and focus ring.
          // Label matches the Session Drawer toolbar, CsvView and XlsxView,
          // which have always called this action "Open externally" — this was
          // the one place that said something different.
          size="lg"
          onClick={openExternally}
          title="Open with the default app"
        >
          Open externally
        </Button>
      )}
    </div>
  );
}
