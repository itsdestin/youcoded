// Destin, 2026-09-11, on his phone:
//  - "when i create a session, i don't see the initializing session screen. it just immediately
//    resets to the create session/no active session screen until the pc responds with an
//    initailized session, which makes it feel like the app broke/didn't respond";
//  - "sometimes erroneously showing me the very first run 'start your first session' screen when
//    i connect via remote access".
// The first is the screen not changing on the tap: the form closed, and the session only appeared
// when the computer's announcement arrived — which a phone still catching up does not get. The
// second is a failed question about past conversations being read as "you have none".
import { describe, expect, it } from 'vitest';
import { readStripped, assertPatternMatches } from './helpers/guard-scope';
import { showFirstRunWelcome } from '../src/renderer/first-run-screen';

const read = (rel: string) => readStripped(new URL(rel, import.meta.url).pathname);
const app = read('../src/renderer/App.tsx');

describe('who gets told "Start your first session"', () => {
  it('someone with no sessions and nothing to resume, once both are known', () => {
    expect(showFirstRunWelcome({ sessionCount: 0, hasResumable: false, sessionListLoaded: true })).toBe(true);
  });

  it('never someone whose past conversations could not be counted', () => {
    // The failure Destin saw: `browse` was lost with the connection, the answer was recorded as
    // false, and a person with hundreds of conversations was greeted as a new user.
    expect(showFirstRunWelcome({ sessionCount: 0, hasResumable: null, sessionListLoaded: true })).toBe(false);
  });

  it('never before this computer has said which sessions are open', () => {
    expect(showFirstRunWelcome({ sessionCount: 0, hasResumable: false, sessionListLoaded: false })).toBe(false);
  });

  it('never when a conversation is already open', () => {
    expect(showFirstRunWelcome({ sessionCount: 2, hasResumable: false, sessionListLoaded: true })).toBe(false);
    expect(showFirstRunWelcome({ sessionCount: 2, hasResumable: true, sessionListLoaded: true })).toBe(false);
  });
});

describe('the screen App actually renders comes from that one decision', () => {
  it('App asks the function rather than re-deriving it', () => {
    const shape = /const firstTimeWelcome = showFirstRunWelcome\(\{ sessionCount: sessions\.length, hasResumable, sessionListLoaded \}\);/;
    assertPatternMatches(shape, 'const firstTimeWelcome = showFirstRunWelcome({ sessionCount: sessions.length, hasResumable, sessionListLoaded });', 'first-run decision');
    expect(app).toMatch(shape);
  });

  it('a failed or unrecognised answer is unknown, and is asked again after a reconnect', () => {
    expect(app).toContain('.catch(() => { if (alive) setHasResumable(null); });');
    expect(app).toContain('setHasResumable(Array.isArray(list) ? list.length > 0 : null)');
    expect(app).toContain('useOnRemoteReconnect(() => setResumeProbe((n) => n + 1));');
    // A new computer's answer is not the old computer's answer.
    const modeChange = app.slice(app.indexOf('onConnectionModeChange((mode)'));
    expect(modeChange.slice(0, 700)).toContain('setHasResumable(null);');
  });

  it('the list of open sessions is marked as arrived even when it is empty', () => {
    const shape = /setSessionListLoaded\(true\);\n\s*if \(!list \|\| list\.length === 0\) return;/;
    assertPatternMatches(shape, 'setSessionListLoaded(true);\n      if (!list || list.length === 0) return;', 'session list arrival');
    expect(app).toMatch(shape);
  });

  it('the new-session form does not open itself over a catch-up', () => {
    const autoOpen = app.slice(app.indexOf('autoOpenedWelcome.current = true'));
    expect(app).toMatch(/if \(remoteCatchingUp\) return;\n\s*if \(firstTimeWelcome && !autoOpenedWelcome\.current\)/);
    expect(autoOpen.length).toBeGreaterThan(0);
  });
});

describe('creating a session says something the moment it is asked for', () => {
  it('the wait is a state of its own, set before the computer is asked', () => {
    const shape = /setStartingSession\(true\);\n\s*setStartFailed\(null\);/;
    assertPatternMatches(shape, 'setStartingSession(true);\n    setStartFailed(null);', 'starting state');
    expect(app).toMatch(shape);
    expect(app).toMatch(/startingSession \?[\s\S]{0,400}Starting your session/);
    // And the buttons that would start a second one are out of reach while it runs.
    const hidden = /w-64\$\{remoteCatchingUp \|\| startingSession \? ' hidden' : ''\}/;
    // A template literal with an escaped ${: the same characters, and not a plain string with
    // what looks like an expression in it (lint: no-template-curly-in-string).
    assertPatternMatches(hidden, `w-64\${remoteCatchingUp || startingSession ? ' hidden' : ''}`, 'welcome buttons hidden while starting');
    expect(app).toMatch(hidden);
  });

  it('the session goes on screen from the computer’s answer, not only its announcement', () => {
    // On a phone the announcement is held back until a catch-up finishes, and even then a
    // remote client will not auto-select it.
    expect(app).toContain('if (info?.id) adoptCreatedSession(info);');
    const adopt = app.slice(app.indexOf('const adoptCreatedSession'));
    expect(adopt.slice(0, 1400)).toContain('setSessionId(info.id);');
    expect(adopt.slice(0, 1400)).toContain('placeDecidedRef.current = true;');
    // Dedup: the announcement handler adds nothing a second time.
    expect(app).toContain('if (prev.some((s) => s.id === info.id)) return prev;');
  });

  it('a start that fails says so and offers to try again, instead of an empty screen', () => {
    expect(app).toContain("setStartFailed(err?.message ? String(err.message) : '');");
    expect(app).toMatch(/startFailed !== null \?[\s\S]{0,300}ErrorState/);
    expect(app).toMatch(/Couldn.{1,8}t start the session/);
    expect(app).toMatch(/onRetry=\{\(\) => \{[\s\S]{0,220}createSession as any/);
  });
});
