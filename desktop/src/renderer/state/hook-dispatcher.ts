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

      if (!requestId) return null;

      return {
        type: 'PERMISSION_REQUEST',
        sessionId,
        toolName,
        input: toolInput,
        requestId,
        permissionSuggestions: permissionSuggestions || undefined,
      };
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
