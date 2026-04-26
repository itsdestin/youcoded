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
import { loadFixture, type FixtureBlock } from './fixture-loader';
import type { ToolCallState } from '../../shared/types';

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

// Skills float to the end of the turn in real chat (see AssistantTurnBubble
// extraction in Task 3); mirror that here so the sandbox shows the real
// layout outcome when we prototype the compact Skill variant.
function orderedBlocks(blocks: FixtureBlock[]): FixtureBlock[] {
  const skillBlocks: FixtureBlock[] = [];
  const otherBlocks: FixtureBlock[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool' && b.tool.toolName === 'Skill') {
      skillBlocks.push(b);
    } else {
      otherBlocks.push(b);
    }
  }
  return [...otherBlocks, ...skillBlocks];
}

// Walks the (already Skill-reordered) blocks. Consecutive non-Skill tools
// get wrapped in a shared bordered container with inGroup={true} on each
// card so they read visually as one tool group (mirrors the production
// CollapsedToolGroup styling without importing it — the import path
// caused a runtime crash, so we reproduce the visual outcome locally).
// Skill tools always render standalone — they extract from groups in
// production (Task 3) and we mirror that here.
function renderBlocks(blocks: FixtureBlock[]): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let toolBuffer: ToolCallState[] = [];

  function flushToolBuffer(key: string) {
    if (toolBuffer.length === 0) return;
    if (toolBuffer.length === 1) {
      const t = toolBuffer[0];
      out.push(<ToolCard key={t.toolUseId} tool={t} />);
    } else {
      out.push(
        <div key={key} className="border border-edge rounded-lg overflow-hidden my-1">
          <div className="px-2 py-1.5 space-y-0.5">
            {toolBuffer.map((t) => (
              <ToolCard key={t.toolUseId} tool={t} inGroup />
            ))}
          </div>
        </div>
      );
    }
    toolBuffer = [];
  }

  blocks.forEach((block, i) => {
    if (block.kind === 'text') {
      flushToolBuffer(`group-${i}`);
      out.push(
        <p key={`text-${i}`} style={{ margin: '8px 0', lineHeight: 1.5, opacity: 0.9 }}>
          {block.text}
        </p>
      );
    } else if (block.tool.toolName === 'Skill') {
      flushToolBuffer(`group-${i}`);
      out.push(<ToolCard key={block.tool.toolUseId} tool={block.tool} />);
    } else {
      toolBuffer.push(block.tool);
    }
  });
  flushToolBuffer('group-final');

  return out;
}

// Derive the group heading for a fixture: multi-block fixtures go under
// "Grouped turns"; single-tool fixtures group by their tool's name, with
// all mcp__*__* tools folded under "MCP" so ecosystem tools share one header.
function groupKey(name: string, blocks: FixtureBlock[]): string {
  if (name.startsWith('group-')) return 'Grouped turns';
  const firstTool = blocks.find((b) => b.kind === 'tool');
  if (!firstTool || firstTool.kind !== 'tool') return 'Other';
  const t = firstTool.tool.toolName;
  if (t.startsWith('mcp__')) return 'MCP';
  return t;
}

// Keep "Grouped turns" at the bottom of the page; the single-tool groups
// sort alphabetically above it so "Agent", "Bash", "Edit"... read in order.
function compareGroups(a: string, b: string): number {
  if (a === 'Grouped turns') return 1;
  if (b === 'Grouped turns') return -1;
  return a.localeCompare(b);
}

export function ToolSandbox() {
  const entries = Object.entries(fixtures).map(([path, raw]) => {
    const name = path.split('/').pop()!.replace(/\.jsonl$/, '');
    return { name, result: loadFixture(name, raw) };
  });

  // Bucket each fixture by its derived group, sort fixtures alphabetically
  // within each group.
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = groupKey(entry.name, entry.result.blocks);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }
  for (const list of groups.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const sortedGroups = Array.from(groups.entries()).sort((a, b) => compareGroups(a[0], b[0]));

  return (
    <ChatProvider>
      {/* App root CSS pins html/body to 100vh + overflow:hidden so chat/terminal
          panes can manage their own scroll. Sandbox is a normal document, so
          we opt the scroll back in on this outer container. */}
      <div style={{ height: '100vh', overflowY: 'auto' }}>
      <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
        <h1 style={{ fontSize: 20, marginBottom: 16 }}>ToolCard Sandbox</h1>
        <p style={{ opacity: 0.7, marginBottom: 24, fontSize: 13 }}>
          Dev-only. Each card renders a real &lt;ToolCard&gt; against a fixture
          tool_use/tool_result pair. Edit ToolBody.tsx and save to see changes
          via HMR.
        </p>
        {sortedGroups.map(([groupName, fixturesInGroup]) => (
          <section key={groupName} style={{ marginBottom: 40 }}>
            <h2
              style={{
                fontSize: 18,
                marginBottom: 12,
                paddingBottom: 6,
                borderBottom: '1px solid var(--edge-dim, #333)',
              }}
            >
              {groupName}
            </h2>
            {fixturesInGroup.map(({ name, result }) => {
              // Multi-block fixtures (or any fixture with text) get a bubble frame
              // so the grouping reads as "one assistant turn". Single-tool fixtures
              // render bare — matches the original sandbox look.
              const hasText = result.blocks.some((b) => b.kind === 'text');
              const wrap = result.blocks.length > 1 || hasText;
              return (
                <div key={name} style={{ marginBottom: 24 }}>
                  <h3 style={{ fontSize: 13, opacity: 0.6, marginBottom: 8, fontWeight: 400 }}>
                    {name}
                  </h3>
                  {result.error ? (
                    <div style={{ color: 'tomato', fontFamily: 'monospace' }}>
                      {result.error}
                    </div>
                  ) : wrap ? (
                    // Light outline + padding so the grouping reads visually.
                    // Intentionally minimal; the point is "this is all one turn", not theming.
                    <div
                      style={{
                        border: '1px solid var(--edge-dim, #333)',
                        borderRadius: 8,
                        padding: 16,
                        margin: '8px 0',
                      }}
                    >
                      {renderBlocks(orderedBlocks(result.blocks))}
                    </div>
                  ) : (
                    renderBlocks(orderedBlocks(result.blocks))
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
      </div>
    </ChatProvider>
  );
}
