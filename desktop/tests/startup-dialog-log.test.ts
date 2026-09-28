// The desktop.log trail for Claude Code's startup dialogs: one line per dialog,
// a warning when a session waits on one for a minute, and silence once the
// session has started (its first hook event).
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { StartupDialogLog, STARTUP_DIALOG_WARN_MS } from '../src/main/startup-dialog-log';

const TRUST = '\x1b[2m Accessing workspace:\x1b[0m\r\n ❯ No, exit\r\n   Yes, I trust this folder\r\n\r\n Enter to confirm · Esc to cancel';
const BYPASS = ' WARNING: Claude Code running in Bypass Permissions mode\r\n ❯ No, exit\r\n   Yes, I accept\r\n Enter to confirm · Esc to cancel';

afterEach(() => { vi.useRealTimers(); });

function setup() {
  const lines: Array<{ level: string; msg: string; extra?: Record<string, unknown> }> = [];
  const log = new StartupDialogLog((level, _c, msg, extra) => lines.push({ level, msg, extra }));
  return { log, lines };
}

describe('StartupDialogLog', () => {
  it('logs each startup dialog once, even when Claude Code redraws it', () => {
    const { log, lines } = setup();
    log.begin('s1');
    log.output('s1', TRUST);
    log.output('s1', TRUST);
    log.output('s1', BYPASS);
    expect(lines.map((l) => l.msg)).toEqual([
      'Claude Code is showing a dialog before the session starts',
      'Claude Code is showing a dialog before the session starts',
    ]);
    expect(lines[0].extra).toMatchObject({ sessionId: 's1', numbered: false });
    expect(String(lines[0].extra!.excerpt)).toContain('Yes, I trust this folder');
    expect(String(lines[1].extra!.excerpt)).toContain('Yes, I accept');
  });

  it('notes a numbered dialog as numbered', () => {
    const { log, lines } = setup();
    log.begin('s1');
    log.output('s1', ' ❯ 1. Yes, I trust this folder\r\n   2. No, exit\r\n Enter to confirm · Esc to cancel');
    expect(lines[0].extra).toMatchObject({ numbered: true });
  });

  it('warns when a session is still waiting a minute later, and not once it has started', () => {
    vi.useFakeTimers();
    const a = setup();
    a.log.begin('s1');
    a.log.output('s1', TRUST);
    vi.advanceTimersByTime(STARTUP_DIALOG_WARN_MS);
    expect(a.lines.some((l) => l.level === 'WARN')).toBe(true);

    const b = setup();
    b.log.begin('s2');
    b.log.output('s2', TRUST);
    b.log.end('s2', 'started');
    vi.advanceTimersByTime(STARTUP_DIALOG_WARN_MS);
    expect(b.lines.some((l) => l.level === 'WARN')).toBe(false);
    expect(b.lines.at(-1)!.msg).toBe('Startup dialogs answered; session started');
  });

  it('ignores output after the session started, and sessions it was never told about', () => {
    const { log, lines } = setup();
    log.output('never', TRUST);
    log.begin('s1');
    log.end('s1', 'started');
    log.output('s1', TRUST);
    expect(lines).toEqual([]);
  });
});

describe('StartupDialogLog on real Claude Code 2.1.281 output', () => {
  const dir = path.join(__dirname, 'fixtures', 'startup-dialogs');
  const cases: Array<[string, number]> = [
    ['cc-2.1.281-untrusted-100x35.json', 1],
    ['cc-2.1.281-bypass-untrusted-100x35.json', 2],
    ['cc-2.1.281-mcp-two-100x35.json', 2],
    ['cc-2.1.281-mcp-one-40x30.json', 2],
    ['cc-2.1.281-trusted-100x35.json', 0],
  ];
  for (const [file, dialogs] of cases) {
    it(`${file}: ${dialogs} dialog line(s), including the arrow-key redraws`, () => {
      const fx = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const { log, lines } = setup();
      log.begin('s');
      for (const c of fx.chunks) log.output('s', Buffer.from(c.b64, 'base64').toString('utf8'));
      expect(lines.filter((l) => l.msg.startsWith('Claude Code is showing')).length).toBe(dialogs);
    });
  }
});

import { EventEmitter } from 'events';
import { attachStartupDialogLog } from '../src/main/startup-dialog-log';
import { SessionManager } from '../src/main/session-manager';
describe('the first hook marks a session started for every client', () => {
  it('calls onStarted with the session id on its first hook event', () => {
    const sessions = new EventEmitter();
    const hooks = new EventEmitter();
    const started: string[] = [];
    attachStartupDialogLog(sessions as never, hooks as never, () => {}, (id) => started.push(id));
    hooks.emit('hook-event', { sessionId: 's1' });
    expect(started).toEqual(['s1']);
  });

  it('SessionManager.markStarted clears awaitingStart on the listed info', () => {
    const sm = new SessionManager();
    const info = { id: 's1', awaitingStart: true } as any;
    (sm as any).sessions.set('s1', { info });
    expect(sm.listSessions()[0].awaitingStart).toBe(true);
    sm.markStarted('s1');
    expect(sm.listSessions()[0].awaitingStart).toBeUndefined();
  });
});
