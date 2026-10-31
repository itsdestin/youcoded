/**
 * github-client.ts — the app's single GitHub credential custodian + REST
 * helper (main process).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Phase 2 of the 2026-07-22 sync-setup overhaul: GitHub features must work on
 * a machine with nothing installed but the app and git. Before this module the
 * only credential store was the `gh` CLI, so sync (and publishing, and bug
 * reports) dead-ended on any stock machine without it. This module owns:
 *
 *  - TOKEN CUSTODY — the OAuth token minted by the in-app device flow, stored
 *    encrypted via Electron `safeStorage` (OS keychain-backed) in the
 *    PER-INSTALL userData dir.
 *  - ACQUISITION ORDER — stored app token → `gh auth token` (a machine already
 *    authed for the terminal keeps working with zero migration) → null
 *    (callers surface "connect GitHub").
 *  - REST HELPERS — private-repo provisioning replacing `gh repo create/view`,
 *    plus the login lookup, with typed 401 handling ("sign-in expired").
 *
 * WHY STORAGE LIVES IN userData AND NOWHERE ELSE (load-bearing)
 * -------------------------------------------------------------
 * userData is per-install and never synced. Storing the token under ~/.claude
 * or any sync space would upload the (encrypted or not) credential into the
 * very repos it authenticates — and safeStorage ciphertext is only decryptable
 * on the machine that wrote it anyway. Do not "consolidate" this file into
 * toolkit-state.
 *
 * TOKEN HYGIENE (extends the github-auth.ts wall — never relax)
 * -------------------------------------------------------------
 * The token NEVER leaves the main process, is NEVER logged, NEVER interpolated
 * into an Error message, NEVER written into any git config file or process
 * argv, and NEVER crosses the renderer / remote-WebSocket boundary. Tests pin
 * the error-string half; the transport pins the config/argv half.
 *
 * PURE-CORE / IO-SHELL: every I/O (fs, safeStorage, fetch, exec) is injectable
 * with a real default, matching github-auth.ts.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveCommand } from './prerequisite-installer';
import { detectGh, type FetchLike, type ExecFn } from './github-auth';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Typed error code
// ---------------------------------------------------------------------------

/**
 * Marker carried on thrown errors (as `err.syncErrorCode`) and forwarded onto
 * sync 'error' events (as `errorCode`) so the renderer can show a "Connect
 * GitHub" CTA instead of a bare "Try again" — string-matching prose would
 * break the moment copy is edited.
 */
export const GITHUB_AUTH_ERROR_CODE = 'github-auth';

/** Plain-language errors per docs/error-message-standards.md — specific and
 *  accurate, and they carry the typed code so the UI can act on them. */
function notConnectedError(): Error {
  const e: any = new Error('Not connected to GitHub — connect your GitHub account in the Sync settings');
  e.syncErrorCode = GITHUB_AUTH_ERROR_CODE;
  return e;
}
/** Coded refusal for a PUBLIC repo (shared with sync-spaces/repo-visibility.ts). */
const REPO_PUBLIC_ERROR_CODE = 'repo-public';
export function repoPublicError(repoName: string): Error {
  const e: any = new Error(
    `Sync is paused because the GitHub repository "${repoName}" is public, so anyone could read what YouCoded syncs there. ` +
    'Make it private on GitHub (Settings, then Danger Zone), or delete it so YouCoded can create a private one, then try again.',
  );
  e.syncErrorCode = REPO_PUBLIC_ERROR_CODE;
  return e;
}
function authExpiredError(): Error {
  const e: any = new Error('GitHub sign-in expired — reconnect your GitHub account in the Sync settings');
  e.syncErrorCode = GITHUB_AUTH_ERROR_CODE;
  return e;
}

// ---------------------------------------------------------------------------
// Injectable I/O
// ---------------------------------------------------------------------------

