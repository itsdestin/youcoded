// DeliverablesCard — the in-bubble card for files the assistant hands to the user
// via the SendUserFile tool (Claude Code's built-in, mirrored by the native
// harness under the same name — spec 2026-08-25), and links the assistant hands
// to the user via the SendUserLink tool (spec 2026-09-02 — a link tile opens in
// the system browser, never the artifact viewer, because a URL has no artifact
// to preview).
//
// Layout decisions (Destin, 2026-08-25 — workbench compare rounds 1–2, pick
// "D + scroll-aware fades + collapsible"):
//   - ONE "Deliverables" card per bubble, LAST in the bubble after the tool
//     cards. Named "Deliverables", NOT "Files" (Destin 2026-08-25): other files
//     show up in chat as pills and tool cards without being deliverables, and
//     a card called "Files" would blur that line. It
//     is the deliverable, not a log line, so it must stay visually distinct
//     from a collapsed tool group: lifted bg-well card, a "Deliverables · N" header
//     with the caption, and previews instead of a status line. The
//     SendUserFile calls are pulled out of their tool groups the same way
//     Skill cards are (see AssistantTurnBubble → ToolGroupInline).
//   - Body is a FILMSTRIP: one row of fixed-width preview tiles that scrolls
//     sideways. A fade on the right says "more this way" only while there IS
//     more; a fade on the left appears once a tile has slid under that edge.
//     Same strip on narrow screens (a sideways swipe is natural on a phone).
//   - Collapsible like a tool card (chevron; Ctrl+O expand/collapse-all
//     applies), CLOSED by default like the tool cards around it (Destin,
//     2026-08-25, after seeing it open on a real screen).
//   - Every tile opens the artifact viewer through useOpenFilepath, the same
//     path a filepath pill takes — so untracked files (a scratchpad report)
//     still open, and "Open" never lies.
//   - Preview is ArtifactThumbnail: ONE preview mechanism app-wide (image /
//     first lines of text / scaled HTML page / letter glyph). Nothing here
//     re-implements a thumbnail.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolCallState } from '../../shared/types';
import type { ArtifactRecord } from '../../shared/artifacts/types';
import { useArtifactOptional } from '../state/ArtifactContext';
import { useNarrowViewport } from '../hooks/use-narrow-viewport';
import { useExpandAllToggle, getInitialExpanded } from '../hooks/useExpandAllToggle';
import { ChevronIcon } from './Icons';
import { useOpenFilepath } from '../hooks/useOpenFilepath';
import { ArtifactThumbnail } from './ArtifactThumbnail';
import { matchSessionArtifact } from './filepath-match';
import { asString } from '../utils/tool-input';
import { isSendUserLinkToolName } from '../../shared/send-user-link';
import { Tooltip } from './ui';

export const SENT_FILES_TOOL = 'SendUserFile';

export function isSentFilesTool(tool: ToolCallState | undefined): tool is ToolCallState {
  return !!tool && tool.toolName === SENT_FILES_TOOL;
}

/** Link deliveries arrive under TWO names — `SendUserLink` from YouCoded's own
 *  harness, `mcp__youcoded__SendUserLink` from the per-session MCP server the
 *  app attaches to Claude Code sessions (main/claude-code-mcp.ts). Both draw
 *  the same tile; isSendUserLinkToolName is the single matcher (and matches
 *  exactly, never a wildcard — see shared/send-user-link.ts). */
export function isSentLinksTool(tool: ToolCallState | undefined): tool is ToolCallState {
  return !!tool && isSendUserLinkToolName(tool.toolName);
}

/** The `files` argument, tolerant of the model sending a single string. Tool
 *  inputs are untyped JSON — never trust the shape (see utils/tool-input). */
export function sentFilePaths(input: Record<string, unknown>): string[] {
  const raw = input.files;
  if (Array.isArray(raw)) return raw.filter((f): f is string => typeof f === 'string' && f.length > 0);
  const single = asString(raw) || asString(input.file) || asString(input.file_path);
  return single ? [single] : [];
}

export interface SentLink {
  url: string;
  label?: string;
}

/** The `links` argument: an array of `{url, label?}` objects. Tolerant like
 *  sentFilePaths — a bare string url is accepted, a label is optional. */
