// Ask first, websites (Destin, 2026-10-31): in a native conversation set to Ask first,
// the assistant asks the first time it wants to visit each new website. Yes covers that
// site for the rest of the chat; Always allow remembers it. Auto edit and Full auto never
// ask. These drive the real HarnessSession loop with the REAL mode rules + decision
// engine, so a change to either one shows up here.
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { HarnessSession, rememberedRuleFor } from '../src/main/harness/harness-session';
import { decidePermission } from '../src/main/harness/permission-engine';
import { buildChildDecide } from '../src/main/harness/specialists/child-permissions';
import { rulesForMode, DESTRUCTIVE_DENY_LIST, type NativePermissionMode, type PermissionRule } from '../src/shared/permission-types';
import { siteKeyFor } from '../src/shared/site-key';
import { WebFetchTool } from '../src/main/harness/tools/web-fetch';
import { textChunks, toolCallChunk, finishChunk, stream, scriptedModel } from './helpers/scripted-model';
import { makeOpts, fakeTool } from './helpers/harness-fakes';
import type { AskRequest, AskDecision } from '../src/main/harness/permission-broker';

/** A WebFetch whose subject is exactly the real tool's (the site), so the card, the rule
 *  and the memory all see what production sees. */
const fetchTool = () => fakeTool('WebFetch', {
  schema: z.object({ url: z.string() }),
  permissionSubject: (a: any) => WebFetchTool.permissionSubject(a),
});

/** Runs the model through `urls`, one WebFetch each, returning what was asked and run. */
async function visit(mode: NativePermissionMode, urls: string[], answer: AskDecision | ((r: AskRequest) => AskDecision) = { behavior: 'allow' }, remembered: PermissionRule[] = []) {
  const tool = fetchTool();
  const rules = [...remembered];
  const decide = async (name: string, subject: string | undefined) => decidePermission(name, subject, {
    presetRules: [], modeRules: rulesForMode(mode), denyList: DESTRUCTIVE_DENY_LIST, rememberedRules: rules,
  });
  const asked: AskRequest[] = [];
  const askUser = vi.fn(async (r: AskRequest): Promise<AskDecision> => { asked.push(r); return typeof answer === 'function' ? answer(r) : answer; });
  const model = scriptedModel([
    ...urls.map((url, i) => stream(toolCallChunk(`c${i}`, 'WebFetch', { url }), finishChunk('tool-calls'))),
    stream(...textChunks('b', 'ok'), finishChunk('stop')),
  ]);
  const session = new HarnessSession(makeOpts({ tools: [tool], decide, askUser }), async () => model as any);
  const saved: PermissionRule[] = [];
  session.on('remember-rule', (r: PermissionRule) => { saved.push(r); rules.push(r); });
  await session.send('go');
  return { asked, ran: (tool as any).calls.length as number, saved, session };
}

