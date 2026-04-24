// Dev-only page: renders every fixture through the real ToolCard/ToolBody so
// we can iterate on compact views with Vite HMR. Gated behind a query-param
// in App.tsx in dev builds — must not be reachable in prod builds.
//
// Why ChatProvider: ToolCard internally calls useChatDispatch() for click
// handlers (expand/collapse, approval), so it crashes outside the provider
// even though the fixtures don't actually drive the store's session state.

import React from 'react';
import { ChatProvider } from '../state/chat-context';
import ToolCard from '../components/ToolCard';
import { loadFixture } from './fixture-loader';

// Vite's import.meta.glob eagerly reads every fixture as a raw string at build
// time. We silence tsc because our tsconfig uses `module: "commonjs"` which
// rejects the `import.meta` syntax (TS1343) — Vite still rewrites this call
// statically during bundling, so the literal syntax must be preserved. Only
// Vite ever bundles this file; the Electron main process never loads it.
// @ts-ignore TS1343 — import.meta is intercepted by Vite at build time
const fixtures = import.meta.glob('./fixtures/*.jsonl', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export function ToolSandbox() {
  const entries = Object.entries(fixtures)
    .map(([path, raw]) => {
      const name = path.split('/').pop()!.replace(/\.jsonl$/, '');
      return { name, result: loadFixture(name, raw) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <ChatProvider>
      <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
        <h1 style={{ fontSize: 20, marginBottom: 16 }}>ToolCard Sandbox</h1>
        <p style={{ opacity: 0.7, marginBottom: 24, fontSize: 13 }}>
          Dev-only. Each card renders a real &lt;ToolCard&gt; against a fixture
          tool_use/tool_result pair. Edit ToolBody.tsx and save to see changes
          via HMR.
        </p>
        {entries.map(({ name, result }) => (
          <section key={name} style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 14, opacity: 0.6, marginBottom: 8 }}>{name}</h2>
            {result.error ? (
              <div style={{ color: 'tomato', fontFamily: 'monospace' }}>
                {result.error}
              </div>
            ) : (
              result.tools.map((tool) => (
                <ToolCard key={tool.toolUseId} tool={tool} />
              ))
            )}
          </section>
        ))}
      </div>
    </ChatProvider>
  );
}
