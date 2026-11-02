// PageHost — a page open inside the app (Phase 1 shell).
//
// The page runs in an iframe with the SAME sandbox HtmlView.tsx uses for HTML
// previews — `allow-scripts allow-popups allow-forms`, never
// `allow-same-origin` — so it is an opaque origin that cannot script the app
// (scope §4). Phase 1 adds no bridge into the frame; the only message that
// crosses is the theme.
//
// Theme: page-theme.ts bakes the current tokens and the style kit into the
// document before it is framed, then posts fresh tokens whenever the host's
// theme changes. The frame's srcDoc never changes after load, so a theme
// switch keeps whatever the page was doing (scope §2).
//
// THE PAGE VIEW (shell decks rounds 3–8, then Destin's redirection on
// 2026-09-17): "when i click the pages icon, i want it to open straight into
// the view with the left sidebar and the frame page window. the framed window
// will just say No Page Selected until user picks a page. a new filled Create
// a page button above manage pages with a plus sign. pin the drawer to the
// open state and remove the panel/drawer icon from the top left. re-insert the
// settings, project view, and pages icon at the top left (but NOT chat/terminal
// toggle, file browser, or games panel). the old page icon page will now only
// be accessible via manage pages."
//
//   ┌ [⚙][▤][▢]              ◷ Page name                    [Esc · Back to chat] [– □ ×] ┐
//   │╭─────────────────────╮ ╭──────────────────────────────────────────────────╮│
//   ││ every page, grouped, │ │  the page — or "No page selected"                ││
//   ││ pin beside each      │ │                                                  ││
//   ││ [ + Create a page  ] │ │                                                  ││
//   ││ [   Manage pages   ] │ ╰──────────────────────────────────────────────────╯│
//
// Opened by PAGE_VIEW_OPENED (the Pages button) or PAGE_OPENED (a card, a
// pinned button, a panel row). Renders nothing while closed. The library
// (Manage pages) opens OVER it and closes back onto it.
//
// FOCUS (Destin, 2026-09-17): a pinned button opens its page "full screen
// framed with no side bar" — PAGE_OPENED with focus. The band is the same
// (ScreenBand, shared with Project View), the pinned button lights instead of
// the Pages icon, and the panel is simply not rendered; the Pages icon brings
// it back with the page still open.
// First-run refinement (2026-09-23): keep the quoted decision above for pages
// that exist; with none, the frame carries the former Manage pages welcome card.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useArtifactSelector, useArtifactDispatch } from '../../state/ArtifactContext';
import { useDismissTop, useEscClose } from '../../hooks/use-esc-close';
import { useNarrowViewport } from '../../hooks/use-narrow-viewport';
import { isAndroid } from '../../platform';
import { isWorkbenchDocument, workbenchScreenFrame } from '../../workbench-mode';
import { Button, LoadingState, ErrorState, SectionLabel, Tooltip } from '../ui';
import { ScreenBand } from '../ScreenBand';
import type { PageDocument, PageFetchRequest, PageFetchResult, PageHome, PageLoadFailure, PageProgramResult, PageSummary, PagesBridge, PlaidRequest, PlaidResult } from '../../../shared/pages-types';
import { MAX_PAGE_DATA_BYTES, MAX_PAGE_PROGRAM_INPUT, MAX_PAGE_SESSION_PROMPT, MAX_PINNED_PAGES, OFFICE_PAGE_ID, PAGE_CHATS_REFUSED, PAGE_PROGRAM_REFUSED, PAGE_SESSION_HIDDEN_CHARS, PAGE_SESSION_REFUSED } from '../../../shared/pages-types';
import { OfficeView } from '../office/OfficeView';
import { HOME_TAB, officeDocFor, previewOfficeComments, previewOfficeTabs, revealInline, selectTab, useOfficeTabs } from '../office/office-store';
import { OfficeAlerts } from '../office/OfficeAlerts';
import { PageGlyph, PagesIcon, PinGlyph } from './page-icons';
import { PagesEmptyCard } from './PagesEmptyCard';
import type { PageStartSessionRequest } from './PageCreateDialog';
import { usePages, setPagePinned, refreshPages } from './use-pages';
import { usePageSockets } from './use-page-sockets';
import { PAGE_EDGES_MESSAGE, PAGE_KIT_CSS } from './page-kit';
import { PageApproval, needsApproval } from './page-connections';
import { answerPageChats } from './page-chats';
import { PageFreshness } from './PageFreshness';
import { PageCodeChanged } from './PageCodeChanged';
import { usePaneGlass } from './use-pane-glass';
import {
  PAGE_DATA_MESSAGE, PAGE_DATA_SET_MESSAGE, PAGE_ESC_MESSAGE, PAGE_FETCH_MESSAGE, PAGE_FETCH_RESULT_MESSAGE,
  PAGE_CHATS_MESSAGE, PAGE_CHATS_RESULT_MESSAGE, PAGE_PROGRAM_MESSAGE, PAGE_PROGRAM_RESULT_MESSAGE,
  PAGE_PLAID_MESSAGE, PAGE_PLAID_RESULT_MESSAGE,
  PAGE_REFRESH_MESSAGE, PAGE_SESSION_START_MESSAGE, PAGE_SESSION_START_RESULT_MESSAGE, PAGE_THEME_MESSAGE, paneIsGlass, prepareHostedDocument, readThemeCss, watchThemeCss,
} from './page-theme';
import { useScreenOpen, ScreenMark } from '../../shoot-mode';

function pagesBridge(): PagesBridge | undefined {
  return (window as unknown as { claude?: { pages?: PagesBridge } }).claude?.pages;
}

/** A page's own script wrote these, so nothing is assumed about them: only a
 *  flat object of strings is forwarded as request headers (main allows three
 *  of them through anyway — design §4 step 4). */
function isSocketPlan(v: unknown): v is NonNullable<PageFetchRequest['socket']> {
  const o = v as { send?: unknown; until?: unknown; timeoutMs?: unknown } | null;
  return !!o && typeof o === 'object' && Array.isArray(o.send) && o.send.every((m) => typeof m === 'string')
    && typeof o.until === 'number' && (o.timeoutMs === undefined || typeof o.timeoutMs === 'number');
}

function isStringMap(v: unknown): v is Record<string, string> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
}

