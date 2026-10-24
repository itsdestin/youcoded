import { z } from 'zod';
import { defineTool } from './registry';
import type { NativeTool } from './types';

const shortText = z.string().min(1).max(512);
const edit = z.union([
  z.object({ kind: z.literal('replaceText'), find: z.string().min(1).max(20000), replace: z.string().max(20000) }).strict(),
  z.object({ kind: z.literal('writeCells'), range: shortText, values: z.array(z.array(z.union([z.string().max(20000), z.number().finite(), z.boolean(), z.null()])).max(100)).max(1000) }).strict(),
]);
const schema = z.object({
  action: z.enum(['list', 'read', 'propose', 'create', 'pending']),
  account_id: shortText.optional(), file_id: shortText.optional(),
  edits: z.array(edit).min(1).max(20).optional(), summary: z.string().min(1).max(2000).optional(),
  mode: z.enum(['original', 'copy']).optional(),
  kind: z.enum(['Doc', 'Sheet', 'Slides']).optional(), name: z.string().min(1).max(200).optional(),
  content: z.string().max(50000).optional(),
}).strict();

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is required for this action.`);
  return value;
}

export const GoogleFilesTool = defineTool<z.infer<typeof schema>>({
  name: 'GoogleFiles',
  description: 'Work with Google files explicitly attached to this conversation. list returns connected accounts and this chat’s files; read gets their current content. propose drafts text replacements in Docs/Slides or cell values in Sheets; create drafts a new Doc, Sheet or Slides file. Neither action saves anything: the user must review and approve in YouCoded. pending checks drafts waiting for that approval. Never claim an edit is saved merely because you proposed it. Other chats and unselected Drive files are inaccessible. Read before drafting edits. Spreadsheet values are literal, not formulas.',
  shortDescription: 'Read attached Google files and propose edits or new files for user approval.',
  inputSchema: schema,
  permissionSubject: () => undefined,
  untrusted: 'Google files',
  async execute(args, ctx) {
    const api = ctx.services?.googleFiles;
    if (!api) throw new Error('Google files are not available in this session.');
    ctx.signal.throwIfAborted();
    let result: unknown;
    switch (args.action) {
      case 'list': result = { accounts: await api.accounts(), files: await api.attached(ctx.sessionId) }; break;
      case 'read': result = await api.read(ctx.sessionId, required(args.account_id, 'account_id'), required(args.file_id, 'file_id')); break;
      case 'propose': result = await api.propose(ctx.sessionId, required(args.account_id, 'account_id'), required(args.file_id, 'file_id'), required(args.edits, 'edits'), required(args.summary, 'summary'), args.mode ?? 'original'); break;
      case 'create': result = await api.proposeCreate(ctx.sessionId, required(args.account_id, 'account_id'), required(args.kind, 'kind'), required(args.name, 'name'), args.content ?? ''); break;
      case 'pending': result = await api.proposals(ctx.sessionId); break;
    }
    return { text: JSON.stringify(result, null, 2) };
  },
});

/** WHY conditional: no tool on unconfigured runtimes or specialist children lacking explicit file grants. */
export function syncGoogleFilesTool(tools: Map<string, NativeTool>, enabled: boolean): void {
  if (enabled) tools.set(GoogleFilesTool.name, GoogleFilesTool);
  else tools.delete(GoogleFilesTool.name);
}
