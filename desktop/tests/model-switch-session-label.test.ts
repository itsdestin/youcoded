// Switching a Claude Code conversation's model must also update the session's own
// `model`, which the All Sessions menu labels its row from (session-runtime-label.ts).
// Only native swaps did (onNativeModelChanged), so after a switch the status bar said
// "Haiku" while the menu still said "Claude Code · Sonnet" (UX tester, 2026-09-26).
//
// WHY source text: the switch lives inside App (switchSessionModel), which no test can
// mount cheaply; this pins that both the switch and its revert write the session list.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
const body = (start: string, len = 2500) => { const i = APP.indexOf(start); expect(i, `${start} not found`).toBeGreaterThan(-1); return APP.slice(i, i + len); };

describe('a model switch updates the session the All Sessions menu reads', () => {
  it('rememberSessionModel writes the chip map AND the session', () => {
    const fn = body('const rememberSessionModel = useCallback(', 400);
    expect(fn).toContain('setSessionModels((prev) => new Map(prev).set(sid, m))');
    expect(fn).toMatch(/setSessions\(\(prev\) => prev\.map\(\(s\) => \(s\.id === sid \? \{ \.\.\.s, model: m \} : s\)\)\)/);
  });
  it('every Claude Code switch goes through it: the shared switch, its revert, and the Model & Effort pick', () => {
    expect(body('const switchSessionModel = useCallback(')).toContain('rememberSessionModel(sid, target)');
    expect(body('const actual = MODELS.find(', 600)).toContain('rememberSessionModel(sessionId, actual)');
    expect(body('onSelectModel={(m) => {', 800)).toContain('rememberSessionModel(sessionId, m)');
  });
});
