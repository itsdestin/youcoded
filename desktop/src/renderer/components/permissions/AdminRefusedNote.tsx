import React from 'react';
import type { ToolCallState } from '../../../shared/types';
import { Callout } from '../ui';
import { ADMIN_REFUSED_CARD_LINE, ADMIN_REFUSED_MODEL_MARKER } from '../../../shared/admin-password-copy';

/** Never fail silently (2026-09-26): YouCoded turned down an admin password
 *  request from this command. The note lives in the command's saved result
 *  (so it survives reloads and reaches a phone); the card says it plainly. */
export function AdminRefusedNote({ tool }: { tool: ToolCallState }) {
  // A failed command's text is saved in `error`, a successful one's in `response`
  // — sudo refused usually means the command failed, so both must be read.
  const saved = `${tool.response ?? ''}\n${tool.error ?? ''}`;
  if (tool.toolName !== 'Bash' || !saved.includes(ADMIN_REFUSED_MODEL_MARKER)) return null;
  return (
    <div className="px-3 py-2 border-t border-edge" data-testid="admin-refused-note">
      <Callout tone="warning">{ADMIN_REFUSED_CARD_LINE}</Callout>
    </div>
  );
}