export function sentLinks(input: Record<string, unknown>): SentLink[] {
  const raw = input.links;
  if (!Array.isArray(raw)) return [];
  const out: SentLink[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.length > 0) {
      out.push({ url: item });
    } else if (item && typeof item === 'object') {
      const url = (item as Record<string, unknown>).url;
      if (typeof url === 'string' && url.length > 0) {
        const label = (item as Record<string, unknown>).label;
        out.push({ url, label: typeof label === 'string' && label.length > 0 ? label : undefined });
      }
    }
  }
  return out;
}

/** Open a URL in the system browser (Electron: shell.openExternal; the
 *  remote/Android shims map it the same way). Only called on a user click —
 *  the model never triggers navigation itself. */
export function openExternalUrl(url: string): void {
  void (window.claude?.shell?.openExternal?.(url) ?? Promise.resolve());
}

function basename(fp: string): string {
  const parts = fp.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || fp;
}

function parentDir(fp: string): string {
  const norm = fp.replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  const dir = parts.slice(0, -1).join('/');
  // Keep the leading slash on absolute paths: "/tmp/scratch/" is a location,
  // "tmp/scratch/" reads as a folder inside the project — which it isn't.
  return norm.startsWith('/') && dir ? '/' + dir : dir;
}

function isAbsolute(p: string): boolean {
  return /^([a-zA-Z]:\/|\/|~)/.test(p.replace(/\\/g, '/'));
}

/** Best-effort absolute path: join a relative path onto the session cwd. Used
 *  for the right-click menu (data-file-path) and the untracked-file stand-in. */
