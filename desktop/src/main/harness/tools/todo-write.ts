import { z } from 'zod';
import { defineTool } from './registry';

export const TodoWriteTool = defineTool({
  name: 'TodoWrite',
  // Pause handoff §1 (WHY): changes this computer only, so a plan restart checks first.
  effect: 'local',
  description: 'Replace your task list. Use it to plan multi-step work and mark progress (pending / in_progress / completed).',
  // Compact form for small local models (simplified presentation, spec §4.2).
  shortDescription: 'Replace your task list to plan and track multi-step work.',
  inputSchema: z.object({
    todos: z.array(
      z.object({
        content: z.string(),
        status: z.enum(['pending', 'in_progress', 'completed']),
        activeForm: z.string(),
      }),
    ),
  }).strict(), // .strict(): an unknown parameter is an error the model can fix, never silently dropped (ledger D-2)
  permissionSubject: () => undefined,
  async execute(args, ctx) {
    ctx.todos.length = 0;
    ctx.todos.push(...args.todos);
    const done = args.todos.filter((t) => t.status === 'completed').length;
    return { text: `Todo list updated: ${args.todos.length} items, ${done} completed.` };
  },
});
