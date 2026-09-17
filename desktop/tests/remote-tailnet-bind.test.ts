import { describe, expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

/**
 * Contract row R10: other devices reach this computer only through Tailscale; its direct
 * home-network address no longer answers. This used to be a source-text pin on the exact
 * `server.listen(this.config.port, this.bindAddress ?? undefined, …)` call shape — it broke on
 * any rename or reformat and proved nothing about a real bind. Rewritten (Plan B Task 4,
 * 2026-09-16) to actually start the server and inspect the socket it opens.
 *
 * WHY 127.0.0.1 instead of a tailnet IP: no CI runner has a tailnet interface, but loopback
 * exists on every OS this suite runs on (Linux/macOS/Windows). RemoteConfig.detectTailscale is
 * mocked to hand back that address, exactly as it would hand back a real tailnet IP — the code
 * under test (`start()` binding to `this.bindAddress`) does not know or care which address it is.
 *
 * `ws` is intentionally left unmocked here (unlike tests/remote-server.test.ts): the WebSocketServer
 * just attaches upgrade handling to the real http.Server, and no test below opens a socket to it.
 */

const detection: { installed: boolean; connected: boolean; ip: string | null } =
  { installed: true, connected: true, ip: '127.0.0.1' };

vi.mock('../src/main/remote-config', async () => {
  const actual = await vi.importActual<typeof import('../src/main/remote-config')>('../src/main/remote-config');
  return {
    ...actual,
    RemoteConfig: Object.assign(
      function RemoteConfigStub() { /* tests pass their own config object */ } as unknown as typeof actual.RemoteConfig,
      actual.RemoteConfig,
      {
        detectTailscale: vi.fn(async () => ({
          installed: detection.installed,
          connected: detection.connected,
          ip: detection.ip,
          hostname: 'test-host',
          url: detection.ip ? `http://test-host:9900` : null,
        })),
      },
    ),
  };
});

function makeServer() {
  // Typed `any`, matching tests/remote-server.test.ts: RemoteServer's real SessionManager/
  // HookRelay types carry many fields these tests never touch, and this file only exercises
  // start()'s bind/error paths.
  const mockSessionManager: any = Object.assign(new EventEmitter(), {
    listSessions: vi.fn(() => []),
    createSession: vi.fn(),
    destroySession: vi.fn(),
    sendInput: vi.fn(),
    resizeSession: vi.fn(),
  });
  const mockHookRelay: any = Object.assign(new EventEmitter(), { respond: vi.fn(() => true) });
  const config: any = {
    enabled: true,
    // Port 0 asks the OS for a free ephemeral port — a fixed port would collide
    // across parallel CI runners; see .claude/rules/test-suite-hygiene.md.
    port: 0,
    passwordHash: '$2b$10$fakehash',
    verifyPassword: vi.fn(async () => false),
  };
  return { mockSessionManager, mockHookRelay, config };
}

let server: import('../src/main/remote-server').RemoteServer | null = null;

afterEach(() => {
  // No fixed sleeps: stop() synchronously clears the ping/upload timers and closes
  // the real socket this suite opened, so nothing outlives the test.
  server?.stop();
  server = null;
  detection.installed = true;
  detection.connected = true;
  detection.ip = '127.0.0.1';
});

describe('the listener is private by construction', () => {
  it('binds the address Tailscale reports, not every interface', async () => {
    const { mockSessionManager, mockHookRelay, config } = makeServer();
    const { RemoteServer } = await import('../src/main/remote-server');
    server = new RemoteServer(mockSessionManager, mockHookRelay, config);

    await server.start();

    // Reach into the private httpServer the way tests/remote-files.test.ts reaches into
    // other private state — there is no public accessor, and adding one only for a test
    // would be a larger change than the pin it replaces.
    const address = (server as any).httpServer.address();
    expect(address.address).toBe('127.0.0.1');
    expect(address.port).toBeGreaterThan(0);
  });

  it('refuses to start without a private address instead of falling back', async () => {
    // The fallback IS the open listener this batch exists to remove: binding every
    // interface is what makes conversations readable by anything on the same wifi.
    detection.connected = false;
    detection.ip = null;
    const { mockSessionManager, mockHookRelay, config } = makeServer();
    const { RemoteServer } = await import('../src/main/remote-server');
    server = new RemoteServer(mockSessionManager, mockHookRelay, config);

    await expect(server.start()).rejects.toThrow(
      'Tailscale is installed but not connected, so there is no private address to listen on.',
    );
    expect(server.isRunning()).toBe(false);
  });

  it('says which of the two Tailscale problems it is', async () => {
    // "Not installed" and "installed but not connected" need different next steps, and
    // guessing between them is the invented-cause failure the standards forbid.
    detection.installed = false;
    detection.connected = false;
    detection.ip = null;
    const { mockSessionManager, mockHookRelay, config } = makeServer();
    const { RemoteServer } = await import('../src/main/remote-server');
    server = new RemoteServer(mockSessionManager, mockHookRelay, config);

    await expect(server.start()).rejects.toThrow(
      'Tailscale is not installed, so there is no private address to listen on.',
    );
  });
});
