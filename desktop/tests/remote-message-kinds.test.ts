import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MESSAGE_KIND, REHYDRATE_ON_RECONNECT } from '../src/renderer/remote-shim';

const shim = readFileSync(new URL('../src/renderer/remote-shim.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** Every channel the shim sends without expecting a reply — the ones that could be queued. */
function firedChannels(): string[] {
  return [...shim.matchAll(/\bfire\('([^']+)'/g)].map(m => m[1]).sort();
}

describe('nothing sends itself', () => {
  it('every fire-and-forget channel is classified', () => {
    // WHY a guard and not a convention: the way this regresses is a new channel added
    // without a kind, silently defaulting to the queue — which is exactly the behaviour
    // contract row R2 forbids.
    const unclassified = firedChannels().filter(c => !MESSAGE_KIND[c]);
    expect(unclassified).toEqual([]);
  });

  it('the scan finds real channels, so an empty result cannot pass vacuously', () => {
    expect(firedChannels()).toContain('session:input');
    expect(firedChannels()).toContain('native:interrupt');
  });

  it('typing and the actions beside it are user actions, never queued', () => {
    for (const c of ['session:input', 'native:retry', 'native:interrupt', 'ui:action']) {
      expect(MESSAGE_KIND[c]).toBe('user-action');
    }
    // The refusal path: send() returns false for a user action rather than queueing it.
    expect(shim).toContain("if (MESSAGE_KIND[msg?.type] === 'user-action') return false;");
  });

  it('only reads are re-issued on reconnect', () => {
    // Asking again is safe precisely because asking changes nothing. A write in this list
    // would be the old auto-flush bug wearing a new name.
    for (const channel of REHYDRATE_ON_RECONNECT) {
      const kind = MESSAGE_KIND[channel];
      expect(kind === undefined || kind === 'read').toBe(true);
    }
    expect(REHYDRATE_ON_RECONNECT.length).toBeGreaterThan(0);
    // And only on a RECONNECT: a first connect already flushes the caller's own mount-time
    // fetches, so re-asking there would double the traffic of every connection.
    const shimSrc = readFileSync(new URL('../src/renderer/remote-shim.ts', import.meta.url), 'utf8');
    expect(shimSrc).toContain('if (hasConnectedBefore) rehydrate();');
  });

  it('the composer asks whether it can send instead of writing to find out', () => {
    const bar = readFileSync(new URL('../src/renderer/components/InputBar.tsx', import.meta.url), 'utf8');
    expect(bar).toContain('window.claude.session.canSend?.() === false');
    // Both bridges answer it, so the composer never has to know which one it holds.
    expect(readFileSync(new URL('../src/main/preload.ts', import.meta.url), 'utf8')).toContain('canSend: () => true');
    expect(shim).toContain('canSend: () =>');
  });
});
