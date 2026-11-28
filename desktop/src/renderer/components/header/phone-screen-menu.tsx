// Phone menu alternative (youcoded-dev docs/active/design/2026-11-04-narrow-screens/
// phone-menu.json, 2026-11-28). Destin: "the session selection/creation menu becomes a
// full-screen display ... work more like the traditional gpt/claude/gemini apps that just
// show all prior sessions in a grouped 'Previous Sessions' section under the 'Active
// Sessions'". Workbench-only (narrowTop=menu); the approved layout is untouched.
//
// WHY its own file: SessionStrip.tsx is held to a line budget, so the strip only PLACES
// these pieces (the top, the past chats and the search filter); everything else is here.
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button, CloseButton, SectionLabel, TextInput } from '../ui';
import { formatRelativeTime } from '../../utils/format-time';

// ── The search box's text ──────────────────────────────────────────────────
// WHY a tiny store, not state in SessionStrip: the box (top of the menu), the open-session
// rows and the past-chat list all read it, and keystroke state must not live in the strip
// (performance rule 5) — only these three readers redraw per letter.
let query = '';
const listeners = new Set<() => void>();
function setQuery(q: string) { query = q; listeners.forEach((l) => l()); }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
export function useScreenMenuQuery(): string {
  return useSyncExternalStore(subscribe, () => query, () => '');
}
/** True when a chat's name matches what is typed (case ignored; empty matches all). */
export function matchesScreenQuery(name: string, q: string): boolean {
  return !q || name.toLowerCase().includes(q.trim().toLowerCase());
}

// ── Leaving the menu for a place ───────────────────────────────────────────
// D-2 (Destin: "a premium/polished scrolling effect where text/title of menu and the correct page
// fade in for selected page"). Tapping a place: its name fades in as the menu's title, the place
// opens UNDER the menu, and the menu fades away over it (220ms) — so the title changes first and
// the page appears through the fading menu instead of the menu blinking shut.
let title = 'Chats';
const titleListeners = new Set<() => void>();
function setTitle(t: string) { title = t; titleListeners.forEach((l) => l()); }
function subscribeTitle(l: () => void) { titleListeners.add(l); return () => { titleListeners.delete(l); }; }
let closeMenu: (() => void) | null = null;
let menuBox: HTMLElement | null = null;
const LEAVE_MS = 220;
/** Called by a place's tile: retitle, open the place beneath, fade the menu out, then close it. */
function leaveMenuTo(label: string, open: () => void) {
  setTitle(label);
  // A tap during the fade must not open a second place.
  if (menuBox) menuBox.style.pointerEvents = 'none';
  // One frame for the new title to start fading in before the place's screen mounts beneath.
  requestAnimationFrame(() => {
    open();
    if (menuBox) { menuBox.style.transition = `opacity ${LEAVE_MS}ms var(--ease-out)`; menuBox.style.opacity = '0'; }
    window.setTimeout(() => closeMenu?.(), LEAVE_MS);
  });
}

/** The menu's head, laid out like the phone Settings page's (title at left, close at right — the
 *  Title heading level), then search and the big New session button (where the Claude and
 *  ChatGPT apps put theirs). D-2: "the header styling … need to be fixed to look like other
 *  screens". `order` keeps it first in the panel. */
export function ScreenMenuTop({ onClose, onNew }: { onClose: () => void; onNew?: () => void }) {
  const q = useScreenMenuQuery();
  const t = useSyncExternalStore(subscribeTitle, () => title, () => 'Chats');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    closeMenu = onClose;
    menuBox = ref.current?.closest('.session-menu') as HTMLElement | null;
    // A fresh search and title each time the menu opens.
    return () => { setQuery(''); setTitle('Chats'); closeMenu = null; menuBox = null; };
  }, [onClose]);
  return (
    <div ref={ref} className="shrink-0 px-4 pt-3 pb-2 flex flex-col gap-3" style={{ order: -2 }}>
      <div className="flex items-center justify-between gap-2 min-h-9">
        {/* key: a new title remounts and fades in (row-fade-in, globals.css) instead of snapping. */}
        <h2 key={t} className="text-base font-semibold text-fg truncate" style={{ animation: 'row-fade-in 180ms var(--ease-out) both' }}>{t}</h2>
        <CloseButton onClick={onClose} label="Close menu" />
      </div>
      <TextInput type="search" value={q} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" aria-label="Search chats" />
      <Button variant="primary" size="md" className="w-full" onClick={onNew}>+ New session</Button>
    </div>
  );
}

export interface PlaceTile { key: string; label: string; icon: React.ReactNode; dot?: string | null; onOpen: () => void }

