import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createGithubClient,
  combinedGithubStatus,
  fetchGithubLogin,
  GITHUB_AUTH_ERROR_CODE,
  type SafeStorageLike,
} from '../src/main/github-client';

// ---------------------------------------------------------------------------
// Fakes. The safeStorage fake "encrypts" by prefixing so tests can tell
// ciphertext from plaintext without real key material; exec/fetch fakes keep
// every test offline (house pattern — see github-auth.test.ts).
// ---------------------------------------------------------------------------

const SECRET = 'gho_supersecrettoken_should_never_leak';

function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b) => {
      const s = b.toString('utf8');
      if (!s.startsWith('enc:')) throw new Error('bad ciphertext');
      return s.slice(4);
    },
  };
}

/** exec fake for `gh auth token`: resolves a token, or throws (gh missing/unauthed). */
const ghExec = (token: string | null) =>
  vi.fn(async () => {
    if (token == null) throw new Error('gh: not logged in');
    return { stdout: `${token}\n`, stderr: '' };
  });

/** fetch fake driven by an ordered [urlSubstring → response] script. */
type FakeResponse = { status: number; json: any };
function fakeFetch(script: Array<[method: string, urlPart: string, res: FakeResponse]>) {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fn = vi.fn(async (url: string, init?: any) => {
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body });
    const idx = script.findIndex(([m, part]) => (init?.method ?? 'GET') === m && url.includes(part));
    if (idx === -1) throw new Error(`unexpected fetch ${init?.method} ${url}`);
    const [, , res] = script.splice(idx, 1)[0];
    return { ok: res.status < 300, status: res.status, json: async () => res.json };
  });
  return { fn: fn as any, calls };
}

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-ghc-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const tokenFile = () => path.join(tmp, 'github-token.json');

// ---------------------------------------------------------------------------
// Token custody
// ---------------------------------------------------------------------------

