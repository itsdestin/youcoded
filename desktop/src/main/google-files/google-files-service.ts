import { promises as fs } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { SecretsStore } from '../providers/secrets-store';
import { mutateFileUnderLock } from '../artifacts/cas-write';
import type { GoogleAccount, GoogleAuthState, GoogleDriveFile, GoogleEdit, GoogleFilesStatus, GoogleProposal, GoogleReadResult } from '../../shared/google-files-types';
import { DRIVE, GoogleRequestError, fileMetadata, metadataUrl, request, textContent, validateEdits, validateScope, type Json } from './google-api';
import { exchange, loadClient, picker, type GoogleToken, type PickerFlow } from './google-oauth';

interface Options {
  userDataDir: string; clientFile?: string;
  secrets: Pick<SecretsStore, 'get' | 'set' | 'delete' | 'assertAvailable'>;
  openExternal: (url: string) => Promise<void>; fetch?: typeof fetch;
}
interface StoredAccount { account: GoogleAccount; secretRef: string; files: GoogleDriveFile[] }
interface Selection { sessionId: string; accountId: string; fileId: string }
interface State { version: 1; accounts: StoredAccount[]; selections: Selection[] }
interface Snapshot { result: GoogleReadResult; fingerprint: string; copyFingerprint: string }
interface Pending { proposal: GoogleProposal; fingerprint: string }
const empty = (): State => ({ version: 1, accounts: [], selections: [] });
const clone = <T>(value: T): T => structuredClone(value);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicAccount = (value: StoredAccount) => clone(value.account);

function copyFingerprint(data: Json): string {
  // WHY: plain-text extraction misses Slides textRun.text and Sheets values. Compare the full
  // structure, excluding only root copy identity/title/revision; unknown differences fail closed.
  // Normalize structural IDs and their references consistently, never arbitrary string content.
  const ids = new Map<string, string>();
  const idKeys = new Set(['objectId', 'pageObjectId', 'slideObjectId', 'tabId', 'parentTabId', 'headerId', 'footerId', 'footnoteId']);
  const normalize = (value: unknown, key = '', depth = 0): unknown => {
    if (depth > 100) throw new Error('Google file structure is too complex to compare safely.');
    if (typeof value === 'string' && idKeys.has(key)) {
      if (!ids.has(value)) ids.set(value, `id${ids.size}`); return ids.get(value);
    }
    if (Array.isArray(value)) return value.map(v => normalize(v, key, depth + 1));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).filter(([k]) => depth !== 0 || !['documentId', 'presentationId', 'spreadsheetId', 'revisionId', 'title'].includes(k)).map(([k, v]) => [k, normalize(v, k, depth + 1)]));
  };
  return digest(normalize(data));
}

export class GoogleFilesService {
  private readonly file: string;
  private readonly fetcher: typeof fetch;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly refreshes = new Map<string, Promise<GoogleToken>>();
  private readonly flows = new Map<string, { state: GoogleAuthState; flow: PickerFlow; task?: Promise<void> }>();
  private readonly pending = new Map<string, Pending>();
  private disposed = false;