/** Where a page's conversation starts (spec 2026-10-14, §2, Q-8). A project
 *  page starts in its own project whatever it suggests. A personal page starts
 *  on the saved default, unless it suggests one of the person's OWN project
 *  folders. WHY that check: a page's script wrote the suggestion, and a folder
 *  the person never added (`/etc`, a dotfile folder) must not be preselected
 *  where a quick Start would miss it. The picker can still change any of it. */
async function startFolderFor(home: PageHome, project: unknown): Promise<string | undefined> {
  if (home.kind === 'project') return home.path;
  if (typeof project !== 'string' || !project.trim()) return undefined;
  // WHY loose (review F6): Windows writes C:\Users\… and a page may write
  // c:/users/…. Matching loosely is safe — the answer is always the person's
  // OWN saved entry, exactly as they saved it, never the page's spelling.
  const trimSlash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  try {
    const list = await (window as unknown as { claude?: { folders?: { list?: () => Promise<unknown> } } }).claude?.folders?.list?.();
    if (!Array.isArray(list)) return undefined;
    const want = trimSlash(project.trim());
    const hit = list.find((f) => typeof (f as { path?: unknown })?.path === 'string' && trimSlash((f as { path: string }).path) === want) as { path: string } | undefined;
    return hit?.path;
  } catch {
    // The list could not be read: the saved default is the safe start.
    return undefined;
  }
}


interface PageHostProps {
  /** The same three icons the app's band shows, wired to the same places. */
  settingsOpen: boolean;
  onToggleSettings: () => void;
  settingsBadge?: boolean;
  settingsDangerBadge?: boolean;
  /** Starts the creator in a new conversation. Owned by App. */
  onCreatePage: () => void;
  /** The focused conversation's folder, for Office's "In <project>" list and new files. */
  projectRoot?: string | null;
  /** A page's `youcoded.startSession` (spec 2026-10-14): App opens the
   *  new-session window with the message waiting, and returns false when that
   *  window is already open (review F2). Absent = refused. */
  onStartSession?: (req: PageStartSessionRequest) => boolean;
}

type Load =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; page: PageDocument; doc: string }
  | { state: 'failed'; failure: PageLoadFailure };

