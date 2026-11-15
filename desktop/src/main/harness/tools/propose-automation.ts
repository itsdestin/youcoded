// ProposeAutomation — the assistant proposing an automation from a chat on one of the app's own models
// (pages-finish step 4). Stateless, like SendUserLink: it checks nothing and saves nothing. The app sees
// this call in the chat and shows the person the "Check this automation" popup
// (main/automations/propose.ts); only their Turn on there saves anything.
//
// The words and input shape are shared with the Claude Code tool (shared/propose-automation.ts), so the
// assistant behaves the same in both kinds of chat.
import { z } from 'zod';
import { defineTool } from './registry';
import { PROPOSE_AUTOMATION_DESCRIPTION, PROPOSE_AUTOMATION_TOOL } from '../../../shared/propose-automation';

export const ProposeAutomationTool = defineTool({
  name: PROPOSE_AUTOMATION_TOOL,
  description: PROPOSE_AUTOMATION_DESCRIPTION,
  shortDescription: 'Propose an automation (a job on a schedule, a page button or a page event). The person checks it in a popup; nothing runs until they turn it on.',
  // Mirrors PROPOSE_AUTOMATION_INPUT_SCHEMA field for field; the app re-checks every value when it builds the draft.
  inputSchema: z.object({
    name: z.string().describe('A short name, as the person would say it.'),
    instruction: z.string().describe('The whole task, in plain words.'),
    start: z.object({
      kind: z.enum(['schedule', 'button', 'event']),
      every: z.enum(['hour', 'day', 'weekday', 'week']).optional().describe('schedule only.'),
      at: z.string().optional().describe('schedule only (not hourly): 24-hour time, "7:00".'),
      day: z.string().optional().describe('weekly only: the day name.'),
      hours: z.number().optional().describe('hourly only: every this many hours.'),
      label: z.string().optional().describe('button only: the words on the page button.'),
      event: z.string().optional().describe('event only: the page event name.'),
    }).strict().describe('When it runs.'),
    page: z.string().optional().describe('The id or name of the page it belongs to, when it uses a page or is started from one.'),
    permissions: z.array(z.object({
      kind: z.enum(['folder', 'command', 'site', 'page-read', 'page-write']),
      mode: z.enum(['allow', 'ask']).describe('"allow" = always allowed; "ask" = the person is asked each time.'),
      folder: z.string().optional().describe('folder only, e.g. "~/Downloads".'),
      change: z.boolean().optional().describe('folder only: true if it may change files; false = look only.'),
      command: z.string().optional().describe('command only: the exact command; * for the part that changes.'),
      label: z.string().optional().describe('command only: what it does, in a few plain words.'),
      site: z.string().optional().describe('site only, e.g. "bestbuy.com".'),
    }).strict()).optional().describe('What it may do. Leave out anything it does not need.'),
  }).strict(),
  // Shows a popup; changes nothing. No path subject, so no permission question either.
  permissionSubject: () => undefined,
  async execute() {
    return { text: 'The person is now being shown this automation to check. Nothing is saved or running until they press Turn on. Tell them it is ready for them to check; do not say it is set up.' };
  },
});
