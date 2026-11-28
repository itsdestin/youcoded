// run-pages.ts — the pages an automation's run may read or change (finishing Pages, step 4; plan decision
// 3 "this page -> that page's data tools", and the plan's "per-page data-tool filter").
//
// A run gets the SAME two page tools a chat has (ReadPageData, UpdatePageData), from the same small program
// (claude-code-pages-mcp.ts), so page data is read and changed one way on every model. Three things keep a
// run to its own pages:
//   - the program is started with only the Pages folders that hold a linked page;
//   - ListPages is never offered (it would name the person's other pages in those folders);
//   - every call's `page` must be one of the linked pages, checked here before the call goes anywhere.
// Whether the run may read or change at all is its Read / Change permission (job-rules.ts).
import path from 'node:path';
import type { StoredAutomation } from './automation-store';

export const PAGE_READ_TOOL = 'ReadPageData';
export const PAGE_CHANGE_TOOL = 'UpdatePageData';

export interface RunPages {
  /** The Pages folders the page program is started with, in order. */
  roots: string[];
  /** Each linked page: the app's id, its name, and what to pass as `page` to the page tools. */
  pages: { id: string; name: string; arg: string }[];
}

/** Work out the linked pages a run may use. A linked page that no longer exists is simply left out. */
export async function runPagesFor(job: Pick<StoredAutomation, 'links' | 'tools'>, pageDir: (pageId: string) => Promise<string | null>): Promise<RunPages> {
  const out: RunPages = { roots: [], pages: [] };
  // No page permission: no page tools at all.
  if (!job.tools.some((t) => t.kind === 'page-read' || t.kind === 'page-write')) return out;
  for (const link of job.links) {
    if (link.kind !== 'page') continue;
    const dir = await pageDir(link.id).catch(() => null); // benign: a linked page that no longer exists is left out of the run
    if (!dir) continue;
    const root = path.dirname(dir);
    if (!out.roots.includes(root)) out.roots.push(root);
    // The page program names pages in its first folder by their folder name, and in any later one with
    // "project:" in front (claude-code-pages-mcp.ts listPages).
    out.pages.push({ id: link.id, name: link.name, arg: `${out.roots.indexOf(root) === 0 ? '' : 'project:'}${path.basename(dir)}` });
  }
  return out;
}

/** Is `page` (the argument of a page tool call) one of this run's pages? */
export function pageArgAllowed(pages: RunPages, page: unknown): boolean {
  return typeof page === 'string' && pages.pages.some((p) => p.arg === page);
}

export const PAGE_REFUSED = 'This automation may only use the page(s) it is linked to. Use the exact `page` value you were given.';

/** The lines of a run's opening instructions about its pages. */
export function describePages(pages: RunPages): string {
  if (pages.pages.length === 0) return '';
  return [
    'The page(s) this automation is linked to. Use the ReadPageData and UpdatePageData tools with exactly these `page` values:',
    ...pages.pages.map((p) => `- ${p.name}: page "${p.arg}"`),
  ].join('\n');
}
