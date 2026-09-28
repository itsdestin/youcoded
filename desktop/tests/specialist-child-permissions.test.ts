// Child permission composition (plan 1a, Task 5). A specialist child's decide()
// is the PARENT's decide with two caps stacked on top — the definition's tool
// allowlist and its charter — plus the launch envelope, which converts the
// parent's "ask" into an allow because the user already consented at spawn time.
// Strictest wins: a cap can only ever narrow what the parent would have allowed.
import { describe, it, expect, vi } from 'vitest';
import { buildChildDecide } from '../src/main/harness/specialists/child-permissions';
import { resolveSpecialist } from '../src/main/harness/specialists/registry';
import type { PermissionDecision } from '../src/shared/permission-types';

const allow: PermissionDecision = { action: 'allow', denyListed: false };
const deny: PermissionDecision = { action: 'deny', denyListed: false, message: 'parent said no' };
const ask: PermissionDecision = { action: 'ask', denyListed: false };

describe('buildChildDecide', () => {
  it('a tool outside allowedTools is refused outright, not asked', async () => {
    const decide = buildChildDecide({
      parentDecide: async () => allow,
      charter: 'read-only', allowedTools: ['Read'], envelopeGranted: true,
    });
    const d = await decide('Write', '/w/x.ts');
    expect(d.action).toBe('deny');
    expect(d.message).toMatch(/not available to this specialist/i);
  });

  it('a write tool under a read-only charter is refused even if listed', async () => {
    const decide = buildChildDecide({
      parentDecide: async () => allow,
      charter: 'read-only', allowedTools: ['Write'], envelopeGranted: true,
    });
    const d = await decide('Write', '/w/x.ts');
    expect(d.action).toBe('deny');
    expect(d.message).toMatch(/read-only/i);
  });

  it('parent DENY always wins over the envelope, message passed through', async () => {
    const decide = buildChildDecide({
      parentDecide: async () => deny,
      charter: 'read-write', allowedTools: ['Write'], envelopeGranted: true,
    });
    const d = await decide('Write', '/w/x.ts');
    expect(d.action).toBe('deny');
    expect(d.message).toBe('parent said no');
  });

  it('inside the envelope, an in-charter tool the parent would ASK about is allowed', async () => {
    const decide = buildChildDecide({
      parentDecide: async () => ask,
      charter: 'read-write', allowedTools: ['Write'], envelopeGranted: true,
    });
    expect((await decide('Write', '/w/x.ts')).action).toBe('allow');  // envelope consent, spec §5
  });

  // --- the rest of the decide order (same table, the cases the brief's four don't cover) ---

  it('without an envelope the parent ASK passes through unchanged — the child never silently escalates', async () => {
    const decide = buildChildDecide({
      parentDecide: async () => ask,
      charter: 'read-write', allowedTools: ['Write'], envelopeGranted: false,
    });
    expect((await decide('Write', '/w/x.ts')).action).toBe('ask');
  });

  it('a parent ALLOW for an in-charter, in-list tool is allowed', async () => {
    const decide = buildChildDecide({
      parentDecide: async () => allow,
      charter: 'read-only', allowedTools: ['Read'], envelopeGranted: true,
    });
    expect((await decide('Read', '/w/x.ts')).action).toBe('allow');
  });

  it('Bash counts as a write tool — a read-only specialist cannot shell out', async () => {
    const decide = buildChildDecide({
      parentDecide: async () => allow,
      charter: 'read-only', allowedTools: ['Bash'], envelopeGranted: true,
    });
    const d = await decide('Bash', 'rm -rf /');
    expect(d.action).toBe('deny');
    expect(d.message).toMatch(/read-only/i);
  });

  it('a read-write charter may use Write/Edit/Bash when they are listed', async () => {
    const decide = buildChildDecide({
      parentDecide: async () => allow,
      charter: 'read-write', allowedTools: ['Write', 'Edit', 'Bash'], envelopeGranted: true,
    });
    for (const tool of ['Write', 'Edit', 'Bash']) {
      expect((await decide(tool, '/w/x.ts')).action).toBe('allow');
    }
  });

  it('the built-in Worker effective toolset permits Bash companions but never overrides a parent deny or floor ask', async () => {
    const worker = resolveSpecialist('worker')!;
    const effective = [...worker.allowedTools, 'BashOutput', 'KillShell'];
    const parentDecide = vi.fn(async (tool: string): Promise<PermissionDecision> =>
      tool === 'KillShell' ? deny : tool === 'Bash' ? { action: 'ask', denyListed: true } : allow);
    const decide = buildChildDecide({ parentDecide, charter: worker.charter, allowedTools: effective, envelopeGranted: true });
    expect((await decide('BashOutput', undefined)).action).toBe('allow');
    expect(await decide('KillShell', undefined)).toEqual(deny);
    expect(await decide('Bash', 'rm -rf /')).toEqual({ action: 'ask', denyListed: true });
    const allAllowed = buildChildDecide({ parentDecide: async () => allow, charter: worker.charter, allowedTools: effective, envelopeGranted: true });
    for (const name of ['Bash', 'BashOutput', 'KillShell']) expect((await allAllowed(name, undefined)).action).toBe('allow');
    expect(worker.allowedTools).not.toContain('BashOutput');
  });

  it('without Bash, read-only definitions never receive its background companions', async () => {
    const explorer = resolveSpecialist('explorer')!;
    const parentDecide = vi.fn(async () => allow);
    const decide = buildChildDecide({ parentDecide, charter: explorer.charter, allowedTools: explorer.allowedTools, envelopeGranted: true });
    for (const name of ['Bash', 'BashOutput', 'KillShell']) expect((await decide(name, undefined)).action).toBe('deny');
    expect(parentDecide).not.toHaveBeenCalled();
    // Even a malformed read-only definition explicitly listing Bash cannot use it.
    const capped = buildChildDecide({ parentDecide: async () => allow, charter: 'read-only', allowedTools: ['Bash'], envelopeGranted: true });
    expect((await capped('Bash', 'pwd')).action).toBe('deny');
  });

  it('the two caps short-circuit BEFORE the parent is consulted — a refused tool costs no parent lookup', async () => {
    // WHY this matters beyond tidiness: parentDecide reads the remembered-rule
    // store (disk I/O). A tool the child may never call must not touch it.
    const parentDecide = vi.fn(async () => allow);
    const decide = buildChildDecide({ parentDecide, charter: 'read-only', allowedTools: ['Read'], envelopeGranted: true });
    await decide('Write', '/w/x.ts');   // out of list
    await decide('Bash', 'ls');         // out of list
    expect(parentDecide).not.toHaveBeenCalled();
  });

  it('a deny-listed ask inside a granted envelope ROUTES to the parent and is denied only by timeout', async () => {
    // Task 8 flip: launch consent still covers the charter of work, not
    // `rm -rf` / `git push` / `sudo` — but a specialist no longer hard-denies
    // this itself. It passes the parent's 'ask' straight through UNCHANGED so
    // childAskRouter can carry it to a REAL user via the parent's card; the
    // envelope branch below (6/7) never gets a chance to silently convert it
    // into an allow because this branch still runs BEFORE it.
    const decide = buildChildDecide({
      parentDecide: async () => ({ action: 'ask', denyListed: true }),
      charter: 'read-write', allowedTools: ['Bash'], envelopeGranted: true,
    });
    const d = await decide('Bash', 'rm -rf /');
    expect(d.action).toBe('ask');
    expect(d.denyListed).toBe(true);
  });

  it('the refusal names the tools the specialist DOES have — a dead end becomes a next step', async () => {
    const decide = buildChildDecide({
      parentDecide: async () => allow,
      charter: 'read-only', allowedTools: ['Read', 'Glob', 'Grep'], envelopeGranted: true,
    });
    const d = await decide('Write', '/w/x.ts');
    expect(d.message).toMatch(/Read, Glob, Grep/);
  });
});
