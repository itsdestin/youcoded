import type { SessionManager } from './session-manager';
import type { SessionRecords } from './session-record';
import type { SessionLiveFacts } from './session-live';
import type { ClaudeControlRequest, ClaudeControlResult } from '../shared/claude-control-types';
import { recordClaudeControlResult } from './ipc/session';

/** WHY: an invoke can time out before the actual receipt; settle the existing record, never replay input. */
export function subscribeClaudeControlReceipts(manager: Pick<SessionManager, 'on' | 'off' | 'hasSession'>, records: SessionRecords, live: SessionLiveFacts): () => void {
  const settled = (id: string, request: ClaudeControlRequest, result: ClaudeControlResult) => {
    if (!manager.hasSession(id)) return;
    recordClaudeControlResult(records, id, request, result);
    live.directCommandFinished(id, request, result);
  };
  const targeted = (id: string, requestId: string, userUuid?: string | null) => {
    if (manager.hasSession(id)) live.directStopTargeted(id, requestId, userUuid);
  };
  manager.on('claude-control-stop-targeted', targeted);
  manager.on('claude-control-settled', settled);
  return () => {
    manager.off('claude-control-stop-targeted', targeted);
    manager.off('claude-control-settled', settled);
  };
}
