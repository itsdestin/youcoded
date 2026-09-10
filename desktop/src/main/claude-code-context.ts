// What a CLAUDE CODE session was given — the other half of the "What the
// assistant was given" panel.
//
// A Claude Code session is run by the Claude Code CLI, which assembles its own
// instructions. So this file is written around one rule: **say what we actually
// know, mark the rest as not ours to say, and never present the second as the
// first.**
//
// What we know, and why it is knowledge rather than a guess:
//
//  · The instruction files. Claude Code reads `CLAUDE.md`/`AGENTS.md` walking up
//    from the working folder, and `~/.claude/CLAUDE.md` for every project. Those
//    files are on this machine; naming the ones that exist is a fact about the
//    disk, not a claim about what the CLI did with them.
//
//  · The skills. YouCoded installs them and writes the four registries Claude
//    Code reads (claude-code-registry.ts) — the app is the thing that put them
//    there. `scanSkills()` is the same scan the Skills screen shows.
//
//  · The model and its window, which the app chose when it started the session.
//
// What we do NOT know, and therefore do not send:
//
//  · Claude Code's system prompt. It is the CLI's, we never see it.
//  · Its tool list. We would be reciting a list from memory that changes with
//    every CLI release — the exact "never invent an error cause" failure, applied
//    to a capability list.
//  · Whether Claude Code shortened anything to fit. It manages its own window.
//
// Those three arrive as null/absent, and `assembledBy: 'claude-code'` tells the
// panel to word them as "Claude Code's own" rather than as "nothing".
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionContext } from '../shared/types';
import { findProjectInstructions } from './harness/prompt-assembly';
import { scanSkills, scanProjectSkills } from './skill-scanner';

/** `~/.claude/CLAUDE.md` — your instructions for every project. Claude Code
 *  reads it; the native harness does not (it only walks up from the working
 *  folder). Returned only when it is actually there. */
export function userInstructionsPath(): string | null {
  const p = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  try { return fs.existsSync(p) ? p : null; } catch { return null; }
}

export function buildClaudeCodeContext(cwd: string, modelLabel: string | null): SessionContext {
  // The SAME walk-up prompt-assembly uses, which is the one Claude Code
  // documents — so the file named here is the file it reads.
  const project = findProjectInstructions(cwd);
  const user = userInstructionsPath();

  // Installed skills plus this project's own `.claude/skills`, which is exactly
  // what Claude Code can reach. scanProjectSkills tolerates a missing folder.
  const skills = [...scanSkills(), ...scanProjectSkills(cwd)].map((s) => ({
    id: s.id,
    label: s.displayName || s.id,
    description: s.description,
  }));

  return {
    assembledBy: 'claude-code',
    modelLabel,
    // Deliberately unset. The window depends on the model AND the plan Claude
    // Code is running under, and a number we cannot check is worse than no
    // number in a panel whose whole job is to be trusted.
    contextWindowTokens: null,
    // Claude Code's own; we never see it.
    systemPrompt: null,
    systemPromptSections: null,
    projectInstructions: project ? { path: project.path, truncated: false, note: null } : null,
    userInstructions: user ? { path: user, truncated: false, note: null } : null,
    skills,
    // Claude Code tells itself about its skills — that is what the registries it
    // reads are for.
    skillsOffered: true,
    // Not ours to list. See the header.
    tools: null,
    // YouCoded drops MCP servers for the native harness only; Claude Code
    // manages its own. Empty, not unknown: we dropped nothing.
    droppedMcpServers: [],
  };
}

/** One instruction file or skill, read whole, for a session YouCoded did not
 *  shorten anything for — a Claude Code session, or the user-level file the
 *  native harness never reads.
 *
 *  `text` and `full` are the same string here, deliberately. The panel's got/cut
 *  comparison only appears when they differ, so a file nobody trimmed shows as
 *  itself, with no comparison and no implied loss.
 *
 *  Refuses by name rather than guessing: "unreadable" covers a file that is
 *  gone, locked, or not text, because naming the wrong one of those is worse
 *  than naming none (error-message-standards.md). */
export function readWholeContextFile(
  sessions: { getSession(id: string): { cwd: string } | undefined },
  sessionId: string,
  kind: 'project' | 'user' | 'skill',
  id?: string,
): { path: string; text: string; full: string; truncated: boolean } | { error: string } {
  let file: string | null = null;
  if (kind === 'user') {
    file = userInstructionsPath();
  } else if (kind === 'project') {
    const cwd = sessions.getSession(sessionId)?.cwd;
    if (!cwd) return { error: 'not-live' };
    file = findProjectInstructions(cwd)?.path ?? null;
  } else {
    const cwd = sessions.getSession(sessionId)?.cwd;
    const found = [...scanSkills(), ...(cwd ? scanProjectSkills(cwd) : [])].find((s) => s.id === id);
    // skillDir is where the scanner found it; SKILL.md is the one on-disk layout
    // (skill-catalog.ts owns that fact — this reads the same shape).
    file = found?.skillDir ? path.join(found.skillDir, 'SKILL.md') : null;
  }
  if (!file) return { error: 'not-found' };
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { path: file, text, full: text, truncated: false };
  } catch {
    return { error: 'unreadable' };
  }
}
