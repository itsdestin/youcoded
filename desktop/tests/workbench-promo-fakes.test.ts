// The promo video's three dev-only fakes. None of this ships: mock-shim.ts is
// the workbench's fake backend. Each `describe` pins one URL/global switch.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Workbook } from 'exceljs';

// Same construction as workbench-shim-semantics.test.ts, but the module is
// re-imported per test because the URL switches are read at module scope.
async function shim(search = '') {
  vi.resetModules();
  vi.stubGlobal('location', { search });
  const { createStore } = await import('../src/renderer/dev/workbench/mock-store');
  const { createMockShim } = await import('../src/renderer/dev/workbench/mock-shim');
  return createMockShim(createStore('site')) as any;
}

async function rows(base64: string): Promise<string[][]> {
  const wb = new Workbook();
  // Fix: Node's Buffer.from(...) is typed Buffer<ArrayBuffer>, which exceljs's
  // declared xlsx.load(Buffer) signature rejects under tsconfig.tests.json's
  // stricter Node types (same mismatch XlsxView.tsx works around with `.buffer as any`).
  await wb.xlsx.load(Buffer.from(base64, 'base64') as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  const out: string[][] = [];
  ws.eachRow((r) => out.push((r.values as unknown[]).slice(1).map((v) => String(v ?? ''))));
  return out;
}

describe('spreadsheet bytes', () => {
  beforeEach(() => { delete (globalThis as any).__workbenchSheet; });

  it('serves an .xlsx for the site session and the "before" sheet is unsorted with no total', async () => {
    const c = await shim('?scenario=site');
    const r = await c.artifacts.readBinary('/home/you/Documents/Q3-sales.xlsx');
    expect(r.ok).toBe(true);
    expect(r.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const rs = await rows(r.base64);
    expect(rs[0]).toEqual(['Region', 'Rep', 'Amount', 'Month']);
    const amounts = rs.slice(1).map((x) => Number(x[2]));
    expect(amounts.length).toBe(15);
    expect([...amounts].sort((a, b) => b - a)).not.toEqual(amounts);
    expect(rs.some((x) => x[0] === 'Total')).toBe(false);
  });

  it('serves the "after" sheet when __workbenchSheet is "after": sorted by amount, with a Total row', async () => {
    (globalThis as any).__workbenchSheet = 'after';
    const c = await shim('?scenario=site');
    const r = await c.artifacts.readBinary('/home/you/Documents/Q3-sales.xlsx');
    const rs = await rows(r.base64);
    const body = rs.slice(1, -1);
    const amounts = body.map((x) => Number(x[2]));
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    expect(rs.at(-1)?.[0]).toBe('Total');
    expect(Number(rs.at(-1)?.[2])).toBe(amounts.reduce((a, b) => a + b, 0));
  });
});

describe('remote access fake', () => {
  it('is untouched without ?remote= (catch-all answers [])', async () => {
    const c = await shim('');
    expect(await c.remote.getConfig()).toEqual([]);
  });
  it('?remote=setup renders the QR state: enabled, password set, Tailscale url, no clients', async () => {
    const c = await shim('?remote=setup');
    const cfg = await c.remote.getConfig();
    expect(cfg).toMatchObject({ enabled: true, hasPassword: true, clientCount: 0 });
    const ts = await c.remote.detectTailscale();
    expect(ts).toMatchObject({ installed: true, connected: true });
    expect(ts.url).toMatch(/^https?:\/\//);
    expect(await c.remote.getClientList()).toEqual([]);
  });
  it('?remote=connected lists one phone', async () => {
    const c = await shim('?remote=connected');
    const cls = await c.remote.getClientList();
    expect(cls).toHaveLength(1);
    expect(cls[0]).toMatchObject({ id: expect.any(String), ip: expect.any(String), connectedAt: expect.any(Number) });
    expect((await c.remote.getConfig()).clientCount).toBe(1);
    expect(await c.remote.getClientCount()).toBe(1);
  });
  it('getStatus carries clientCount as a number, the shape the desktop answer and the socket give (audit W18)', async () => {
    const c = await shim('?remote=connected');
    const st = await c.remote.getStatus();
    expect(st).toMatchObject({ state: expect.any(String), port: expect.any(Number), clientCount: 1 });
  });
});

describe('takeover (lease) fake', () => {
  it('reports no holder without ?lease=', async () => {
    const c = await shim('?scenario=site');
    expect(await c.syncSpaces.leaseQuery('any')).toEqual({ held: false });
  });
  it('?lease=held:Pixel%209 reports another device and lets the takeover succeed', async () => {
    const c = await shim('?scenario=site&lease=held%3APixel%209');
    expect(await c.syncSpaces.leaseQuery('wb-past-1')).toEqual({ held: true, device: 'Pixel 9', self: false, source: 'workbench' });
    expect(await c.syncSpaces.leaseTakeover('wb-past-1')).toEqual({ outcome: 'acquired' });
    expect(await c.syncSpaces.leaseForce('wb-past-1')).toEqual({ ok: true });
  });
});

describe('model favourites fake', () => {
  // ModelPicker keeps favourites in localStorage (no IPC); the shim seeds four
  // models from four companies when the key is absent, and never overwrites.
  const fakeStorage = (initial: Record<string, string> = {}) => {
    const m = new Map(Object.entries(initial));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, map: m };
  };

  it('seeds Claude, DeepSeek, Grok and GPT favourites on a fresh origin, all resolving to catalog rows', async () => {
    const ls = fakeStorage();
    vi.stubGlobal('localStorage', ls);
    const c = await shim('?scenario=site&student=1');
    const favs: string[] = JSON.parse(ls.map.get('youcoded-model-favorites')!);
    const catalog: { id: string; providerId: string }[] = await c.providers.catalog();
    const keys = new Set(catalog.map((m) => `${m.providerId}:${m.id}`));
    for (const f of favs) expect(keys.has(f)).toBe(true);
    const labels = catalog.filter((m) => favs.includes(`${m.providerId}:${m.id}`)).map((m) => m.id);
    expect(labels).toEqual(expect.arrayContaining(['anthropic/claude-sonnet-4-6', 'deepseek/deepseek-v3.2', 'x-ai/grok-4', 'openai/gpt-5']));
    vi.unstubAllGlobals();
  });

  it('never overwrites favourites the reviewer already has', async () => {
    const ls = fakeStorage({ 'youcoded-model-favorites': '["local:llama3.1:8b"]' });
    vi.stubGlobal('localStorage', ls);
    await shim('?scenario=site');
    expect(ls.map.get('youcoded-model-favorites')).toBe('["local:llama3.1:8b"]');
    vi.unstubAllGlobals();
  });

  it('prices nothing: no catalog row carries a price, cost or free tag', async () => {
    const c = await shim('?scenario=site');
    for (const row of await c.providers.catalog()) {
      expect(JSON.stringify(row).toLowerCase()).not.toMatch(/price|cost|free/);
    }
  });
});

describe('marketplace install sticks (dev-only)', () => {
  it('Install adds Remember to the installed list, the packages map and the chip row; uninstall reverses all three', async () => {
    const c = await shim('?scenario=site&student=1');
    const before = await c.skills.list();
    expect(before.some((s: any) => s.id === 'remember')).toBe(false);
    expect((await c.skills.getChips()).some((x: any) => x.label === 'Remember')).toBe(false);

    await c.skills.install('remember');
    const after = await c.skills.list();
    expect(after.some((s: any) => s.id === 'remember' && s.displayName === 'Remember')).toBe(true);
    expect((await c.marketplace.getPackages()).remember?.status).toBe('installed');
    expect((await c.skills.getChips()).filter((x: any) => x.label === 'Remember')).toHaveLength(1);
    // Idempotent: a second install never doubles anything.
    await c.skills.install('remember');
    expect((await c.skills.getChips()).filter((x: any) => x.label === 'Remember')).toHaveLength(1);

    await c.skills.uninstall('remember');
    expect((await c.skills.list()).some((s: any) => s.id === 'remember')).toBe(false);
    expect((await c.marketplace.getPackages()).remember).toBeUndefined();
    expect((await c.skills.getChips()).some((x: any) => x.label === 'Remember')).toBe(false);
  });

  it('leaves the catalog (and its ratings) untouched by an install', async () => {
    const c = await shim('?scenario=site');
    const a = JSON.stringify(await c.skills.listMarketplace());
    await c.skills.install('remember');
    expect(JSON.stringify(await c.skills.listMarketplace())).toBe(a);
  });
});

describe('student project (student=1)', () => {
  it('lists Econ 201 first with files, two conversations and a context note; off, the developer projects are unchanged', async () => {
    const c = await shim('?scenario=site&student=1');
    const { projects } = await c.artifacts.listProjectsIndex({ withCounts: true });
    expect(projects[0].name).toBe('Econ 201');
    expect(projects[0].description).toMatch(/Microeconomics/);
    expect(projects[0].conversationCount).toBe(2);
    const { files } = await c.artifacts.listAllFiles(projects[0].id);
    const names = files.map((f: any) => f.path);
    expect(names).toEqual(expect.arrayContaining(['Q3-sales.xlsx', 'syllabus.md']));
    expect(names.some((n: string) => n.startsWith('lecture notes/'))).toBe(true);
    const { conversations } = await c.project.listConversations(projects[0].path);
    expect(conversations.map((x: any) => x.name).sort()).toEqual(['econ midterm brief', 'econ study guide']);
    const { groups } = await c.project.listContext(projects[0].path);
    const text = JSON.stringify(groups);
    expect(text).toContain('Second-year student. Keep explanations short.');
    expect(text).not.toMatch(/CLAUDE\.md|react-renderer/);
    // The drawer of any student session lists the spreadsheet.
    const { artifacts } = await c.artifacts.listSession('wb-new-1');
    expect(artifacts.map((a: any) => a.path)).toContain('Q3-sales.xlsx');

    const plain = await shim('?scenario=site');
    expect((await plain.artifacts.listProjectsIndex()).projects[0].name).toBe('youcoded');
    expect((await plain.artifacts.listSession('wb-new-1')).artifacts.map((a: any) => a.path)).not.toContain('Q3-sales.xlsx');
  });
});

describe('resumed history (phone takeover)', () => {
  it('answers the first page of a resumed "econ midterm brief" with the briefing as finished history', async () => {
    const c = await shim('?scenario=site&student=1&lease=held%3ADesktop');
    expect(await c.syncSpaces.leaseQuery('wb-past-0')).toMatchObject({ held: true, device: 'Desktop' });
    const page = await c.detach.requestTranscriptPage({ sessionId: 'wb-new-1', beforeCursor: null, claudeSessionId: 'wb-past-0', projectSlug: 'Econ 201' });
    expect(page.hasMore).toBe(false);
    expect(page.events[0]).toMatchObject({ type: 'user-message', sessionId: 'wb-new-1', data: { text: "brief me on tomorrow's econ midterm" } });
    expect(page.events.some((e: any) => e.type === 'assistant-text' && /brief/i.test(e.data.text))).toBe(true);
    expect(page.events.at(-1).type).toBe('turn-complete');
    // App's first ask carries no locator (App.tsx loads a first page for every
    // session it knows); a session created by a resume still answers it.
    const created = await c.session.create({ name: 'Resuming...', cwd: '/home/you/School/Econ 201', resumeSessionId: 'wb-past-0' });
    const bare = await c.detach.requestTranscriptPage({ sessionId: created.id, beforeCursor: null });
    expect(bare.events.length).toBe(page.events.length);
  });
  it('is an honest empty page for any other session, and outside student mode', async () => {
    const c = await shim('?scenario=site&student=1');
    expect(await c.detach.requestTranscriptPage({ sessionId: 'x', beforeCursor: null, claudeSessionId: 'wb-past-1' })).toEqual({ events: [], cursor: null, hasMore: false });
    const plain = await shim('?scenario=site');
    expect((await plain.detach.requestTranscriptPage({ sessionId: 'x', beforeCursor: null, claudeSessionId: 'wb-past-0' })).events).toEqual([]);
  });
});

describe('resuming a Resume row in the workbench', () => {
  it('names the new session after the row and sends the first hook event that lifts "Initializing session…"', async () => {
    const c = await shim('?scenario=site&student=1');
    const hooks: any[] = [];
    c.on.hookEvent((e: any) => hooks.push(e));
    const created = await c.session.create({ name: 'Resuming...', cwd: '/home/you/School/Econ 201', resumeSessionId: 'wb-past-0' });
    expect(created.name).toBe('econ midterm brief');
    await new Promise((r) => setTimeout(r, 120));
    expect(hooks).toEqual([expect.objectContaining({ type: 'SessionStart', sessionId: created.id })]);
    // A plain create is untouched: no hook, the given name.
    const plain = await c.session.create({ name: 'fresh', cwd: '/home/you' });
    await new Promise((r) => setTimeout(r, 120));
    expect(plain.name).toBe('fresh');
    expect(hooks).toHaveLength(1);
  });
});
