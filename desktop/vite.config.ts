import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

// Keep Vite's port in sync with the main process via YOUCODED_PORT_OFFSET.
// Duplicated (not imported from src/shared/ports.ts) because vite.config runs
// outside the main-process tsconfig.
const portOffset = Number(process.env.YOUCODED_PORT_OFFSET ?? 0);
const viteDevPort = 5173 + (Number.isFinite(portOffset) ? portOffset : 0);

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  server: {
    port: viteDevPort,
    strictPort: true,
    // Bind IPv4 loopback explicitly. Vite's default ('localhost') binds IPv6
    // [::1] only on some stacks, leaving 127.0.0.1 unreachable. RemoteServer's
    // dev proxy targets this server by address, so pinning the family here
    // makes that hop deterministic instead of depending on the runtime's
    // happy-eyeballs behavior. Hardening, not a bug fix — the dev-mode 502 was
    // caused by the proxy's hardcoded port (see remote-server.ts), not by this.
    host: '127.0.0.1',
    // VITE_NO_WATCH=1 disables file watching. WHY: on 2026-08-25 the review rig's
    // workbench died twice with ENOSPC — the live app plus one dev Electron
    // instance already held ~495k of the machine's 524k inotify watches, and a
    // watching Vite on a 12-worktree checkout needs more. A headless screenshot
    // sweep never edits files, so it doesn't need HMR; scripts/ui-review sets this.
    ...(process.env.VITE_NO_WATCH ? { watch: null } : {}),
  },
  base: './',
  build: {
    outDir: '../../dist/renderer',
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Marks non-release builds. desktop-test-build.yml sets this to 'BETA' so
    // Settings → About reads `YouCoded v1.3.0-beta (BETA)` — a dogfood build
    // installs over a real one and is otherwise indistinguishable. Empty for
    // release builds, which render unchanged. See src/shared/version-line.ts.
    __BUILD_CHANNEL__: JSON.stringify(process.env.YOUCODED_BUILD_CHANNEL ?? ''),
    __PARTYKIT_HOST__: JSON.stringify(process.env.VITE_PARTYKIT_HOST ?? null),
    // The photo-only build `shoot` photographs (scripts/shoot/, VITE_SHOOT=1 plus
    // VITE_WORKBENCH=1). Replaced by a literal at every use site so the screen
    // openers and marks in shoot-mode.tsx fold away in the real app AND in the
    // landing page's demo build, which strangers can click. Guard:
    // tests/shoot-build-guard.test.ts.
    __SHOOT__: JSON.stringify(process.env.VITE_SHOOT === '1'),
  },
});
