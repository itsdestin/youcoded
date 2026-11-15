// job-decide.ts — plugs an automation's permission list into a running assistant (finishing Pages, step 4).
//
// A run asks one question before every step: decide(tool, subject). In a chat that answer comes from the
// chat's mode and saved "Always allow" choices. In an automation it comes from THIS function instead, which
// turns the step into a plain fact ("change this file", "run this command", "visit this site") and hands it
// to job-rules.ts. Nothing from any chat is consulted (plan-c#C-apart).
//
// WHY the job is read fresh on every step (a function, not a copy): "Allow from now on" changes the list
// while a run is going, and the very next step must see it.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PermissionDecision } from '../../shared/permission-types';
import type { AutomationSummary } from '../../shared/automation-types';
import { decideForJob, type JobCall, type JobDecision } from './job-rules';

type JobRules = Pick<AutomationSummary, 'tools' | 'unlisted' | 'links'>;

const LOOK_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const CHANGE_TOOLS = new Set(['Write', 'Edit']);
/** Tools that touch nothing the person owns: the run's own to-do list and checking on its own commands. */
const FREE_TOOLS = new Set(['TodoWrite', 'BashOutput', 'KillShell']);

/** The page tools arrive bare (native) or as `mcp__youcoded-pages__ReadPageData` (Claude Code). */
function pageTool(tool: string): 'read' | 'change' | null {
  const bare = tool.replace(/^mcp__[^_]+(?:[-_][^_]+)*__/, '');
  if (bare === 'ReadPageData' || bare === 'ListPages') return 'read';
  if (bare === 'UpdatePageData') return 'change';
  return null;
}

/** The real location of a path, following links. For a file that does not exist yet (a Write), the real
 *  location of the nearest folder that does, plus the rest.
 *  WHY: permissions are compared as text; without this a link inside an allowed folder that points
 *  somewhere else would pass as "inside it". */
async function realLocation(p: string): Promise<string> {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(head), ...tail); } catch { /* not there yet: try its folder */ }
    const up = path.dirname(head);
    if (up === head) return path.resolve(p);
    tail.unshift(path.basename(head));
    head = up;
  }
}

/** Turn one step into a plain fact, or null when the tool is none of the kinds a permission can cover. */
export async function jobCallFor(tool: string, subject: string | undefined, cwd: string): Promise<JobCall | 'free' | null> {
  if (FREE_TOOLS.has(tool)) return 'free';
  const page = pageTool(tool);
  if (page) return subject ? { kind: 'page', pageId: subject, change: page === 'change' } : null;
  if (subject === undefined) return null;
  if (LOOK_TOOLS.has(tool) || CHANGE_TOOLS.has(tool)) {
    return { kind: 'file', path: await realLocation(path.resolve(cwd, subject)), change: CHANGE_TOOLS.has(tool) };
  }
  if (tool === 'Bash') return { kind: 'command', command: subject };
  // WebFetch's subject is the site ("bestbuy.com"), not the address (shared/site-key.ts).
  if (tool === 'WebFetch') return { kind: 'site', url: /^https?:\/\//i.test(subject) ? subject : `https://${subject}` };
  return null;
}

/** What the run is told when a step is refused, so it moves on instead of trying again. */
const REFUSED = 'This automation is not allowed to do that, and the person will not be asked. Carry on without it.';

export interface JobDecideOpts {
  /** The automation as it is right now. */
  rules: () => JobRules | undefined;
  /** The run's own work folder: it may always read and change files there. */
  workDir: string;
  home?: string;
  /** Told which permission a question falls under, so "Allow from now on" knows what to switch. */
  onAsk?: (toolId: string | undefined) => void;
}

/** The `decide` a run is built with. */
export function buildJobDecide(opts: JobDecideOpts): (tool: string, subject: string | undefined, where?: { shellCwd?: string }) => Promise<PermissionDecision> {
  const home = opts.home ?? os.homedir();
  return async (tool, subject) => {
    const rules = opts.rules();
    // The automation was deleted while its run was going: nothing more is allowed.
    if (!rules) return { action: 'deny', denyListed: false, message: REFUSED };
    const call = await jobCallFor(tool, subject, opts.workDir);
    if (call === 'free') return { action: 'allow', denyListed: false };
    // A tool no permission can cover (searching the web, asking a question, sending a file) is refused.
    // WHY refused, not asked: the screen has no row for it, so there would be no way to allow it for next time.
    if (call === null) return { action: 'deny', denyListed: false, message: REFUSED };
    // Its own scratch space, where it keeps notes between steps. Real location compared, like any folder.
    if (call.kind === 'file') {
      const rel = path.relative(await realLocation(opts.workDir), call.path);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return { action: 'allow', denyListed: false };
    }
    const d: JobDecision = decideForJob(rules, call, { home });
    if (d.action === 'ask') opts.onAsk?.(d.toolId);
    return d.action === 'deny' ? { action: 'deny', denyListed: false, message: REFUSED } : { action: d.action, denyListed: false };
  };
}
