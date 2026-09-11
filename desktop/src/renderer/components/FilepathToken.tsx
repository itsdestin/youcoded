import { useArtifactOptional } from '../state/ArtifactContext';
import { useOpenFilepath } from '../hooks/useOpenFilepath';
import { Tooltip } from './ui';

interface Props {
  path: string;
  sessionId: string;
  /** 'pill' (default) is the recessed file chip used inline in prose.
   *  'inline' renders `label` as dotted-underlined text instead — for places
   *  where the file IS the thing already named, and a second chip beside it
   *  would just repeat itself (the skill-invocation card, Destin 2026-07-28).
   *  Both variants share every bit of the resolve-and-open behavior below,
   *  which is the whole reason this is a variant and not a second component. */
  variant?: 'pill' | 'inline';
  /** Text for the 'inline' variant. Defaults to the basename. */
  label?: string;
}

// Inline SVG glyphs (not emoji) so the icon inherits `currentColor` and matches
// the app's lucide-style iconography. Image files get the picture glyph; every
// other type gets the document glyph.
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);

function FileGlyph({ ext }: { ext: string }) {
  const common = {
    width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const, className: 'text-fg-dim shrink-0',
  };
  if (IMAGE_EXTS.has(ext)) {
    return (
      <svg {...common}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.5-3.5L11 18" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

// Best-effort absolute path for the right-click menu's View-in-folder / Open /
// Copy-as-path actions. Claude often writes a project-relative path; join it with
// the session cwd so shell.showItemInFolder/openPath get a real target. Already-
// absolute paths (POSIX, Windows drive, or ~) pass through untouched.
function resolveForMenu(p: string, cwd?: string): string {
  const norm = p.replace(/\\/g, '/');
  if (/^([a-zA-Z]:\/|\/|~)/.test(norm)) return p;
  if (cwd) return cwd.replace(/[\\/]+$/, '') + '/' + norm.replace(/^\.\//, '');
  return p;
}

export function FilepathToken({ path, sessionId, variant = 'pill', label }: Props) {
  // Optional: the buddy window / sandbox render this without ArtifactProvider.
  // When absent, the pill still renders (so prose isn't disrupted) but the
  // click is a no-op — there's no drawer to open in those roots.
  const artifactCtx = useArtifactOptional();
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  // Basename only inline — the full path lives in the title tooltip. Keeps prose
  // calm when Claude references deep paths mid-sentence.
  const name = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path;
  // Absolute path for the chat right-click menu (View in folder / Copy as path).
  const menuPath = resolveForMenu(path, artifactCtx?.state.sessionCwd?.[sessionId]);

  // Resolve-and-open lives in useOpenFilepath, shared with DeliverablesCard, so
  // a pill and a sent-file tile can never disagree about what a click opens.
  const openFile = useOpenFilepath(sessionId);
  const onClick = () => { void openFile(path); };

  if (variant === 'inline') {
    return (
      <Tooltip text={path}>
      <button
        type="button"
        // Dotted underline rather than a solid link: it reads as "there is more
        // behind this word" without turning the label into prose-styled link text.
        // select-text: globals.css makes every <button> unselectable chrome, but
        // this label is a word of the message. Without it, a copied sentence
        // would come out with the file name missing (Destin, 2026-09-10).
        className="underline decoration-dotted underline-offset-2 decoration-fg-muted hover:decoration-fg transition-colors select-text"
        onClick={onClick}
        data-file-path={menuPath || undefined}
      >
        {label ?? name}
      </button>
      </Tooltip>
    );
  }

  return (
    <Tooltip text={path}>
    <button
      type="button"
      // B4 recessed pill: sits on --well with a hairline --edge border so it
      // lifts out of the bg-inset chat bubble. (Before this, the chip was also
      // bg-inset — same color as the bubble, so it read as flat text, not a
      // clickable file.) Monospace basename keeps the "this is a file" signal.
      // select-text: same reason as the inline variant above. The file name is
      // part of the message, even though the pill is a <button>.
      className="group inline-flex items-center gap-1.5 align-middle px-2 py-0.5 rounded-md bg-well border border-edge hover:border-fg-muted transition-colors select-text"
      onClick={onClick}
      // Right-click menu recovers the path here (left-click still opens the drawer).
      data-file-path={menuPath || undefined}
    >
      <FileGlyph ext={ext} />
      <span className="font-mono text-[0.85em] text-fg group-hover:underline underline-offset-2 decoration-fg-muted">
        {name}
      </span>
    </button>
    </Tooltip>
  );
}
