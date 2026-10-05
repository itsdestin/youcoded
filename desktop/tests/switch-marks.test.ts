// @vitest-environment jsdom
// Switch marks, page half: what the page tells the hitch recorder, and the places it must be told from.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { announceNoSession, announceSwitch, noteSwitchIntent, noteTerminalShown, resetSwitchMarks } from '../src/renderer/state/switch-marks';

const heard: Array<{ name: string; d: any }> = [];
beforeEach(() => {
  resetSwitchMarks();
  heard.length = 0;
  for (const name of ['yc:switch', 'yc:switch-term', 'yc:switch-none']) {
    document.addEventListener(name, ((e: CustomEvent) => heard.push({ name, d: JSON.parse(e.detail) })) as unknown as EventListener, { once: true });
  }
});
const info = (over: Record<string, unknown> = {}) => ({ sessionId: 's1', record: true, viewMode: 'chat' as const, kind: 'claude' as const, streaming: false, sessionCount: 3, ...over });

describe('page -> recorder announcements', () => {
  it('carries the input event\'s own timestamp and the cause, as a JSON string (detail objects do not cross the preload world boundary)', () => {
    noteSwitchIntent('menu', { timeStamp: 1234.5 });
    announceSwitch(info());
    expect(heard).toHaveLength(1);
    expect(heard[0].d).toMatchObject({ c: 'menu', t: 1234.5, id: 's1', vm: 'chat', k: 'claude', s: 0, n: 3, r: 1 });
  });

  it('a switch with no input of its own is "auto", and an input is consumed by the switch it caused', () => {
    noteSwitchIntent('pill', { timeStamp: performance.now() });
    announceSwitch(info());
    announceSwitch(info({ sessionId: 's2' }));
    document.addEventListener('yc:switch', ((e: CustomEvent) => heard.push({ name: 'x', d: JSON.parse(e.detail) })) as unknown as EventListener, { once: true });
    announceSwitch(info({ sessionId: 's3' }));
    expect(heard.at(-1)!.d).toMatchObject({ c: 'auto', id: 's3' });
    expect(heard.at(-1)!.d.t).toBeUndefined();
  });

  it('an input older than 5 s is not blamed for a later switch', () => {
    const spy = vi.spyOn(performance, 'now').mockReturnValue(20_000);
    noteSwitchIntent('pill', { timeStamp: 14_000 });
    announceSwitch(info());
    spy.mockRestore();
    expect(heard[0].d.c).toBe('auto');
  });

  it('without an event, the clock starts when the intent was noted', () => {
    const before = performance.now();
    noteSwitchIntent('key');
    announceSwitch(info());
    expect(heard[0].d.t).toBeGreaterThanOrEqual(before);
  });

  it('a first selection is announced with r = 0 (remembered, not recorded)', () => {
    announceSwitch(info({ record: false }));
    expect(heard[0].d.r).toBe(0);
  });

  it('terminal view: reports the backlog size, then fires "drained" for this switch once xterm has parsed it', async () => {
    const parsed = vi.fn((cb: () => void) => { setTimeout(cb, 0); });
    document.addEventListener('yc:switch-term', ((e: CustomEvent) => heard.push({ name: 'yc:switch-term', d: JSON.parse(e.detail) })) as unknown as EventListener, { once: true });
    noteTerminalShown(4096, parsed);            // the terminal's layout effect runs BEFORE the App's
    announceSwitch(info({ viewMode: 'terminal' }));
    expect(heard[0].d).toMatchObject({ vm: 'terminal', dr: 4096 });
    await new Promise((r) => setTimeout(r, 5));
    expect(heard.find((h) => h.name === 'yc:switch-term')!.d.q).toBe(heard[0].d.q);
  });

  it('a terminal show that is not a session switch (the chat/terminal toggle) leaves nothing parked for the next one', async () => {
    const parsed = vi.fn();
    noteTerminalShown(99, parsed);
    await Promise.resolve();                     // the commit is over
    announceSwitch(info({ viewMode: 'terminal' }));
    expect(heard[0].d.dr).toBeUndefined();
    expect(parsed).not.toHaveBeenCalled();       // and no empty write was issued either
  });

  it('no session left is announced so a switch in flight can end', () => {
    announceNoSession();
    expect(heard[0].name).toBe('yc:switch-none');
  });
});

describe('where the page must say it (pinned by source scan)', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  it('every user-driven path in the session strip names its cause', () => {
    const s = src('../src/renderer/components/SessionStrip.tsx');
    expect(s).toMatch(/onSelectSession\(sessionId, 'pill', e\)/);          // press on a pill
    expect(s).toMatch(/onSelectSession\(id, 'pill', ev\)/);                // click on a pill
    expect(s).toMatch(/onSelectSession\(s\.id, 'menu', e\)/);              // All Sessions menu row (click and Enter/Space)
    expect(s).toMatch(/onSelectSession\(sessions\[idx\]\.id, 'key', e\)/); // Shift-hold navigation
    expect(s).toMatch(/if \(id !== activeIdRef\.current\) noteSwitchIntent/); // pressing the active pill is not a switch
  });
  it('the App announces every change of the active session from one layout effect', () => {
    const a = src('../src/renderer/App.tsx');
    expect(a).toMatch(/useLayoutEffect\(\(\) => \{\s*const prev = prevSwitchSessionRef\.current;/);
    expect(a).toMatch(/announceSwitch\(\{/);
    expect(a).toMatch(/noteSwitchIntent\('other'\)/);                       // buddy "open main app"
  });
  it('the terminal reports its show to the switch marks', () => {
    expect(src('../src/renderer/components/TerminalView.tsx')).toMatch(/noteTerminalShown\(owed,/);
  });
});
