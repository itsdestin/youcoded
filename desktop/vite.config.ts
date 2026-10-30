import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildAppCsp } from './src/shared/app-csp';

// Keep Vite's port in sync with the main process via YOUCODED_PORT_OFFSET.
// Duplicated (not imported from src/shared/ports.ts) because vite.config runs
// outside the main-process tsconfig.
const portOffset = Number(process.env.YOUCODED_PORT_OFFSET ?? 0);
const viteDevPort = 5173 + (Number.isFinite(portOffset) ? portOffset : 0);

// WHY (2026-10-22 phone speed): a phone loads the connection code (remote-shim) by a dynamic import that only starts once the
// whole entry has downloaded and run — one more round trip (~0.5 s measured over a 470 ms link) before it even begins to
// connect. Naming that chunk and its own imports in the page lets the browser fetch them alongside the entry. The desktop
// window reads the same page from disk, where this costs nothing measurable.
const preloadConnectionCode = {
  name: 'youcoded-preload-connection-code',
  transformIndexHtml: {
    order: 'post' as const,
    handler(html: string, ctx: { bundle?: Record<string, { type: string; fileName: string; facadeModuleId?: string | null; imports?: string[] }> }) {
      if (!ctx.bundle) return [];
      const chunks = Object.values(ctx.bundle);
      const shim = chunks.find((c) => c.type === 'chunk' && c.facadeModuleId?.endsWith('/remote-shim.ts'));
      if (!shim) return [];
      return [shim.fileName, ...(shim.imports ?? [])].filter((file) => !html.includes(file)).map((file) => ({ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: true, href: `./${file}` }, injectTo: 'head' as const }));
    },
  },
};

// WHY the buddy's picture is shared (2026-10-22 phone speed, Destin approved): each YouCoded theme has five pose drawings
// (themes/builtin/assets/*-mascot-*.svg, written by scripts/brand/glass-buddy.py) and every one embeds the SAME glass
// picture — 103 KB in the day theme, 186 KB at night, so ~1.15 MB of the startup code was four extra copies. A phone browser
// on the plain-http remote address is only offered gzip, which cannot match repeats that far apart (it remembers 32 KB), so
// a phone downloaded all of them: 1.9 MB measured on Destin's phone. Each drawing is now built from its own few KB plus ONE
// shared copy of its picture, joined back into the identical text at runtime, so nothing on screen changes. The files on
// disk stay whole, so regenerating them needs no change here.
const MASCOT_SVG = /[\\/]themes[\\/]builtin[\\/]assets[\\/][^\\/]*mascot[^\\/]*\.svg\?raw$/;
const EMBEDDED_PICTURE = /data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]{4096,}/;
const sharedPictures = new Map<string, string>();
const shareMascotPictures = {
  name: 'youcoded-share-mascot-pictures',
  enforce: 'pre' as const,
  resolveId(id: string) { return id.startsWith('\0mascot-picture:') ? id : null; },
  load(id: string) {
    if (id.startsWith('\0mascot-picture:')) return `export default ${JSON.stringify(sharedPictures.get(id.slice('\0mascot-picture:'.length)) ?? '')};`;
    if (!MASCOT_SVG.test(id)) return null;
    const svg = readFileSync(id.replace(/\?raw$/, ''), 'utf8');
    const match = EMBEDDED_PICTURE.exec(svg);
    if (!match) return `export default ${JSON.stringify(svg)};`;
    const key = createHash('sha256').update(match[0]).digest('hex').slice(0, 16);
    sharedPictures.set(key, match[0]);
    const before = svg.slice(0, match.index);
    const after = svg.slice(match.index + match[0].length);
    return `import picture from ${JSON.stringify('\0mascot-picture:' + key)};\nexport default ${JSON.stringify(before)} + picture + ${JSON.stringify(after)};`;
  },
};

// WHY one startup file (2026-10-22 phone speed): once the big screens loaded on demand (App.tsx deferredScreen), the
// bundler split the code they share with startup into ~20 small files, all fetched before anything shows. A browser asks
// a computer for about six files at a time, and every round of asking costs a phone a round trip (~470 ms); the connection
// code ended up queued behind them (measured: 25 requests, the last connection file arriving ~0.4 s after the app code).
// So everything the page runs at startup — the app's static imports, and the connection code it fetches straight after —
// goes in one file. What only the on-demand screens use stays in their own files.
const STARTUP_ROOTS = [/[\\/]src[\\/]renderer[\\/]index\.tsx$/, /[\\/]src[\\/]renderer[\\/]remote-shim\.ts$/, /[\\/]src[\\/]renderer[\\/]last-computer\.ts$/];
type ModuleGraph = { getModuleInfo(id: string): { importers: readonly string[] } | null };
const startupMemo = new WeakMap<ModuleGraph, Map<string, boolean>>();
/** Whether `id` is a root, or is statically imported (at any depth) by one. Walks importers upward, memoised per build. */
function atStartup(id: string, graph: ModuleGraph): boolean {
  let memo = startupMemo.get(graph);
  if (!memo) startupMemo.set(graph, (memo = new Map()));
  const walk = (mid: string): boolean => {
    const known = memo!.get(mid);
    if (known !== undefined) return known;
    memo!.set(mid, false);   // a cycle answers "not through here"; a real path is found from another importer
    const yes = STARTUP_ROOTS.some((r) => r.test(mid)) || (graph.getModuleInfo(mid)?.importers ?? []).some(walk);
    memo!.set(mid, yes);
    return yes;
  };
  return walk(id);
}

// WHY (2026-10-30 security audit F4): the main page had no Content-Security-Policy. Stamped into index.html as a <meta> so
// it covers the desktop window (file://), a phone's browser and the Android WebView alike. Left out of the public landing-page
// demo build (`build:site`: VITE_WORKBENCH=1), which is a different product surface that fetches fixtures from other places.
// The policy and the reasons for each part: src/shared/app-csp.ts. Pinned by tests/app-csp.test.ts.
const appContentSecurityPolicy = {
  name: 'youcoded-content-security-policy',
  apply: (_config: unknown, env: { command: string }) => !(env.command === 'build' && process.env.VITE_WORKBENCH === '1'),
  // Written straight after <meta charset> (the charset tag must stay within the first 1024 bytes of the file, and the policy
  // must come before the first script and style it governs). The policy only uses single quotes, so a double-quoted attribute is safe.
  transformIndexHtml: {
    order: 'pre' as const,
    handler: (html: string) => html.replace(/(<meta charset="[^"]*"\s*\/?>)/i, `$1\n  <meta http-equiv="Content-Security-Policy" content="${buildAppCsp()}" />`),
  },
};

export default defineConfig({
  plugins: [shareMascotPictures, react(), preloadConnectionCode, appContentSecurityPolicy],
  // WHY: Vite resolves --outDir from this root, not the shell directory. build:site
  // therefore needs ../../../docs/site; ../docs/site silently left the public embed stale.
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
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: (id: string, ctx: ModuleGraph) => (atStartup(id, ctx) ? 'startup' : null) }],
        },
      },
    },
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