describe('Ask first: visiting a website', () => {
  it('asks the first time each new website comes up, naming the site', async () => {
    const r = await visit('ask', ['https://example.com/a']);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toMatchObject({ toolName: 'WebFetch', subject: 'example.com' });
    expect(r.ran).toBe(1);
  });

  it('does not ask again for the same site this chat (other pages, www., capitals), but asks for a new site', async () => {
    const r = await visit('ask', ['https://example.com/a', 'https://www.example.com/b', 'https://EXAMPLE.com/c', 'https://other.org/']);
    expect(r.asked.map((a) => a.subject)).toEqual(['example.com', 'other.org']);
    expect(r.ran).toBe(4);
  });

  it('a No stops the visit, and the next try asks again', async () => {
    const r = await visit('ask', ['https://example.com/a', 'https://example.com/b'], { behavior: 'deny' });
    expect(r.asked).toHaveLength(2);
    expect(r.ran).toBe(0);
  });

  it('Always allow remembers the SITE (not the page), and that site never asks again', async () => {
    const r = await visit('ask', ['https://www.example.com/deep/page?q=1'], { behavior: 'allow', always: true });
    expect(r.saved).toEqual([{ tool: 'WebFetch', pattern: 'example.com', action: 'allow', match: 'exact' }]);
    // a fresh chat holding that remembered rule: this site is free, another still asks
    const next = await visit('ask', ['https://example.com/x', 'https://news.example.com/'], { behavior: 'allow' }, r.saved);
    expect(next.asked.map((a) => a.subject)).toEqual(['news.example.com']);
    expect(next.ran).toBe(2);
  });

  it('the chat memory ends with the session: a resumed chat asks again', async () => {
    const r = await visit('ask', ['https://example.com/a']);
    expect(r.session.approvedSites.has('example.com')).toBe(true);
    r.session.seedHistory([]); // a resume re-seeds the history, which clears chat-only consent
    expect(r.session.approvedSites.size).toBe(0);
  });

  it.each(['auto-edit', 'full-auto'] as const)('%s never asks about websites, exactly as before', async (mode) => {
    const r = await visit(mode, ['https://example.com/a', 'https://other.org/']);
    expect(r.asked).toHaveLength(0);
    expect(r.ran).toBe(2);
  });

  it('a helper asks through the parent, and inherits the parent chat\'s approved sites', async () => {
    // The helper's decide is the parent's decide behind buildChildDecide. Its launch
    // approval (envelopeGranted) must NOT cover websites, so the ask still reaches the person.
    const rules: PermissionRule[] = [];
    const parentDecide = async (name: string, subject: string | undefined) => decidePermission(name, subject, {
      presetRules: [], modeRules: rulesForMode('ask'), denyList: DESTRUCTIVE_DENY_LIST, rememberedRules: rules,
    });
    const decide = buildChildDecide({ parentDecide, charter: 'read-only', allowedTools: ['WebFetch'], envelopeGranted: true });
    const parentSites = new Set<string>(['example.com']);
    const tool = fetchTool();
    const asked: AskRequest[] = [];
    const askUser = vi.fn(async (r: AskRequest): Promise<AskDecision> => { asked.push(r); return { behavior: 'allow' }; });
    const model = scriptedModel([
      stream(toolCallChunk('c0', 'WebFetch', { url: 'https://example.com/a' }), finishChunk('tool-calls')),
      stream(toolCallChunk('c1', 'WebFetch', { url: 'https://new-site.net/' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ]);
    const child = new HarnessSession(makeOpts({ tools: [tool], decide, askUser, isSpecialistChild: true, parentApprovedSites: () => parentSites }), async () => model as any);
    await child.send('go');
    expect(asked.map((a) => a.subject)).toEqual(['new-site.net']); // parent-approved site is free, a new one asks
    expect((tool as any).calls).toHaveLength(2);
  });
});

describe('Ask first: what a remembered website rule looks like', () => {
  it('rememberedRuleFor stores the site exactly (never a wildcard, never tool-wide)', () => {
    const subject = WebFetchTool.permissionSubject({ url: 'https://Docs.Example.com/Guide' } as any);
    expect(subject).toBe('docs.example.com');
    expect(rememberedRuleFor('WebFetch', subject, undefined)).toEqual({ tool: 'WebFetch', pattern: 'docs.example.com', action: 'allow', match: 'exact' });
  });
  it('the tool and the card agree on the site', () => {
    for (const u of ['https://www.Example.com/a', 'http://example.com:81/b']) {
      expect(WebFetchTool.permissionSubject({ url: u } as any)).toBe(siteKeyFor(u));
    }
  });
  it('an unreadable address is asked about as written and never becomes a tool-wide grant', () => {
    const subject = WebFetchTool.permissionSubject({ url: 'not a url' } as any);
    expect(subject).toBe('not a url');
    expect(rememberedRuleFor('WebFetch', subject, undefined)?.pattern).toBe('not a url');
  });
});