export function PageHost({ settingsOpen, onToggleSettings, settingsBadge, settingsDangerBadge, onCreatePage, projectRoot = null, onStartSession }: PageHostProps) {
  // Narrow selectors (perf, 2026-09-23): only the page flags this host shows.
  const dispatch = useArtifactDispatch();
  const open = useArtifactSelector((s) => s.pageViewOpen);
  const pageId = useArtifactSelector((s) => s.openPageId);
  const pagesViewOpen = useArtifactSelector((s) => s.pagesViewOpen);
  const pageFocus = useArtifactSelector((s) => s.pageFocus);
  const narrow = useNarrowViewport();
  // WHY: beside a 240px rail, phone pages were crushed into an unusable strip.
  // Reuse pinned-page focus on selection; the band's Pages button restores the
  // list without leaving the page, while Back to chat keeps its separate job.
  // WHY phoneLayout (2026-11-01 phone test, #15): a foldable's inner screen is wider than 640px, so width alone left the
  // squeezed two-pane layout on a phone. The Android app always gets the phone layout.
  const phoneLayout = narrow || isAndroid();
  // Phone: the list and the open page are two full-width screens that slide between each other (owner's decision).
  // Picking a page from the list no longer jumps to the full-screen "focus" view; it slides the list away instead.
  const [phoneListOpen, setPhoneListOpen] = useState(true);
  const openPageId = pageId;
  // WHY: a page opened any other way (a card, a pinned button) must show the page, not leave the list on top; no page = the list.
  useEffect(() => { setPhoneListOpen(openPageId === null); }, [openPageId]);
  const openFromRail = (id: string) => { dispatch({ type: 'PAGE_OPENED', pageId: id }); setPhoneListOpen(false); };
  // Back to chat leaves pages altogether (the library over this view goes too).
  const backToChat = () => dispatch({ type: 'PAGE_VIEW_CLOSED' });
  const managePages = () => dispatch({ type: 'PAGES_VIEW_OPENED' });
  useEscClose(open && !pagesViewOpen && !settingsOpen, backToChat);
  // Esc pressed INSIDE the page (the frame swallows the key) is forwarded by
  // the page's bootstrap; it dismisses whatever is on top exactly as the key
  // would — Settings or the library over the view, else the view itself.
  // (Before: ignored while Settings was open, so Settings could not be
  // closed by Esc with the page focused — Destin, 2026-09-17.)
  const dismissTop = useDismissTop();
  const { pages, loaded, failed, pinnedTotal } = usePages();
  // Practice app only (workbench / landing demo, never the real app): `?openPage=<id>` opens that
  // page at start. WHY: a review deck's live pane must land straight on a page's design option
  // (`pagesHome=v-…`) for Destin to operate, not on the chat two clicks away.
  useEffect(() => {
    if (!isWorkbenchDocument()) return;
    const id = new URLSearchParams(location.search).get('openPage');
    // Keep direct demo links consistent with a phone selection from the list.
    if (id) dispatch({ type: 'PAGE_OPENED', pageId: id, focus: narrow });
  }, [dispatch, narrow]);
  // Photo-only build: `shoot` opens a page by id, in the panel or focused (the pinned-button view).
  const pageIds = pages.map((p) => p.id);
  useScreenOpen('pages/page', (id) => { if (id) dispatch({ type: 'PAGE_OPENED', pageId: id }); }, pageIds);
  useScreenOpen('pages/focus', (id) => { if (id) dispatch({ type: 'PAGE_OPENED', pageId: id, focus: true }); }, pageIds);
  // Office (built in): home beside the panel; documents as a pinned button opens them.
  useScreenOpen('office/home', () => dispatch({ type: 'PAGE_OPENED', pageId: OFFICE_PAGE_ID }));
  useScreenOpen('office/first-run', () => dispatch({ type: 'PAGE_OPENED', pageId: OFFICE_PAGE_ID }));
  useScreenOpen('office/document', () => { void previewOfficeTabs(0); dispatch({ type: 'PAGE_OPENED', pageId: OFFICE_PAGE_ID, focus: true }); });
  useScreenOpen('office/spreadsheet', () => { void previewOfficeTabs(1); dispatch({ type: 'PAGE_OPENED', pageId: OFFICE_PAGE_ID, focus: true }); });
  // WHY: the third editor (slides) needs its own picture too — the look is per editor.
  useScreenOpen('office/presentation', () => { void previewOfficeTabs(2); dispatch({ type: 'PAGE_OPENED', pageId: OFFICE_PAGE_ID, focus: true }); });
  // Office's own comments panel, restyled to match the app's comment cards (finish plan Task 6).
  useScreenOpen('office/document-comments', () => { previewOfficeComments('document'); dispatch({ type: 'PAGE_OPENED', pageId: OFFICE_PAGE_ID, focus: true }); });
  useScreenOpen('office/spreadsheet-comments', () => { previewOfficeComments('spreadsheet'); dispatch({ type: 'PAGE_OPENED', pageId: OFFICE_PAGE_ID, focus: true }); });
  useScreenOpen('office/versions', () => { void previewOfficeTabs(0, true); dispatch({ type: 'PAGE_OPENED', pageId: OFFICE_PAGE_ID, focus: true }); });
  const summary = pages.find((p) => p.id === pageId) ?? null;
  // Office is built in (office-questions#Q-entry): it lists, pins and opens like
  // a page, but its body is OfficeView, never a framed page document.
  const isOffice = pageId === OFFICE_PAGE_ID;
  const officeKept = useOfficeTabs().docs.length > 0;
  const ownPages = pages.filter((p) => p.home.kind !== 'builtin');
  const pinnedCount = pinnedTotal ?? pages.filter((p) => p.pinned).length; // hidden Office pins count too (use-pages)
  // The frame reloads when page.html was rewritten (the stamp moves) and not
  // when the page saved its own data (it does not) — review F7.
  const htmlStamp = summary?.htmlStamp ?? 0;

  // What the LIST says about this page's approvals. It is not what the gate
  // reads (finding 17 — that is the loaded document, below), but a change to it
  // means the answer on disk moved, so the document is read again: approving a
  // line is what turns the approval screen back into the page.
  const connSig = useMemo(
    // A device's address is in it too: allowing a different address must
    // rebuild the document, so `youcoded.devices` names the one now allowed.
    () => (summary?.connections ?? []).map((c) => `${c.id}:${c.approved ? 1 : 0}${c.kind === 'device' ? `@${c.address}` : ''}`).join('|'),
    [summary],
  );

  // WHY: a page deleted while it is open (through chat) used to stay in the
  // frame until another page was picked — nothing told the view its id was
  // gone. Every way of opening a page picks it FROM this list, so once a
  // loaded, healthy list lacks the open id, the page no longer exists: fall
  // back to "No page selected". A list that has not loaded or failed to proves
  // nothing, so it is left alone.
  const openPageMissing = open && pageId !== null && loaded && !failed && !summary;
  useEffect(() => {
    if (openPageMissing) dispatch({ type: 'PAGE_CLOSED' });
  }, [openPageMissing, dispatch]);

  const [load, setLoad] = useState<Load>({ state: 'loading' });
  // WHY (Destin, 2026-10-20 draft): the page list can fold down to a slim rail of glyphs so a
  // page gets the width. Session-local for the draft; persistence waits on his sign-off.
  const [railCollapsed, setRailCollapsed] = useState(false);
  // Only the confirmed first-run state replaces the rail, not loading, errors, or an open page.
  // The first-run card is about the person's OWN pages — Office alone does not count.
  const emptyPages = pageId === null && load.state === 'idle' && loaded && !failed && ownPages.length === 0;
  // The list is the screen on top while a phone has no page open (or after it was asked for); the first-run card wins over it.
  const asideShown = open && !pageFocus && (!emptyPages || pages.some((p) => p.home.kind === 'builtin'));
  // Both panes are full width side by side; sliding both left by one pane + the gap shows the page (WHY not absolute: the
  // screen body's padding/gap would be ignored and the pane would touch the screen edge).
  const listOnTop = phoneLayout && asideShown && !emptyPages && (pageId === null || phoneListOpen);
  const phoneSlide = listOnTop || !asideShown ? 'translateX(0)' : 'translateX(calc(-100% - var(--frame-edge, 10px)))';
  const frameRef = useRef<HTMLIFrameElement>(null);
  // The data the page in the frame is known to hold, so an outside change can
  // be told apart from the echo of the page's own save (see the onData effect).
  const frameDataRef = useRef<string>('null');
  // True while the page's own save is waiting to be written (the 500 ms
  // debounce, then the write itself). WHY: any pages broadcast in that window
  // — a page's request updating its "Updated now" stamp is enough — re-read
  // the file from disk, found the OLD data, saw it differ from the frame's,
  // and posted it in: the Home page's remote flickered closed and open again
  // (round 4 testing). Disk is stale until the save lands, so nothing is
  // posted in until then.
  const savingRef = useRef(false);
  // Read by the frame's message handler without re-registering it (which would
  // flush a pending save): the page document the gate also reads, and App's
  // latest start-session callback.
  const loadedPageRef = useRef<PageDocument | null>(null);
  loadedPageRef.current = load.state === 'ready' ? load.page : null;
  const onStartSessionRef = useRef(onStartSession);
  onStartSessionRef.current = onStartSession;
  // See-through: the pane is glass (a wallpaper theme in a floating style AND the global
  // Appearance switch "Show theme background behind pages" on, default on). The document build reads
  // paneIsGlass() at that moment instead of depending on this value — a dependency would reload
  // the frame and lose the page's working state on every theme change.
  const glass = usePaneGlass(open);
  // Office wears the same frost (owner: "make office use this new frosted styling"), so no !isOffice.
  const seeThrough = glass;

  // Fetch the working version when the open page changes or its document was
  // rewritten. The document is prepared ONCE here, with the theme and the
  // saved data of that moment; later theme changes go through postMessage
  // below rather than a new srcDoc (which would reload the page and lose its
  // state).
  useEffect(() => {
    if (!open) return;
    void refreshPages();
    if (pageId === null || pageId === OFFICE_PAGE_ID) { setLoad({ state: 'idle' }); return; }
    let cancelled = false;
    setLoad({ state: 'loading' });
    const bridge = pagesBridge();
    if (!bridge) {
      setLoad({ state: 'failed', failure: { kind: 'unreadable', message: 'Pages are not available in this window.' } });
      return;
    }
    bridge.get(pageId).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        try { frameDataRef.current = JSON.stringify(r.page.data ?? null); } catch { frameDataRef.current = 'null'; }
        // Read at this moment (not a dependency): the page is born see-through or not.
        const seeNow = paneIsGlass();
        // The policy the document carries is built from THIS page's connections
        // (design §6), so a page that reaches nothing gets the tightest one.
        setLoad({ state: 'ready', page: r.page, doc: prepareHostedDocument(r.page.html, readThemeCss(document.documentElement, seeNow), PAGE_KIT_CSS, r.page.data, r.page.connections ?? [], seeNow) });
      } else setLoad({ state: 'failed', failure: r.failure });
    }, () => {
      if (!cancelled) setLoad({ state: 'failed', failure: { kind: 'unreadable', message: 'The page could not be read.' } });
    });
    return () => { cancelled = true; };
  }, [open, pageId, htmlStamp, connSig]);

  // Everything the page says to the host. Only THIS frame is heard: every
  // sandboxed frame in the app has origin 'null' (HtmlView's artifact previews
  // use the same sandbox), so a type-only filter would let a previewed file
  // write page data — the check is e.source (review F4), and an answer goes
  // back to that same window and nowhere else.
  //   · save  — debounced so a page that saves on every keystroke writes once
  //             per pause; last write wins.
  //   · fetch — forwarded to pages.fetch, which is where the approvals are
  //             checked. The renderer never holds the credential (design §4),
  //             and only the four known fields are passed on.
  useEffect(() => {
    if (load.state !== 'ready' || pageId === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: unknown = undefined;
    const flush = () => {
      timer = null;
      if (pending === undefined) return;
      const data = pending; pending = undefined;
      const write = pagesBridge()?.setData(pageId, data);
      if (!write) { savingRef.current = false; return; }
      // A newer save arriving while this one is written keeps the flag up.
      write.then(() => { if (timer === null && pending === undefined) savingRef.current = false; },
        () => { if (timer === null && pending === undefined) savingRef.current = false; });
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      const d = e.data as { type?: unknown; data?: unknown; id?: unknown; url?: unknown; method?: unknown; headers?: unknown; body?: unknown; as?: unknown; socket?: unknown; request?: unknown; top?: unknown; bottom?: unknown } | null;
      if (!d) return;
      // WHY the frame carries the page document's scroll fade (pages-kit-questions #7: every scrolling
      // area in a Page uses the app's one fade, the page itself included): the page's kit reports which
      // edges hide more, and the frame fades there (scroll-mask.css .scroll-mask-frame). Written straight
      // onto the element — a flag flip per edge reached, never a React render.
      if (d.type === PAGE_EDGES_MESSAGE) {
        const f = frameRef.current;
        if (f) { f.dataset.fadeTop = String(d.top === true); f.dataset.fadeBottom = String(d.bottom === true); }
        return;
      }
      // Esc inside the page = Esc on the view: leave, unless Settings or the
      // library is open over it (their own Esc handling owns the key then).
      if (d.type === PAGE_ESC_MESSAGE) { dismissTop(); return; }
      if (d.type === PAGE_SESSION_START_MESSAGE) {
        // Page start session (spec 2026-10-14, §4). Checked HERE, not trusted
        // from the bootstrap: page code can post this itself. Needs an approved
        // `session` line on the loaded page (the one the gate read) and a sane
        // message; then App opens the window and the page hears only "opened".
        if (typeof d.id !== 'string') return;
        const id = d.id;
        const source = e.source as Window;
        const answer = (ok: boolean, reason?: string) => {
          try { source.postMessage({ type: PAGE_SESSION_START_RESULT_MESSAGE, id, result: ok ? { ok } : { ok, reason } }, '*'); } catch { /* the frame went away */ }
        };
        const approvedOn = (p: PageDocument | null) => !!p?.connections?.some((c) => c.kind === 'session' && c.approved);
        const page = loadedPageRef.current;
        const start = onStartSessionRef.current;
        const prompt = (d as { prompt?: unknown }).prompt;
        if (!page || !start || !approvedOn(page)) { answer(false, PAGE_SESSION_REFUSED.notAllowed); return; }
        // WHY a fresh click inside THIS page (review F2; Destin chose no rate
        // limits): page code can post this itself, past the bootstrap's own
        // check. The frame's origin is opaque, so its activation cannot be read
        // here — but a click in a frame also activates this window, and leaves
        // the frame focused. Both together mean "the person just pressed
        // something in the page": a timer has no activation, and a reopen right
        // after Cancel has the activation of the Cancel click but the focus is
        // no longer in the page (the dialog does not hand it back). Checked now,
        // before the folder read, because activation lasts only seconds.
        const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
        if (!ua?.isActive || document.activeElement !== frameRef.current) { answer(false, PAGE_SESSION_REFUSED.noClick); return; }
        if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PAGE_SESSION_PROMPT) { answer(false, PAGE_SESSION_REFUSED.badMessage); return; }
        // Review F1: hidden characters would reach the model unseen.
        if (PAGE_SESSION_HIDDEN_CHARS.test(prompt)) { answer(false, PAGE_SESSION_REFUSED.hidden); return; }
        void startFolderFor(page.home, (d as { project?: unknown }).project).then((cwd) => {
          // The page may have been closed or swapped while the folder list was
          // read, or its session line removed then (review F3) — ask again.
          const now = loadedPageRef.current;
          if (now?.id !== page.id || !approvedOn(now)) { answer(false, PAGE_SESSION_REFUSED.closed); return; }
          // App turns it down while the window is already open (review F2).
          const opened = onStartSessionRef.current?.({ prompt, cwd, pageName: page.name }) === true;
          answer(opened, opened ? undefined : PAGE_SESSION_REFUSED.alreadyOpen);
        });
        return;
      }
      if (d.type === PAGE_CHATS_MESSAGE) {
        // Page chats (spec 2026-10-16). Checked HERE, not trusted from the bootstrap: page code can post this
        // itself. page-chats.ts reads the approval from the LOADED document, filters to the chats the line
        // names, refuses changes unless the line says "full", and turns Resume down unless the person just
        // clicked in THIS page — the same two-part test as startSession (window activation AND the frame
        // holding focus), so neither a timer nor a reopen right after a dialog gets through.
        if (typeof d.id !== 'string') return;
        const id = d.id;
        const source = e.source as Window;
        const answer = (result: unknown) => {
          try { source.postMessage({ type: PAGE_CHATS_RESULT_MESSAGE, id, result }, '*'); } catch { /* the frame went away */ }
        };
        void answerPageChats(d.request, {
          page: () => loadedPageRef.current,
          clicked: () => {
            const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
            return !!ua?.isActive && document.activeElement === frameRef.current;
          },
        }).then(answer, () => answer({ ok: false, reason: PAGE_CHATS_REFUSED.unavailable }));
        return;
      }
      if (d.type === PAGE_PROGRAM_MESSAGE) {
        // Page programs (spec 2026-10-16). Needs an approved `program` line for THIS file on the loaded page;
        // main then checks the approval on disk AND that the file is still the one that was approved.
        if (typeof d.id !== 'string') return;
        const id = d.id;
        const source = e.source as Window;
        const answer = (result: PageProgramResult) => {
          try { source.postMessage({ type: PAGE_PROGRAM_RESULT_MESSAGE, id, result }, '*'); } catch { /* the frame went away */ }
        };
        const file = (d as { file?: unknown }).file;
        const input = (d as { input?: unknown }).input;
        const approvedFor = (p: PageDocument | null) => !!p?.connections?.some((c) => c.kind === 'program' && c.approved && c.file === file);
        const page = loadedPageRef.current;
        if (typeof file !== 'string' || !page || !approvedFor(page)) { answer({ ok: false, reason: PAGE_PROGRAM_REFUSED.notAllowed }); return; }
        // Character count is a cheap first cut; main measures the bytes.
        if (typeof input !== 'string' || input.length > MAX_PAGE_PROGRAM_INPUT) { answer({ ok: false, reason: PAGE_PROGRAM_REFUSED.badRequest }); return; }
        const bridge = pagesBridge();
        if (!bridge?.runProgram) { answer({ ok: false, reason: PAGE_PROGRAM_REFUSED.unsupported }); return; }
        bridge.runProgram(pageId, file, input).then((r) => {
          // The page may have been closed or changed while it ran (stopPrograms ends the program itself).
          answer(loadedPageRef.current?.id === page.id && approvedFor(loadedPageRef.current) ? r : { ok: false, reason: PAGE_PROGRAM_REFUSED.closed });
        }, () => answer({ ok: false, reason: 'The program could not be run.' }));
        return;
      }
      if (d.type === PAGE_PLAID_MESSAGE) {
        // Plaid on the page's behalf: the request is passed through as-is and
        // main keeps only the shapes it knows (plaid.ts cleanPlaidRequest).
        if (typeof d.id !== 'string') return;
        const id = d.id;
        const source = e.source as Window;
        const answer = (result: PlaidResult) => {
          try { source.postMessage({ type: PAGE_PLAID_RESULT_MESSAGE, id, result }, '*'); } catch { /* the frame went away */ }
        };
        const bridge = pagesBridge();
        const op = (d.request as { op?: PlaidRequest['op'] } | null)?.op ?? 'status';
        if (!bridge?.plaid) { answer({ ok: false, op, code: 'UNSUPPORTED', message: 'Bank connections work in YouCoded on your computer only.' }); return; }
        bridge.plaid(pageId, d.request as PlaidRequest).then(answer, () => {
          answer({ ok: false, op, code: 'UNKNOWN', message: 'The bank request could not be completed.' });
        });
        return;
      }
      if (d.type === PAGE_FETCH_MESSAGE) {
        if (typeof d.id !== 'string') return;
        const id = d.id;
        const source = e.source as Window;
        const answer = (result: PageFetchResult) => {
          try { source.postMessage({ type: PAGE_FETCH_RESULT_MESSAGE, id, result }, '*'); } catch { /* the frame went away */ }
        };
        const bridge = pagesBridge();
        if (!bridge?.fetch) {
          // Not a guess about the network: this window simply has no such
          // channel (an older host, or a platform that answers unsupported).
          answer({ ok: false, reason: 'unsupported', message: 'This window cannot make requests for pages.' });
          return;
        }
        const req: PageFetchRequest = {
          url: typeof d.url === 'string' ? d.url : '',
          ...(typeof d.method === 'string' ? { method: d.method } : {}),
          ...(isStringMap(d.headers) ? { headers: d.headers } : {}),
          ...(typeof d.body === 'string' ? { body: d.body } : {}),
          // A camera snapshot comes back as a data: link (home-device deck).
          ...(d.as === 'picture' ? { as: 'picture' as const } : d.as === 'video' ? { as: 'video' as const } : {}),
          // A one-shot socket exchange with a home device (renames, room
          // moves). Shape-checked here; main checks everything that matters.
          ...(isSocketPlan(d.socket) ? { socket: d.socket } : {}),
        };
        bridge.fetch(pageId, req).then(answer, () => {
          answer({ ok: false, reason: 'network', message: 'The request could not be completed.' });
        });
        return;
      }
      if (d.type !== PAGE_DATA_SET_MESSAGE) return;
      let json = '';
      try { json = JSON.stringify(d.data ?? null); } catch { return; }
      if (json.length > MAX_PAGE_DATA_BYTES) return; // main refuses it too; no point posting
      frameDataRef.current = json;
      savingRef.current = true;
      pending = d.data ?? null;
      if (timer === null) timer = setTimeout(flush, 500);
    };
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); if (timer !== null) { clearTimeout(timer); flush(); } };
  }, [load.state, pageId, dismissTop]);

  // A page's data can change under it — the same page open in another window,
  // or a sync arrival — and `youcoded.onData` is the page's way of hearing
  // about it. Any pages:changed broadcast means a file under Pages/ moved, so
  // the data is read again and posted in ONLY when it differs from what the
  // frame already holds; the echo of the page's own save therefore posts
  // nothing and cannot loop.
  useEffect(() => {
    if (load.state !== 'ready' || pageId === null) return;
    // The page's own save has not landed: disk is older than the frame.
    if (savingRef.current) return;
    const bridge = pagesBridge();
    if (!bridge) return;
    let cancelled = false;
    bridge.get(pageId).then((r) => {
      if (cancelled || !r.ok || savingRef.current) return;
      let json = '';
      try { json = JSON.stringify(r.page.data ?? null); } catch { return; }
      if (json === frameDataRef.current) return;
      frameDataRef.current = json;
      frameRef.current?.contentWindow?.postMessage({ type: PAGE_DATA_MESSAGE, data: r.page.data ?? null }, '*');
    }, () => { /* the next broadcast tries again */ });
    return () => { cancelled = true; };
  }, [pages, load.state, pageId]);

  // Live theme: watch the host document and post the fresh tokens in.
  useEffect(() => {
    if (load.state !== 'ready') return;
    return watchThemeCss((css, see) => {
      frameRef.current?.contentWindow?.postMessage({ type: PAGE_THEME_MESSAGE, css, seeThrough: see }, '*');
    });
  }, [load.state]);

  const title = useMemo(() => summary?.name ?? (load.state === 'ready' ? load.page.name : ''), [summary, load]);
  // The gate reads the LOADED document, never the list summary (design review
  // 1, finding 17): the list is a broadcast that can be a moment stale, and the
  // page that would run is this one. The list is the fallback only before the
  // document has been read, when nothing is running yet either way.
  // Named loadedPage, not loaded: `loaded` is the list store's "has the list
  // arrived" flag (first-run landing, merged from master 2026-09-23).
  const loadedPage = load.state === 'ready' ? load.page : null;
  const awaitingApproval = needsApproval(loadedPage ?? summary);
  // "Closing the page stops it running" (the approved program card): a page with an approved program line
  // asks the app to stop what it started whenever its frame goes away — closed, switched to another page, or
  // rebuilt after an edit. Nothing is registered for a page without one, so ordinary pages cost nothing here.
  const runsPrograms = open && load.state === 'ready' && !awaitingApproval && !!loadedPage?.connections?.some((c) => c.kind === 'program' && c.approved);
  const programFrame = load.state === 'ready' ? load.doc : null;
  useEffect(() => {
    if (!runsPrograms || pageId === null) return;
    const stopFor = pageId;
    return () => { void pagesBridge()?.stopPrograms?.(stopFor)?.catch?.(() => { /* the program ends with its window anyway */ }); };
  }, [runsPrograms, pageId, programFrame]);
  // The page's live sockets live only as long as ITS frame: not while the view is
  // closed, awaiting approval or loading, and a new document is a new frame.
  usePageSockets(frameRef, pageId, open && load.state === 'ready' && !awaitingApproval, load.state === 'ready' ? load.doc : null, pagesBridge);
  /** The band's refresh button is how a person asks the page for fresh
   *  information; the page hears it through `youcoded.onRefresh` (§5). */
  const askPageToRefresh = () => {
    frameRef.current?.contentWindow?.postMessage({ type: PAGE_REFRESH_MESSAGE }, '*');
  };
  // WHY stay mounted, hidden, while Office has documents open (C2, Task 6 fix round 1): closing
  // the page view (or showing another page) used to unmount every Office editor, and an editor
  // unmounted inside autosave's 3 s window lost its last changes. Kept mounted, the editors
  // also come back instantly. Everything else in the view still goes when it closes.
  // Review (the unsaved prompt, a failed hidden close): the Office page, in front, on that tab.
  // A document edited in place is brought forward where it is (fix round 3), never as a tab.
  const reviewOffice = (path: string) => {
    if (!officeDocFor(path) && revealInline(path)) return;
    // A document with no tab any more (its closed tab's last save failed later, fix round 5)
    // opens Office on Home, where Recent has it — never on a tab that does not exist.
    selectTab(officeDocFor(path) ? path : HOME_TAB); dispatch({ type: 'PAGE_OPENED', pageId: OFFICE_PAGE_ID, focus: true });
  };
  // The alerts stay mounted either way: a close or quit can ask while no page is open.
  if (!open && !officeKept) return <OfficeAlerts onReview={reviewOffice} />;

  const builtin = pages.filter((p) => p.home.kind === 'builtin');
  const personal = pages.filter((p) => p.home.kind === 'personal');
  const byProject = new Map<string, PageSummary[]>();
  for (const p of pages) {
    if (p.home.kind !== 'project') continue;
    const list = byProject.get(p.home.name) ?? [];
    list.push(p);
    byProject.set(p.home.name, list);
  }

  return (
    // z-40, the same layer as Project View (they replace each other, never
    // coexist) and BELOW the Settings drawer's click-outside backdrop, so the
    // gear opens the drawer and a click beside it closes it (found 2026-09-17:
    // at z-45 the backdrop sat under the view and Settings could not be
    // closed). The library (z-[60]) opens over this from Manage pages.
    // .screen-view / .screen-pane: floating-chrome themes restyle them (see
    // globals.css → "Screens in floating chrome"); data-screen-frame is the
    // workbench's variant switch for that design round, 'cards' in the app.
    // Closed but kept for Office: invisible, not display:none — an editor laid out at zero size
    // (opened, or shown again, while hidden) came back blank or mis-scrolled (dev window, fix
    // round 1). visibility:hidden keeps its size, takes no clicks and is not painted.
    // inert (fix round 2): kept but closed, nothing inside may take focus or the keyboard.
    <>
    <OfficeAlerts onReview={reviewOffice} />
    <div className={`screen-view fixed inset-0 bg-panel z-40 flex flex-col ${open ? '' : 'invisible pointer-events-none'}`} aria-hidden={open ? undefined : true} inert={!open} data-screen-frame={workbenchScreenFrame()}>
      {open && <ScreenBand
        settingsOpen={settingsOpen}
        onToggleSettings={onToggleSettings}
        settingsBadge={settingsBadge}
        settingsDangerBadge={settingsDangerBadge}
        active={pageFocus ? null : 'pages'}
        onBack={backToChat}
        // WHY icon for Pages home too (decisions "Full-screen titles", H-1: every full
        // screen's title carries its icon): an open page shows its own glyph; the
        // page list showed none.
        icon={summary ? <PageGlyph icon={summary.icon} customIcon={summary.customIcon} className="w-4 h-4" /> : <PagesIcon className="w-4 h-4" />}
        title={<>
          <span className="truncate">{title || 'Pages'}</span>
          {/* Freshness belongs to the app, not the page (deck Q-last-updated):
              same place on every connected page, and true because the app made
              the request. Hidden until the page is approved. */}
          {summary && !awaitingApproval && <PageFreshness page={summary} onRefresh={askPageToRefresh} />}
          {summary && !awaitingApproval && <PageCodeChanged page={summary} />}
        </>}
      />}

      {/* Below the band: the panel in its own rounded container and the page
          pane, both inset by the frame edge, like the chat pane and the
          files/games pane are in a chat session. */}
      <div className={`screen-body flex-1 min-h-0 flex${phoneLayout ? ' relative overflow-hidden' : ''}`}>
        {/* With Office built in the panel always has something to list, so it
            stays beside the first-run card instead of hiding. WHY panel-glass while see-through (ux review 2, U5): the list sat over
            the wallpaper unframed and names ran into tree edges; it gets the same one theme-engine glass as the page pane, and Reduced
            effects removes it the same way. */}
        {open && !pageFocus && (!emptyPages || builtin.length > 0) && (
        <aside inert={phoneLayout && !listOnTop} aria-hidden={phoneLayout && !listOnTop ? true : undefined}
          className={`screen-pane screen-pane--panel ${phoneLayout ? 'w-full shrink-0 transition-transform duration-300 motion-reduce:transition-none' : railCollapsed ? 'w-12 shrink-0' : 'w-60 shrink-0'} ${phoneLayout ? '' : 'relative'} flex flex-col select-none rounded-xl bg-canvas overflow-hidden${seeThrough ? ' panel-glass' : ''}`}
          style={phoneLayout ? { transform: phoneSlide } : undefined}>
          {/* Photo-only: on a phone the list is the screen, so the view's mark lives on it (the frame is slid away). */}
          {listOnTop && load.state === 'idle' && loaded && !failed && <ScreenMark name="pages" />}
          {/* WHY the phone classes: the list is a full-width screen that slides left when a page is shown (owner, 2026-11-01). `inert` while slid away so Tab/screen readers skip it. */}
          {/* WHY absolute when unfolded (Destin, 2026-10-20: "eliminate this empty space above Built in"):
              the toggle sits in the first group label's row instead of costing the list a row of its own. */}
          {/* Phone: this button slides back to the open page (only when there is one). Desktop: folds the list to a rail. */}
          {(!phoneLayout || pageId !== null) && (
          <div className={!phoneLayout && railCollapsed ? 'flex items-center justify-center px-2 pt-2' : 'absolute top-3 right-3 z-10'}>
            <Tooltip text={phoneLayout ? 'Show the page' : railCollapsed ? 'Show the page list' : 'Hide the page list'} placement="bottom">
              <Button size="icon-sm" variant="ghost" aria-label={phoneLayout ? 'Show the page' : railCollapsed ? 'Show the page list' : 'Hide the page list'}
                aria-expanded={phoneLayout ? undefined : !railCollapsed}
                onClick={() => (phoneLayout ? setPhoneListOpen(false) : setRailCollapsed((c) => !c))} className="w-7 h-7">
                <RailToggleGlyph collapsed={phoneLayout ? false : railCollapsed} />
              </Button>
            </Tooltip>
          </div>
          )}
          {!phoneLayout && railCollapsed ? (
            <div className="scroll-mask flex-1 overflow-y-auto flex flex-col items-center gap-1 py-1">
              {[...builtin, ...personal, ...[...byProject.values()].flat()].map((p) => (
                <Tooltip key={p.id} text={p.name} placement="bottom">
                  <Button size="icon-sm" variant="ghost" aria-label={`Open ${p.name}`} aria-current={p.id === pageId ? 'page' : undefined}
                    onClick={() => openFromRail(p.id)} className={`w-8 h-8 ${p.id === pageId ? 'bg-inset' : ''}`}>
                    <PageGlyph icon={p.icon} customIcon={p.customIcon} className="w-4 h-4" />
                  </Button>
                </Tooltip>
              ))}
            </div>
          ) : (<>
          <div className="scroll-mask flex-1 overflow-y-auto p-2">
            {builtin.length > 0 && (
              <RailGroup label="Built in">
                {builtin.map((p) => (
                  <RailRow key={p.id} page={p} current={p.id === pageId} pinFull={pinnedCount >= MAX_PINNED_PAGES}
                    onOpen={() => openFromRail(p.id)} />
                ))}
              </RailGroup>
            )}
            {personal.length > 0 && (
              <RailGroup label="Personal">
                {personal.map((p) => (
                  <RailRow key={p.id} page={p} current={p.id === pageId} pinFull={pinnedCount >= MAX_PINNED_PAGES}
                    onOpen={() => openFromRail(p.id)} />
                ))}
              </RailGroup>
            )}
            {[...byProject.entries()].map(([name, list]) => (
              <RailGroup key={name} label={name}>
                {list.map((p) => (
                  <RailRow key={p.id} page={p} current={p.id === pageId} pinFull={pinnedCount >= MAX_PINNED_PAGES}
                    onOpen={() => openFromRail(p.id)} />
                ))}
              </RailGroup>
            ))}
          </div>
          <div className="p-3 flex flex-col gap-2">
            {/* The welcome card owns the primary action when the library is empty (G-4). */}
            {ownPages.length > 0 && <Button variant="primary" onClick={onCreatePage} className="w-full justify-center rounded-full">
              <PlusGlyph />
              Create a page
            </Button>}
            <Button variant="secondary" onClick={managePages} className="w-full justify-center rounded-full">
              <PagesIcon className="w-3.5 h-3.5" />
              Manage pages
            </Button>
          </div>
          </>)}
        </aside>
        )}
        {/* WHY panel-glass while see-through (owner, 2026-10-05: "a glass effect kinda like marketplace or terminal"): it is the
            app's own opt-in for theme-engine's ONE glass rule (blur at the theme's --panels-blur, written only while a wallpaper is
            on and Reduced effects is off), so the page pane frosts exactly like Marketplace's surfaces and "Reduced effects" removes
            it the same way. One element — never a blur per card inside the page. In 'float' chrome the pane already has its own
            heavier frost (!important), which simply wins. Solid pages (plain theme, framed chrome, or the Appearance switch off) do not get the class: unchanged. Office's frame is this same pane, so it frosts too. */}
        <div inert={phoneLayout && listOnTop} className={`screen-pane screen-pane--frame ${phoneLayout ? 'w-full shrink-0 transition-transform duration-300 motion-reduce:transition-none' : 'relative flex-1 min-w-0'} rounded-xl overflow-hidden bg-canvas${seeThrough ? ' panel-glass' : ''}`}
          style={phoneLayout ? { transform: phoneSlide } : undefined}>
          {/* Phone: the way back to the list from an open page (the list's own button slides forward again). */}
          {phoneLayout && asideShown && !listOnTop && (
            <Button size="icon-sm" variant="secondary" aria-label="Show the page list" onClick={() => setPhoneListOpen(true)}
              className="absolute top-2 left-2 z-20 w-8 h-8">
              <RailToggleGlyph collapsed />
            </Button>
          )}
          {/* First, so its place in the tree never changes whatever else shows (see officeKept). */}
          {(isOffice || officeKept) && (
            <div className={`absolute inset-0 ${open && isOffice ? '' : 'invisible pointer-events-none'}`} aria-hidden={open && isOffice ? undefined : true} inert={!(open && isOffice)}>
              <OfficeView projectRoot={projectRoot} visible={open && isOffice} />
            </div>
          )}
          {open && <>
          {/* Photo-only marks: the view once its list has loaded, or the page once it is ready. */}
          {load.state === 'idle' && loaded && !failed && !isOffice && !listOnTop && <ScreenMark name="pages" />}
          {load.state === 'ready' && pageId && <ScreenMark name={`pages/${pageFocus ? 'focus' : 'page'}/${pageId}`} />}
          {/* WHY: first-run belongs where the Pages button lands, not a second click into Manage pages. */}
          {load.state === 'idle' && !loaded && <LoadingState what="pages" />}
          {load.state === 'idle' && loaded && failed && <ErrorState message="The list of pages could not be read." onRetry={() => void refreshPages()} />}
          {emptyPages && (
            <div className="scroll-mask absolute inset-0 overflow-y-auto flex flex-col">
              <PagesEmptyCard onMake={onCreatePage} />
            </div>
          )}
          {load.state === 'idle' && loaded && !failed && !isOffice && ownPages.length > 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 select-none">
              <div className="text-sm font-medium text-fg-2">No page selected</div>
              <div className="text-xs text-fg-muted">Pick one from the list, or create a page.</div>
            </div>
          )}
          {load.state === 'loading' && <LoadingState what={title} verb="Opening" />}
          {load.state === 'failed' && (
            <div className="p-6 max-w-xl mx-auto">
              <ErrorState message={load.failure.message} onRetry={() => { if (pageId !== null) dispatch({ type: 'PAGE_OPENED', pageId }); }} />
            </div>
          )}
          {/* A page with a line waiting for a yes stays closed: the approval
              shows IN PLACE OF it, so nothing in the page runs first (decks
              Q-own-pages, S-change). "Not now" leaves the page unselected — or, from
              a pinned button (no panel to fall back to), goes back to chat. */}
          {load.state === 'ready' && awaitingApproval && (
            <PageApproval page={load.page} onNotNow={() => dispatch({ type: pageFocus ? 'PAGE_VIEW_CLOSED' : 'PAGE_CLOSED' })} />
          )}
          {load.state === 'ready' && !awaitingApproval && (
            <iframe
              ref={frameRef}
              srcDoc={load.doc}
              sandbox="allow-scripts allow-popups allow-forms"
              className={`scroll-mask-frame absolute inset-0 w-full h-full border-0 ${seeThrough ? '' : 'bg-canvas'}`}
              title={title}
            />
          )}
          </>}
        </div>
      </div>
    </div>
    </>
  );
}