function resolveAbsolute(p: string, cwd?: string): string {
  const norm = p.replace(/\\/g, '/');
  if (isAbsolute(norm) || !cwd) return norm;
  return cwd.replace(/[\\/]+$/, '') + '/' + norm.replace(/^\.\//, '');
}

/** A throwaway ArtifactRecord for a file the session hasn't tracked (yet).
 *  Images still preview (ArtifactThumbnail reads by absolutePath); text/html
 *  fall back to the letter glyph until the tracker records the file. Never
 *  persisted — it exists only to feed the thumbnail. */
function standInRecord(absPath: string): ArtifactRecord {
  return {
    id: absPath,
    path: basename(absPath),
    kind: 'external',
    absolutePath: absPath,
    lastModified: '',
    status: 'active',
    versions: [],
    comments: [],
    tags: [],
  };
}

export interface SentFileTileProps {
  path: string;
  sessionId: string;
  status: ToolCallState['status'];
  /** The tool's own error text when status is 'failed'. Shown verbatim (first
   *  line under the strip, full text as the tooltip) — never a guessed reason:
   *  a folder, a missing file and an unreadable file all fail differently and
   *  the user has to be able to tell which (docs/error-message-standards.md). */
  error?: string;
  narrow: boolean;
  /** Tile background utility. Default bg-well lifts a tile off the bubble;
   *  a tile nested inside a bg-well card passes bg-inset to alternate. */
  tileBg?: string;
  /** Filmstrip tiles: the whole tile is the click target and width is scarce,
   *  so the "Open" button collapses to its arrow glyph and the name gets the
   *  full row. */
  compact?: boolean;
}

export function SentFileTile({ path, sessionId, status, error, narrow, tileBg = 'bg-well', compact = false }: SentFileTileProps) {
  const artifactCtx = useArtifactOptional();
  const open = useOpenFilepath(sessionId);
  const cwd = artifactCtx?.state.sessionCwd?.[sessionId];
  const sessionArts = artifactCtx?.state.sessionArtifacts?.[sessionId];
  const abs = resolveAbsolute(path, cwd);

  const matched = useMemo(
    () => matchSessionArtifact(sessionArts ?? [], abs),
    [sessionArts, abs],
  );
  const tracked = matched;
  const record = tracked ?? standInRecord(abs);
  // Internal records resolve relative to the session's project; externals
  // carry their own absolutePath and ignore projectPath.
  const projectPath = record.kind === 'internal' ? (cwd ?? '') : '';

  const labelPath = tracked?.kind === 'internal' ? tracked.path : path;
  const name = basename(labelPath);
  const dir = parentDir(labelPath);
  const failed = status === 'failed';
  const sending = status === 'running' || status === 'awaiting-approval';

  return (
    <Tooltip text={failed ? (error ? `${path} — ${error}` : path) : `Open ${name}`}>
    <button
      type="button"
      onClick={() => { void open(path); }}
      // A failed tile names the TOOL's reason when it has one and stops there when
      // it does not — `error || 'could not be sent'` asserted a cause nobody
      // verified, which is the shape `status-strip-authority.test.tsx` scans for
      // (docs/error-message-standards.md). The "Couldn't send" overlay already
      // tells the user it failed; the tooltip must not invent WHY.
      // data-file-path (absolute) lets the chat right-click menu recover the
      // real path for View in folder / Copy as path — left-click opens the
      // in-app artifact viewer.
      data-file-path={abs || undefined}
      data-testid="sent-file-tile"
      className={`group flex flex-col w-full min-w-0 text-left rounded-lg ${tileBg} border border-edge hover:border-fg-muted overflow-hidden transition-colors ${failed ? 'opacity-70' : ''}`}
    >
      <div className={`relative w-full ${narrow ? 'h-16' : 'h-28'} border-b border-edge`}>
        <ArtifactThumbnail
          artifact={record}
          projectPath={projectPath}
          bgClass="bg-canvas"
          className="w-full h-full"
        />
        {sending && (
          // Tool still running: the file isn't confirmed yet. Dim the preview
          // and say so, rather than showing a finished-looking card that may
          // turn into an error a second later.
          <div className="absolute inset-0 flex items-center justify-center bg-canvas/70 text-2xs font-medium text-fg-muted animate-pulse">
            Sending…
          </div>
        )}
        {failed && (
          <div className="absolute inset-0 flex items-center justify-center bg-canvas/80 text-2xs font-semibold text-red-400">
            Couldn’t send
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 px-2.5 py-2 min-w-0">
        <span className="flex-1 min-w-0">
          <span className="block text-sm-tight font-semibold text-fg truncate">{name}</span>
          {dir && <span className="block text-2xs font-mono text-fg-muted truncate">{dir}/</span>}
        </span>
        <span className={`shrink-0 inline-flex items-center gap-1 text-2xs font-semibold text-fg-2 border border-edge group-hover:border-fg-muted rounded-md transition-colors ${compact ? 'p-1 self-start' : 'px-2 py-1'}`} aria-label="Open">
          {!compact && 'Open'}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 7h10v10" />
            <path d="M7 17 17 7" />
          </svg>
        </span>
      </div>
    </button>
    </Tooltip>
  );
}

// A link glyph — a globe, distinct from the file/document glyph.
function LinkGlyph({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

/** A tile in the Deliverables card for a URL the assistant handed the user.
 *  Unlike a file tile there is no artifact to preview: the whole tile is the
 *  click target and opens the URL in the system browser. Opened ONLY on a user
 *  click — the model never triggers navigation itself. */
export function SentLinkTile({ link, status, error, narrow, compact = false }: {
  link: SentLink;
  status: ToolCallState['status'];
  error?: string;
  narrow: boolean;
  compact?: boolean;
}) {
  const failed = status === 'failed';
  // Two lines, never the same text twice. With a label: label over the full
  // URL. Without one: the host over the path, and no second line at all when
  // there is no path (a bare `http://localhost:5173` reads as one clean line).
  // An unparseable URL can still be shown — the tool refuses to send those, so
  // the tile only ever sees one while the call is still in flight.
  let title = link.label ?? link.url;
  let sub = link.label ? link.url : '';
  if (!link.label) {
    try {
      const u = new URL(link.url);
      title = u.host;
      const rest = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
      sub = rest;
    } catch { /* not parseable yet — fall back to the raw string above */ }
  }
  return (
    <Tooltip text={failed ? (error ? `${link.url} — ${error}` : link.url) : `Open ${link.url}`}>
    <button
      type="button"
      onClick={() => { if (!failed) openExternalUrl(link.url); }}
      data-link-url={link.url}
      data-testid="sent-link-tile"
      className={`group flex flex-col w-full min-w-0 text-left rounded-lg bg-inset border border-edge hover:border-fg-muted overflow-hidden transition-colors ${failed ? 'opacity-70' : ''}`}
    >
      <div className={`relative w-full ${narrow ? 'h-16' : 'h-28'} border-b border-edge bg-canvas flex items-center justify-center text-fg-dim`}>
        <LinkGlyph className={narrow ? 'w-7 h-7' : 'w-10 h-10'} />
        {failed && (
          <div className="absolute inset-0 flex items-center justify-center bg-canvas/80 text-2xs font-semibold text-red-400">
            Couldn’t send
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 px-2.5 py-2 min-w-0">
        <span className="flex-1 min-w-0">
          <span className="block text-sm-tight font-semibold text-fg truncate">{title}</span>
          {sub && <span className="block text-2xs font-mono text-fg-muted truncate">{sub}</span>}
        </span>
        <span className={`shrink-0 inline-flex items-center gap-1 text-2xs font-semibold text-fg-2 border border-edge group-hover:border-fg-muted rounded-md transition-colors ${compact ? 'p-1 self-start' : 'px-2 py-1'}`} aria-label="Open">
          {!compact && 'Open'}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 7h10v10" />
            <path d="M7 17 17 7" />
          </svg>
        </span>
      </div>
    </button>
    </Tooltip>
  );
}

// The document glyph FilepathToken draws, at header size.
function FilesGlyph({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

/** Tracks whether a horizontally scrolling element has content hidden past
 *  either edge. Re-measured on scroll and on resize (a bubble that widens can
 *  bring the last tile fully into view, at which point the right fade lies). */
function useEdgeOverflow(ref: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const left = el.scrollLeft > 2;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', measure); ro.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return edges;
}

interface Props {
  /** Every SendUserFile / SendUserLink call in this bubble, in invocation
   *  order. They merge into ONE card: files AND links concatenate, each keeps
   *  its own call's status. */
  tools: ToolCallState[];
  sessionId: string;
}

export function DeliverablesCard({ tools, sessionId }: Props) {
  const narrow = useNarrowViewport();
  // Closed by default (Destin, 2026-08-25 — asked for this after seeing the
  // card open on a real screen): it now matches the tool cards around it
  // instead of dominating the bubble. getInitialExpanded still seeds from an
  // ACTIVE Ctrl+O expand/collapse-all first, so a card that mounts mid
  // expand-all still comes up open, and mid collapse-all still comes up
  // closed — only the plain-mount default changed, from true to false.
  //
  // WHY this tracks WHICH calls have failed, not merely WHETHER any has:
  // one card merges every SendUserFile call in the bubble
  // (AssistantTurnBubble → collectBubbleSentFiles), so a card routinely holds
  // 2+ concurrent deliveries. Both the per-tile "Couldn't send" overlay and
  // the failures paragraph only render while `open` is true, and the
  // header's count treats a failed call identically to a sent one — so a
  // card that stayed collapsed could fail outright and look like an
  // ordinary one-liner. A delivery failure is an error the user must see
  // without clicking anything (docs/error-message-standards.md); it must
  // never be able to hide behind a collapsed card — including a SECOND
  // failure arriving after the user has already read the first one and
  // collapsed the card. An aggregate `tools.some(failed)` boolean can only
  // transition false→true ONCE per card's lifetime, so it goes stale the
  // moment a second call fails while the first failure is still recorded —
  // that was attempt #2's gap. Tracking failed call IDs individually lets a
  // second (third, ...) newly-failed id reopen the card even though
  // "something has failed" was already true.
  const failedIds = useMemo(
    () => tools.filter((t) => t.status === 'failed').map((t) => t.toolUseId),
    [tools],
  );
  const hasFailure = failedIds.length > 0;
  const [open, setOpen] = useState(() => getInitialExpanded(hasFailure));
  // IDs already accounted for — seeded from the mount state above (whatever
  // `open` came out to, not necessarily open: a Ctrl+O collapse-all forces
  // `getInitialExpanded` to false even with a failure already present, so
  // the card can mount CLOSED with these ids marked surfaced — that's
  // intentional, collapse-all is an explicit global instruction, see the
  // effect below for the live case) or by the effect below (live: it
  // already opened the card for them once). A ref, not state: updating it
  // must not itself trigger a render, only recording what the effect has
  // already reacted to.
  const surfacedFailedIds = useRef<Set<string>>(new Set(failedIds));
  // A derived STRING key, not `failedIds` itself: an array is a new
  // reference every render even when its contents are identical (tools is
  // rebuilt upstream on every chat-reducer action), so using the array as
  // the effect's dependency would re-run — and by extension re-diff and
  // re-assign the ref — on every unrelated render. It would not infinite
  // loop (setOpen(true) is a no-op once open is already true, and the ref
  // write triggers no render at all), but it would burn a diff every render
  // for nothing. The string can also change VALUE for reasons besides a
  // call's failed-ness actually changing — a failed call entering or
  // leaving `tools`, or the order of failed calls shifting — but the ref
  // gate below is what makes those inert regardless: it only opens the
  // card for an id it hasn't already seen, so a key change with no new id
  // in it is a no-op. That's what keeps an explicit user collapse stuck.
  const failedIdsKey = failedIds.join(',');
  useEffect(() => {
    // failedIds here is the value captured at the moment failedIdsKey
    // last changed, i.e. it always matches the key that triggered this run.
    const hasNewFailure = failedIds.some((id) => !surfacedFailedIds.current.has(id));
    if (hasNewFailure) setOpen(true);
    surfacedFailedIds.current = new Set(failedIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedIdsKey]);
  useExpandAllToggle(() => setOpen(true), () => setOpen(false));

  // Two entry kinds: file tiles (path) and link tiles (link). Both derive from
  // the same tools array — sentFilePaths for SendUserFile, sentLinks for
  // SendUserLink — and merge into ONE strip in CALL order: one pass over the
  // tools, not files-then-links, or a link sent before a file would still be
  // drawn after it.
  // The index rides in the key because the same path/URL can legitimately be
  // sent twice in one call, and two identical React keys silently drop a tile.
  const entries = useMemo(
    () => tools.flatMap((tool) => [
      ...sentFilePaths(tool.input).map((path, i) => ({ kind: 'file' as const, path, status: tool.status, error: tool.error, key: `${tool.toolUseId}:f${i}:${path}` })),
      ...sentLinks(tool.input).map((link, i) => ({ kind: 'link' as const, link, status: tool.status, error: tool.error, key: `${tool.toolUseId}:l${i}:${link.url}` })),
    ]),
    [tools],
  );
  // Failed calls list their reason under the strip, in the tool's own words —
  // one line per failed call (a multi-path error names every bad path).
  const failures = useMemo(
    () => tools.filter((t) => t.status === 'failed' && t.error).map((t) => ({ key: t.toolUseId, text: t.error as string })),
    [tools],
  );
  const captions = useMemo(
    () => tools.map((t) => asString(t.input.caption)).filter((c): c is string => !!c),
    [tools],
  );

  const stripRef = useRef<HTMLDivElement>(null);
  const edges = useEdgeOverflow(stripRef, [open, entries.length, narrow]);

  if (entries.length === 0 && captions.length === 0) return null;

  // One caption rides the header; several stack under the strip so none is lost.
  const headerCaption = captions.length === 1 ? captions[0] : '';
  const footCaptions = captions.length > 1 ? captions : [];
  const fade = (side: 'left' | 'right') => ({
    background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, var(--well), transparent)`,
  });

  return (
    <div className="mt-2 rounded-lg border border-edge bg-well overflow-hidden" data-testid="deliverables-card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-inset/50 transition-colors"
      >
        <FilesGlyph className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
        <span className="text-fg-faint text-xs select-none">|</span>
        <span className="text-xs font-semibold text-fg-2">Deliverables</span>
        <span className="text-2xs font-mono text-fg-muted">{entries.length}</span>
        <span className="flex-1 min-w-0 text-2xs text-fg-muted truncate text-right">{headerCaption}</span>
        <ChevronIcon className="w-3.5 h-3.5 shrink-0 text-fg-muted" expanded={open} />
      </button>
      {open && (
        <>
          <div className="relative">
            <div ref={stripRef} className="flex gap-2 overflow-x-auto px-2 pb-2" data-testid="deliverables-strip">
              {entries.map((e) => (
                <div key={e.key} className={`${narrow ? 'w-44' : 'w-56'} shrink-0`}>
                  {e.kind === 'file' ? (
                    <SentFileTile path={e.path} sessionId={sessionId} status={e.status} error={e.error} narrow={narrow} tileBg="bg-inset" compact />
                  ) : (
                    <SentLinkTile link={e.link} status={e.status} error={e.error} narrow={narrow} compact />
                  )}
                </div>
              ))}
            </div>
            {/* Edge fades: only while something is actually hidden past that
                edge, so a strip that fits shows none and a fully-scrolled strip
                shows only the left one. */}
            {edges.left && <div className="pointer-events-none absolute top-0 bottom-2 left-0 w-10" style={fade('left')} data-testid="deliverables-fade-left" />}
            {edges.right && <div className="pointer-events-none absolute top-0 bottom-2 right-0 w-10" style={fade('right')} data-testid="deliverables-fade-right" />}
          </div>
          {footCaptions.map((c, i) => (
            <p key={i} className="px-3 pb-2 -mt-0.5 text-2xs text-fg-muted">{c}</p>
          ))}
          {failures.map((f) => (
            <p key={f.key} className="px-3 pb-2 -mt-0.5 text-2xs text-red-400 whitespace-pre-line">{f.text}</p>
          ))}
        </>
      )}
    </div>
  );
}