  constructor(private readonly options: Options) {
    this.file = path.join(options.userDataDir, 'google-files.json'); this.fetcher = options.fetch ?? fetch;
  }
  // WHY: attachment changes, disconnect and approvals share one async queue. An approval claims its
  // one-use entry before any await; no second caller can race a cloud write or resurrect a selection.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Google files service is closed.'));
    const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next;
  }
  private parse(raw: string | null): State {
    if (!raw) return empty();
    try {
      const value = JSON.parse(raw) as State;
      if (value.version !== 1 || !Array.isArray(value.accounts) || !Array.isArray(value.selections)) throw new Error();
      if (value.accounts.some(a => !a.account || typeof a.account.id !== 'string' || typeof a.secretRef !== 'string' || !Array.isArray(a.files))) throw new Error();
      return value;
    } catch { throw new Error('Saved Google file connections could not be read.'); }
  }
  private async state(): Promise<State> {
    try { const stat = await fs.stat(this.file); if (stat.size > 4 * 1024 * 1024) throw new Error(); return this.parse(await fs.readFile(this.file, 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw new Error('Saved Google file connections could not be read.'); }
  }
  private async update(fn: (state: State) => void): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    for (let i = 0; i < 5; i++) {
      if (await mutateFileUnderLock(this.file, raw => { const value = this.parse(raw); fn(value); const out = JSON.stringify(value); if (out.length > 4 * 1024 * 1024) throw new Error('Too many saved Google files.'); return out; })) return;
    }
    throw new Error('Saved Google files are busy. Try again.');
  }
  private account(state: State, id: string): StoredAccount {
    const account = state.accounts.find(a => a.account.id === id); if (!account) throw new Error('Connect this Google account first.'); return account;
  }
  private selected(state: State, sessionId: string, accountId: string, fileId: string): StoredAccount {
    const account = this.account(state, accountId);
    if (!state.selections.some(s => s.sessionId === sessionId && s.accountId === accountId && s.fileId === fileId) || !account.files.some(f => f.id === fileId)) throw new Error('Attach this Google file to this chat first.');
    return account;
  }
  private async token(account: StoredAccount): Promise<GoogleToken> {
    let token: GoogleToken;
    try { const raw = await this.options.secrets.get(account.secretRef); if (!raw) throw new Error(); token = JSON.parse(raw); validateScope(token.scope); if (typeof token.refreshToken !== 'string' || !token.refreshToken || typeof token.accessToken !== 'string' || !token.accessToken || !Number.isFinite(token.expiresAt)) throw new Error(); }
    catch { throw new Error('Reconnect this Google account to continue.'); }
    if (token.expiresAt > Date.now() + 60_000) return token;
    const existing = this.refreshes.get(account.account.id); if (existing) return existing;
    const task = (async () => {
      const client = await loadClient(this.options.clientFile);
      const refreshed = await exchange(this.fetcher, client, { grant_type: 'refresh_token', refresh_token: token.refreshToken }, token);
      try { await this.options.secrets.set(JSON.stringify(refreshed), account.secretRef); }
      catch { throw new Error('Secure Google credentials could not be saved. Reconnect this account.'); }
      return refreshed;
    })();
    this.refreshes.set(account.account.id, task);
    try { return await task; } finally { this.refreshes.delete(account.account.id); }
  }
  private async api(account: StoredAccount, url: string, method = 'GET', body?: unknown): Promise<Json> {
    const token = await this.token(account);
    // WHY: never retry writes on 401/network failures: copy and replaceAllText may already have applied.
    return request(this.fetcher, url, { method, headers: { Authorization: `Bearer ${token.accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  private async metadata(account: StoredAccount, id: string): Promise<GoogleDriveFile> {
    const raw = await this.api(account, metadataUrl(id)); if (raw.id !== id) throw new Error('Google returned a different file.'); return fileMetadata(raw, account.account);
  }
  async status(): Promise<GoogleFilesStatus> {
    return this.serial(async () => { let configured = false; try { await loadClient(this.options.clientFile); configured = true; } catch { /* Only expose availability, never client configuration. */ }
      return { configured, accounts: (await this.state()).accounts.map(publicAccount) }; });
  }
  async beginAuth(accountId?: string): Promise<{ flowId: string }> {
    return this.serial(async () => {
      if ([...this.flows.values()].filter(f => f.state.state === 'pending').length >= 16) throw new Error('Close an existing Google sign-in before starting another.');
      // Bound retained polling results without making the seventeenth connection require an app restart.
      for (const [id, flow] of this.flows) if (this.flows.size >= 32 && flow.state.state !== 'pending') this.flows.delete(id);
      if (accountId) this.account(await this.state(), accountId);
      try { await this.options.secrets.assertAvailable(); } catch { throw new Error('Secure storage is unavailable. Google sign-in cannot continue.'); }
      const client = await loadClient(this.options.clientFile); const flow = await picker(client); const flowId = randomUUID();
      const entry: { state: GoogleAuthState; flow: PickerFlow; task?: Promise<void> } = { state: { state: 'pending' }, flow };
      this.flows.set(flowId, entry);
      entry.task = (async () => {
        try {
          const callback = await flow.result;
          const token = await exchange(this.fetcher, client, { grant_type: 'authorization_code', code: callback.code, code_verifier: callback.verifier, redirect_uri: callback.redirectUri });
          if (entry.state.state !== 'pending' || this.disposed) return;
          const auth = { method: 'GET', headers: { Authorization: `Bearer ${token.accessToken}` } };
          const about = await request(this.fetcher, `${DRIVE}/about?fields=user(displayName,emailAddress,permissionId)`, auth);
          const user = about.user;
          if (!user || typeof user.permissionId !== 'string' || !user.permissionId || (accountId && user.permissionId !== accountId)) throw new Error('Select the same Google account to add more files.');
          const account: GoogleAccount = { id: user.permissionId, email: typeof user.emailAddress === 'string' ? user.emailAddress : '', displayName: typeof user.displayName === 'string' ? user.displayName : 'Google account' };
          const files: GoogleDriveFile[] = [];
          for (const id of callback.ids) {
            if (entry.state.state !== 'pending' || this.disposed) return;
            const raw = await request(this.fetcher, metadataUrl(id), auth); if (raw.id !== id) throw new Error('Google returned a different file.'); files.push(fileMetadata(raw, account));
          }
          await this.serial(async () => {
            if (entry.state.state !== 'pending') return;
            const old = (await this.state()).accounts.find(a => a.account.id === account.id);
            const secretRef = await this.options.secrets.set(JSON.stringify(token), old?.secretRef);
            try {
              await this.update(state => { const previous = state.accounts.find(a => a.account.id === account.id); const merged = new Map((previous?.files ?? []).map(f => [f.id, f])); for (const file of files) merged.set(file.id, file);
                state.accounts = state.accounts.filter(a => a.account.id !== account.id); state.accounts.push({ account, secretRef, files: [...merged.values()] }); });
            } catch { if (!old) await this.options.secrets.delete(secretRef); throw new Error('Google connection could not be saved.'); }
            entry.state = { state: 'complete', account, files };
          });
        } catch {
          // Never forward callback, keychain or OAuth exceptions across the renderer boundary.
          if (entry.state.state === 'pending') entry.state = { state: 'error', error: 'Google sign-in could not be completed. Try again using selected-file access only.' };
        }
      })();
      try { await this.options.openExternal(flow.url); } catch { flow.close(); entry.state = { state: 'error', error: 'Google sign-in could not open in your browser.' }; }
      return { flowId };
    });
  }
  async authState(flowId: string): Promise<GoogleAuthState> { return clone(this.flows.get(flowId)?.state ?? { state: 'error', error: 'Google sign-in is no longer available. Try again.' }); }
  private cancelFlow(flowId: string): void { const entry = this.flows.get(flowId); if (entry?.state.state === 'pending') { entry.state = { state: 'error', error: 'Google sign-in was cancelled.' }; entry.flow.close(); } }
  async cancelAuth(flowId: string): Promise<void> { return this.serial(async () => { this.cancelFlow(flowId); }); }
  async listFiles(accountId: string): Promise<GoogleDriveFile[]> {
    return this.serial(async () => { const account = this.account(await this.state(), accountId); const files: GoogleDriveFile[] = [];
      for (const file of account.files) {
        try { files.push(await this.metadata(account, file.id)); }
        catch (error) {
          // WHY: only a metadata GET's definitive 404 retires this selected file. Never turn
          // authentication, quota, policy, transport or server failures into silent file removal.
          if (!(error instanceof GoogleRequestError) || error.status !== 404 || error.code !== 'not_found') throw error;
          await this.update(state => {
            this.account(state, accountId).files = this.account(state, accountId).files.filter(f => f.id !== file.id);
            state.selections = state.selections.filter(s => s.accountId !== accountId || s.fileId !== file.id);
          });
          for (const [id, p] of this.pending) if (p.proposal.file.accountId === accountId && p.proposal.file.id === file.id) this.pending.delete(id);
        }
      }
      await this.update(state => { this.account(state, accountId).files = files; }); return clone(files); });
  }
  async attach(sessionId: string, accountId: string, fileIds: string[]): Promise<GoogleDriveFile[]> {
    return this.serial(async () => {
      if (!sessionId || sessionId.length > 256 || !Array.isArray(fileIds) || !fileIds.length || fileIds.length > 100) throw new Error('Choose files and a chat first.');
      const account = this.account(await this.state(), accountId);
      if (fileIds.some(id => !account.files.some(f => f.id === id))) throw new Error('Select this file in the Google file picker first.');
      const files: GoogleDriveFile[] = []; for (const id of new Set(fileIds)) files.push(await this.metadata(account, id));
      await this.update(state => { const current = this.account(state, accountId); for (const file of files) {
        if (!current.files.some(f => f.id === file.id)) throw new Error('Select this file in Google first.');
        current.files = current.files.map(f => f.id === file.id ? file : f);
        if (!state.selections.some(s => s.sessionId === sessionId && s.accountId === accountId && s.fileId === file.id)) state.selections.push({ sessionId, accountId, fileId: file.id });
      } }); return clone(files);
    });
  }
  async attached(sessionId: string): Promise<GoogleDriveFile[]> {
    return this.serial(async () => { const state = await this.state(); return clone(state.selections.filter(s => s.sessionId === sessionId).flatMap(s => state.accounts.find(a => a.account.id === s.accountId)?.files.filter(f => f.id === s.fileId) ?? [])); });
  }
  async detach(sessionId: string, accountId: string, fileId: string): Promise<void> {
    return this.serial(async () => { await this.update(state => { state.selections = state.selections.filter(s => !(s.sessionId === sessionId && s.accountId === accountId && s.fileId === fileId)); });
      for (const [id, p] of this.pending) if (p.proposal.sessionId === sessionId && p.proposal.file.accountId === accountId && p.proposal.file.id === fileId) this.pending.delete(id); });
  }
  async disconnect(accountId: string): Promise<void> {
    return this.serial(async () => { const account = this.account(await this.state(), accountId);
      await this.update(state => { state.accounts = state.accounts.filter(a => a.account.id !== accountId); state.selections = state.selections.filter(s => s.accountId !== accountId); });
      for (const [id, p] of this.pending) if (p.proposal.file.accountId === accountId) this.pending.delete(id);
      // Cancel reconnect flows too, otherwise a callback could reconnect after local disconnect.
      for (const [id, flow] of this.flows) if (flow.state.state === 'pending') this.cancelFlow(id);
      await this.options.secrets.delete(account.secretRef);
    });
  }
  private async snapshot(account: StoredAccount, id: string, edits?: GoogleEdit[]): Promise<Snapshot> {
    const file = await this.metadata(account, id); let data: Json; let content: string; let revision: string | undefined;
    const encoded = encodeURIComponent(id);
    if (file.kind === 'Doc' || file.kind === 'Slides') {
      const base = file.kind === 'Doc' ? 'https://docs.googleapis.com/v1/documents' : 'https://slides.googleapis.com/v1/presentations';
      data = await this.api(account, `${base}/${encoded}${file.kind === 'Doc' ? '?includeTabsContent=true' : ''}`);
      content = textContent(data); revision = typeof data.revisionId === 'string' ? data.revisionId : undefined;
    } else if (file.kind === 'Sheet') {
      // Sheets has no compare-and-set values API. Snapshot bounded ranges and compare immediately
      // before writes; this detects changes, but cannot make compare/read/write atomic on Google's side.
      // FORMULA preserves formula edits that happen to evaluate to the same displayed value.
      const ranges = edits?.filter((e): e is Extract<GoogleEdit, { kind: 'writeCells' }> => e.kind === 'writeCells').map(e => e.range);
      if (ranges?.length) {
        const values = []; for (const range of ranges) values.push(await this.api(account, `https://sheets.googleapis.com/v4/spreadsheets/${encoded}/values/${encodeURIComponent(range)}?valueRenderOption=FORMULA`));
        data = { ranges: values }; content = JSON.stringify(data);
      } else {
        data = await this.api(account, `https://sheets.googleapis.com/v4/spreadsheets/${encoded}?ranges=A1:CV1000&includeGridData=true&fields=spreadsheetId,sheets(properties(title),data(rowData(values(formattedValue,userEnteredValue))))`); content = JSON.stringify(data);
      }
    } else throw new Error('Reading this Google file type is not supported.');
    if (content.length > 200_000) throw new Error('Google file content is too large. Select a smaller file.');
    return { result: { file, content, ...(revision ? { revision } : {}) }, fingerprint: digest({ data, file: { kind: file.kind, canEdit: file.canEdit, canCopy: file.canCopy } }), copyFingerprint: copyFingerprint(data) };
  }
  async read(sessionId: string, accountId: string, fileId: string): Promise<GoogleReadResult> {
    return this.serial(async () => { const account = this.selected(await this.state(), sessionId, accountId, fileId); return (await this.snapshot(account, fileId)).result; });
  }
  async propose(sessionId: string, accountId: string, fileId: string, edits: GoogleEdit[], summary: string, mode: 'original' | 'copy' = 'original'): Promise<GoogleProposal> {
    return this.serial(async () => {
      const account = this.selected(await this.state(), sessionId, accountId, fileId);
      const file = await this.metadata(account, fileId); validateEdits(file, edits); this.capability(file, mode);
      if (typeof summary !== 'string' || !summary.trim() || summary.length > 2000) throw new Error('Give this Google edit a short summary.');
      if (this.pending.size >= 100) throw new Error('Review pending Google edits before proposing more.');
      const snapshot = await this.snapshot(account, fileId, edits);
      if (file.kind !== 'Sheet' && !snapshot.result.revision) throw new Error('Google file revision is unavailable. Try again.');
      const proposal: GoogleProposal = { id: randomUUID(), sessionId, file: snapshot.result.file, summary, edits: clone(edits), mode, createdAt: Date.now() };
      this.pending.set(proposal.id, { proposal, fingerprint: snapshot.fingerprint }); return clone(proposal);
    });
  }
  async proposeCreate(sessionId: string, accountId: string, kind: 'Doc' | 'Sheet' | 'Slides', name: string, content: string): Promise<GoogleProposal> {
    return this.serial(async () => {
      const account = this.account(await this.state(), accountId);
      if (!sessionId || sessionId.length > 256 || !['Doc', 'Sheet', 'Slides'].includes(kind) || typeof name !== 'string' || !name.trim() || name.length > 256 || typeof content !== 'string' || content.length > 40_000) throw new Error('Choose a file type, short name, and at most 40,000 characters of initial text.');
      if (this.pending.size >= 100) throw new Error('Review pending Google edits before proposing more.');
      const id = randomUUID();
      const file: GoogleDriveFile = { id: `draft:${id}`, accountId, account: account.account.email || account.account.displayName, name, kind, mimeType: kind === 'Doc' ? 'application/vnd.google-apps.document' : kind === 'Sheet' ? 'application/vnd.google-apps.spreadsheet' : 'application/vnd.google-apps.presentation', webViewLink: '', canEdit: true, canCopy: true };
      // WHY: a draft is a review-only synthetic reference, not a granted or attached cloud file.
      // Sheets intentionally initializes one RAW text cell; it does not parse formulas or CSV.
      const proposal: GoogleProposal = { id, sessionId, file, summary: kind === 'Sheet' ? `Create ${name} with initial text in cell A1` : `Create ${name}`, edits: [], mode: 'original', createdAt: Date.now(), create: { kind, name, content } };
      this.pending.set(id, { proposal, fingerprint: '' }); return clone(proposal);
    });
  }
  private async createApproved(sessionId: string, account: StoredAccount, create: NonNullable<GoogleProposal['create']>): Promise<GoogleDriveFile> {
    const base = create.kind === 'Doc' ? 'https://docs.googleapis.com/v1/documents' : create.kind === 'Sheet' ? 'https://sheets.googleapis.com/v4/spreadsheets' : 'https://slides.googleapis.com/v1/presentations';
    const raw = await this.api(account, base, 'POST', create.kind === 'Sheet' ? { properties: { title: create.name } } : { title: create.name });
    const id = create.kind === 'Doc' ? raw.documentId : create.kind === 'Sheet' ? raw.spreadsheetId : raw.presentationId;
    if (typeof id !== 'string' || !id) throw new Error('Google creation result is uncertain. Check Google Drive before creating another file.');
    try {
      const file = await this.metadata(account, id);
      // Record the real file before initializing it, so partial failure never hides a created file.
      await this.update(state => { this.account(state, account.account.id).files.push(file); });
      if (create.content || create.kind === 'Slides') {
        const encoded = encodeURIComponent(id);
        if (create.kind === 'Sheet') {
          const sheetTitle = raw.sheets?.[0]?.properties?.title;
          if (typeof sheetTitle !== 'string') throw new Error('Google sheet title is unavailable.');
          const range = `'${sheetTitle.replace(/'/g, "''")}'!A1`;
          await this.api(account, `${base}/${encoded}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, 'PUT', { range, majorDimension: 'ROWS', values: [[create.content]] });
        } else if (create.kind === 'Doc') {
          await this.api(account, `${base}/${encoded}:batchUpdate`, 'POST', { requests: [{ insertText: { location: { index: 1 }, text: create.content } }] });
        } else {
          // Fixed generated object IDs and shape types only: never forward model-provided API bodies.
          const slide = `yc_${randomUUID().replace(/-/g, '')}`, title = `${slide}_title`, body = `${slide}_body`;
          await this.api(account, `${base}/${encoded}:batchUpdate`, 'POST', { requests: [
            { createSlide: { objectId: slide, slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' }, placeholderIdMappings: [{ layoutPlaceholder: { type: 'TITLE' }, objectId: title }, { layoutPlaceholder: { type: 'BODY' }, objectId: body }] } },
            { insertText: { objectId: title, text: create.name, insertionIndex: 0 } }, ...(create.content ? [{ insertText: { objectId: body, text: create.content, insertionIndex: 0 } }] : [])
          ] });
        }
      }
      await this.update(state => { this.account(state, account.account.id); state.selections.push({ sessionId, accountId: account.account.id, fileId: id }); });
      return file;
    } catch {
      // Never delete a shared file or report full success after partial initialization.
      throw new Error('Google created the file, but its initial content or chat attachment could not be completed. Check Google Drive before creating another file.');
    }
  }
  private capability(file: GoogleDriveFile, mode: string): void {
    if (mode !== 'original' && mode !== 'copy') throw new Error('Choose editing the original or a copy.');
    if ((mode === 'original' && !file.canEdit) || (mode === 'copy' && !file.canCopy)) throw new Error('This Google file does not allow that operation.');
  }
  async proposals(sessionId: string): Promise<GoogleProposal[]> { return this.serial(async () => clone([...this.pending.values()].filter(p => p.proposal.sessionId === sessionId).map(p => p.proposal))); }
  async reject(sessionId: string, proposalId: string): Promise<void> { return this.serial(async () => { const p = this.pending.get(proposalId); if (!p || p.proposal.sessionId !== sessionId) throw new Error('Google edit proposal is unavailable.'); this.pending.delete(proposalId); }); }
  async approve(sessionId: string, proposalId: string, mode?: 'original' | 'copy'): Promise<GoogleDriveFile> {
    return this.serial(async () => {
      const pending = this.pending.get(proposalId);
      if (!pending || pending.proposal.sessionId !== sessionId) throw new Error('Google edit proposal is unavailable or already used.');
      this.pending.delete(proposalId); // ONE SHOT, including stale, failed and ambiguous writes.
      const p = pending.proposal;
      if (Date.now() - p.createdAt > 30 * 60_000) throw new Error('Google edit proposal expired. Propose it again.');
      const selectedMode = mode ?? p.mode;
      if (selectedMode !== 'original' && selectedMode !== 'copy') throw new Error('Choose editing the original or a copy.');
      if (p.create) {
        if (selectedMode !== 'original') throw new Error('A new Google file cannot be created as a copy of an existing file.');
        return this.createApproved(sessionId, this.account(await this.state(), p.file.accountId), p.create);
      }
      const account = this.selected(await this.state(), sessionId, p.file.accountId, p.file.id);
      // WHY: the user's target choice may change at review, but the proposal's original fingerprint
      // must not. Re-proposing here would silently authorize edits against changed cloud content.
      const fresh = await this.snapshot(account, p.file.id, p.edits); this.capability(fresh.result.file, selectedMode); validateEdits(fresh.result.file, p.edits);
      if (pending.fingerprint !== fresh.fingerprint) throw new Error('Google file changed since this proposal. Read it and propose the edit again.');
      let target = fresh;
      if (selectedMode === 'copy') {
        const copy = await this.api(account, `${DRIVE}/files/${encodeURIComponent(p.file.id)}/copy?fields=id,name,mimeType,capabilities(canEdit,canCopy)`, 'POST', { name: `${p.file.name} (YouCoded copy)` });
        const copied = fileMetadata(copy, account.account);
        // Remember a created copy even if its subsequent edit fails. Never automatically copy twice.
        await this.update(state => { this.account(state, account.account.id).files.push(copied); state.selections.push({ sessionId, accountId: account.account.id, fileId: copied.id }); });
        target = await this.snapshot(account, copied.id, p.edits); this.capability(target.result.file, 'original');
        // WHY: files.copy can race a source edit after our last source read. The created file stays
        // listed/attached for inspection, but its own revision alone does not authorize changed content.
        if (target.result.file.kind !== fresh.result.file.kind || target.copyFingerprint !== fresh.copyFingerprint) throw new Error('Google copy content changed from the approved source. The copy was kept and attached to this chat without applying edits. Read it before proposing another edit.');
      }
      const id = encodeURIComponent(target.result.file.id);
      if (target.result.file.kind === 'Sheet') {
        const data = p.edits.filter((e): e is Extract<GoogleEdit, { kind: 'writeCells' }> => e.kind === 'writeCells').map(e => ({ range: e.range, majorDimension: 'ROWS', values: e.values }));
        // WHY: one values batch avoids independently applying ranges. Sheets offers no revision CAS;
        // a lost or malformed acknowledgement must never trigger a retry or a false success.
        try {
          const response = await this.api(account, `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchUpdate`, 'POST', { valueInputOption: 'RAW', data });
          if (response.spreadsheetId !== target.result.file.id || !Array.isArray(response.responses) || response.responses.length !== data.length || response.responses.some((r: Json) => !r || typeof r.updatedRange !== 'string')) throw new Error();
        } catch (error) {
          if (error instanceof GoogleRequestError && error.status !== undefined && error.status < 500) throw error;
          throw new Error('Google Sheets write result is uncertain. Check the file before proposing another edit; do not automatically retry.');
        }
      } else {
        if (!target.result.revision) throw new Error('Google file revision is unavailable. Read the file before trying again.');
        const base = target.result.file.kind === 'Doc' ? 'https://docs.googleapis.com/v1/documents' : 'https://slides.googleapis.com/v1/presentations';
        await this.api(account, `${base}/${id}:batchUpdate`, 'POST', { requests: p.edits.filter((e): e is Extract<GoogleEdit, { kind: 'replaceText' }> => e.kind === 'replaceText').map(e => ({ replaceAllText: { containsText: { text: e.find, matchCase: true }, replaceText: e.replace } })), writeControl: { requiredRevisionId: target.result.revision } });
      }
      return clone(target.result.file);
    });
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [id] of this.flows) this.cancelFlow(id);
    await Promise.all([...this.flows.values()].map(f => f.task)); await this.queue;
    this.pending.clear(); this.flows.clear();
  }
}
