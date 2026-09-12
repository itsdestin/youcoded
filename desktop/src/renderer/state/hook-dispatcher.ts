import { HookEvent } from '../../shared/types';
import { ChatAction } from './chat-types';

/**
 * Maps a HookEvent into a ChatAction. Now only handles permission events —
 * all other chat state comes from the transcript watcher.
 */
export function hookEventToAction(event: HookEvent): ChatAction | null {
  const { type, sessionId, payload } = event;

  switch (type) {
    case 'PermissionRequest': {
      const toolName = (payload.tool_name as string) || 'Unknown';
      const toolInput = (payload.tool_input as Record<string, unknown>) || {};
      const requestId = payload._requestId as string;
      const permissionSuggestions = payload.permission_suggestions as string[] | undefined;
      // Native broker rides denyListed along the payload (permission-broker.ts) —
      // mirror permissionSuggestions' optional-passthrough so ToolCard can gate
      // the "Always allow" consequence warning. Absent for CC hook events. Task 13.
      const denyListed = payload.denyListed as boolean | undefined;
      // Same optional-passthrough for `external`: the ask was forced by a path
      // outside the session folder, which also skips the permission rules on
      // every later call — so ToolCard must NOT offer "Always allow". Absent for
      // CC hook events. See spec 2026-08-11, finding 3.
      const external = payload.external as boolean | undefined;
      // Validate against the union rather than trusting the wire — a remote
      // peer on an older/newer build must degrade to the generic row, never
      // to a mode-shaped string the safety-stop footer misreads.
      const rawMode = payload.permissionMode;
      const permissionMode =
        rawMode === 'ask' || rawMode === 'auto-edit' || rawMode === 'full-auto' ? rawMode : undefined;

      if (!requestId) return null;

      // Specialists 1c: the broker spreads `specialist` {childId, agentType,
      // title, parentToolCallId} onto a routed child ask (permission-broker.ts).
      // Validate the shape rather than trust the wire — a payload missing the
      // child id degrades to a plain (top-level) ask, never to a mis-nested one.
      const rawSpecialist = payload.specialist as Record<string, unknown> | undefined;
      const specialist = rawSpecialist && typeof rawSpecialist.childId === 'string'
        ? {
            childId: rawSpecialist.childId,
            agentType: typeof rawSpecialist.agentType === 'string' ? rawSpecialist.agentType : 'specialist',
            title: typeof rawSpecialist.title === 'string' ? rawSpecialist.title : 'A specialist',
            parentToolCallId: typeof rawSpecialist.parentToolCallId === 'string' ? rawSpecialist.parentToolCallId : undefined,
          }
        : undefined;

      return {
        type: 'PERMISSION_REQUEST',
        sessionId,
        toolName,
        input: toolInput,
        requestId,
        permissionSuggestions: permissionSuggestions || undefined,
        denyListed: denyListed || undefined,
        external: external || undefined,
        permissionMode,
        specialist,
      };
    }

    // Specialists 1c: the child-ask-router's 5-minute hold elapsed. The ask is
    // still answerable; the nested row just tells the user the helper moved on.
    case 'PermissionHeld': {
      const requestId = payload._requestId as string;
      if (!requestId) return null;
      return { type: 'PERMISSION_HELD', sessionId, requestId };
    }

    // Remote access batch 2 (§7): the broker/relay's "this ask is no longer open"
    // signal. Until batch 2 it was a host-side purge only; a phone that never
    // saw the answer kept live-looking Yes/No buttons on a dead question.
    case 'PermissionResolved': {
      const requestId = payload._requestId as string;
      if (!requestId) return null;
      return { type: 'PERMISSION_RESOLVED_ELSEWHERE', sessionId, requestId };
    }

    case 'PermissionExpired': {
      const requestId = payload._requestId as string;
      if (!requestId) return null;
      return { type: 'PERMISSION_EXPIRED', sessionId, requestId };
    }

    default:
      return null;
  }
}
