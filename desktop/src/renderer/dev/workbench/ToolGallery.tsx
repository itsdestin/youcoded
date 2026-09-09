// Dev-only catalog for reviewing real tool components against their reducer-backed
// fixtures. Reached through ?mode=workbench&view=tools; it is never part of the
// production navigation.
//
// Why ChatProvider: ToolCard dispatches expand/collapse and approval actions, so
// its real interaction surface needs this provider even though fixtures are static.

import React from 'react';
import { ChatProvider } from '../../state/chat-context';
import ToolCard from '../../components/ToolCard';
import { CollapsedToolGroup } from '../../components/AssistantTurnBubble';
import { DeliverablesCard, isSentFilesTool, isSentLinksTool } from '../../components/DeliverablesCard';
import { loadFixture, type FixtureBlock, type LoadResult } from './fixture-loader';
import type { ToolCallState } from '../../../shared/types';

// Vite replaces this static glob at bundle time. tsconfig uses CommonJS and
// therefore rejects import.meta even though this dev-only renderer is Vite-only.
// @ts-ignore TS1343 — Vite statically transforms import.meta.glob
const fixtures = import.meta.glob('./fixtures/tools/*.jsonl', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const GALLERY_SESSION_ID = 'sandbox';

type FixtureEntry = { name: string; result: LoadResult };
type CatalogKind = 'tools' | 'group' | 'deliverables';

interface CatalogSection {
  title: string;
  description: string;
  kind: CatalogKind;
  names: string[];
}

// Explicit curation keeps related states together instead of letting filename
// order bury an approval, error, or background-run variant among ordinary cards.
const CATALOG: CatalogSection[] = [
  {
    title: 'Individual tool cards',
    description: 'Common completed calls and MCP integrations.',
    kind: 'tools',
    names: ['askuserquestion', 'bash', 'big-bash', 'edit', 'glob', 'grep', 'mcp-gmail-read', 'mcp-todoist', 'mcp-windows-control', 'read', 'todowrite', 'webfetch', 'websearch', 'write'],
  },
  {
    title: 'Agents & specialists',
    description: 'Delegated work and its compact Task/Agent treatment.',
    kind: 'tools',
    names: ['agent'],
  },
  {
    title: 'Failures & status variants',
    description: 'Failed, approval-gated, and background execution states.',
    kind: 'tools',
    names: ['bash-awaiting-approval', 'bash-awaiting-approval-denylisted', 'bash-background-running', 'bash-background-finished', 'bash-background-failed', 'bash-background-stopped', 'bash-background-detached', 'bash-failed'],
  },
  {
    title: 'Chatsearch cards',
    description: 'Conversation find and preview cards rendered through their Bash calls.',
    kind: 'tools',
    names: ['chatsearch-find', 'chatsearch-find-piped', 'chatsearch-show'],
  },
  {
    title: 'Deliverable cards',
    description: 'File and link handoffs, including loading and failed delivery states.',
    kind: 'deliverables',
    names: ['senduserfile', 'senduserfile-running', 'senduserfile-failed', 'senduserlink', 'senduserlink-claude-code'],
  },
  {
    title: 'Skill cards',
    description: 'Skill invocation states use the same ToolCard treatment as chat.',
    kind: 'tools',
    names: ['skill', 'skill-failed'],
  },
  {
    title: 'Grouped tool cards',
    description: 'Every entry remains a real CollapsedToolGroup, not a gallery approximation.',
    kind: 'group',
    names: ['group-active-mixed-complete', 'group-active-with-failure', 'group-agent-followed-by-tools', 'group-all-active', 'group-bash-read-skill', 'group-bash-then-read', 'group-failed-bash-with-retry', 'group-four-kinds-settled', 'group-mcp-mixed'],
  },
];

function toolBlocks(blocks: FixtureBlock[]): ToolCallState[] {
  return blocks.flatMap((block) => block.kind === 'tool' ? [block.tool] : []);
}

function FixtureCard({ entry, kind }: { entry: FixtureEntry; kind: CatalogKind }) {
  if (entry.result.error) {
    return <p className="text-xs text-red-400 font-mono">{entry.result.error}</p>;
  }

  const tools = toolBlocks(entry.result.blocks);
  const deliverables = tools.filter((tool) => isSentFilesTool(tool) || isSentLinksTool(tool));

  // WHY grouped fixtures bypass the normal per-tool loop: the catalog must
  // exercise the production group headline, state aggregation, and expansion
  // behavior as one unit — the former bubble wrapper only imitated that layout.
  const content = kind === 'group' ? (
    tools.length > 1
      ? <CollapsedToolGroup tools={tools} sessionId={GALLERY_SESSION_ID} />
      : <ToolCard tool={tools[0]} sessionId={GALLERY_SESSION_ID} />
  ) : kind === 'deliverables' ? (
    <DeliverablesCard tools={deliverables} sessionId={GALLERY_SESSION_ID} />
  ) : (
    <div className="space-y-1">{tools.map((tool) => <ToolCard key={tool.toolUseId} tool={tool} sessionId={GALLERY_SESSION_ID} />)}</div>
  );

  return (
    <article className="min-w-0 rounded-lg border border-edge-dim bg-panel/40 p-2.5">
      <h3 className="mb-2 text-2xs font-mono font-medium text-fg-muted">{entry.name}</h3>
      {content}
    </article>
  );
}

function CatalogSectionView({ section, entries }: { section: CatalogSection; entries: Map<string, FixtureEntry> }) {
  const items = section.names.flatMap((name) => {
    const entry = entries.get(name);
    return entry ? [entry] : [];
  });

  return (
    <section aria-labelledby={`tool-gallery-${section.title}`} className="space-y-2">
      <header className="sticky top-0 z-10 -mx-1 bg-canvas/95 px-1 pt-3 pb-2 backdrop-blur-sm border-b border-edge-dim">
        <h2 id={`tool-gallery-${section.title}`} className="text-sm font-semibold text-fg">{section.title}</h2>
        <p className="mt-0.5 text-2xs text-fg-muted">{section.description}</p>
      </header>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {items.map((entry) => <FixtureCard key={entry.name} entry={entry} kind={section.kind} />)}
      </div>
    </section>
  );
}

export function ToolGallery() {
  const entries = new Map<string, FixtureEntry>(Object.entries(fixtures).map(([path, raw]) => {
    const name = path.split('/').pop()!.replace(/\.jsonl$/, '');
    return [name, { name, result: loadFixture(name, raw) }];
  }));

  return (
    <ChatProvider>
      {/* WHY this pane owns its scroll: app-root intentionally locks document
          scrolling for the live split-pane UI. The catalog needs a stable title
          and independent, full-height browsing without affecting that UI. */}
      <main className="h-screen flex flex-col bg-canvas text-fg">
        <header className="shrink-0 border-b border-edge px-5 py-4">
          <div className="mx-auto max-w-7xl">
            <h1 className="text-lg font-semibold">Tool gallery</h1>
            <p className="mt-1 text-xs text-fg-muted">Dev-only component catalog · reducer-backed fixtures · real chat cards</p>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-8">
          <div className="mx-auto max-w-7xl space-y-7">
            {CATALOG.map((section) => <CatalogSectionView key={section.title} section={section} entries={entries} />)}
          </div>
        </div>
      </main>
    </ChatProvider>
  );
}
