import { promises as fs } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { createServer, type Server } from 'http';
import { DRIVE_SCOPE, request, validateScope } from './google-api';

export interface DesktopClient { client_id: string; client_secret: string }
export interface GoogleToken { accessToken: string; refreshToken: string; expiresAt: number; scope: string }
export async function loadClient(file?: string): Promise<DesktopClient> {
  if (!file) throw new Error('Google desktop sign-in is not configured.');
  try {
    const stat = await fs.stat(file); if (stat.size > 16_384) throw new Error();
    const value = JSON.parse(await fs.readFile(file, 'utf8')).installed;
    if (!value || typeof value.client_id !== 'string' || !value.client_id || typeof value.client_secret !== 'string' || !value.client_secret) throw new Error();
    return { client_id: value.client_id, client_secret: value.client_secret };
  } catch { throw new Error('Google desktop sign-in configuration is unavailable.'); }
}
export async function exchange(fetcher: typeof fetch, client: DesktopClient, fields: Record<string, string>, old?: GoogleToken): Promise<GoogleToken> {
  const value = await request(fetcher, 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, ...fields }).toString() });
  // Refresh responses may omit scope: only inherit a previously validated drive.file scope.
  const scope = value.scope ?? old?.scope; validateScope(scope);
  if (typeof value.access_token !== 'string' || !value.access_token || (!old && (typeof value.refresh_token !== 'string' || !value.refresh_token)) || typeof value.expires_in !== 'number' || value.expires_in <= 0) throw new Error('Google sign-in returned incomplete credentials. Reconnect this account.');
  return { accessToken: value.access_token, refreshToken: typeof value.refresh_token === 'string' ? value.refresh_token : old!.refreshToken, expiresAt: Date.now() + Math.min(value.expires_in, 86400) * 1000, scope };
}
export interface PickerFlow { url: string; close: () => void; result: Promise<{ code: string; ids: string[]; redirectUri: string; verifier: string }> }
export async function picker(client: DesktopClient): Promise<PickerFlow> {
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
  let redirectUri = '', claimed = false;
  let resolve!: (value: { code: string; ids: string[]; redirectUri: string; verifier: string }) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<Parameters<typeof resolve>[0]>((ok, fail) => { resolve = ok; reject = fail; });
  // Attach immediately; a cancellation must not produce an unhandled rejection before its owner awaits it.
  void result.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closeServer = (server: Server) => { if (timer) clearTimeout(timer); server.close(); server.closeAllConnections(); };
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const bad = () => { res.writeHead(400); res.end('Invalid Google sign-in callback.'); };
    if (claimed || req.method !== 'GET' || !req.url || req.url.length > 16_384) return bad();
    let url: URL; try { url = new URL(req.url, redirectUri); } catch { return bad(); }
    const p = url.searchParams;
    if (url.origin !== new URL(redirectUri).origin || req.headers.host !== new URL(redirectUri).host || url.pathname !== '/google-files/callback' || p.getAll('state').length !== 1 || p.get('state') !== state || [...new Set(p.keys())].some(key => p.getAll(key).length !== 1)) return bad();
    if (p.has('error')) {
      claimed = true; res.end('Google sign-in was cancelled. You may close this tab.'); closeServer(server); reject(new Error('Google sign-in was cancelled.')); return;
    }
    const code = p.get('code'), picked = p.get('picked_file_ids');
    if (!code || code.length > 4096 || p.getAll('code').length !== 1 || picked === null) return bad();
    const ids = [...new Set(picked.split(',').filter(Boolean))];
    if (!ids.length || ids.length > 100 || ids.some(id => id.length > 256 || !/^[\w-]+$/.test(id))) return bad();
    claimed = true; res.end('Google files selected. You may close this tab and return to YouCoded.');
    // WHY: finish the callback response before closing idle connections; no token ever enters this page.
    res.once('finish', () => closeServer(server));
    resolve({ code, ids, redirectUri, verifier });
  });
  server.maxHeadersCount = 30; server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => { server.removeListener('error', fail); ok(); }); });
  server.on('error', () => { closeServer(server); reject(new Error('Google sign-in callback is unavailable.')); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Google sign-in callback is unavailable.');
  redirectUri = `http://127.0.0.1:${address.port}/google-files/callback`;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', scope: DRIVE_SCOPE, access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', trigger_onepick: 'true', allow_multiple: 'true' }).toString();
  const close = () => { claimed = true; closeServer(server); reject(new Error('Google sign-in was cancelled.')); };
  timer = setTimeout(() => { claimed = true; closeServer(server); reject(new Error('Google sign-in timed out. Try again.')); }, 5 * 60_000); timer.unref();
  return { url: url.toString(), close, result };
}
