// job-rules.ts — what one automation may do, decided the same way for every model (finishing Pages, step 4;
// build plan decision 3 and design-review ruling 1).
//
// One question, one answer: "the run wants to do X — is that Always allowed, Asks first, or refused?"
// The answer comes ONLY from that automation's own permission list and its two "anything else" rows. A chat's
// saved "Always allow" choices never reach here, and nothing allowed here reaches a chat (plan-c#C-apart).
//
// Order of the answer:
//   1. A permission in the list covers it → that permission's mode. When two cover it and they disagree,
//      Asks first wins (the safer of the two).
//   2. Nothing covers it → the "Other websites" or "Other commands and files" row: Never refuses, Asks first asks.
// WHY Never can never be unlocked from a run: a refused step raises no question, so there is no
// "Allow from now on" to press; only the person adding a permission to the list changes it.
//
// Commands are compared by the app's existing rule matcher (shared/subject-glob.ts), so the same safety
// rules hold as in a chat: a `*` never reaches across `&&`, `;` or a pipe, and a pattern that would cover a
// command able to run any code covers nothing.
import os from 'node:os';
import path from 'node:path';
import { grantRunsAnyCode, ruleMatches, type MatchContext } from '../../shared/subject-glob';
import { riskyVariant } from '../../shared/bash-risky-variants';
import type { AutomationSummary, AutomationTool } from '../../shared/automation-types';

/** What a run is about to do, already reduced to plain facts by the runner. */
export type JobCall =
  /** `path` must be absolute and already resolved through links (the runner does that; see WHY below). */
  | { kind: 'file'; path: string; change: boolean }
  | { kind: 'command'; command: string }
  | { kind: 'site'; url: string }
  | { kind: 'page'; pageId: string; change: boolean };

export interface JobDecision {
  action: 'allow' | 'ask' | 'deny';
  /** The permission that decided it; with 'ask', the one "Allow from now on" would switch to Always allowed. */
  toolId?: string;
}

type JobRules = Pick<AutomationSummary, 'tools' | 'unlisted' | 'links'>;

/** `~/Downloads` → the real folder. Anything not absolute after that covers nothing. */
function folderOf(exact: string | undefined, home: string): string | null {
  if (!exact) return null;
  const p = exact === '~' ? home : exact.startsWith('~/') || exact.startsWith('~\\') ? path.join(home, exact.slice(2)) : exact;
  return path.isAbsolute(p) ? path.resolve(p) : null;
}

/** Is `file` the folder itself or anything inside it, however deep (plan decision 3: "read/write inside it")?
 *  WHY the caller resolves links first: compared as text, a link inside an allowed folder that points
 *  elsewhere would pass; the runner hands over the real location. */
