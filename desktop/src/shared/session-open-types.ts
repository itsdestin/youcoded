// session-open-types.ts — the ask and the answer of `session:open`, shared by the computer (main/session-open.ts), the phone's page
// (remote-shim.ts) and the renderer's fill (state/session-fill.ts). Types only: nothing here runs.
//
// WHY here and not in main/ (one-core R5-2): the renderer applies the answer, and renderer code does not import from main/.
import type { TranscriptPageResult } from './types';

/** One push as a screen would receive it live: replayed through the same handler. */
export interface Push { type: string; payload: unknown }

export interface OpenRequest {
  sessionId: string;
  /** Where this screen got to in this session, from the last open or live push it saw. */
  have?: { epoch?: string; seq?: number } | null;
  /** Phone only: how far the terminal has drawn. Present (even empty) means "send the terminal too". */
  pty?: { epoch?: string; units?: number } | null;
  /** A resumed Claude Code session's transcript, for the moments the computer cannot find the file by itself. */
  claudeSessionId?: string;
  projectSlug?: string;
  /** Refresh: ignore `have` and send a fresh page. */
  fresh?: boolean;
}

interface OpenFacts {
  /** A turn is in flight, as the record folded it. A page read from disk cannot say. */
  working: boolean;
  attention: string;
}

export type OpenReply =
  | {
    ok: true;
    epoch: string;
    headSeq: number;
    resume: 'events' | 'page';
    before: Push[];
    page: TranscriptPageResult | null;
    after: Push[];
    facts: OpenFacts;
    pty?: { epoch: string; offset: number; data: string; reset: boolean };
  }
  | { ok: false; error: string; gone?: boolean };

