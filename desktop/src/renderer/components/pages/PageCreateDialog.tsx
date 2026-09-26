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
import React from 'react';
import { Dialog } from '../ui/Dialog';
import { BuddyNewSessionForm } from '../buddy/BuddyNewSessionForm';

export interface PageCreateRequest {
  /** What the composer holds when the conversation opens. */
  initialInput: string;
  /** Start in this folder (a project page's project); else the saved default. */
  cwd?: string;
  /** Dialog title: "Create a page" or "Edit <name>". */
  title: string;
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
    <Dialog screen={request.title.startsWith('Edit ') ? 'pages/library/edit' : 'pages/create'} open onClose={onCancel} layer={3} size="panel" title={request.title} subtitle="Pick where the conversation starts and which model builds it.">
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
