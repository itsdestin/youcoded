import type { SessionManager } from './session-manager';
import type { SessionScreens } from './session-screens';
import type { SessionRecords } from './session-record';
import type { Publish } from './publish';
import { ClaudeQueueRuntime } from './claude-queue-runtime';
import { IPC } from '../shared/backend-contract';
/** Shared desktop/headless wiring; root getter remains lazy until the first CLI preparation. */
export function wireClaudeQueues(manager: SessionManager, records: SessionRecords, screens: SessionScreens, publish: Publish, root: () => string): ClaudeQueueRuntime | undefined {
 const bridge=manager.claudeBridgeForQueues?.(); if(!bridge)return undefined;
 return new ClaudeQueueRuntime({userDataRoot:root,bridge,manager,inputSafe:id=>screens.queueInputSafe(id),waitInputSafe:(id,deadline)=>screens.waitForQueueInputSafe(id,deadline),working:id=>records.facts(id)?.working===true,
  publish:(id,body)=>publish(id,IPC.SESSION_LIVE,{sessionId:id,...body}),noteSend:(id,sendId)=>records.noteSend(id,sendId)});
}
