// TEST-MODE ONLY control surface: lets the rig drive a running backend (create a set, pair, send, remove, go offline)
// the way a screen later will. Started by boot-hook.ts ONLY when config.ts says test mode AND the rig supplied a token.
// A packaged build never reaches it (config.ts refuses test mode there).
//
// SAFETY: binds 127.0.0.1 on a random port; every request needs `Authorization: Bearer <token>` (compared in constant
// time; the token comes from the environment the rig made and is never logged); a request with an `Origin` header is
// refused (a web page cannot drive it); one JSON object per request; bodies capped. The port is announced once on stdout
// as `YOUCODED_MESH_TEST_CONTROL <port>`: a port is not a secret.
// It returns identifiers and pairing messages the rig must move. It can show the typed pairing code (a person would read
// it off the screen): the rig keeps it out of every log, and this file never logs request or response bodies.
import http from 'http';
import { timingSafeEqual } from 'crypto';
import type { AddressInfo } from 'net';
import type { MeshService } from './service';

const MAX_BODY = 8 * 1024 * 1024;
const b64 = (b: Buffer): string => b.toString('base64');
const unb64 = (s: unknown): Buffer => Buffer.from(String(s ?? ''), 'base64');

type Json = Record<string, unknown>;

async function route(svc: MeshService, path: string, q: Json): Promise<Json> {
  switch (path) {
    case '/status': return { ...svc.status() };
    case '/create-set': await svc.createSet(); return { ok: true };
    case '/pair/open': return { ...svc.openPairing() };
    // Through the relay's meeting point (the product path); the direct routes below stay as the hostile-pipe test carrier.
    case '/pair/open-relay': return { ...(await svc.openPairingViaRelay()) };
    case '/pair/join-relay': await svc.joinWithCode(String(q.code)); return { ok: true };
    case '/pair/join-status': return { ...svc.joinStatus() };
    case '/pair/state': return { ...svc.pairingState() };
    case '/pair/prompt': return { prompt: svc.pairingPrompt() };
    case '/pair/msg': return { out: svc.hostPairingMessage(String(q.conn), unb64(q.b64)).map(b64) };
    case '/pair/decide': return { out: (await svc.hostPairingDecide(String(q.conn), q.approve === true)).map(b64) };
    case '/pair/join': return { first: b64(svc.joinStart({ room: Buffer.from(String(q.room), 'hex'), code: String(q.code) })) };
    case '/pair/join-msg': { const r = await svc.joinMessage(unb64(q.b64)); return { out: r.out.map(b64), stage: r.stage, sas: r.sas, done: r.done, failed: r.failed }; }
    case '/send': return { ...(await svc.sendNote(String(q.text), q.to ? String(q.to) : undefined)) };
    case '/inbox': return { items: svc.inbox };
    case '/remove': return { ok: true, outcome: await svc.removeDevice(String(q.device)) };
    case '/rename': await svc.renameSelf(String(q.name)); return { ok: true };
    case '/reset-position': await svc.resetReadPosition(); return { ok: true };
    case '/offline': svc.setOffline(q.offline !== false); return { ok: true };
    case '/stress-append': return { done: await svc.stressAppend(Number(q.n) || 0) };
    // The replicator (only when the process was started with YOUCODED_MESH_REPLICATOR=1): lines travel as base64.
    case '/rep/create': await svc.repCreate(Buffer.from(String(q.version), 'hex'), String(q.chat ?? 'rig:chat')); return { ok: true };
    case '/rep/append': return { ...(await svc.repAppend(Buffer.from(String(q.version), 'hex'), (Array.isArray(q.lines) ? q.lines : []).map(unb64))) };
    case '/rep/heads': return { heads: await svc.repHeads() };
    case '/rep/read': return { lines: (await svc.repRead(Buffer.from(String(q.version), 'hex'), Number(q.from) || 0, Number(q.to) || 0)).map(b64), ok: await svc.repVerify(Buffer.from(String(q.version), 'hex')) };
    default: throw Object.assign(new Error('no such route'), { status: 404 });
  }
}

export async function startTestControl(svc: MeshService, token: string): Promise<{ port: number; close: () => Promise<void> }> {
  const want = Buffer.from(token);
  const server = http.createServer((req, res) => {
    const reply = (status: number, body: Json): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const got = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (req.headers.origin || got.length !== want.length || !timingSafeEqual(got, want)) return reply(401, { error: 'unauthorized' });
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      void (async () => {
        try {
          const q = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json) : {};
          reply(200, await route(svc, (req.url ?? '/').split('?')[0], q));
        } catch (e) {
          const status = (e as { status?: number }).status ?? 500;
          // The message of an error thrown by our own code (never a body or a key): a fixed phrase per cause.
          reply(status, { error: e instanceof Error ? e.message : 'failed' });
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  console.log(`YOUCODED_MESH_TEST_CONTROL ${port}`);
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}