// WHY SectionLabel, not the old spaced-caps eyebrow (labels batch, guide: no
// spaced capitals — decisions H-3/L-1…L-4).
function RailGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pb-2">
      {/* Padding on a wrapper — SectionLabel owns only margin/layout
          (design lint no-restyle). */}
      <div className="px-2 pt-2 pb-1">
        <SectionLabel>{label}</SectionLabel>
      </div>
      {children}
    </div>
  );
}

/** One page in the panel: glyph, name, and its pin at the right. The row opens
 *  the page; the pin is its own control and stops the row's click. Rows are
 *  rounded pills inside the panel, so the current one reads as selected
 *  without a hard-edged band. */
function RailRow({ page, current, pinFull, onOpen }: { page: PageSummary; current: boolean; pinFull: boolean; onOpen: () => void }) {
  const cannotPin = !page.pinned && pinFull;
  return (
    <div
      role="button"
      tabIndex={0}
      data-rail-page={page.id}
      aria-current={current ? 'page' : undefined}
      onClick={onOpen}
      // WHY the target check (U19): Enter/Space on the pin button inside this row bubbled up and also opened the page.
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(); } }}
      className={`group flex items-center gap-2.5 h-8 pl-2 pr-1 rounded-md text-sm text-left cursor-pointer transition-colors ${current ? 'bg-inset text-fg' : 'text-fg-2 hover:text-fg hover:bg-inset/60'}`}
    >
      <PageGlyph icon={page.icon} customIcon={page.customIcon} className="w-4 h-4 shrink-0" />
      <span className="flex-1 min-w-0 truncate">{page.name}</span>
      <Tooltip text={cannotPin ? `Up to ${MAX_PINNED_PAGES} pinned pages` : page.pinned ? 'Unpin from the top bar' : 'Pin to the top bar'} placement="bottom">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={page.pinned ? `Unpin ${page.name}` : `Pin ${page.name}`}
          aria-pressed={page.pinned}
          disabled={cannotPin}
          onClick={(e) => { e.stopPropagation(); void setPagePinned(page.id, !page.pinned); }}
          className="w-6 h-6"
        >
          {/* The colour rides on the glyph, not the Button (the primitive owns
              its own text colour): quiet until the row is hovered, solid when pinned. */}
          <span className={page.pinned ? 'text-fg' : 'text-fg-faint group-hover:text-fg-muted'}><PinGlyph filled={page.pinned} /></span>
        </Button>
      </Tooltip>
    </div>
  );
}


/** Sidebar glyph for the page-list fold: a panel outline with its left column, plus a chevron
 *  pointing the way the list will move. */
function RailToggleGlyph({ collapsed }: { collapsed: boolean }) {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16" />
      <path d={collapsed ? 'M13.5 10l2 2-2 2' : 'M16 10l-2 2 2 2'} />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeWidth={2.5} d="M12 5v14M5 12h14" />
    </svg>
  );
}