/** The subset of Electron's safeStorage this module uses. Injectable because
 *  unit tests run outside Electron. `null` forces the plaintext-file fallback. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface GithubClientOpts {
  /** Per-install Electron userData dir (see the storage WHY above). */
  storageDir: string;
  safeStorage?: SafeStorageLike | null;
  fetchFn?: FetchLike;
  execFn?: ExecFn;
  log?: (m: string) => void;
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit);
const defaultExec: ExecFn = async (cmd, args, opts) => {
  const { stdout, stderr } = await execFileAsync(resolveCommand(cmd), args, { encoding: 'utf8', ...opts });
  return { stdout: String(stdout), stderr: String(stderr) };
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface GithubTokenInfo {
  token: string;
  /** 'app' = our stored device-flow token; 'gh' = borrowed live from `gh auth token`. */
  source: 'app' | 'gh';
}

export interface GithubClientStatus {
  /** A usable token exists (stored or via gh). */
  connected: boolean;
  source: 'app' | 'gh' | null;
  /** Login handle recorded at connect time (app) — gh's own handle is merged
   *  in by combinedGithubStatus, not here (it needs a gh exec). */
  login?: string;
  /** True when the stored token had to be written WITHOUT OS-keychain
   *  encryption (Linux without a secret service). Never silent — surfaced so
   *  the UI can say so. */
  degradedStorage: boolean;
}

export interface GithubClient {
  /** Persist the device-flow token (+ login when known). Returns whether
   *  storage had to degrade to the plaintext 0600 file. */
  setToken(token: string, login?: string): Promise<{ degraded: boolean }>;
  clearToken(): void;
  /** Acquisition order: stored app token → `gh auth token` → null. Cached
   *  briefly — sync calls this once per git invocation. */
  getToken(): Promise<GithubTokenInfo | null>;
  status(): Promise<GithubClientStatus>;
  /** Create (or adopt, when it already exists) a private repo; returns its
   *  https clone URL. Replaces `gh repo create/view`. */
  createPrivateRepo(name: string): Promise<string>;
  /**
   * Generic REST call for the gh-CLI conversions (publishing forks/branches/
   * contents/PRs, issue creation, PR search). Returns {status, json} — the
   * CALLER interprets non-2xx statuses (a 422 can be "already exists" =
   * success). Throws only: coded not-connected (no token, unless
   * `anonymous: true` — the search API works unauthenticated at 60 req/hr),
   * coded auth-expired on 401, and named transport errors. The token rides
   * the Authorization header only — never the path, body, or any error.
   */
  api(method: string, apiPath: string, body?: object, opts?: { anonymous?: boolean }): Promise<{ status: number; json: any }>;
  /** GET /user → login for the CURRENT token. Throws coded not-connected /
   *  auth-expired — replaces `gh api user --jq .login` in the publishers. */
  fetchAuthedLogin(): Promise<string>;
}

/** On-disk shape of <userData>/github-token.json. `data` is base64: of the
 *  safeStorage ciphertext when `encrypted`, of the raw token when not (the
 *  base64 there is NOT protection — the 0600 mode + explicit degraded warning
 *  are the honest story on keychain-less Linux). */
interface StoredTokenFile { v: 1; encrypted: boolean; data: string; login?: string }

const TOKEN_FILE = 'github-token.json';
const TOKEN_CACHE_MS = 60_000; // sync asks per git call — don't re-read fs / re-exec gh each time

export function createGithubClient(opts: GithubClientOpts): GithubClient {
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const execFn = opts.execFn ?? defaultExec;
  const log = opts.log ?? (() => {});
  const file = path.join(opts.storageDir, TOKEN_FILE);

  let cache: { value: GithubTokenInfo | null; at: number } | null = null;

  function readStored(): StoredTokenFile | null {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  function storedToken(): string | null {
    const s = readStored();
    if (!s || typeof s.data !== 'string') return null;
    try {
      if (s.encrypted) {
        // Ciphertext without a working safeStorage (keyring gone, or the file
        // was copied from another machine) is unreadable — treat as no token,
        // never throw: callers fall through to gh / "connect GitHub".
        if (!opts.safeStorage?.isEncryptionAvailable()) return null;
        return opts.safeStorage.decryptString(Buffer.from(s.data, 'base64'));
      }
      return Buffer.from(s.data, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }

  async function ghToken(): Promise<string | null> {
    try {
      const { stdout } = await execFn('gh', ['auth', 'token'], { timeout: 10_000 });
      const t = stdout.trim();
      return t.length > 0 ? t : null;
    } catch {
      return null; // gh missing or unauthed — both mean "no token from gh"
    }
  }

  async function getToken(): Promise<GithubTokenInfo | null> {
    if (cache && Date.now() - cache.at < TOKEN_CACHE_MS) return cache.value;
    const app = storedToken();
    const value: GithubTokenInfo | null = app
      ? { token: app, source: 'app' }
      : await ghToken().then((t) => (t ? { token: t, source: 'gh' as const } : null));
    cache = { value, at: Date.now() };
    return value;
  }

  async function setToken(token: string, login?: string): Promise<{ degraded: boolean }> {
    const canEncrypt = !!opts.safeStorage?.isEncryptionAvailable();
    const payload: StoredTokenFile = canEncrypt
      ? { v: 1, encrypted: true, data: opts.safeStorage!.encryptString(token).toString('base64'), login }
      : { v: 1, encrypted: false, data: Buffer.from(token, 'utf8').toString('base64'), login };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Temp-file + rename (atomic) with 0600 from the first byte — the token
    // must never exist on disk world-readable, even transiently.
    // pid-suffixed temp name: two processes sharing ~/.claude must not race the same .tmp
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, file);
    cache = null;
    if (!canEncrypt) {
      // Explicit degraded policy (never silent): no OS keychain available, so
      // the token sits in a file only filesystem permissions protect.
      log('github-client: OS keychain encryption unavailable — GitHub token stored as a 0600 file without encryption');
    }
    return { degraded: !canEncrypt };
  }

  function clearToken(): void {
    try { fs.rmSync(file, { force: true }); } catch { /* nothing to clear */ }
    cache = null;
  }

  async function status(): Promise<GithubClientStatus> {
    const stored = readStored();
    const info = await getToken();
    return {
      connected: !!info,
      source: info?.source ?? null,
      // Login is only authoritative for the app token (recorded at connect);
      // a gh-sourced login needs a gh exec, which combinedGithubStatus does.
      login: info?.source === 'app' ? stored?.login : undefined,
      degradedStorage: !!stored && !stored.encrypted,
    };
  }

  // -------------------------------------------------------------------------
  // REST
  // -------------------------------------------------------------------------

  async function rest(token: string | null, method: string, apiPath: string, body?: object): Promise<{ status: number; json: any }> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchFn(`https://api.github.com${apiPath}`, {
        method,
        headers: {
          // token may be null only on anonymous calls (search API) — the
          // Authorization header is simply omitted then.
          ...(token ? { Authorization: `token ${token}` } : {}),
          Accept: 'application/vnd.github+json',
          'User-Agent': 'YouCoded',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err: any) {
      // Transport-level failure — offline/DNS/timeout. Named as such so it is
      // never confused with an auth failure (which would tell the user to
      // reconnect for no reason).
      throw new Error(`Could not reach GitHub (${String(err?.message ?? err)}) — check your internet connection`);
    }
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  async function api(method: string, apiPath: string, body?: object, apiOpts?: { anonymous?: boolean }): Promise<{ status: number; json: any }> {
    const info = await getToken();
    if (!info && !apiOpts?.anonymous) throw notConnectedError();
    const out = await rest(info?.token ?? null, method, apiPath, body);
    // 401 with a token = the credential is dead — every caller wants the same
    // typed "reconnect" signal, so centralize it. (Anonymous 401s can't happen;
    // anonymous rate-limit rejections are 403 and stay caller-interpreted.)
    if (out.status === 401 && info) throw authExpiredError();
    return out;
  }

  async function fetchAuthedLogin(): Promise<string> {
    const user = await api('GET', '/user');
    const login = user.json?.login ? String(user.json.login) : null;
    if (!login) throw new Error(`GitHub could not identify this account (HTTP ${user.status})`);
    return login;
  }

  async function createPrivateRepo(name: string): Promise<string> {
    const info = await getToken();
    if (!info) throw notConnectedError();
    const { token } = info;

    const created = await rest(token, 'POST', '/user/repos', { name, private: true });
    if (created.status === 201 && created.json?.clone_url) return String(created.json.clone_url);
    if (created.status === 401) throw authExpiredError();

    // 422 = validation failed, in practice "name already exists on this
    // account". That is SUCCESS for us (same contract as the old gh path): the
    // state file recording provisioned URLs is per-device, so a second device
    // re-runs creation for repos the first device already made. Confirm by
    // looking the repo up rather than trusting the message text.
    if (created.status === 422) {
      const user = await rest(token, 'GET', '/user');
      if (user.status === 401) throw authExpiredError();
      const login = user.json?.login ? String(user.json.login) : null;
      if (login) {
        const existing = await rest(token, 'GET', `/repos/${login}/${encodeURIComponent(name)}`);
        if (existing.status === 200 && existing.json?.clone_url) {
          // WHY (security hardening 2026-10-30): adopting a same-named repo is only safe if it is
          // PRIVATE — otherwise the user's conversations/files would be pushed somewhere public.
          // Strictly `=== true`: a missing field is treated as "not proven private".
          if (existing.json.private !== true) throw repoPublicError(name);
          return String(existing.json.clone_url);
        }
      }
    }

    // Genuine failure — surface GitHub's own message (it never contains the
    // token) plus the status, per the no-misleading-errors rule.
    const detail = created.json?.message ? `: ${String(created.json.message)}` : '';
    throw new Error(`GitHub could not create repository "${name}" (HTTP ${created.status})${detail}`);
  }

  return { setToken, clearToken, getToken, status, createPrivateRepo, api, fetchAuthedLogin };
}

// ---------------------------------------------------------------------------
// Login lookup (shared by github-connect's done payload and status)
// ---------------------------------------------------------------------------

/** Best-effort GET /user → login for a freshly minted token. Works with no gh
 *  installed (the whole point of Phase 2). Throws only Error('network'). */
export async function fetchGithubLogin(token: string, fetchFn: FetchLike = defaultFetch): Promise<string | undefined> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn('https://api.github.com/user', {
      method: 'GET',
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'YouCoded' },
    });
  } catch {
    throw new Error('network');
  }
  const json = await res.json().catch(() => null);
  return json?.login ? String(json.login) : undefined;
}

// ---------------------------------------------------------------------------
// Combined status (the github:status IPC payload)
// ---------------------------------------------------------------------------

export interface CombinedGithubStatus {
  /** gh CLI presence — the connect modal still offers "Install GitHub CLI"
   *  for the terminal-agent story, so this stays a gh fact. */
  installed: boolean;
  /** True when ANY usable credential exists: stored app token OR gh login.
   *  This is the field SyncPanel's enable-preflight gates on. */
  authed: boolean;
  login?: string;
  source: 'app' | 'gh' | null;
  degradedStorage: boolean;
}

/** One status object covering both credential sources. Keeps the legacy
 *  {installed, authed, login} shape (additive fields only) so older remote
 *  clients / the Android shim keep working. */
export async function combinedGithubStatus(
  detectGhFn: typeof detectGh = detectGh,
  client: GithubClient | null = getGithubClient(),
): Promise<CombinedGithubStatus> {
  const gh = await detectGhFn();
  let cs: GithubClientStatus = { connected: false, source: null, degradedStorage: false };
  if (client) {
    try { cs = await client.status(); } catch { /* status read is best-effort */ }
  }
  return {
    installed: gh.installed,
    authed: gh.authed || cs.connected,
    login: cs.login ?? gh.login,
    source: cs.source ?? (gh.authed ? 'gh' : null),
    degradedStorage: cs.degradedStorage,
  };
}

// ---------------------------------------------------------------------------
// Module singleton (mirrors github-connect.ts / sync-state.ts patterns)
// ---------------------------------------------------------------------------

let singleton: GithubClient | null = null;

/** Register the process-wide client (called once from main.ts, BEFORE
 *  startSyncSpaces — provisioning reads it via getGithubClient). */
export function setGithubClient(c: GithubClient | null): void {
  singleton = c;
}

export function getGithubClient(): GithubClient | null {
  return singleton;
}
