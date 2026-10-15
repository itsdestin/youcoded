// remote-dev-proxy.ts — a dev instance's remote door hands its page to the Vite dev server.
//
// Moved out of remote-server.ts unchanged (2026-10-14, Android clean rebuild P1) to keep that file inside
// its line budget while it gained local mode. Dev only: a built app serves its own copy of the page.
import http from 'http';
import type { Duplex } from 'stream';

/** One HTTP request, passed through to Vite; a dead dev server answers 502. */
export function proxyHttpToVite(req: http.IncomingMessage, res: http.ServerResponse, viteUrl: string): void {
  const url = new URL(req.url || '/', viteUrl);
  const proxyReq = http.request(url, {
    method: req.method,
    headers: req.headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    res.writeHead(502);
    res.end('Vite dev server not available');
  });
  req.pipe(proxyReq);
}

/** WebSocket upgrades other than the door's own /ws go to Vite, for hot reload. */
export function proxyUpgradesToVite(server: http.Server, viteDevUrl: string): void {
  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, _head: Buffer) => {
    if (req.url === '/ws') return; // handled by the door's WebSocketServer
    // Use http:// URL — WebSocket upgrade is an HTTP request with Upgrade header
    const proxyUrl = new URL(req.url || '/', viteDevUrl);
    const proxyReq = http.request(proxyUrl, {
      method: 'GET',
      headers: req.headers,
    });
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
        '\r\n\r\n'
      );
      if (proxyHead.length) socket.write(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    proxyReq.on('error', () => socket.destroy());
    proxyReq.end();
  });
}
