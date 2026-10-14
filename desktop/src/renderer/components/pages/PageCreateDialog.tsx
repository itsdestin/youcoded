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
import { BuddyNewSessionForm } from '../buddy/BuddyNewSessionForm';

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
  return { title: 'Start a conversation', subtitle: `From ${pageName}`, initialInput: prompt, cwd };
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
      <BuddyNewSessionForm
        key={request.initialInput + (request.cwd ?? '')}
        initialInput={request.initialInput}
        initialCwd={request.cwd}
        onManageProjects={onManageProjects}
        size="md"
        onCreated={(_id, info) => onCreated(info)}
        onCancel={onCancel}
      />
    </Dialog>
  );
}
