// startup-dialog-log.ts — write a line to ~/.claude/desktop.log whenever Claude
// Code shows a dialog BEFORE a session starts (folder trust, the bypass warning,
// MCP-server approval, anything new), and a warning if the session is still
// waiting on one a minute later.
//
// WHY: when Claude Code reshapes one of these dialogs the app can stop
// recognising it, and a real user's new session just sits on "Initializing
// session…". Until now nothing on disk recorded that a dialog was even on
// screen, so the hang could not be diagnosed from a bug report. The log
// already carries "Claude Code detected: <version>" from the launch check
// (prerequisite-installer.ts), so these lines plus that one say which version
// showed which dialog.
//
// Local only — nothing leaves the machine. It reads the raw PTY stream (main
// has no terminal emulator), so the excerpt is best-effort text, not a parsed
// menu; it is bounded, and stops the moment the session's first hook event
// arrives (Claude Code runs hooks only after every startup dialog is answered —
// measured on 2.1.281, fixtures' `sessionStartHookAt`).

/** Claude Code's dialog footer — the same phrases the renderer's parser keys on. */
// The rest of the footer line is part of the match, so "Enter to confirm · Esc
// to cancel" is consumed whole and its second half never reads as a new dialog.
const FOOTER = /(Enter to confirm|Esc to (cancel|exit|reject)|Space to select)[^\r\n]*/i;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g;
const TAIL_MAX = 4000;
export const STARTUP_DIALOG_WARN_MS = 60_000;

type LogFn = (level: 'INFO' | 'WARN', component: string, msg: string, extra?: Record<string, unknown>) => void;

interface Watch {
  tail: string;
  seen: string[];
  firstSeenAt: number | null;
  warnTimer: ReturnType<typeof setTimeout> | null;
}

export class StartupDialogLog {
  private watches = new Map<string, Watch>();

  constructor(private log: LogFn, private now: () => number = Date.now) {}

  /** A Claude Code session was just spawned — start watching its output. */
  begin(sessionId: string): void {
    this.watches.set(sessionId, { tail: '', seen: [], firstSeenAt: null, warnTimer: null });
  }

  output(sessionId: string, data: string): void {
    const w = this.watches.get(sessionId);
    if (!w) return;
    w.tail = (w.tail + data.replace(ANSI, ' ')).slice(-TAIL_MAX);
    const m = FOOTER.exec(w.tail);
    if (!m) return;
    // A footer with nothing above it is the tail end of one already logged (the
    // stream split mid-line) — drop it without logging.
    if (w.tail.slice(0, m.index).replace(/\s+/g, '').length < 8) {
      w.tail = w.tail.slice(m.index + m[0].length);
      return;
    }
    // The text just above the footer: the options and the end of the body.
    const excerpt = w.tail.slice(Math.max(0, m.index - 240), m.index + m[0].length)
      .replace(/\s+/g, ' ').trim();
    // Consume what was matched so one dialog is logged once, a redraw of it is
    // skipped, and the NEXT dialog (trust, then bypass) gets its own line.
    w.tail = w.tail.slice(m.index + m[0].length);
    const key = excerpt.slice(-120);
    if (w.seen.includes(key)) return;
    w.seen.push(key);
    w.firstSeenAt ??= this.now();
    this.log('INFO', 'startup-dialog', 'Claude Code is showing a dialog before the session starts', {
      sessionId,
      // A printed "1." means the app can answer by digit; none = arrow navigation.
      numbered: /(^|\s)1\.\s/.test(excerpt),
      excerpt,
    });
    if (!w.warnTimer) {
      w.warnTimer = setTimeout(() => {
        if (!this.watches.has(sessionId)) return;
        this.log('WARN', 'startup-dialog', 'Session still waiting on a Claude Code startup dialog', {
          sessionId,
          waitedMs: this.now() - (w.firstSeenAt ?? this.now()),
          dialogs: w.seen.length,
        });
      }, STARTUP_DIALOG_WARN_MS);
    }
  }

  /** First hook event (Claude Code is running) or the process exited. */
  end(sessionId: string, why: 'started' | 'exited'): void {
    const w = this.watches.get(sessionId);
    if (!w) return;
    this.watches.delete(sessionId);
    if (w.warnTimer) clearTimeout(w.warnTimer);
    if (w.firstSeenAt !== null) {
      this.log('INFO', 'startup-dialog', why === 'started'
        ? 'Startup dialogs answered; session started'
        : 'Session ended while a startup dialog was showing', {
        sessionId, afterMs: this.now() - w.firstSeenAt, dialogs: w.seen.length,
      });
    }
  }
}
