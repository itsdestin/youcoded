// The native host never lets the prompt assembler shell out to git.
//
// assembleSystemPrompt(Parts) runs `git rev-parse` and `git status` for the
// <env> block — synchronously unless the caller hands it the line. The host
// reads it first with gitSnapshotAsync (off the main thread) at every place a
// session is built: create, resume, and BOTH specialist paths — the helper
// spawn mid-turn is the one that used to freeze the whole app for up to two
// 3 s timeouts on a big or dirty repo. Guard: every call in the host passes
// `gitSnapshot`, and the only callers of the sync reader are the assembler's
// own fallback (for the evaluator and tests).
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { readStripped } from './helpers/guard-scope';

const MAIN = join(__dirname, '..', 'src', 'main');

/** Each `assembleSystemPrompt(` / `assembleSystemPromptParts(` call's argument text. */
function assemblerCalls(src: string): Array<{ at: number; args: string }> {
  const out: Array<{ at: number; args: string }> = [];
  const re = /assembleSystemPrompt(?:Parts)?\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    out.push({ at: m.index, args: src.slice(m.index + m[0].length, i - 1) });
  }
  return out;
}

describe('the host precomputes the git snapshot (2026-09-16 C3)', () => {
  it('every prompt assembly in native-session-host.ts passes gitSnapshot', () => {
    const src = readStripped(join(MAIN, 'harness', 'native-session-host.ts'));
    const calls = assemblerCalls(src);
    expect(calls.length).toBeGreaterThanOrEqual(2); // toolWiring + buildSpecialistSession
    for (const call of calls) {
      expect(call.args, `assembleSystemPrompt call at offset ${call.at} lacks gitSnapshot`).toMatch(/\bgitSnapshot\b/);
    }
  });

  it('nothing in main/ calls the sync git shell-out except the assembler itself', () => {
    const src = readStripped(join(MAIN, 'harness', 'prompt-assembly.ts'));
    // The sync form stays for callers without a host (evaluator, tests); it must
    // not be exported, so no other main-process module can pick it up.
    expect(src).not.toMatch(/export function gitSnapshot\(/);
    expect(src).toMatch(/export async function gitSnapshotAsync\(/);
  });
});