/** D-2 (Destin: "settings appear as a normal icon next to projects/pages/etc. and keep pinnable
 *  pages in the list as their own icons"): one row of boxed tiles at the foot of the menu —
 *  Settings, Projects, Pages, Games, then each pinned page. It scrolls sideways under the app's
 *  edge fade when it does not fit (design guide: a row never wraps at phone width), and no line
 *  divides it from the chats above (Spacing: "no dividing lines"); 16px of space does. */
export function ScreenMenuPlaces({ tiles }: { tiles: PlaceTile[] }) {
  return (
    <div className="shrink-0 pt-2 pb-3" style={{ order: 1 }}>
      <div role="group" aria-label="Places" className="scroll-mask-x scroll-mask--chips flex gap-2 overflow-x-auto px-4 scrollbar-none">
        {tiles.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => leaveMenuTo(t.label, t.onOpen)}
            className="coarse-roomy relative shrink-0 w-[4.5rem] flex flex-col items-center gap-1 px-1 py-2.5 rounded-lg bg-inset text-fg-2 hover:text-fg hover:bg-well transition-colors"
          >
            <span className="shrink-0 [&_svg]:w-5 [&_svg]:h-5">{t.icon}</span>
            <span className="max-w-full truncate text-2xs">{t.label}</span>
            {t.dot && <span className={`absolute top-1.5 right-1.5 w-2 h-2 rounded-full ${t.dot}`} />}
          </button>
        ))}
      </div>
    </div>
  );
}

interface PastRow { sessionId: string; name: string; projectPath: string; lastModified: number }

// Day headings, like the phone apps: Today, Yesterday, then the date.
function dayLabel(ms: number, now: number): string {
  const day = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const diff = Math.round((day(now) - day(ms)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(ms).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}

// WHY a cap with "Show more" (renderer-lists rule): someone with 1,600 past chats must not
// get 1,600 rows built when the menu opens. A real build reuses useChunkedReveal.
const PAGE = 40;

/** Every past chat not open now, newest first, grouped by day, filtered by the search box.
 *  Drawn INSIDE the session list's scroller so open and past chats scroll as one list.
 *  Fetched once per opening from the list the Resume page reads (session.browse). */
export function ScreenMenuPrevious({ openIds, onOpen }: { openIds: ReadonlySet<string>; onOpen: (row: PastRow) => void }) {
  const [rows, setRows] = useState<PastRow[] | null>(null);
  const [shown, setShown] = useState(PAGE);
  const q = useScreenMenuQuery();
  useEffect(() => {
    let live = true;
    void (window as any).claude.session.browse().then((all: PastRow[]) => {
      if (!live) return;
      // Open sessions' ids AND names: the workbench's practice list includes open ones.
      setRows(all.filter((r) => !openIds.has(r.sessionId) && !openIds.has(r.name)).sort((a, b) => b.lastModified - a.lastModified));
    }).catch(() => { if (live) setRows([]); });
    return () => { live = false; };
    // Once per opening (see PhoneRecent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const groups = useMemo(() => {
    const now = Date.now();
    const out: { label: string; rows: PastRow[] }[] = [];
    for (const r of (rows ?? []).filter((x) => matchesScreenQuery(x.name, q)).slice(0, shown)) {
      const label = dayLabel(r.lastModified, now);
      if (out.length === 0 || out[out.length - 1].label !== label) out.push({ label, rows: [] });
      out[out.length - 1].rows.push(r);
    }
    return out;
  }, [rows, q, shown]);
  if (!rows) return null;
  const total = rows.filter((x) => matchesScreenQuery(x.name, q)).length;
  return (
    <div className="pt-1">
      <SectionLabel className="mx-3 mt-2">Previous sessions</SectionLabel>
      {total === 0 && <p className="mx-3 my-2 text-xs text-fg-muted">{q ? 'No past chats match.' : 'No past chats yet.'}</p>}
      {groups.map((g) => (
        <div key={g.label}>
          <div className="mx-3 mt-2 mb-0.5 text-3xs text-fg-muted">{g.label}</div>
          {g.rows.map((r) => (
            <button key={r.sessionId} type="button" onClick={() => onOpen(r)} className="coarse-roomy w-full flex flex-col items-start px-3 py-1.5 text-left hover:bg-inset transition-colors">
              <span className="w-full truncate text-sm text-fg-2">{r.name}</span>
              <span className="w-full truncate text-3xs text-fg-muted">{r.projectPath.replace(/\\/g, '/').split('/').pop()} · {formatRelativeTime(r.lastModified)}</span>
            </button>
          ))}
        </div>
      ))}
      {total > shown && (
        <button type="button" onClick={() => setShown((n) => n + PAGE)} className="w-full px-3 py-2 text-xs text-fg-muted hover:text-fg text-left">Show more</button>
      )}
    </div>
  );
}