describe('github-client token custody', () => {
  it('setToken encrypts via safeStorage and getToken round-trips it (source: app)', async () => {
    const c = createGithubClient({ storageDir: tmp, safeStorage: fakeSafeStorage(), execFn: ghExec(null) });
    const { degraded } = await c.setToken(SECRET, 'octocat');
    expect(degraded).toBe(false);

    const raw = fs.readFileSync(tokenFile(), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.encrypted).toBe(true);
    // Neither the raw token NOR its bare base64 may sit in the file when the
    // keychain is available — only ciphertext.
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(Buffer.from(SECRET, 'utf8').toString('base64'));

    await expect(c.getToken()).resolves.toEqual({ token: SECRET, source: 'app' });
  });

  it('DEGRADED PIN: keychain unavailable → 0600 plaintext file, degraded:true, explicit log — never silent', async () => {
    const log = vi.fn();
    const c = createGithubClient({ storageDir: tmp, safeStorage: fakeSafeStorage(false), execFn: ghExec(null), log });
    const { degraded } = await c.setToken(SECRET);
    expect(degraded).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('without encryption'));
    expect(JSON.parse(fs.readFileSync(tokenFile(), 'utf8')).encrypted).toBe(false);
    if (process.platform !== 'win32') {
      expect(fs.statSync(tokenFile()).mode & 0o777).toBe(0o600);
    }
    // Still round-trips — a keyring-less Linux box must not lose sync.
    await expect(c.getToken()).resolves.toEqual({ token: SECRET, source: 'app' });
  });

  it('ACQUISITION ORDER PIN: stored app token beats a gh token; gh fills in when no stored token; null when neither', async () => {
    // Neither → null (and gh throwing must not propagate).
    const none = createGithubClient({ storageDir: tmp, safeStorage: fakeSafeStorage(), execFn: ghExec(null) });
    await expect(none.getToken()).resolves.toBeNull();

    // gh only → borrowed gh token.
    const ghOnly = createGithubClient({ storageDir: path.join(tmp, 'gh-only'), safeStorage: fakeSafeStorage(), execFn: ghExec('gho_gh_cli_token') });
    await expect(ghOnly.getToken()).resolves.toEqual({ token: 'gho_gh_cli_token', source: 'gh' });

    // Both → the app token wins (no forced migration, but the app's own
    // credential is authoritative once it exists).
    const both = createGithubClient({ storageDir: path.join(tmp, 'both'), safeStorage: fakeSafeStorage(), execFn: ghExec('gho_gh_cli_token') });
    await both.setToken(SECRET);
    await expect(both.getToken()).resolves.toEqual({ token: SECRET, source: 'app' });
  });

  it('clearToken removes the stored token (next getToken falls through to gh)', async () => {
    const c = createGithubClient({ storageDir: tmp, safeStorage: fakeSafeStorage(), execFn: ghExec('gho_gh_cli_token') });
    await c.setToken(SECRET);
    c.clearToken();
    expect(fs.existsSync(tokenFile())).toBe(false);
    await expect(c.getToken()).resolves.toEqual({ token: 'gho_gh_cli_token', source: 'gh' });
  });

  it('ciphertext with NO working keychain reads as no-token (never throws, never mis-decrypts)', async () => {
    const writer = createGithubClient({ storageDir: tmp, safeStorage: fakeSafeStorage(), execFn: ghExec(null) });
    await writer.setToken(SECRET);
    // Same file, but this process has no keychain (keyring gone / file copied
    // from another machine — safeStorage ciphertext is machine-bound anyway).
    const reader = createGithubClient({ storageDir: tmp, safeStorage: fakeSafeStorage(false), execFn: ghExec(null) });
    await expect(reader.getToken()).resolves.toBeNull();
  });

  it('status() reports connection, source, recorded login, and degraded storage', async () => {
    const c = createGithubClient({ storageDir: tmp, safeStorage: fakeSafeStorage(), execFn: ghExec(null) });
    await expect(c.status()).resolves.toEqual({ connected: false, source: null, login: undefined, degradedStorage: false });
    await c.setToken(SECRET, 'octocat');
    await expect(c.status()).resolves.toEqual({ connected: true, source: 'app', login: 'octocat', degradedStorage: false });

    const degraded = createGithubClient({ storageDir: path.join(tmp, 'deg'), safeStorage: fakeSafeStorage(false), execFn: ghExec(null) });
    await degraded.setToken(SECRET, 'octocat');
    await expect(degraded.status()).resolves.toMatchObject({ connected: true, degradedStorage: true });
  });
});

// ---------------------------------------------------------------------------
// REST: createPrivateRepo (replaces `gh repo create/view`)
// ---------------------------------------------------------------------------

