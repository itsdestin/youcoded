// Destin, 2026-09-11, on his phone:
//  - "when i create a session, i don't see the initializing session screen. it just immediately
//    resets to the create session/no active session screen until the pc responds with an
//    initailized session, which makes it feel like the app broke/didn't respond";
//  - "sometimes erroneously showing me the very first run 'start your first session' screen when
//    i connect via remote access".
// The first is the screen not changing on the tap: the form closed, and the session only appeared
// when the computer's announcement arrived — which a phone still catching up does not get. The
// second is a failed question about past conversations being read as "you have none".
//
// WHY only the decision is tested here (Plan B, 2026-09-16): this file also pinned exact
// App.tsx lines for the first-run and start flow as source text. Those pins broke on every
// rewording, and App cannot be mounted in a unit test to check the behaviour instead, so they
// were deleted. The decision App asks is the part a unit test can really exercise.
import { describe, expect, it } from 'vitest';
import { showFirstRunWelcome } from '../src/renderer/first-run-screen';

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
