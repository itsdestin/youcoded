// NotifyUser — the assistant tells the person a response is ready or a
// checkpoint was reached (shared/notify-user.ts). Stateless like SendUserLink:
// it checks its input and reports; the RENDERER draws the notification card and
// relabels the conversation in the session list from the tool call itself.
//
// It can only ever produce the blue "ready" state. Nothing here can raise a
// permission-style red: that stays the app's own cards (Destin, 2026-10-26).
import { z } from 'zod';
import { defineTool } from './registry';
import {
  NOTIFY_LABEL_DESCRIPTION, NOTIFY_LABEL_MAX, NOTIFY_MESSAGE_DESCRIPTION, NOTIFY_USER_DESCRIPTION, NOTIFY_USER_TOOL,
} from '../../../shared/notify-user';

export const NotifyUserTool = defineTool({
  name: NOTIFY_USER_TOOL,
  description: NOTIFY_USER_DESCRIPTION,
  shortDescription: 'Tell the user something is ready: a short label for their conversation list and a one-line message.',
  inputSchema: z.object({
    label: z.string().min(1).describe(NOTIFY_LABEL_DESCRIPTION),
    message: z.string().min(1).describe(NOTIFY_MESSAGE_DESCRIPTION),
  }).strict(),
  // Reads and writes nothing; it only labels the conversation. No path subject.
  permissionSubject: () => undefined,
  async execute(args) {
    // An over-long label is still delivered (the pill cuts it with an ellipsis);
    // saying so lets the model keep the next one short.
    const long = args.label.trim().length > NOTIFY_LABEL_MAX;
    return { text: long ? `Notified the user. The label was cut to ${NOTIFY_LABEL_MAX} characters in their list; keep labels to two or three words.` : 'Notified the user.' };
  },
});