describe('github-client createPrivateRepo', () => {
  async function clientWith(script: Array<[string, string, FakeResponse]>) {
    const { fn, calls } = fakeFetch(script);
    const c = createGithubClient({ storageDir: tmp, safeStorage: fakeSafeStorage(), execFn: ghExec(null), fetchFn: fn });
    await c.setToken(SECRET);
    return { c, calls };
  }

  it('creates a private repo and returns its clone URL', async () => {
    const { c, calls } = await clientWith([
      ['POST', '/user/repos', { status: 201, json: { clone_url: 'https://github.com/u/r.git' } }],
    ]);
    await expect(c.createPrivateRepo('r')).resolves.toBe('https://github.com/u/r.git');
    // private: true is mandatory (spec §14) — pin it in the request body.
    expect(JSON.parse(calls[0].body!)).toEqual({ name: 'r', private: true });
    // The token rides the Authorization header, never the URL/body.
    expect(calls[0].url).not.toContain(SECRET);
    expect(calls[0].body).not.toContain(SECRET);
  });

  it('SECOND DEVICE PIN: 422 already-exists → adopts the existing repo (success, not failure)', async () => {
    const { c } = await clientWith([
      ['POST', '/user/repos', { status: 422, json: { message: 'name already exists on this account' } }],
      ['GET', '/user', { status: 200, json: { login: 'octocat' } }],
      ['GET', '/repos/octocat/r', { status: 200, json: { clone_url: 'https://github.com/octocat/r.git', private: true } }],
    ]);
    await expect(c.createPrivateRepo('r')).resolves.toBe('https://github.com/octocat/r.git');
  });

  it.each([false, undefined])('SECURITY: an existing repo that is not proven private (private=%s) is REFUSED, never adopted', async (priv) => {
    const { c } = await clientWith([
      ['POST', '/user/repos', { status: 422, json: { message: 'name already exists on this account' } }],
      ['GET', '/user', { status: 200, json: { login: 'octocat' } }],
      ['GET', '/repos/octocat/r', { status: 200, json: { clone_url: 'https://github.com/octocat/r.git', private: priv } }],
    ]);
    const err = await c.createPrivateRepo('r').catch((e) => e);
    expect(err.syncErrorCode).toBe('repo-public');
    expect(String(err.message)).toContain('is public');
  });

  it('401 → plain-language "sign-in expired" with the github-auth code, token absent', async () => {
    const { c } = await clientWith([
      ['POST', '/user/repos', { status: 401, json: { message: 'Bad credentials' } }],
    ]);
    const err = await c.createPrivateRepo('r').catch((e) => e);
    expect(String(err.message)).toContain('GitHub sign-in expired');
    expect(err.syncErrorCode).toBe(GITHUB_AUTH_ERROR_CODE);
    expect(String(err.message)).not.toContain(SECRET);
  });

  it('no token anywhere → plain-language "not connected" with the github-auth code', async () => {
    const c = createGithubClient({ storageDir: tmp, safeStorage: fakeSafeStorage(), execFn: ghExec(null) });
    const err = await c.createPrivateRepo('r').catch((e) => e);
    expect(String(err.message)).toContain('Not connected to GitHub');
    expect(err.syncErrorCode).toBe(GITHUB_AUTH_ERROR_CODE);
  });

  it('transport failure → "Could not reach GitHub" — NEVER classified as an auth problem', async () => {
    const fetchFn: any = vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); });
    const c = createGithubClient({ storageDir: tmp, safeStorage: fakeSafeStorage(), execFn: ghExec(null), fetchFn });
    await c.setToken(SECRET);
    const err = await c.createPrivateRepo('r').catch((e) => e);
    expect(String(err.message)).toContain('Could not reach GitHub');
    expect(err.syncErrorCode).toBeUndefined();
    expect(String(err.message)).not.toContain(SECRET);
  });

  it('other HTTP failures surface status + GitHub message verbatim (no invented cause), token absent', async () => {
    // 403 is not proof the sign-in is dead (rate limit, SAML enforcement) —
    // it must surface as-is, not as "reconnect", and not trigger the 422
    // already-exists recovery.
    const { c } = await clientWith([
      ['POST', '/user/repos', { status: 403, json: { message: 'API rate limit exceeded' } }],
    ]);
    const err = await c.createPrivateRepo('r').catch((e) => e);
    expect(String(err.message)).toContain('HTTP 403');
    expect(String(err.message)).toContain('API rate limit exceeded');
    expect(String(err.message)).not.toContain(SECRET);
    expect(err.syncErrorCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fetchGithubLogin + combinedGithubStatus
// ---------------------------------------------------------------------------

describe('fetchGithubLogin', () => {
  it('returns the login from GET /user', async () => {
    const { fn } = fakeFetch([['GET', '/user', { status: 200, json: { login: 'octocat' } }]]);
    await expect(fetchGithubLogin(SECRET, fn)).resolves.toBe('octocat');
  });
  it("maps transport failures to Error('network')", async () => {
    const fn: any = async () => { throw new Error(`boom ${SECRET}`); };
    await expect(fetchGithubLogin(SECRET, fn)).rejects.toThrow('network');
  });
});

describe('combinedGithubStatus', () => {
  it('app token + NO gh at all → authed:true (the stock-machine pin)', async () => {
    const c = createGithubClient({ storageDir: tmp, safeStorage: fakeSafeStorage(), execFn: ghExec(null) });
    await c.setToken(SECRET, 'octocat');
    const s = await combinedGithubStatus(async () => ({ installed: false, authed: false }), c);
    expect(s).toEqual({ installed: false, authed: true, login: 'octocat', source: 'app', degradedStorage: false });
  });

  it('no app token + gh authed → authed:true via gh (legacy devices unchanged)', async () => {
    const c = createGithubClient({ storageDir: tmp, safeStorage: fakeSafeStorage(), execFn: ghExec('gho_gh_cli_token') });
    const s = await combinedGithubStatus(async () => ({ installed: true, authed: true, login: 'ghuser' }), c);
    expect(s).toEqual({ installed: true, authed: true, login: 'ghuser', source: 'gh', degradedStorage: false });
  });

  it('nothing anywhere → not authed', async () => {
    const c = createGithubClient({ storageDir: tmp, safeStorage: fakeSafeStorage(), execFn: ghExec(null) });
    const s = await combinedGithubStatus(async () => ({ installed: false, authed: false }), c);
    expect(s).toMatchObject({ installed: false, authed: false, source: null });
  });
});

// ---------------------------------------------------------------------------
// Phase 3: generic api() + fetchAuthedLogin (the gh-CLI conversion surface)
// ---------------------------------------------------------------------------

describe('github-client api()', () => {
  it('sends the token in the Authorization header only; caller interprets statuses', async () => {
    const { fn, calls } = fakeFetch([['POST', '/repos/o/r/forks', { status: 202, json: { ok: true } }]]);
    const c = createGithubClient({ storageDir: tmp, safeStorage: fakeSafeStorage(), execFn: ghExec(null), fetchFn: fn });
    await c.setToken(SECRET);
    const out = await c.api('POST', '/repos/o/r/forks');
    expect(out.status).toBe(202);
    expect(calls[0].url).not.toContain(SECRET);
  });

  it('no token → coded not-connected error, UNLESS anonymous is allowed', async () => {
    const { fn } = fakeFetch([['GET', '/search/issues', { status: 200, json: { items: [] } }]]);
    const c = createGithubClient({ storageDir: tmp, safeStorage: fakeSafeStorage(), execFn: ghExec(null), fetchFn: fn });
    await expect(c.api('GET', '/search/issues')).rejects.toMatchObject({ syncErrorCode: GITHUB_AUTH_ERROR_CODE });
    const anon = await c.api('GET', '/search/issues', undefined, { anonymous: true });
    expect(anon.status).toBe(200);
  });

  it('401 with a token → coded sign-in-expired error (centralized for every consumer)', async () => {
    const { fn } = fakeFetch([['GET', '/user', { status: 401, json: { message: 'Bad credentials' } }]]);
    const c = createGithubClient({ storageDir: tmp, safeStorage: fakeSafeStorage(), execFn: ghExec(null), fetchFn: fn });
    await c.setToken(SECRET);
    const err = await c.api('GET', '/user').catch((e) => e);
    expect(err.syncErrorCode).toBe(GITHUB_AUTH_ERROR_CODE);
    expect(String(err.message)).toContain('GitHub sign-in expired');
    expect(String(err.message)).not.toContain(SECRET);
  });
});

describe('github-client fetchAuthedLogin', () => {
  it('returns the login (replaces `gh api user --jq .login`)', async () => {
    const { fn } = fakeFetch([['GET', '/user', { status: 200, json: { login: 'octocat' } }]]);
    const c = createGithubClient({ storageDir: tmp, safeStorage: fakeSafeStorage(), execFn: ghExec(null), fetchFn: fn });
    await c.setToken(SECRET);
    await expect(c.fetchAuthedLogin()).resolves.toBe('octocat');
  });

  it('login missing from the response → named error without inventing a cause', async () => {
    const { fn } = fakeFetch([['GET', '/user', { status: 500, json: {} }]]);
    const c = createGithubClient({ storageDir: tmp, safeStorage: fakeSafeStorage(), execFn: ghExec(null), fetchFn: fn });
    await c.setToken(SECRET);
    await expect(c.fetchAuthedLogin()).rejects.toThrow('HTTP 500');
  });
});
