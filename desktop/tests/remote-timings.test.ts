// The computer's log lines for how long a phone waited (src/main/remote-timings.ts), and the phone's report that feeds them
// (src/renderer/remote-timings.ts). Destin's phone felt slow and nothing measured it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { describePhoneTimings, describeAnswer } from '../src/main/remote-timings';

describe('the computer\'s line for a phone\'s timings', () => {
  it('lists the steps in order, with how the page was opened and what it downloaded', () => {
    expect(describePhoneTimings({ kind: 'load', nav: 'reload', downloaded: 2048, marks: { drawn: 3000, open: 1200, page: 400, 'signed-in': 1700 } }))
      .toBe('timings (page reload, 2 KB downloaded), ms: page 400 · connected 1200 · signed in 1700 · drawn 3000');
    expect(describePhoneTimings({ kind: 'reconnect', marks: { open: 500, drawn: 1400 } })).toBe('timings (reconnect), ms: connected 500 · drawn 1400');
  });

  it('ignores anything that is not a report, and steps it does not know or cannot believe', () => {
    expect(describePhoneTimings(null)).toBeNull();
    expect(describePhoneTimings({ kind: 'other', marks: { open: 1 } })).toBeNull();
    expect(describePhoneTimings({ kind: 'load', marks: { secret: 5, open: -1, drawn: 'x' } })).toBeNull();
  });

  it('says which conversation answer it was, how long it took and how big it was', () => {
    expect(describeAnswer('session:open', { ptyOnly: true }, 12.4, 3 * 1024 * 1024)).toBe('terminal answered in 12 ms, 3.0 MB');
    expect(describeAnswer('session:open', {}, 80, 200 * 1024)).toBe('conversation answered in 80 ms, 200 KB');
    expect(describeAnswer('session:list', {}, 3, 900)).toBe('list answered in 3 ms, 1 KB');
  });
});

describe('the phone\'s report', () => {
  beforeEach(() => { vi.resetModules(); });

  it('reports the page load once, then each reconnect from its own start', async () => {
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    const timings = await import('../src/renderer/remote-timings');
    t = 100; timings.markPage('connection-code');
    t = 200; timings.startConnection();
    t = 700; timings.markConnection('open');
    t = 900; timings.markConnection('signed-in');
    t = 1500;
    const load = timings.takeReport();
    expect(load).toMatchObject({ kind: 'load', marks: { 'connection-code': 100, connecting: 200, open: 700, 'signed-in': 900, drawn: 1500 } });
    expect(timings.takeReport()).toBeNull();                       // once per connection

    t = 5000; timings.startConnection();
    t = 5400; timings.markConnection('open');
    t = 6000;
    expect(timings.takeReport()).toEqual({ kind: 'reconnect', marks: { open: 400, drawn: 1000 } });

    // Shown again: the next connection says how long after that it began (the wake check's wait), and only that one.
    t = 9000; timings.markWake();
    t = 11500; timings.startConnection();
    t = 12500;
    expect(timings.takeReport()).toEqual({ kind: 'reconnect', marks: { waited: 2500, drawn: 1000 } });
    t = 13000; timings.startConnection();
    t = 13500;
    expect(timings.takeReport()).toEqual({ kind: 'reconnect', marks: { drawn: 500 } });
    expect(describePhoneTimings({ kind: 'reconnect', marks: { waited: 2500, drawn: 1000 } })).toBe('timings (reconnect), ms: waited after waking 2500 · drawn 1000');
  });
});
