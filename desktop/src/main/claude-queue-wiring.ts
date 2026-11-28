import type { SessionManager } from './session-manager';
import type { SessionScreens } from './session-screens';
import type { SessionRecords } from './session-record';
import type { Publish } from './publish';
import { ClaudeQueueRuntime } from './claude-queue-runtime';
import { IPC } from '../shared/backend-contract';
import { noteMilestone } from './analytics-service';
/** Shared desktop/headless wiring; root getter remains lazy until the first CLI preparation. */
export function wireClaudeQueues(manager: SessionManager, records: SessionRecords, screens: SessionScreens, publish: Publish, root: () => string): ClaudeQueueRuntime | undefined {
 const bridge=manager.claudeBridgeForQueues?.(); if(!bridge)return undefined;
 return new ClaudeQueueRuntime({userDataRoot:root,bridge,manager,inputSafe:id=>screens.queueInputSafe(id),inputBlock:id=>screens.queueInputBlock(id),waitInputSafe:(id,deadline)=>screens.waitForQueueInputSafe(id,deadline),working:id=>records.facts(id)?.working===true,
  publish:(id,body)=>publish(id,IPC.SESSION_LIVE,{sessionId:id,...body}),
  // WHY noteMilestone here (2026-11-25): chat sends in a Claude Code chat go through this queue, never the
  // `session:input` channel the setup staircase's "sent a message" step was hooked to — so the owner's dashboard
  // read 0 for nearly every Claude Code user. The queue accepting a message is the same fact native chats count.
  noteSend:(id,sendId)=>{records.noteSend(id,sendId);noteMilestone('first_message');}});
}
