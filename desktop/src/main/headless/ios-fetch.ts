// ios-fetch.ts — `fetch` for the iPhone app's backend, built on Node's own http/https modules.
//
// WHY this exists (2026-11-25, iPhone app, card #89): the iPhone app runs this backend on the Node build that exists
// for iOS (nodejs-mobile, Node 18). Apple forbids apps from generating machine code at runtime, so that Node runs
// with V8's JIT switched off — and with the JIT off, V8 has no WebAssembly at all. Node 18's built-in `fetch`
// (undici) parses HTTP with a WebAssembly parser, so every built-in fetch on the phone fails with
// "WebAssembly is not defined". Every provider call, sign-in and download in the backend goes through `fetch`.
//
// Node's http/https modules use the C parser and work without WebAssembly, so this is `fetch` rebuilt on them. It
// returns the platform's own `Response`/`Headers` objects (those classes construct fine without WebAssembly), with a
// real web ReadableStream body, so streaming replies (server-sent events read through `response.body.getReader()`)
// behave exactly as with the built-in.
//
// Scope: what the backend uses — methods, headers, string/bytes/URLSearchParams/FormData/Blob/stream bodies,
// AbortSignal, redirects (follow/manual/error), gzip/deflate/brotli. No cookies, no cache, no CORS (a server-side
// fetch has none of those either).
import http from 'http';
import https from 'https';
import zlib from 'zlib';
import { Readable } from 'stream';
import type { ReadableStream as NodeWebReadableStream } from 'stream/web';

const MAX_REDIRECTS = 20;
/** Statuses whose responses must not carry a body (the Response constructor throws if one is given). */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

type BodySource = { bytes: Buffer | null; stream: Readable | null; contentType: string | null };

function abortError(signal: AbortSignal | null | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}

/** Turn any body `fetch` accepts into bytes (replayable across a redirect) or a one-shot stream. */
async function readBody(body: unknown): Promise<BodySource> {
  if (body == null) return { bytes: null, stream: null, contentType: null };
  if (typeof body === 'string') return { bytes: Buffer.from(body, 'utf8'), stream: null, contentType: 'text/plain;charset=UTF-8' };
  if (body instanceof URLSearchParams) return { bytes: Buffer.from(body.toString(), 'utf8'), stream: null, contentType: 'application/x-www-form-urlencoded;charset=UTF-8' };
  if (Buffer.isBuffer(body)) return { bytes: body, stream: null, contentType: null };
  if (body instanceof ArrayBuffer) return { bytes: Buffer.from(body), stream: null, contentType: null };
  if (ArrayBuffer.isView(body)) return { bytes: Buffer.from(body.buffer, body.byteOffset, body.byteLength), stream: null, contentType: null };
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return { bytes: Buffer.from(await body.arrayBuffer()), stream: null, contentType: body.type || null };
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    // The platform's own Response serialises a form (boundary and all) without touching the network.
    const r = new Response(body);
    return { bytes: Buffer.from(await r.arrayBuffer()), stream: null, contentType: r.headers.get('content-type') };
  }
  if (body instanceof Readable) return { bytes: null, stream: body, contentType: null };
  if (typeof (body as { getReader?: unknown }).getReader === 'function') {
    return { bytes: null, stream: Readable.fromWeb(body as NodeWebReadableStream), contentType: null };
  }
  if (typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
    return { bytes: null, stream: Readable.from(body as AsyncIterable<Uint8Array>), contentType: null };
  }
  return { bytes: Buffer.from(String(body), 'utf8'), stream: null, contentType: 'text/plain;charset=UTF-8' };
}

function decompress(res: http.IncomingMessage, method: string): Readable {
  const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
  if (method === 'HEAD' || !encoding || encoding === 'identity') return res;
  // Z_SYNC_FLUSH: a streamed reply (events arriving one at a time) is compressed in flushed pieces, and a decoder
  // waiting for the "final" block would hold every event until the connection closed.
  const flushOpts = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH };
  let decoder: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress;
  if (encoding === 'gzip' || encoding === 'x-gzip') decoder = zlib.createGunzip(flushOpts);
  else if (encoding === 'deflate') decoder = zlib.createInflate(flushOpts);
  else if (encoding === 'br') decoder = zlib.createBrotliDecompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
  else return res;
  res.on('error', (e) => decoder.destroy(e));
  // A connection cut mid-reply must surface as an error to the reader, never as a clean end of a truncated body.
  res.on('aborted', () => decoder.destroy(Object.assign(new Error('terminated'), { code: 'ECONNRESET' })));
  return res.pipe(decoder);
}

function toHeaders(raw: string[]): Headers {
  const h = new Headers();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    try { h.append(raw[i], raw[i + 1]); } catch { /* a header the platform refuses to represent is dropped */ }
  }
  return h;
}

interface Attempt {
  url: URL;
  method: string;
  headers: Headers;
  body: BodySource;
  signal: AbortSignal | null;
  redirect: 'follow' | 'manual' | 'error';
  hops: number;
}