function inside(folder: string, file: string): boolean {
  if (!path.isAbsolute(file)) return false;
  const rel = path.relative(folder, path.resolve(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** "bestbuy.com" covers bestbuy.com and www.bestbuy.com, never notbestbuy.com or bestbuy.com.evil.net. */
function siteCovers(exact: string | undefined, url: string): boolean {
  if (!exact) return false;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    // WHY refuse a name-and-password address: `https://bestbuy.com@evil.net/` reads as the allowed site to a person.
    if (u.username !== '' || u.password !== '') return false;
    host = u.hostname.toLowerCase();
  } catch { return false; }
  const want = exact.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (want === '' || !want.includes('.')) return false;
  return host === want || host.endsWith(`.${want}`);
}

/** Words that make the next thing on the line code rather than a file. */
const CODE_AS_ARGUMENT: readonly string[] = ['-c', '-e', '-m', '--eval', '-Command', '-command', '/c', 'eval', '-exec', '-execdir', '-ok'];
/** Programs whose first argument is itself a program to run. */
const LAUNCHERS: readonly string[] = ['eval', 'env', 'xargs', 'find', 'sudo', 'doas', 'exec', 'source', '.', 'nohup', 'time', 'watch', 'ssh'];

/** "whisper ~/Recordings/*" — a `*` right after a `/` stands for a file under that folder.
 *  WHY this exists beside the chat matcher: there a `*` must sit between whole words, so it can never
 *  finish a file's path, and "run this program on any file in that folder" (the approved example on the
 *  Add menu) could not be written at all. The same guards are kept: one command only, nothing the shell
 *  fills in later, no stepping out of the folder with `..`, and never a pattern that could run any code. */
function filePatternCovers(pattern: string, command: string): boolean {
  if (/[;&|<>`\n\r\\]|\$[({]/.test(command)) return false;
  if (grantRunsAnyCode(pattern) || riskyVariant(command, pattern) !== null) return false;
  // WHY these two extra checks: the app's "could this run any code" list is judged by the chat matcher,
  // which a file pattern never satisfies, so `bash -c /*` would slip past it. A pattern that hands its
  // file to something that treats it as code or as a second program covers nothing.
  const words = pattern.trim().split(/\s+/);
  if (CODE_AS_ARGUMENT.some((flag) => words.includes(flag)) || LAUNCHERS.includes(words[0] ?? '')) return false;
  const parts = pattern.split('*');
  const afterSlash = parts.slice(0, -1).map((lit) => lit.endsWith('/'));
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const source = parts.map(esc).reduce((acc, lit, i) => acc + (afterSlash[i - 1] ? '(\\S+)' : '([\\s\\S]*)') + lit);
  const m = new RegExp(`^${source}$`).exec(command);
  if (!m) return false;
  let at = parts[0].length;
  for (let i = 1; i < m.length; i++) {
    const got = m[i];
    if (afterSlash[i - 1]) {
      // A file's path: no quotes or variables, and no `..` step that would leave the named folder.
      if (/['"$~]/.test(got) || got.split('/').includes('..')) return false;
    } else if (got !== '') {
      // Any other `*` keeps the chat matcher's rule: what it stands for begins and ends between words.
      const before = command[at - 1];
      const after = command[at + got.length];
      if (!(before === undefined || /\s/.test(before) || /^\s/.test(got))) return false;
      if (!(after === undefined || /\s/.test(after) || /\s$/.test(got))) return false;
    }
    at += got.length + parts[i].length;
  }
  return true;
}

function covers(tool: AutomationTool, call: JobCall, rules: JobRules, home: string, context: MatchContext): boolean {
  switch (call.kind) {
    case 'file': {
      if (tool.kind !== 'folder') return false;
      // A look-only permission never covers a change; a change permission covers looking too.
      if (call.change && !tool.change) return false;
      const folder = folderOf(tool.exact, home);
      return folder !== null && inside(folder, call.path);
    }
    case 'command': {
      if (tool.kind !== 'command' || !tool.exact) return false;
      const wild = tool.exact.includes('*');
      // A command without `*` is that exact command, byte for byte; with `*` it is a pattern under the
      // matcher's safety rules.
      if (ruleMatches({ tool: 'Bash', pattern: tool.exact, action: 'allow', ...(wild ? {} : { match: 'exact' as const }) }, call.command, context)) return true;
      return wild && tool.exact.includes('/*') && filePatternCovers(tool.exact, call.command);
    }
    case 'site':
      return tool.kind === 'site' && siteCovers(tool.exact, call.url);
    case 'page': {
      if (tool.kind !== 'page-read' && tool.kind !== 'page-write') return false;
      if (call.change && tool.kind !== 'page-write') return false;
      // "This page" means a page the automation is linked to — never some other page.
      return rules.links.some((l) => l.kind === 'page' && l.id === call.pageId);
    }
  }
}

export function decideForJob(rules: JobRules, call: JobCall, opts: { home?: string; context?: MatchContext } = {}): JobDecision {
  const home = opts.home ?? os.homedir();
  const matching = rules.tools.filter((t) => covers(t, call, rules, home, opts.context ?? {}));
  if (matching.length > 0) {
    const asks = matching.find((t) => t.mode === 'ask');
    return asks ? { action: 'ask', toolId: asks.id } : { action: 'allow', toolId: matching[0].id };
  }
  // WHY a page's information has no "anything else" row: a page the automation was not given is simply not
  // its business, and there is no row on the screen that could say otherwise.
  if (call.kind === 'page') return { action: 'deny' };
  const row = call.kind === 'site' ? rules.unlisted.sites : rules.unlisted.commands;
  return { action: row === 'ask' ? 'ask' : 'deny' };
}
