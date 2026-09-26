// admin-forget.test.ts — design §5: "when the LAST registered call that
// received a password exits, run <the verified sudo> -K … Also on app
// quit." `execFile` is mocked throughout — this never runs a real `sudo`
// (CI runs this suite on Windows/macOS too, where sudo may not even exist).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn((_cmd: string, _args: string[], cb: (err: Error | null) => void) => cb(null)),
}));
vi.mock('child_process', () => ({ execFile: execFileMock }));

import { forgetOnCallExit, forgetOnQuit } from '../src/main/harness/askpass/admin-forget';
import { RunningCalls } from '../src/main/harness/askpass/running-calls';

// A reader that always resolves — registerPid never fails, so every
// registered pid actually lands in RunningCalls.
const okReader = { startTime: async (_pid: number) => 1 } as any;

beforeEach(() => {
  execFileMock.mockClear();
});

// admin-password design section 5, review 2 finding E5.
describe('forgetOnCallExit — the granted-calls Set emptying triggers sudo -K', () => {
  it('never runs -K for a call that was never granted a password', () => {
    const rc = new RunningCalls(okReader);
    forgetOnCallExit(rc, 'never-granted');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('does not run -K while OTHER granted calls remain outstanding', () => {
    const rc = new RunningCalls(okReader);
    rc.markGranted('a');
    rc.markGranted('b');
    rc.recordSudoPath('/usr/bin/sudo');
    forgetOnCallExit(rc, 'a');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('runs -K exactly once, against the VERIFIED path (never PATH), when the LAST granted call exits', () => {
    const rc = new RunningCalls(okReader);
    rc.markGranted('a');
    rc.recordSudoPath('/usr/bin/sudo');
    forgetOnCallExit(rc, 'a');
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][0]).toBe('/usr/bin/sudo');
    expect(execFileMock.mock.calls[0][1]).toEqual(['-K']);
  });

  it('one call authenticating twice (two distinct sudo pids) is added to the Set only once — release() still empties it on the FIRST exit', () => {
    const rc = new RunningCalls(okReader);
    rc.markGranted('a');
    rc.markGranted('a'); // idempotent — a second delivery for the SAME call
    rc.recordSudoPath('/usr/bin/sudo');
    forgetOnCallExit(rc, 'a');
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('never runs -K when nothing was ever verified (no recordSudoPath call)', () => {
    const rc = new RunningCalls(okReader);
    rc.markGranted('a');
    forgetOnCallExit(rc, 'a');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('a failed -K is logged, never thrown', () => {
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], cb: (err: Error | null) => void) => cb(new Error('boom')));
    const rc = new RunningCalls(okReader);
    rc.markGranted('a');
    rc.recordSudoPath('/usr/bin/sudo');
    expect(() => forgetOnCallExit(rc, 'a')).not.toThrow();
  });
});

describe('forgetOnQuit — the "also on app quit" sweep', () => {
  it('is a no-op when nothing was ever verified', () => {
    const rc = new RunningCalls(okReader);
    forgetOnQuit(rc);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('runs -K against the verified path, unconditionally, with no password argument anywhere', () => {
    const rc = new RunningCalls(okReader);
    rc.recordSudoPath('/usr/bin/sudo');
    forgetOnQuit(rc);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args).toEqual(['-K']);
    expect(args.join(' ')).not.toMatch(/-S|-A|password/i);
  });
});