function once(a: Attempt): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (a.signal?.aborted) { reject(abortError(a.signal)); return; }
    if (a.url.protocol !== 'http:' && a.url.protocol !== 'https:') {
      reject(new TypeError(`fetch failed: unsupported protocol ${a.url.protocol}`));
      return;
    }
    const headers: Record<string, string> = {};
    a.headers.forEach((v, k) => { headers[k] = v; });
    if (!('accept' in headers)) headers.accept = '*/*';
    if (!('accept-encoding' in headers)) headers['accept-encoding'] = 'gzip, deflate, br';
    if (!('user-agent' in headers)) headers['user-agent'] = 'node';
    if (a.body.bytes && !('content-length' in headers)) headers['content-length'] = String(a.body.bytes.length);
    if (a.body.contentType && !('content-type' in headers)) headers['content-type'] = a.body.contentType;

    const lib = a.url.protocol === 'https:' ? https : http;
    const req = lib.request(a.url, { method: a.method, headers });
    let settled = false;
    const onAbort = () => { req.destroy(abortError(a.signal)); };
    a.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => a.signal?.removeEventListener('abort', onAbort);

    req.on('error', (e) => {
      if (settled) return;
      settled = true; cleanup();
      if (a.signal?.aborted) { reject(abortError(a.signal)); return; }
      // The built-in reports every network failure as TypeError('fetch failed') with the real error as `cause`;
      // provider-failure sorting reads both.
      reject(Object.assign(new TypeError('fetch failed'), { cause: e }));
    });

    req.on('response', (res) => {
      if (settled) { res.destroy(); return; }
      settled = true;
      const status = res.statusCode ?? 0;
      const location = res.headers.location;

      if (REDIRECT_STATUS.has(status) && location && a.redirect !== 'manual') {
        res.resume(); cleanup();
        if (a.redirect === 'error') { reject(new TypeError('fetch failed: unexpected redirect')); return; }
        if (a.hops >= MAX_REDIRECTS) { reject(new TypeError('fetch failed: redirect count exceeded')); return; }
        let next: URL;
        try { next = new URL(location, a.url); } catch { reject(new TypeError('fetch failed: invalid redirect')); return; }
        const nextHeaders = new Headers(a.headers);
        let method = a.method;
        let body = a.body;
        // The fetch standard: 303 always becomes GET; 301/302 turn a POST into GET; 307/308 keep method and body.
        if (status === 303 || ((status === 301 || status === 302) && a.method === 'POST')) {
          method = a.method === 'HEAD' ? 'HEAD' : 'GET';
          body = { bytes: null, stream: null, contentType: null };
          for (const h of ['content-length', 'content-type', 'content-encoding', 'content-language', 'content-location']) nextHeaders.delete(h);
        } else if (a.body.stream) {
          reject(new TypeError('fetch failed: cannot follow a redirect with a streamed request body'));
          return;
        }
        // Credentials never follow a redirect to another site.
        if (next.origin !== a.url.origin) {
          for (const h of ['authorization', 'cookie', 'proxy-authorization']) nextHeaders.delete(h);
        }
        once({ ...a, url: next, method, headers: nextHeaders, body, hops: a.hops + 1 }).then(resolve, reject);
        return;
      }

      const resHeaders = toHeaders(res.rawHeaders);
      const init = { status, statusText: res.statusMessage ?? '', headers: resHeaders };
      let response: Response;
      if (NULL_BODY_STATUS.has(status) || a.method === 'HEAD') {
        res.resume(); cleanup();
        response = new Response(null, init);
      } else {
        const stream = decompress(res, a.method);
        if (stream !== res) {
          // Decoded bytes no longer match these two headers; the built-in drops them the same way.
          resHeaders.delete('content-encoding');
          resHeaders.delete('content-length');
        } else {
          res.on('aborted', () => res.destroy(Object.assign(new Error('terminated'), { code: 'ECONNRESET' })));
        }
        // An abort after headers arrived must end the body read with the abort error (how a "Stop" ends a reply).
        const onBodyAbort = () => { stream.destroy(abortError(a.signal)); req.destroy(); };
        cleanup();
        a.signal?.addEventListener('abort', onBodyAbort, { once: true });
        const done = () => a.signal?.removeEventListener('abort', onBodyAbort);
        stream.once('end', done); stream.once('error', done); stream.once('close', done);
        response = new Response(Readable.toWeb(stream) as unknown as BodyInit, init);
      }
      // `url` and `redirected` are read-only on a constructed Response; callers read them after redirects.
      Object.defineProperty(response, 'url', { value: a.url.href, configurable: true });
      Object.defineProperty(response, 'redirected', { value: a.hops > 0, configurable: true });
      resolve(response);
    });

    if (a.body.stream) {
      a.body.stream.on('error', (e) => req.destroy(e));
      a.body.stream.pipe(req);
    } else {
      req.end(a.body.bytes ?? undefined);
    }
  });
}

/** `fetch`, without WebAssembly. Same call shape as the built-in. */
export async function iosFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const req = isRequest ? (input as Request) : null;
  const url = new URL(req ? req.url : String(input));
  const method = String(init.method ?? req?.method ?? 'GET').toUpperCase();
  const headers = new Headers(req?.headers);
  if (init.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
  const signal = (init.signal ?? req?.signal ?? null) as AbortSignal | null;
  if (signal?.aborted) throw abortError(signal);
  const rawBody = init.body !== undefined ? init.body : (req && method !== 'GET' && method !== 'HEAD' ? req.body : null);
  if (rawBody != null && (method === 'GET' || method === 'HEAD')) throw new TypeError('Request with GET/HEAD method cannot have body');
  const body = await readBody(rawBody);
  // A URL may carry its own sign-in (https://user:pass@host); http.request honours it, fetch forbids it.
  if (url.username || url.password) throw new TypeError('Request cannot be constructed from a URL that includes credentials');
  const redirect = (init.redirect ?? req?.redirect ?? 'follow') as 'follow' | 'manual' | 'error';
  return once({ url, method, headers, body, signal, redirect, hops: 0 });
}
