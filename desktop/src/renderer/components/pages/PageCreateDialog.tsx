// PageCreateDialog — "Create a page" / "Make a page" / the pencil on a card
// open THIS, not a conversation straight away (Destin, 2026-09-17: "it should
// show a popup with the new session menu (model/project/etc)"). It is the
// app's shared new-session form (BuddyNewSessionForm — folder, model, skip
// permissions, the same create payload) in the shared dialog shell, with the
// page-builder command waiting in the composer when the conversation opens.
//
// The form creates the session itself and hands the SessionInfo back; App
// adopts it (adoptCreatedSession) and leaves the page view, so the new
// conversation is what the person sees next.
import React, { useCallback, useRef, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { CARD_LEVEL_1 } from '../ui/cardLevels';
import { SectionLabel } from '../ui/SectionLabel';
import { BuddyNewSessionForm } from '../buddy/BuddyNewSessionForm';
import { markCaretAtStart } from './page-prompt-caret';

export interface PageCreateRequest {
  /** What the composer holds when the conversation opens. */
  initialInput: string;
  /** Start in this folder (a project page's project); else the saved default. */
  cwd?: string;
  /** Dialog title: "Create a page" or "Edit <name>". */
  title: string;
  /** Line under the title; defaults to the page-building one. Document
   *  comments' Ask Your Assistant (Projects screen) reuses this dialog. */
  subtitle?: string;
  /** Set only for a page's start-session request: the page's name. The window
   *  then shows the message above the choices (review F4). */
  fromPage?: string;
}

/** What a page's `youcoded.startSession` hands App (spec 2026-10-14), after
 *  PageHost checked the frame, the approval and the message. */
export interface PageStartSessionRequest {
  /** Shown in full in the composer, never sent until the person presses Enter. */
  prompt: string;
  /** The folder the window starts in; undefined = the saved default. */
  cwd?: string;
  /** For the window's "From <page>" line. */
  pageName: string;
}

/** The window for a page's start-session request: the same form as Create a
 *  page, titled for a conversation and naming the page that asked (Q-1). The
 *  person still picks project, model and the permission toggle (Q-4). */
function startSessionRequest({ prompt, cwd, pageName }: PageStartSessionRequest): PageCreateRequest {
  return { title: 'Start a conversation', subtitle: `From ${pageName}`, initialInput: prompt, cwd, fromPage: pageName };
}

/** App's state for this window, plus the one way a page may open it.
 *  WHY (review F2): a page's request while the window is open is turned down
 *  (`false`), never swapped in — swapping changed the message while the person
 *  was choosing, and the form's remount put back the folder, model and
 *  permission toggle they had just changed. The ref, not the state, is read so
 *  two requests in one tick (before React renders) still see the window open. */
export function usePageCreate() {
  const [request, setRequest] = useState<PageCreateRequest | null>(null);
  const openRef = useRef(false);
  const set = useCallback((r: PageCreateRequest | null) => { openRef.current = r !== null; setRequest(r); }, []);
  const offerFromPage = useCallback((r: PageStartSessionRequest): boolean => {
    if (openRef.current) return false;
    // WHY (review F4): the chat's caret starts at the top of this message.
    markCaretAtStart(r.prompt);
    set(startSessionRequest(r));
    return true;
  }, [set]);
  return [request, set, offerFromPage] as const;
}

export function PageCreateDialog({ request, onCreated, onCancel, onManageProjects }: {
  request: PageCreateRequest | null;
  onCreated: (info: unknown) => void;
  onCancel: () => void;
  onManageProjects: () => void;
}) {
  if (!request) return null;
  return (
    // Layer 3: the library (z-60, layer 2's band) may be under it — Make a
    // page lives there too — and a dialog must sit above what opened it.
    // `screen`: the photo-only name — the title is the one thing that tells Create from Edit.
    <Dialog screen={request.title.startsWith('Edit ') ? 'pages/library/edit' : 'pages/create'} open onClose={onCancel} layer={3} size="panel" title={request.title} subtitle={request.subtitle ?? 'Pick where the conversation starts and which model builds it.'}>
      {/* WHY a card round the form (final-review#ST-21/#PR-7, the one popup rule): its fields
          and switch sat bare on the popup. One card holding a whole form with its buttons, as the
          quick-chip editor's card does. */}
      <div className={`${CARD_LEVEL_1} p-3`}>
        {/* The page's message stays inside the one card, above the choices it leads into. */}
        {request.fromPage !== undefined && <PageMessagePreview text={request.initialInput} pageName={request.fromPage} />}
      <BuddyNewSessionForm
        key={request.initialInput + (request.cwd ?? '')}
        initialInput={request.initialInput}
        initialCwd={request.cwd}
        onManageProjects={onManageProjects}
        size="md"
        onCreated={(_id, info) => onCreated(info)}
        onCancel={onCancel}
      />
      </div>
    </Dialog>
  );
}

/** WHY (review F4, Destin picked "preview" 2026-10-14): the person reads a
 *  page's message HERE, before choosing the project, model and permission
 *  toggle, not only in the chat box after Create Session. The whole message,
 *  as plain text (never rendered markdown or links: a page wrote it), in a
 *  `well` (the deepest surface, which reads as "not a field to type in"), with
 *  its own scroll so a long message cannot push the choices off the window.
 *  tabIndex makes that scroll reachable from the keyboard. */
function PageMessagePreview({ text, pageName }: { text: string; pageName: string }) {
  const label = `Message from ${pageName}`;
  return (
    <div className="mb-3">
      {/* WHY SectionLabel (guide "Headings": small labels are sentence case, never spaced capitals). */}
      <SectionLabel className="mb-1">{label}</SectionLabel>
      {/* WHY a frame and a scroller (guide: every scroll area fades with the one fade): the mask
          fades whatever it is on, so the well's fill and border sit on the outer box and only the
          text inside scrolls under the fade. */}
      <div className="bg-well border border-edge-dim rounded-lg focus-within:border-accent">
        <div
          role="region"
          aria-label={label}
          tabIndex={0}
          className="scroll-mask max-h-40 overflow-y-auto px-3 py-2 text-xs text-fg-2 whitespace-pre-wrap break-words select-text focus:outline-none"
        >{text}</div>
      </div>
      <p className="text-2xs text-fg-muted mt-1 mb-0">It waits in the message box until you press Enter.</p>
    </div>
  );
}
