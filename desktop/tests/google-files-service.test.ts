import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import { GoogleFilesService } from '../src/main/google-files/google-files-service';

const scope = 'https://www.googleapis.com/auth/drive.file';
let dir: string;
let service: GoogleFilesService;
let browser: string;
let revision: string;
let kind: 'document' | 'spreadsheet' | 'presentation';
let sheetValue: string;
let calls: { url: string; init?: RequestInit }[];
const vault = new Map<string, string>();
let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;
const metadata = (id = 'doc') => ({ id, name: 'A document', mimeType: `application/vnd.google-apps.${kind}`, capabilities: { canEdit: true, canCopy: true }, version: revision });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'google-files-test-'));
  await fs.writeFile(path.join(dir, 'client.json'), JSON.stringify({ installed: { client_id: 'test-client', client_secret: 'desktop-secret' } }));
  vault.clear(); browser = ''; revision = 'r1'; kind = 'document'; sheetValue = 'old'; calls = [];
  mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'PRIVATE-ACCESS', refresh_token: 'PRIVATE-REFRESH', expires_in: 3600, scope });
    if (url.includes('/about?')) return json({ user: { permissionId: 'person1', emailAddress: 'one@example.com', displayName: 'One' } });
    if (init?.method === 'POST' && /\/(documents|spreadsheets|presentations)$/.test(url)) return json({ documentId: 'created', spreadsheetId: 'created', presentationId: 'created', sheets: [{ properties: { title: 'Sheet 1' } }] });
    if (url.includes('/values/')) return json({ values: [[sheetValue]] });
    if (url.includes('/values:batchUpdate')) {
      const body = JSON.parse(String(init?.body));
      return json({ spreadsheetId: url.includes('/copied/') ? 'copied' : 'doc', responses: body.data.map((r: { range: string }) => ({ updatedRange: r.range })) });
    }
    if (url.includes(':batchUpdate')) return json({});
    if (url.includes('/copy')) return json(metadata('copied'));
    if (url.includes('slides.googleapis.com')) return json({ revisionId: revision, presentationId: url.includes('/copied') ? 'copied' : 'doc', slides: [{ objectId: url.includes('/copied') ? 'copy-slide' : 'source-slide', pageElements: [{ objectId: url.includes('/copied') ? 'copy-shape' : 'source-shape', shape: { text: { textElements: [{ textRun: { text: 'Hello world' } }] } } }] }] });
    if (url.includes('docs.googleapis.com')) return json({ revisionId: revision, body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Hello world' } }] } }] } });
    return json(metadata(url.includes('/copied') ? 'copied' : url.includes('/created') ? 'created' : 'doc'));
  });
  service = new GoogleFilesService({ userDataDir: dir, clientFile: path.join(dir, 'client.json'),
    secrets: { assertAvailable: async () => {}, get: async ref => vault.get(ref) ?? null, set: async (value, ref) => { const key = ref ?? 'secret-ref'; vault.set(key, value); return key; }, delete: async ref => { vault.delete(ref); } },
    openExternal: async url => { browser = url; }, fetch: mockFetch as typeof fetch });
});
afterEach(async () => { await service.dispose(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
async function connected() {
  const { flowId } = await service.beginAuth();
  const url = new URL(browser);
  const callback = new URL(url.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', url.searchParams.get('state')!);
  callback.searchParams.set('code', 'private-code'); callback.searchParams.set('picked_file_ids', 'doc');
  await fetch(callback);
  await vi.waitFor(async () => { expect((await service.authState(flowId)).state).not.toBe('pending'); });
  const state = await service.authState(flowId); expect(state.state).toBe('complete');
  const exchangeCall = calls.find(c => c.url.includes('/token'))!;
  const fields = new URLSearchParams(String(exchangeCall.init?.body));
  expect(fields.get('client_secret')).toBe('desktop-secret'); expect(fields.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'));
  expect(createHash('sha256').update(fields.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
  return state;
}
describe('Google files secure service', () => {
  it('uses only drive.file, PKCE, consent and the system-browser Picker', async () => {
    const { flowId } = await service.beginAuth(); const url = new URL(browser);
    expect(url.origin).toBe('https://accounts.google.com'); expect(url.searchParams.get('scope')).toBe(scope);
    expect(url.searchParams.get('prompt')).toBe('consent'); expect(url.searchParams.get('trigger_onepick')).toBe('true');
    expect(url.searchParams.get('allow_multiple')).toBe('true'); expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')!.length).toBeGreaterThan(30); expect(url.searchParams.get('code_challenge')!.length).toBe(43);
    await service.cancelAuth(flowId); expect((await service.authState(flowId)).state).toBe('error');
  });
  it('rejects bad callback method/path/state/duplicate code without exchanging a token', async () => {
    await service.beginAuth(); const url = new URL(browser); const callback = new URL(url.searchParams.get('redirect_uri')!);
    expect((await fetch(callback, { method: 'POST' })).status).toBe(400);
    expect((await fetch(new URL('/wrong', callback))).status).toBe(400);
    callback.searchParams.set('state', 'wrong'); callback.searchParams.set('code', 'a');
    expect((await fetch(callback)).status).toBe(400);
    callback.searchParams.set('state', url.searchParams.get('state')!); callback.searchParams.append('code', 'b');
    expect((await fetch(callback)).status).toBe(400); expect(mockFetch).not.toHaveBeenCalled();
  });
  it('persists metadata and secretRef, never tokens, and restores session attachments', async () => {
    const state = await connected(); expect(JSON.stringify(state)).not.toContain('PRIVATE');
    await service.attach('chat1', 'person1', ['doc']);
    const raw = await fs.readFile(path.join(dir, 'google-files.json'), 'utf8');
    expect(raw).toContain('secret-ref'); expect(raw).not.toMatch(/PRIVATE|desktop-secret|private-code/);
    expect(await service.attached('chat1')).toHaveLength(1); expect(await service.attached('chat2')).toEqual([]);
    expect(vault.size).toBe(1);
  });
  it('denies other chats, accounts and ungranted files', async () => {
    await connected(); await service.attach('chat1', 'person1', ['doc']);
    await expect(service.read('chat2', 'person1', 'doc')).rejects.toThrow();
    await expect(service.read('chat1', 'person2', 'doc')).rejects.toThrow();
    await expect(service.attach('chat1', 'person1', ['unknown'])).rejects.toThrow();
  });
  it('proposes without Google writes, approves exactly once with required revision', async () => {
    await connected(); await service.attach('chat1', 'person1', ['doc']); calls = [];
    const p = await service.propose('chat1', 'person1', 'doc', [{ kind: 'replaceText', find: 'Hello', replace: 'Goodbye' }], 'Change greeting');
    expect(calls.every(c => !c.init?.method || c.init.method === 'GET')).toBe(true);
    const results = await Promise.allSettled([service.approve('chat1', p.id), service.approve('chat1', p.id)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const writes = calls.filter(c => c.url.includes(':batchUpdate')); expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0].init?.body)).writeControl).toEqual({ requiredRevisionId: 'r1' });
    await expect(service.approve('chat1', p.id)).rejects.toThrow();
  });
  it('refuses stale proposals and detached files without writes', async () => {
    await connected(); await service.attach('chat1', 'person1', ['doc']);
    const p = await service.propose('chat1', 'person1', 'doc', [{ kind: 'replaceText', find: 'Hello', replace: 'Bye' }], 'Change'); revision = 'r2';
    await expect(service.approve('chat1', p.id)).rejects.toThrow(/changed/i);
    expect(calls.filter(c => c.url.includes(':batchUpdate'))).toHaveLength(0);
    await service.detach('chat1', 'person1', 'doc'); expect(await service.proposals('chat1')).toEqual([]);
  });
  it('copies only after approval and edits the copy under the same account', async () => {
    await connected(); await service.attach('chat1', 'person1', ['doc']);
    const p = await service.propose('chat1', 'person1', 'doc', [{ kind: 'replaceText', find: 'Hello', replace: 'Bye' }], 'Change', 'copy');
    expect(calls.some(c => c.url.includes('/copy'))).toBe(false);
    const file = await service.approve('chat1', p.id); expect(file.id).toBe('copied'); expect(file.accountId).toBe('person1');
    expect(calls.find(c => c.url.includes(':batchUpdate'))?.url).toContain('/copied:batchUpdate');
  });
  it.each(['original', 'copy'] as const)('allows choosing %s at approval without changing the proposal', async mode => {
    await connected(); await service.attach('chat1', 'person1', ['doc']);
    const p = await service.propose('chat1', 'person1', 'doc', [{ kind: 'replaceText', find: 'Hello', replace: 'Hi' }], 'Replace', mode === 'copy' ? 'original' : 'copy');
    calls = []; const file = await service.approve('chat1', p.id, mode);
    expect(file.id).toBe(mode === 'copy' ? 'copied' : 'doc');
    expect(calls.filter(c => c.url.includes('/copy'))).toHaveLength(mode === 'copy' ? 1 : 0);
    expect(JSON.parse(String(calls.find(c => c.url.includes(':batchUpdate'))?.init?.body)).writeControl.requiredRevisionId).toBe('r1');
  });
  it('keeps the original stale snapshot when approval switches to copy', async () => {
    await connected(); await service.attach('chat1', 'person1', ['doc']);
    const p = await service.propose('chat1', 'person1', 'doc', [{ kind: 'replaceText', find: 'Hello', replace: 'Hi' }], 'Replace');
    revision = 'r2'; calls = [];
    await expect(service.approve('chat1', p.id, 'copy')).rejects.toThrow(/changed/i);
    expect(calls.some(c => c.init?.method === 'POST' || c.init?.method === 'PUT')).toBe(false);
  });
  it('validates approval mode and fresh capability before any write', async () => {
    await connected(); await service.attach('chat1', 'person1', ['doc']);
    const edit = [{ kind: 'replaceText' as const, find: 'Hello', replace: 'Hi' }];
    const invalid = await service.propose('chat1', 'person1', 'doc', edit, 'Replace');
    calls = []; await expect(service.approve('chat1', invalid.id, 'invalid' as 'copy')).rejects.toThrow(/original or a copy/);
    expect(calls.some(c => c.init?.method === 'POST')).toBe(false);
    const readonly = await service.propose('chat1', 'person1', 'doc', edit, 'Replace');
    const original = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (...args) => String(args[0]).includes('/files/') ? json({ ...metadata(), capabilities: { canEdit: true, canCopy: false } }) : original(...args));
    calls = []; await expect(service.approve('chat1', readonly.id, 'copy')).rejects.toThrow(/does not allow/);
    expect(calls.some(c => c.init?.method === 'POST')).toBe(false);
  });
  it('keeps account identities separate and rejects cross-chat approval and rejected proposals', async () => {
    await connected(); await service.attach('chat1', 'person1', ['doc']);
    const p = await service.propose('chat1', 'person1', 'doc', [{ kind: 'replaceText', find: 'Hello', replace: 'Hi' }], 'Replace');
    await expect(service.approve('chat2', p.id)).rejects.toThrow(); expect(await service.proposals('chat1')).toHaveLength(1);
    await service.reject('chat1', p.id); await expect(service.approve('chat1', p.id)).rejects.toThrow();
    const original = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (...args) => String(args[0]).includes('/about?') ? json({ user: { permissionId: 'person2', displayName: 'Two' } }) : original(...args));
    const { flowId } = await service.beginAuth('person1'); const url = new URL(browser); const cb = new URL(url.searchParams.get('redirect_uri')!);
    cb.searchParams.set('state', url.searchParams.get('state')!); cb.searchParams.set('code', 'CODE'); cb.searchParams.set('picked_file_ids', 'doc'); await fetch(cb);
    await vi.waitFor(async () => expect((await service.authState(flowId)).state).toBe('error'));
    expect((await service.status()).accounts.map(a => a.id)).toEqual(['person1']);
  });
  it('refuses read-only original edits and oversized responses', async () => {
    await connected(); await service.attach('chat1', 'person1', ['doc']);
    const original = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (...args) => String(args[0]).includes('/files/') ? json({ ...metadata(), capabilities: { canEdit: false, canCopy: false } }) : original(...args));
    await expect(service.propose('chat1', 'person1', 'doc', [{ kind: 'replaceText', find: 'Hello', replace: 'Hi' }], 'Replace')).rejects.toThrow(/does not allow/);
    mockFetch.mockImplementation(async (...args) => String(args[0]).includes('docs.googleapis.com') ? json({ text: 'x'.repeat(2 * 1024 * 1024) }) : original(...args));
    await expect(service.read('chat1', 'person1', 'doc')).rejects.toThrow(/too large/);
  });
  it('restores saved account and chat selections without storing credentials in metadata', async () => {
    await connected(); await service.attach('chat1', 'person1', ['doc']); await service.dispose();
    service = new GoogleFilesService({ userDataDir: dir, clientFile: path.join(dir, 'client.json'), fetch: mockFetch,
      openExternal: async () => {}, secrets: { assertAvailable: async () => {}, get: async ref => vault.get(ref) ?? null, set: async () => 'secret-ref', delete: async () => {} } });
    expect((await service.status()).accounts[0].id).toBe('person1'); expect((await service.attached('chat1'))[0].id).toBe('doc');
    expect(await service.proposals('chat1')).toEqual([]); expect((await service.read('chat1', 'person1', 'doc')).content).toContain('Hello world');
  });
  it('disconnect deletes local secrets and attachments without ACL changes', async () => {
    await connected(); await service.attach('chat1', 'person1', ['doc']); await service.disconnect('person1');
    expect(vault.size).toBe(0); expect((await service.status()).accounts).toEqual([]); expect(await service.attached('chat1')).toEqual([]);
    expect(calls.some(c => c.url.includes('/permissions'))).toBe(false);
  });
  it.each(['document', 'spreadsheet', 'presentation'] as const)('creates approved %s files once and attaches the result', async nativeKind => {
    kind = nativeKind; await connected(); calls = [];
    const fileKind = kind === 'document' ? 'Doc' : kind === 'spreadsheet' ? 'Sheet' : 'Slides';
    const p = await service.proposeCreate('chat-create', 'person1', fileKind, 'New file', 'Initial text');
    expect(calls).toEqual([]); expect(p.create?.kind).toBe(fileKind); expect(p.file.id).toMatch(/^draft:/);
    const file = await service.approve('chat-create', p.id); expect(file.id).toBe('created'); expect(file.accountId).toBe('person1');
    expect((await service.attached('chat-create')).map(f => f.id)).toContain('created');
    expect(calls.filter(c => c.init?.method === 'POST' && /\/(documents|spreadsheets|presentations)$/.test(c.url))).toHaveLength(1);
    expect(calls.some(c => String(c.init?.body).includes('Initial text'))).toBe(true);
    await expect(service.approve('chat-create', p.id)).rejects.toThrow();
  });
  it('does not retry or report success after partially creating a file', async () => {
    await connected(); const original = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (...args) => String(args[0]).includes(':batchUpdate') ? json({ error: 'SECRET' }, 500) : original(...args));
    const p = await service.proposeCreate('chat1', 'person1', 'Doc', 'New', 'Text');
    await expect(service.approve('chat1', p.id)).rejects.toThrow(/created the file.*could not be completed/i);
    expect(await service.attached('chat1')).toEqual([]); expect((await service.listFiles('person1')).map(f => f.id)).toContain('created');
    await expect(service.approve('chat1', p.id)).rejects.toThrow();
    expect(calls.filter(c => c.url.endsWith('/documents') && c.init?.method === 'POST')).toHaveLength(1);
    expect(calls.some(c => c.init?.method === 'DELETE')).toBe(false);
  });
  it('writes bounded RAW Sheets ranges with escaped URLs and detects range changes', async () => {
    kind = 'spreadsheet'; await connected(); await service.attach('chat1', 'person1', ['doc']);
    const edit = { kind: 'writeCells' as const, range: "'Budget & Costs'!A1:B2", values: [['=literal', 2], [null, true]] };
    const p = await service.propose('chat1', 'person1', 'doc', [edit], 'Set cells'); calls = [];
    await service.approve('chat1', p.id);
    const write = calls.find(c => c.url.endsWith('/values:batchUpdate'))!;
    expect(calls.some(c => c.url.includes('Budget%20%26%20Costs'))).toBe(true);
    expect(JSON.parse(String(write.init?.body))).toEqual({ valueInputOption: 'RAW', data: [{ range: edit.range, majorDimension: 'ROWS', values: edit.values }] });
    const stale = await service.propose('chat1', 'person1', 'doc', [edit], 'Set cells'); sheetValue = 'concurrent edit'; calls = [];
    await expect(service.approve('chat1', stale.id)).rejects.toThrow(/changed/i); expect(calls.some(c => c.init?.method === 'PUT' || c.init?.method === 'POST')).toBe(false);
    await expect(service.propose('chat1', 'person1', 'doc', [{ ...edit, range: 'A:A' }], 'Invalid')).rejects.toThrow(/bounded/);
    await expect(service.propose('chat1', 'person1', 'doc', [{ ...edit, range: 'A1:A1' }], 'Invalid')).rejects.toThrow(/bounded/);
    const single = await service.propose('chat1', 'person1', 'doc', [{ kind: 'writeCells', range: "'Owner''s budget'!A1", values: [['text']] }], 'Set one cell');
    expect(single.edits[0].kind).toBe('writeCells');
  });
  it.each(['document', 'presentation', 'spreadsheet'] as const)('refuses changed %s copy content after source validation and retains the copy', async nativeKind => {
    kind = nativeKind; await connected(); await service.attach('chat1', 'person1', ['doc']);
    const edits = nativeKind === 'spreadsheet' ? [{ kind: 'writeCells' as const, range: 'A1', values: [['new']] }] : [{ kind: 'replaceText' as const, find: 'Hello', replace: 'Bye' }];
    const p = await service.propose('chat1', 'person1', 'doc', edits, 'Change', 'copy');
    const original = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (...args) => {
      const url = String(args[0]);
      if (url.includes('/copied') && url.includes('/values/')) return json({ values: [['changed']] });
      if (url.includes('/copied') && url.includes('slides.googleapis.com')) {
        const data = await (await original(...args)).json(); data.slides[0].pageElements[0].shape.text.textElements[0].textRun.text = 'Changed target'; return json(data);
      }
      if (url.includes('/copied') && url.includes('docs.googleapis.com')) return json({ revisionId: 'copy-revision', body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Changed target' } }] } }] } });
      return original(...args);
    });
    calls = []; await expect(service.approve('chat1', p.id)).rejects.toThrow(/copy.*changed|changed.*copy/i);
    expect(calls.filter(c => c.url.includes(':batchUpdate') || c.init?.method === 'PUT')).toEqual([]);
    expect((await service.attached('chat1')).map(f => f.id)).toContain('copied');
    await expect(service.approve('chat1', p.id)).rejects.toThrow(/unavailable|used/);
  });
  it('compares full copy content while ignoring root identity and revision', async () => {
    await connected(); await service.attach('chat1', 'person1', ['doc']);
    const original = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (...args) => {
      const response = await original(...args); const url = String(args[0]);
      if (url.includes('docs.googleapis.com') && !url.includes(':batchUpdate')) {
        const data = await response.json(); return json({ ...data, documentId: url.includes('/copied') ? 'copied' : 'doc', title: url.includes('/copied') ? 'Copy title' : 'Original title', revisionId: url.includes('/copied') ? 'copy-revision' : 'r1' });
      }
      return response;
    });
    const p = await service.propose('chat1', 'person1', 'doc', [{ kind: 'replaceText', find: 'Hello', replace: 'Bye' }], 'Change', 'copy');
    await service.approve('chat1', p.id);
    expect(JSON.parse(String(calls.find(c => c.url.includes(':batchUpdate'))?.init?.body)).writeControl.requiredRevisionId).toBe('copy-revision');
  });
  it('accepts a Slides copy with normalized structural IDs but unchanged text', async () => {
    kind = 'presentation'; await connected(); await service.attach('chat1', 'person1', ['doc']);
    const p = await service.propose('chat1', 'person1', 'doc', [{ kind: 'replaceText', find: 'Hello', replace: 'Bye' }], 'Change', 'copy');
    expect((await service.approve('chat1', p.id)).id).toBe('copied');
  });
  it.each([false, 0, '=A2', '0'])('does not lose Sheets copy value %s in content comparison', async copiedValue => {
    kind = 'spreadsheet'; sheetValue = ''; await connected(); await service.attach('chat1', 'person1', ['doc']);
    const p = await service.propose('chat1', 'person1', 'doc', [{ kind: 'writeCells', range: 'A1', values: [['new']] }], 'Change', 'copy');
    const original = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (...args) => String(args[0]).includes('/copied/values/') ? json({ values: [[copiedValue]] }) : original(...args));
    calls = []; await expect(service.approve('chat1', p.id)).rejects.toThrow(/copy.*changed/i);
    expect(calls.some(c => c.url.includes(':batchUpdate'))).toBe(false);
  });
  it('submits multiple Sheets ranges in one RAW values batch', async () => {
    kind = 'spreadsheet'; await connected(); await service.attach('chat1', 'person1', ['doc']);
    const edits = [{ kind: 'writeCells' as const, range: 'A1', values: [['=literal']] }, { kind: 'writeCells' as const, range: 'B2', values: [[true]] }];
    const p = await service.propose('chat1', 'person1', 'doc', edits, 'Set cells'); calls = [];
    await service.approve('chat1', p.id);
    const writes = calls.filter(c => c.init?.method !== 'GET'); expect(writes).toHaveLength(1);
    expect(writes[0].url).toBe('https://sheets.googleapis.com/v4/spreadsheets/doc/values:batchUpdate');
    expect(writes[0].init?.method).toBe('POST');
    expect(JSON.parse(String(writes[0].init?.body))).toEqual({ valueInputOption: 'RAW', data: edits.map(e => ({ range: e.range, majorDimension: 'ROWS', values: e.values })) });
  });
  it.each(['network', 'invalid', 'empty', 'server'] as const)('reports an uncertain Sheets write on %s without retry', async failure => {
    kind = 'spreadsheet'; await connected(); await service.attach('chat1', 'person1', ['doc']);
    const p = await service.propose('chat1', 'person1', 'doc', [{ kind: 'writeCells', range: 'A1', values: [['text']] }], 'Set cell');
    const original = mockFetch.getMockImplementation()!; let writes = 0;
    mockFetch.mockImplementation(async (...args) => {
      if (args[1]?.method === 'POST' || args[1]?.method === 'PUT') {
        writes++; if (failure === 'network') throw new Error('PRIVATE-ACCESS');
        return failure === 'invalid' ? new Response('PRIVATE-ACCESS') : json({}, failure === 'server' ? 503 : 200);
      }
      return original(...args);
    });
    await expect(service.approve('chat1', p.id)).rejects.toThrow(/uncertain.*check.*before/i);
    await expect(service.approve('chat1', p.id)).rejects.toThrow(/unavailable|used/); expect(writes).toBe(1);
  });
  it('lists remaining files and invalidates missing file selections and proposals across chats', async () => {
    await connected(); await service.attach('chat1', 'person1', ['doc']); await service.attach('chat2', 'person1', ['doc']);
    await service.propose('chat1', 'person1', 'doc', [{ kind: 'replaceText', find: 'Hello', replace: 'Bye' }], 'Change');
    const stateFile = path.join(dir, 'google-files.json'); const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    state.accounts[0].files.push({ ...state.accounts[0].files[0], id: 'good' }); await fs.writeFile(stateFile, JSON.stringify(state));
    mockFetch.mockImplementation(async input => String(input).includes('/files/doc?') ? json({ error: 'PRIVATE-ACCESS' }, 404) : json(metadata('good')));
    expect((await service.listFiles('person1')).map(f => f.id)).toEqual(['good']);
    expect(await service.attached('chat1')).toEqual([]); expect(await service.attached('chat2')).toEqual([]); expect(await service.proposals('chat1')).toEqual([]);
    expect(JSON.parse(await fs.readFile(stateFile, 'utf8')).selections).toEqual([]);
  });
  it.each([401, 403, 429, 503])('does not swallow account/auth/transient HTTP %s or invalidate selections', async status => {
    await connected(); await service.attach('chat1', 'person1', ['doc']);
    mockFetch.mockImplementation(async () => json({ error: 'PRIVATE-ACCESS' }, status));
    await expect(service.listFiles('person1')).rejects.toMatchObject({ status, code: expect.any(String), message: expect.not.stringContaining('PRIVATE') });
    expect(await service.attached('chat1')).toHaveLength(1);
  });
  it('does not swallow transport or invalid-token list failures', async () => {
    await connected(); await service.attach('chat1', 'person1', ['doc']);
    mockFetch.mockImplementation(async () => { throw new Error('PRIVATE-ACCESS'); });
    await expect(service.listFiles('person1')).rejects.toMatchObject({ code: 'transport', message: expect.not.stringContaining('PRIVATE') });
    expect(await service.attached('chat1')).toHaveLength(1);
    vault.clear(); await expect(service.listFiles('person1')).rejects.toThrow(/Reconnect/);
    expect(await service.attached('chat1')).toHaveLength(1);
  });
  it('writes Slides replacements using requiredRevisionId', async () => {
    kind = 'presentation'; await connected(); await service.attach('chat1', 'person1', ['doc']);
    const p = await service.propose('chat1', 'person1', 'doc', [{ kind: 'replaceText', find: 'Hello', replace: 'Hi' }], 'Replace title');
    await service.approve('chat1', p.id);
    const write = calls.find(c => c.url.includes('slides.googleapis.com') && c.url.includes(':batchUpdate'))!;
    expect(JSON.parse(String(write.init?.body)).writeControl.requiredRevisionId).toBe('r1');
  });
  it('sanitizes API and transport errors without retrying writes', async () => {
    await connected(); await service.attach('chat1', 'person1', ['doc']);
    const p = await service.propose('chat1', 'person1', 'doc', [{ kind: 'replaceText', find: 'Hello', replace: 'Hi' }], 'Replace');
    const original = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (...args) => { if (String(args[0]).includes(':batchUpdate')) throw new Error('Google PRIVATE transport token'); return original(...args); });
    const result = await service.approve('chat1', p.id).catch((error: Error) => error.message);
    expect(result).not.toMatch(/PRIVATE|transport token/); await expect(service.approve('chat1', p.id)).rejects.toThrow();
    mockFetch.mockImplementation(async () => json({ error: 'PRIVATE-ACCESS' }, 403));
    await expect(service.read('chat1', 'person1', 'doc')).rejects.toThrow('Google file access is unavailable. Select the file again.');
  });
  it('refreshes only validated scoped secrets and never exposes refresh credentials', async () => {
    await connected(); await service.attach('chat1', 'person1', ['doc']);
    const token = JSON.parse(vault.get('secret-ref')!); token.expiresAt = 0; vault.set('secret-ref', JSON.stringify(token)); calls = [];
    await Promise.all([service.read('chat1', 'person1', 'doc'), service.read('chat1', 'person1', 'doc')]);
    expect(calls.filter(c => c.url.includes('/token'))).toHaveLength(1);
    const tokenCall = calls.find(c => c.url.includes('/token'))!;
    expect(new URLSearchParams(String(tokenCall.init?.body)).get('grant_type')).toBe('refresh_token');
    token.scope = 'https://www.googleapis.com/auth/drive'; vault.set('secret-ref', JSON.stringify(token)); calls = [];
    await expect(service.read('chat1', 'person1', 'doc')).rejects.toThrow(/Reconnect/); expect(calls).toEqual([]);
  });
  it('rejects invalid_grant safely and requires reconnect', async () => {
    await connected(); await service.attach('chat1', 'person1', ['doc']);
    const token = JSON.parse(vault.get('secret-ref')!); token.expiresAt = 0; vault.set('secret-ref', JSON.stringify(token));
    mockFetch.mockImplementation(async () => json({ error: 'invalid_grant', error_description: 'PRIVATE-REFRESH' }, 400));
    await expect(service.read('chat1', 'person1', 'doc')).rejects.toThrow(/Reconnect/);
  });
  it('sanitizes API errors and rejects broad token scopes', async () => {
    mockFetch.mockImplementation(async () => json({ access_token: 'PRIVATE', refresh_token: 'PRIVATE', scope: 'https://www.googleapis.com/auth/drive' }));
    const { flowId } = await service.beginAuth(); const url = new URL(browser); const cb = new URL(url.searchParams.get('redirect_uri')!);
    cb.searchParams.set('state', url.searchParams.get('state')!); cb.searchParams.set('code', 'SECRET'); cb.searchParams.set('picked_file_ids', 'doc'); await fetch(cb);
    await vi.waitFor(async () => { expect((await service.authState(flowId)).state).not.toBe('pending'); });
    expect(await service.authState(flowId)).toEqual({ state: 'error', error: expect.not.stringMatching(/PRIVATE|SECRET/) }); expect(vault.size).toBe(0);
  });
});
