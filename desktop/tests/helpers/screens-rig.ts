// screens-rig.ts — the computer's own copy of a Claude Code terminal (main/session-screens.ts) wired to a real record and a real live-facts publisher, with
// a virtual clock and the REAL @xterm/headless terminal wrapped so a test can wait for parsing instead of sleeping (one-core R5-4b).
import { vi, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { SessionRecords } from '../../src/main/session-record';
import { createPublish } from '../../src/main/publish';
import { SessionLiveFacts } from '../../src/main/session-live';
import { SessionScreens, type ScreenTerminal } from '../../src/main/session-screens';

export const S = 'sess-1';

export interface Rig {
  records: SessionRecords;
  screens: SessionScreens;
  live: SessionLiveFacts;
  /** Everything published for the session, in order. */
  lives: () => any[];
  /** The headless terminal the computer made for the session (null while none exists). */
  term: () => Terminal | null;
  /** Terminals the computer has created, ever. */
  created: () => number;
  now: () => number;
  /** A chunk of terminal output: noted in the record first, then handed to the screens, as the session manager does. */
  output: (data: string) => void;
  /** Run the virtual clock forward: every timer and every stuck-check tick due in the interval fires, in order. */
  advance: (ms: number) => Promise<void>;
  /** Wait for the terminal to finish taking in what it was written. */
  settle: () => Promise<void>;
  /** Hook events and transcript events, as the core feeds them to the record. */
  note: (type: string, payload: unknown) => void;
}

export function makeRig(opts: { started?: boolean; claude?: boolean } = {}): Rig {
  let t = 1_000_000;
  const records = new SessionRecords({ now: () => t });
  records.begin(S);
  let parsing = 0;
  let current: Terminal | null = null;
  let created = 0;
  const sent: any[] = [];
  const publish = createPublish({
    records,
    toWindows: (_s, ch, args) => { if (ch === 'session:live') sent.push(args[0]); },
    toSockets: () => {},
  });
  const live = new SessionLiveFacts({ publish, records, isClaude: () => opts.claude !== false, now: () => t });
  const timers: Array<{ at: number; fn: () => void; dead?: boolean; every?: number }> = [];
  const screens = new SessionScreens({
    records, live, isClaude: () => opts.claude !== false, now: () => t,
    setTimer: (fn, ms) => { const e = { at: t + ms, fn }; timers.push(e); return e; },
    clearTimer: (h) => { if (h) (h as any).dead = true; },
    setRepeat: (fn, ms) => { const e = { at: t + ms, fn, every: ms }; timers.push(e); return e; },
    clearRepeat: (h) => { if (h) (h as any).dead = true; },
    createTerminal: (cols, rows) => {
      const term = new Terminal({ cols, rows, scrollback: 60, allowProposedApi: true });
      current = term; created++;
      return {
        get rows() { return term.rows; }, get buffer() { return term.buffer; },
        write: (d: string, cb?: () => void) => { parsing++; term.write(d, () => { parsing--; cb?.(); }); },
        resize: (c: number, r: number) => term.resize(c, r),
        dispose: () => { if (current === term) current = null; term.dispose(); },
      } as unknown as ScreenTerminal;
    },
  });
  records.onScreenNeedChange((id) => screens.refresh(id));
  if (opts.started) records.note(S, 'hook:event', { type: 'SessionStart', sessionId: S, payload: {} });

  const settle = () => vi.waitFor(() => expect(parsing).toBe(0));
  const advance = async (ms: number) => {
    await settle();
    const end = t + ms;
    for (;;) {
      const due = timers.filter((x) => !x.dead && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at;
      if (due.every) due.at += due.every; else due.dead = true;
      due.fn();
      await settle();
    }
    t = end;
  };
  return {
    records, screens, live,
    lives: () => sent,
    term: () => current,
    created: () => created,
    now: () => t,
    output: (data) => { const at = records.notePty(S, data); screens.noteOutput(S, data, at); },
    advance, settle,
    note: (type, payload) => { records.note(S, type, payload); },
  };
}

/** A user message and the events that say a turn is running. */
export const turnStarts = (): Array<[string, unknown]> => [['transcript:event', { type: 'user-message', sessionId: S, uuid: 'u1', timestamp: 1, data: { text: 'do it' } }]];
export const turnEnds = (): Array<[string, unknown]> => [['transcript:event', { type: 'turn-complete', sessionId: S, uuid: 'u2', timestamp: 2, data: {} }]];
