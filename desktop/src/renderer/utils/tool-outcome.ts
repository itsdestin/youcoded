import type { ToolCallState } from '../../shared/types';
import { liveReport, shellEndKind } from '../state/native-run-facts';

/** How one tool card's WORK ended — which is not always what its own result says. */
export type ToolOutcome = 'running' | 'completed' | 'failed' | 'stopped';

/**
 * The ONE rule for "is this card's work running / done / failed / stopped",
 * shared by the collapsed group header, the group headline and the Subagents
 * chip (2026-10-22 audit A3 + B9).
 *
 * WHY it exists: a background helper or command's own tool result is only a
 * LAUNCH RECEIPT (`status: 'complete'`). Three places each read `tool.status`
 * alone, so a helper that failed or was stopped after launch drew a plain check,
 * and a stopped foreground Task (whose Task card unwinds to `failed` after its
 * run already says `interrupted`) was counted failed while its icon said stopped.
 * The work's own record — run / ccBackground / shellRun — wins over the receipt.
 */
export function toolOutcome(t: ToolCallState): ToolOutcome {
  // Native helper: the ledger's run record is authoritative (the card status can lag it).
  if (t.specialistRun) {
    switch (t.specialistRun.status) {
      case 'running': return 'running';
      case 'interrupted': return 'stopped';
      case 'failed': return 'failed';
      // A delivered report that says it failed outranks a "completed" run.
      default: return liveReport(t)?.status === 'failed' ? 'failed' : 'completed';
    }
  }
  // Native background command: its run record, once it exists.
  if (t.shellRun) {
    // Signal kills / unknown exits are stopped, not failed (native-run-facts.ts).
    return shellEndKind(t.shellRun);
  }
  if (t.status === 'failed') return 'failed';
  // Claude Code background work: only meaningful once the launch receipt landed.
  if (t.status === 'complete' && t.ccBackground) {
    switch (t.ccBackground.status) {
      case 'running': return 'running';
      case 'failed': return 'failed';
      case 'stopped': return 'stopped';
      default: return 'completed';
    }
  }
  return t.status === 'running' ? 'running' : 'completed';
}
