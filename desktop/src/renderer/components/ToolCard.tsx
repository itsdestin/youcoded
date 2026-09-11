import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ToolCallState } from '../../shared/types';
import { useChatDispatch } from '../state/chat-context';
import { useSpecialistDefinition, useSpecialistRunByChild } from '../hooks/useSpecialists';
import { TaskConsentBlock } from './SpecialistEnvelope';
import { hasNestedAsk } from '../utils/specialist-cards';
import { useArtifactOptional } from '../state/ArtifactContext';
import { Button, Radio, RadioGroup, Textarea, Tooltip } from './ui';
// The card renders the widths this SHARED derivation produced and sends back only
// which one was chosen — it never builds a rule pattern of its own.
import { bashGrantOptions, bashNoGrantNote, type GrantScope } from '../../shared/bash-grant-shapes';
import { CheckIcon, FailIcon, QuestionIcon, ChevronIcon, NoteIcon, StoppedIcon, ChatIcon } from './Icons';
import BrailleSpinner from './BrailleSpinner';
import { isAndroid } from '../platform';
import ToolBody from './tool-views/ToolBody';
import { useExpandAllToggle, getInitialExpanded } from '../hooks/useExpandAllToggle';
import { isTypingTarget } from '../utils/is-typing-target';
import { asString } from '../utils/tool-input';
// Full-auto safety stop (spec 2026-08-12, M5 2b): per-family copy + the
// status-bar chip colors, so the footer band can never drift from the chip.
import { fullAutoStopCopy } from './permissions/deny-list-copy';
import { PERMISSION_DISPLAY } from './StatusBar';
// Same parser ToolBody uses to pick the card body, so header and body agree.
import { describeChatsearchCall, COPY } from '../../shared/chatsearch-refs';
import { CLAUDE_CODE_LINK_TOOL, SEND_USER_LINK_TOOL } from '../../shared/send-user-link';
import { toolActionLabel } from '../utils/tool-group-summary';

// --- Helpers for friendly display ---

function basename(filepath: string): string {
  const parts = filepath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || parts[parts.length - 2] || filepath;
}

function titleCase(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// asString (the unknown-input validator this file introduced in PR #295) moved
// to utils/tool-input.ts so ToolBody.tsx can share the exact same idiom.

/**
 * Specialists 1c — what a Task card's header says. Kept out of the switch so
 * SubagentTimeline/tests can call it with the same context ToolCard resolves:
 * `ctx.title` is the child's minted name once the run record has landed;
 * `ctx.targetTitle`/`ctx.targetRunning` describe the OTHER child a `task_id`
 * management call names (steer / resume / stop read differently — the same
 * card copy for all three was the informed-consent gap in ROADMAP).
 */
export function taskDisplay(
  input: Record<string, unknown>,
  ctx?: { title?: string; targetTitle?: string; targetRunning?: boolean; runStatus?: string },
): { label: string; detail: string } {
  const taskId = asString(input.task_id);
  const prompt = asString(input.prompt);
  if (taskId) {
    const who = ctx?.targetTitle || 'a specialist';
    if (input.interrupt === true) return { label: `Stopping ${who}`, detail: '' };
    // Running child → the prompt is a mid-course note; finished → a resume
    // with a fresh brief. Unknown (no record yet) reads as the neutral verb.
    const label = ctx?.targetRunning === true ? `Note to ${who}`
      : ctx?.targetRunning === false ? `Resuming ${who}`
      : `Message to ${who}`;
    return { label, detail: prompt ? `· ${truncate(prompt.replace(/\n/g, ' '), 80)}` : '' };
  }
  const desc = asString(input.description);
  const agent = asString(input.agent) || 'specialist';
  const article = /^[aeiou]/i.test(agent) ? 'an' : 'a';
  const label = ctx?.title || `Hiring ${article} ${agent}`;
  // "· in the background" only while it is still there — a finished background
  // hire reads like any finished hire.
  const bg = input.background === true && (!ctx?.runStatus || ctx.runStatus === 'running') ? ' · in the background' : '';
  return { label: label + bg, detail: desc ? `· ${desc}` : '' };
}

/** The skill's name as English: the plugin namespace is stripped
 *  ("superpowers:brainstorming" → "brainstorming") so a card reads as a word,
 *  not a technical id. Shared by the single Skill card and StackedSkillsCard. */
export function skillBareName(input: Record<string, unknown>): string {
  // Fix: a non-string skill crashed .includes() — optional chaining doesn't
  // guard objects (they're not nullish). Non-string args rendered as
  // "[object Object]".
  const skill = asString(input.skill);
  return skill.includes(':') ? skill.split(':').slice(-1)[0] : skill;
}

/** "a and b" / "a, b and c" — with a repeat collapsed to "a ×2", the way a
 *  tool group summarises "Read, Grep ×2". */
function joinSkillNames(names: string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const parts = [...counts.entries()].map(([n, c]) => (c > 1 ? `${n} \u00d7${c}` : n));
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * One card for SEVERAL skill invocations in a turn: "Invoked 2 skills:
 * brainstorming and writing-plans" (Destin, 2026-09-02 bubble-grouping deck,
 * B-7: "instead of one card above another, a single card that concatenates").
 * Same dashed, non-interactive shell as the single Skill card — it is an
 * annotation, not an expandable card. Status is the stack's: a failed skill
 * shows the fail glyph, one still launching shows the spinner, else the note.
 * Rendered by AssistantTurnBubble's trailing skill row when a turn invoked
 * two or more skills; a single skill keeps its own card.
 */
export function StackedSkillsCard({ skills }: { skills: ToolCallState[] }) {
  const names = skills.map((t) => skillBareName(t.input) || 'skill');
  const anyFailed = skills.some((t) => t.status === 'failed');
  const anyRunning = skills.some((t) => t.status === 'running' || t.status === 'awaiting-approval');
  return (
    <div className="border border-dashed border-edge-dim/60 rounded-lg overflow-hidden" data-testid="stacked-skills">
      <div className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left">
        {anyRunning ? (
          <BrailleSpinner size="sm" />
        ) : anyFailed ? (
          <FailIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
        ) : (
          <NoteIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
        )}
        <span aria-hidden="true" className="w-px h-3.5 bg-edge shrink-0" />
        <span className="text-xs font-medium text-fg-2">
          Invoked {skills.length} skills: {joinSkillNames(names)}
        </span>
      </div>
    </div>
  );
}

export function friendlyToolDisplay(
  tool: ToolCallState,
  ctx?: { taskTargetTitle?: string; taskTargetRunning?: boolean },
): { label: string; detail: string } {
  // The model is still GENERATING this call's arguments, so `input` is empty and
  // every per-tool detail line below would render blank. Show the argument
  // character count instead: it is the only thing on a preparing card that
  // CHANGES, and for Read/Write/Edit the preparing state is effectively the
  // card's whole visible life (execution is a synchronous fs call), so a static
  // card would sit unchanged for minutes and read as stuck.
  if (tool.preparing) {
    return {
      label: tool.toolName,
      detail: `preparing… ${(tool.preparingChars ?? 0).toLocaleString()} chars`,
    };
  }
  const { toolName, input } = tool;
  // Q1-Q5's group verbs, reused here so a single card's label tracks status
  // the same way a group's does — past tense once done, "-ing" while running
  // — instead of showing "Reading foo.ts" forever, complete or not (Destin,
  // 2026-09-06 follow-up). The specific file/command/pattern moves into the
  // detail line so the label stays the plain-language action, not the argument.
  // awaiting-approval counts as "active" too — it hasn't happened yet, so the
  // past-tense form ("Ran a command") would claim something that isn't true.
  const active = tool.status === 'running' || tool.status === 'awaiting-approval';

  switch (toolName) {
    case 'Bash': {
      // Same helper ToolBody uses to pick the card, so header and body agree.
      const cs = describeChatsearchCall(tool);
      if (cs) return { label: cs.cmd === 'find' ? COPY.headerFind(cs.shortIds.length) : COPY.headerShow, detail: '' };
      // Fix: an object survives `(x as string) || ''` (objects are truthy), then
      // .trimStart() throws — crashing the whole Chat pane via its ErrorBoundary.
      const cmd = asString(input.command);
      const desc = asString(input.description);
      // G-1: "· in the background" only while the command is still there — a
      // finished background command reads like any finished command (same rule
      // as a background hire). CC cards keep their ⟳ mark.
      const bg = tool.shellRun
        ? (tool.shellRun.status === 'running' ? ' · in the background' : '')
        : (input.run_in_background ? ' ⟳' : '');
      const label = toolActionLabel('Bash', active) + bg;
      // The model's own description reads better quoted than the raw shell
      // command — fall back to the command itself when there's no description.
      const detail = desc ? `· "${truncate(desc, 60)}"` : cmd ? `· ${truncate(cmd, 80)}` : '';
      return { label, detail };
    }

    case 'Read': {
      // Fix: a non-string file_path crashed basename(); non-number offset/limit
      // and non-string pages rendered "[object Object]" in the detail line.
      const fp = asString(input.file_path);
      const label = toolActionLabel('Read', active);
      let detail = fp ? `· ${fp}` : '';
      const offset = typeof input.offset === 'number' ? input.offset : undefined;
      const limit = typeof input.limit === 'number' ? input.limit : undefined;
      const pages = asString(input.pages);
      if (offset != null && limit != null) {
        detail += ` lines ${offset}-${offset + limit}`;
      } else if (offset != null) {
        detail += ` from line ${offset}`;
      } else if (limit != null) {
        detail += ` first ${limit} lines`;
      }
      if (pages) {
        detail += ` pages ${pages}`;
      }
      return { label, detail };
    }

    case 'SendUserFile': {
      // Files handed to the user. The chat renders these as the DeliverablesCard,
      // not a ToolCard; this label covers the gallery / buddy strip fallbacks.
      const raw = input.files;
      const files = Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string') : [];
      const names = files.map(basename);
      return {
        // Fix: a non-array `files` (malformed input) used to read "Sent 0 files".
        label: files.length === 1 ? 'Sent a file' : files.length ? `Sent ${files.length} files` : 'Sent files',
        detail: names.length ? `· ${names.join(', ')}` : '',
      };
    }

    // Both spellings of a link delivery — the native tool and the Claude Code
    // MCP tool (shared/send-user-link.ts). Listed as explicit cases so neither
    // falls through to the generic `mcp__server__action` label below.
    case CLAUDE_CODE_LINK_TOOL:
    case SEND_USER_LINK_TOOL: {
      // Links handed to the user — same fallback-label treatment as
      // SendUserFile above (the chat renders these as DeliverablesCard tiles).
      const raw = input.links;
      const links = Array.isArray(raw)
        ? raw.map((l) => (l && typeof l === 'object' && typeof (l as Record<string, unknown>).url === 'string' ? ((l as Record<string, unknown>).url as string) : '')).filter(Boolean)
        : [];
      const labels = links.map((u) => { try { return new URL(u).host; } catch { return u; } });
      return {
        label: links.length === 1 ? 'Sent a link' : links.length ? `Sent ${links.length} links` : 'Sent links',
        detail: labels.length ? `· ${labels.join(', ')}` : '',
      };
    }

    case 'Write': {
      // Fix: a non-string file_path crashed basename().
      const fp = asString(input.file_path);
      return {
        label: toolActionLabel('Write', active),
        detail: fp ? `· ${fp}` : '',
      };
    }

    case 'Edit': {
      // Fix: a non-string file_path crashed basename(); a non-string old_string
      // crashed .replace().
      const fp = asString(input.file_path);
      let detail = fp ? `· ${fp}` : '';
      const oldStr = asString(input.old_string);
      if (oldStr) {
        detail += ` ${truncate(oldStr.replace(/\n/g, '⏎'), 40)}`;
      }
      return {
        label: toolActionLabel('Edit', active),
        detail,
      };
    }

    case 'Grep': {
      // Fix: a non-string pattern rendered `Searching for "[object Object]"`.
      const pattern = asString(input.pattern);
      const label = toolActionLabel('Grep', active);
      // Fix: validate each field before interpolating — a malformed (non-string)
      // glob/path/type used to render "[object Object]" or crash basename().
      const glob = asString(input.glob);
      const grepPath = asString(input.path);
      const grepType = asString(input.type);
      let detail = pattern ? `· "${truncate(pattern, 30)}"` : '';
      if (glob) {
        detail += `${detail ? ' ' : '· '}in ${glob} files`;
      } else if (grepPath) {
        detail += `${detail ? ' ' : '· '}in ${basename(grepPath)}/`;
      } else if (grepType) {
        detail += `${detail ? ' ' : '· '}in .${grepType} files`;
      }
      return { label, detail };
    }

    case 'Glob': {
      // Fix: a non-string pattern crashed .replace() (objects survive `|| ''`).
      const pattern = asString(input.pattern);
      const simplified = pattern.replace(/^\*\*\//, '');
      const label = toolActionLabel('Glob', active);
      // Fix: same hardening as Grep — a non-string path must not reach basename().
      const globPath = asString(input.path);
      let detail = pattern ? `· ${simplified} files` : '';
      if (globPath) {
        detail += `${detail ? ' ' : '· '}in ${basename(globPath)}/`;
      }
      return { label, detail };
    }

    // Native specialists (1c). Header reads as the hire — "Wren the Whistling
    // Worker · Run the release checklist" — once the run record names the
    // child; before that, "Hiring a worker". `task_id` calls read as the
    // management verb they are.
    case 'Task':
      return taskDisplay(input, {
        title: tool.specialistRun?.title,
        runStatus: tool.specialistRun?.status,
        targetTitle: ctx?.taskTargetTitle,
        targetRunning: ctx?.taskTargetRunning,
      });

    case 'Agent': {
      // Fix: a non-string description rendered "Agent: [object Object]".
      const desc = asString(input.description);
      const bg = input.run_in_background ? ' ⟳' : '';
      const label = desc ? `Agent: ${desc}` : 'Running Sub-Agent';
      // Fix: a malformed (non-string) subagent_type used to render "[object Object]".
      const subagentType = asString(input.subagent_type);
      const detail = subagentType ? `· ${subagentType}` : '';
      return { label: label + bg, detail };
    }

    case 'WebSearch': {
      // Fix: a non-string query rendered "[object Object]" in the detail line.
      const query = asString(input.query);
      return {
        label: toolActionLabel('WebSearch', active),
        detail: query ? `· ${query}` : '',
      };
    }

    case 'WebFetch': {
      // Fix: a non-string url threw inside new URL(), and the catch fallback then
      // rendered it as "[object Object]".
      const url = asString(input.url);
      let domain = '';
      if (url) {
        try {
          domain = new URL(url).hostname;
        } catch {
          domain = url;
        }
      }
      return {
        label: toolActionLabel('WebFetch', active),
        detail: domain ? `· ${domain}` : '',
      };
    }

    case 'Skill': {
      // Fix: a non-string skill crashed .includes() — optional chaining doesn't
      // guard objects (they're not nullish). Non-string args rendered as
      // "[object Object]".
      const args = asString(input.args);
      // Past tense matches the post-launch state — by the time the card
      // renders, the skill has already been invoked.
      const bareName = skillBareName(input);
      return {
        label: bareName ? `Invoked skill: ${bareName}` : 'Invoked skill',
        detail: args ? `· ${args}` : '',
      };
    }

    case 'TodoWrite': {
      // Fix: a non-array todos (an object survives `|| []` — it's truthy)
      // must never crash .filter()/.find(). Fell all the way through to the
      // generic default before this case existed, showing the bare internal
      // name "TodoWrite" with no detail at all (Destin, 2026-09-06).
      const raw = input.todos;
      const todos = Array.isArray(raw) ? raw : [];
      const isTodoItem = (t: unknown): t is Record<string, unknown> => !!t && typeof t === 'object';
      const total = todos.length;
      const doneCount = todos.filter((t) => isTodoItem(t) && t.status === 'completed').length;
      const inProgress = todos.find((t) => isTodoItem(t) && t.status === 'in_progress');
      const label = toolActionLabel('TodoWrite', active);
      let detail = '';
      if (total > 0) {
        if (inProgress) {
          const activeForm = asString((inProgress as Record<string, unknown>).activeForm)
            || asString((inProgress as Record<string, unknown>).content);
          detail = activeForm ? `· ${truncate(activeForm, 50)} (${doneCount}/${total})` : `· ${doneCount}/${total} done`;
        } else {
          detail = doneCount === total ? `· all ${total} done` : `· ${doneCount}/${total} done`;
        }
      }
      return { label, detail };
    }

    case 'TaskCreate': {
      // Fix: a non-string subject rendered "New Task: [object Object]".
      const subject = asString(input.subject);
      return {
        label: subject ? `New Task: ${truncate(subject, 50)}` : 'New Task',
        detail: '',
      };
    }

    case 'TaskUpdate': {
      const status = input.status as string | undefined;
      let label: string;
      switch (status) {
        case 'completed':
          label = 'Task Completed';
          break;
        case 'in_progress':
          label = 'Task Started';
          break;
        case 'deleted':
          label = 'Task Deleted';
          break;
        default:
          label = 'Updating Task';
      }
      // Fix: a non-string taskId rendered "#[object Object]" (task ids are
      // strings throughout — see task-state.ts).
      const taskId = asString(input.taskId);
      return { label, detail: taskId ? `· #${taskId}` : '' };
    }

    case 'AskUserQuestion': {
      // Show the first question's header/text as the tool label.
      // Fix: only accept string values — String(header) on a malformed object
      // input produced an "[object Object]" label.
      // P-18: read like every other card — short topic as the label, the
      // question itself as the "·" detail (Read shows "Reading X · path").
      // Header missing → plain "Question" so the detail still carries the text.
      const questions = input.questions as any[];
      const header = asString(questions?.[0]?.header);
      const question = asString(questions?.[0]?.question);
      return {
        label: header ? truncate(header, 40) : 'Question',
        detail: question ? `· ${truncate(question, 60)}` : '',
      };
    }

    case 'ExitPlanMode': {
      return { label: 'Plan ready — would you like to proceed?', detail: '' };
    }

    // Native runtime budget gates — synthetic "tools" the harness raises as
    // permission asks (harness-session.ts). They have no real tool call; render
    // plain-language "Continue?" copy, NOT the raw internal name.
    case 'max_steps': {
      const steps = Number(input.steps) || 0;
      return {
        label: 'Continue?',
        detail: `· Claude has taken ${steps} steps on this task without stopping`,
      };
    }

    case 'doom_loop': {
      const repeated = typeof input.repeated === 'string' ? input.repeated : '';
      return {
        label: 'Continue?',
        detail: repeated
          ? `· Claude keeps repeating the same action (${repeated})`
          : '· Claude appears to be repeating the same action',
      };
    }

    default: {
      // MCP tools: mcp__{server}__{action}
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.slice(5).split('__');
        const server = parts[0] ? titleCase(parts[0]) : toolName;
        const action = parts[1] ? titleCase(parts[1]) : '';
        const label = action ? `${server}: ${action}` : server;
        // Show the most interesting input value as detail
        let detail = '';
        const values = Object.values(input).filter(v => typeof v === 'string' && v.length > 0) as string[];
        if (values.length > 0) {
          detail = `· ${truncate(values[0], 60)}`;
        }
        return { label, detail };
      }

      // Unknown tool — show name as-is
      return { label: toolName, detail: '' };
    }
  }
}

// Synthetic updatedPermissions payload for a native "Always allow". The native
// broker's respond() reads "always" purely from a non-empty updatedPermissions
// array + behavior:allow (it ignores the array's CONTENTS — the host derives the
// remembered rule from the tool call itself), so any single-element marker works.
// CC asks keep sending their real suggestion string. Task 13.
/** D2: the folder a project-scoped grant is actually pinned to. The subject is
 *  built from the call's `work_dir` resolved against the session folder
 *  (tools/task.ts), so naming the session folder is only right when the call
 *  did not narrow to a subdirectory — and a note that names the wrong folder
 *  is worse than one that names none. Falls back to a folder-less phrase
 *  rather than guessing. */
function grantFolderName(workDir: unknown, sessionCwd?: string): string {
  const given = typeof workDir === 'string' ? workDir.trim() : '';
  // Resolve the way tools/task.ts does (work_dir against the session cwd)
  // instead of taking the last segment of whatever was typed. Without this,
  // './' read as the folder literally named "." and '..' as one named "..",
  // so the note said "in . only" — a folder name that exists nowhere.
  // Hand-rolled because the renderer bundle has no Node `path`: split on both
  // separators, drop '' and '.', pop on '..'. Only the LAST segment is ever
  // shown, so this needs to be right about the name, not about the whole path.
  const raw = given.replace(/\\/g, '/');
  const absolute = raw.startsWith('/') || /^[A-Za-z]:\//.test(raw);
  const parts = absolute ? [] : (sessionCwd ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { parts.pop(); continue; }
    parts.push(segment);
  }
  // Never invent a name: an empty result (no session cwd, or '..' walked past
  // the root) falls back to the folder-less phrase, as it did before.
  return parts[parts.length - 1] || 'this project';
}

const NATIVE_ALWAYS_ALLOW = 'native:always-allow';

export function PermissionButtons({ requestId, suggestions, denyListed, command, folderName, suppressAlwaysAllow, alwaysAllowNote, permissionMode, onResponded, onFailed, bare = false }: {
  requestId: string;
  /** Specialists 1c: render the generic row WITHOUT its own band (border/bg/
   *  padding) so a host can lay it out inline — the specialists popup puts the
   *  buttons on the same line as the request. Confirm and safety-stop paths
   *  keep their band. */
  bare?: boolean;
  suggestions?: string[];
  /** Deny-listed native ask → gate "Always allow" behind a consequence confirm. */
  denyListed?: boolean;
  /** The exact command the remembered rule will store, echoed in the confirm so
   *  the user can see precisely what they're granting. Deny-listed asks are
   *  Bash-only (DESTRUCTIVE_DENY_LIST has no non-Bash entries), so this is
   *  `input.command` — the same string harness-session.ts:562 persists. */
  command?: string;
  /** Basename of the session cwd. The rule is scoped to that directory's slug
   *  (permission-store.ts:35-43), so naming the folder is what makes the grant's
   *  scope checkable — a worktree does NOT inherit its parent repo's rules. */
  folderName?: string;
  /** Budget gates (max_steps / doom_loop) are a binary "Continue?" — never offer
   *  "Always Allow" (it'd persist a rule that permanently disables the guard).
   *  Also set for an external-directory ask, where a remembered rule could
   *  never be consulted (harness-session.ts, step 4). */
  suppressAlwaysAllow?: boolean;
  /** D2: one line stating HOW WIDE this card's "Always allow" actually is.
   *  Only the caller knows (a hire card reads the specialist's grantScope), and
   *  the button label cannot carry it without becoming a sentence. Shown only
   *  when the button is actually offered — a note about a control that is not
   *  there is noise. */
  alwaysAllowNote?: string;
  /** The session's mode when the ask fired (native broker only). 'full-auto'
   *  + denyListed renders the safety-stop footer instead of the generic row —
   *  Full auto's only rule-based ask IS the destructive-command stop, and a
   *  generic "may I?" there reads as noise (spec 2026-08-12, M5 2b). */
  permissionMode?: 'ask' | 'auto-edit' | 'full-auto';
  onResponded?: () => void;
  onFailed?: () => void;
}) {
  const [responding, setResponding] = useState(false);
  // Native asks carry NO CC permission_suggestions, but Always-allow must still
  // be offered (Task 8 carry-forward). The broker mints `native-${uuid}` request
  // ids, so the prefix is the cleanest native discriminator — no extra state to
  // thread. CC keeps its suggestions-gated behavior unchanged.
  const isNative = requestId.startsWith('native-');
  const hasSuggestions = !!(suggestions?.length);
  // canAlwaysAllow also gates on noGrantPossible (declared below with the grant
  // options) — see its definition for the one case it removes the button.
  // Full-auto's only rule-based ask is a deny-list stop — swap the generic row
  // for the safety-stop footer the compare view settled (workbench surface
  // 'full-auto-ask', R1–R4). Every other combination keeps the row as-is.
  const fullAutoStop = permissionMode === 'full-auto' && !!denyListed;
  // Consequence-gated confirm strip (deny-listed asks) — mirrors the delete-model
  // confirm in LocalModelsSection: replace the button row with a plain-language
  // warning + Cancel / confirm.
  const [confirmingAlways, setConfirmingAlways] = useState(false);

  // M5 2c — the widths this command may be granted at. The card shows what the
  // SHARED derivation produced and never builds a pattern itself; it sends back
  // only which option was chosen (see alwaysAllowDecision). Only native asks
  // carry a real Bash command — CC asks keep their suggestions-driven behavior.
  const grantOptions = useMemo(
    () => (isNative && typeof command === 'string' ? bashGrantOptions(command) : []),
    [isNative, command],
  );
  // A Bash ask whose command yields NO option may not be always-allowed at all
  // (a bare `git push`: its target is not in the command and changes underneath
  // the grant). Non-Bash native asks have no options and are unaffected.
  const noGrantNote = useMemo(
    () => (isNative && typeof command === 'string' ? bashNoGrantNote(command) : null),
    [isNative, command],
  );
  const noGrantPossible = isNative && typeof command === 'string' && grantOptions.length === 0;
  // Which width the user picked. Preselected narrow; irrelevant when the
  // derivation offered only one option (see chosenScope).
  const [grantPick, setGrantPick] = useState<GrantScope>('exact');
  const chosenScope: GrantScope = grantOptions.length === 1 ? grantOptions[0].scope : grantPick;
  const chosen = grantOptions.find((o) => o.scope === chosenScope) ?? grantOptions[0];
  const canAlwaysAllow = (hasSuggestions || isNative) && !suppressAlwaysAllow && !noGrantPossible;
  // Safety-stop default is Run it (the primary verb, index 0); the generic
  // row keeps its shipped default (Always Allow when present).
  const [focusIdx, setFocusIdx] = useState(fullAutoStop ? 0 : canAlwaysAllow ? 1 : 0);
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);

  const handleRespond = useCallback(async (decision: object) => {
    setResponding(true);
    try {
      const delivered = await (window as any).claude.session.respondToPermission(requestId, decision);
      if (delivered === false) {
        console.warn('Permission response not delivered — socket already closed');
        setResponding(false);
        if (onFailed) onFailed();
        return;
      }
      if (onResponded) onResponded();
    } catch (err) {
      console.error('Failed to respond to permission:', err);
      setResponding(false);
      if (onFailed) onFailed();
    }
  }, [requestId, onResponded, onFailed]);

  // The "Always allow" decision: CC sends its first real suggestion; native sends
  // the synthetic marker the broker reads as always.
  const alwaysAllowDecision = () =>
    hasSuggestions
      ? { decision: { behavior: 'allow' }, updatedPermissions: [suggestions![0]] }
      // A SELECTOR, never a pattern — the session re-derives the rule. Sending a
      // pattern from here would let the renderer write the top precedence layer.
      : { decision: { behavior: 'allow' }, updatedPermissions: [NATIVE_ALWAYS_ALLOW], grantScope: chosenScope };

  // The confirm opens for a deny-listed ask (as it always has) AND for any Bash
  // ask the derivation produced options for — that is where the width choice and
  // the limits sentence live (compare rounds R1·B / R2·C). Everything else
  // responds directly, exactly as before.
  const onAlwaysAllow = useCallback(() => {
    if (denyListed || grantOptions.length > 0) { setConfirmingAlways(true); return; }
    handleRespond(alwaysAllowDecision());
  }, [denyListed, grantOptions.length, handleRespond, hasSuggestions, suggestions, chosenScope]);

  // Build actions list so keyboard handler can index into it. The array MUST
  // match the VISUAL order so Arrow Left/Right walk the row: the safety stop
  // puts deny in the MIDDLE (Run it / Skip it | Always Allow) — red mid-row is
  // owner-approved (compare R2) even though every other row ends on red.
  const actions = useRef<(() => void)[]>([]);
  actions.current = fullAutoStop
    ? [
        () => handleRespond({ decision: { behavior: 'allow' } }),
        () => handleRespond({ decision: { behavior: 'deny' } }),
        onAlwaysAllow,
      ]
    : [
        () => handleRespond({ decision: { behavior: 'allow' } }),
        ...(canAlwaysAllow ? [onAlwaysAllow] : []),
        () => handleRespond({ decision: { behavior: 'deny' } }),
      ];
  const count = actions.current.length;

  // Global keyboard navigation: arrows cycle, Enter activates. Suspended while
  // the consequence confirm is open so arrow/Enter don't drive the hidden row.
  useEffect(() => {
    if (responding || confirmingAlways) return;
    const handler = (e: KeyboardEvent) => {
      // Don't steal keyboard events when user is typing in an input
      if (isTypingTarget(e.target as Element)) return;

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        setFocusIdx(prev => {
          const next = e.key === 'ArrowRight' ? (prev + 1) % count : (prev - 1 + count) % count;
          buttonsRef.current[next]?.focus();
          return next;
        });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        actions.current[focusIdx]?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [responding, confirmingAlways, focusIdx, count]);

  const pad = isAndroid() ? 'py-2' : 'py-1';
  const ring = 'ring-2 ring-white/40';

  // Consequence-gated confirm — plain-language warning before persisting a rule
  // for a deny-listed action. Cancel returns to the card (the buttons re-render).
  if (confirmingAlways) {
    return (
      <div className="px-3 py-2 space-y-2 border-t border-edge bg-inset/30">
        {/* The header carries the ask so the body only has to carry the risk.
            Naming the folder keeps the promise checkable — the remembered rule is
            cwd-scoped, so "in this folder" alone would be unverifiable. */}
        {/* The heading names what is actually being granted (compare R2·C): the
            shipped "this exact command" is FALSE the moment the only option is a
            named grant like "Always allow pushing to master", and ambiguous when
            there are two options to choose between. */}
        <p className="text-xs font-medium text-fg-2">
          {grantOptions.length > 1
            ? `Always allow this${folderName ? ` in ${folderName}` : ''}?`
            : grantOptions.length === 1 && grantOptions[0].scope === 'wide'
              ? `${grantOptions[0].label}${folderName ? ` in ${folderName}` : ''}?`
              : `Always allow this exact command${folderName ? ` in ${folderName}` : ''}?`}
        </p>
        {command && (
          <p className="text-2xs leading-relaxed text-fg-2 bg-inset/70 px-2 py-1.5 rounded-sm break-all">
            {command}
          </p>
        )}
        {denyListed && (
          <p className="text-2xs text-fg-dim leading-relaxed">
            {/* Owner-set copy (2026-08-12), shared by every mode's confirm. The
                rule also applies to the REST OF THIS SESSION — the "future
                sessions" understatement was accepted knowingly. Gated on
                denyListed: an ordinary command never carried this warning, and
                showing "may delete files" over `npm run build` would be the
                misleading-error failure in a different costume. */}
            {/* Destin's 2026-08-26/27 copy review: "This can delete", and the
                "during future sessions" hedge dropped — the rule is simply on
                from now on in this project. */}
            This can delete files or change published code, and you won't be asked again in this project.
          </p>
        )}
        {/* The width choice. Only rendered when the derivation actually produced
            two — a named grant replaces its exact rung rather than sitting beside
            it, so every `git push` lands on the single-option path. */}
        {grantOptions.length > 1 && (
          <RadioGroup
            options={grantOptions.map((o) => o.scope)}
            value={chosenScope}
            onChange={(next) => setGrantPick(next as GrantScope)}
            aria-label="How much to allow"
            className="flex flex-col gap-1.5 pt-0.5"
          >
            {grantOptions.map((o) => (
              <button
                key={o.scope}
                type="button"
                disabled={responding}
                onClick={() => setGrantPick(o.scope)}
                className="flex items-start gap-2 text-left disabled:opacity-50"
              >
                <Radio checked={chosenScope === o.scope} onChange={() => setGrantPick(o.scope)} className="mt-0.5" />
                <span className="text-2xs text-fg-2 break-all">
                  {o.scope === 'exact' ? 'Only this exact command' : o.label}
                </span>
              </button>
            ))}
          </RadioGroup>
        )}
        {/* What the grant will NOT cover. This is the item's ONLY warning about
            the two cases that re-ask anyway (a chained command, a flag that
            changes what the command does) — the after-the-fact explanation was
            deliberately dropped, so this line is load-bearing. Settled R2·C. */}
        {chosen && (
          <p className="text-3xs text-fg-muted leading-relaxed">{chosen.limits}</p>
        )}
        <div className="flex items-center gap-2">
          {/* "Allow once" IS the plain-allow decision, so it wears the same green
              as Yes. Previously this slot was Cancel, which dead-ended back on the
              button row and still left the user owing an answer.

              These permission buttons deliberately do NOT go through ui/Button
              (spec §11, change 61). Their green/red/blue are STATUS colors, not
              theme surfaces — desktop/CLAUDE.md keeps those hardcoded — and
              Destin explicitly kept the red on "Always allow" even though red
              means "No" one row down: muscle memory on the app's most-clicked
              control beats colour-semantics tidiness. Only the radius normalizes
              to the app's one control radius (was rounded-sm). */}
          <button
            disabled={responding}
            onClick={() => handleRespond({ decision: { behavior: 'allow' } })}
            className={`px-3 ${pad} text-xs font-medium rounded-lg bg-green-600/60 hover:bg-green-600/80 text-green-100 transition-colors disabled:opacity-50`}
          >
            Nevermind, allow once
          </button>
          <button
            disabled={responding}
            onClick={() => handleRespond(alwaysAllowDecision())}
            className={`px-3 ${pad} text-xs font-medium rounded-lg bg-red-600/60 hover:bg-red-600/80 text-red-100 transition-colors disabled:opacity-50`}
          >
            Always allow
          </button>
        </div>
      </div>
    );
  }

  // The full-auto safety stop (compare surface 'full-auto-ask', settled R4).
  // Same §11/change-61 carve-out as the rows below: green/red/orange are STATUS
  // colors; the band wears the chip's own colors so it reads as the MODE
  // stopping itself, not a generic permission question.
  if (fullAutoStop) {
    const fa = PERMISSION_DISPLAY['full-auto'];
    const stop = fullAutoStopCopy(command);
    return (
      <div className="px-3 py-2 space-y-2 border-t" style={{ background: fa.bg, borderColor: fa.border }}>
        {/* Header + subheader as ONE tight block; the footer's only real gap
            sits before the buttons (owner spacing direction, compare R3). */}
        <div className="space-y-0.5">
          <p className="text-xs font-medium" style={{ color: fa.color }}>{stop.header}</p>
          <p className="text-2xs text-fg-dim leading-relaxed">{stop.subline}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            ref={el => { buttonsRef.current[0] = el; }}
            disabled={responding}
            onClick={() => handleRespond({ decision: { behavior: 'allow' } })}
            className={`px-3 ${pad} text-xs font-medium rounded-lg bg-green-600/60 hover:bg-green-600/80 text-green-100 transition-colors disabled:opacity-50 ${focusIdx === 0 ? ring : ''}`}
          >
            Run it
          </button>
          <button
            ref={el => { buttonsRef.current[1] = el; }}
            disabled={responding}
            onClick={() => handleRespond({ decision: { behavior: 'deny' } })}
            className={`px-3 ${pad} text-xs font-medium rounded-lg bg-red-600/60 hover:bg-red-600/80 text-red-100 transition-colors disabled:opacity-50 ${focusIdx === 1 ? ring : ''}`}
          >
            Skip it
          </button>
          {/* P-18: a real 1px divider instead of a typed "|" — takes the theme's
              edge colour and is silent to screen readers. */}
          <span aria-hidden="true" className="w-px h-3.5 bg-edge shrink-0" />
          {/* Orange, not the generic row's blue: a fourth member of the status
              button set, distinct from the amber band behind it (compare R2·A).
              fullAutoStop implies a native deny-listed ask, so onAlwaysAllow
              always routes through the consequence confirm above. */}
          <button
            ref={el => { buttonsRef.current[2] = el; }}
            disabled={responding}
            onClick={onAlwaysAllow}
            className={`px-3 ${pad} text-xs font-medium rounded-lg bg-orange-600/60 hover:bg-orange-600/80 text-orange-100 transition-colors disabled:opacity-50 ${focusIdx === 2 ? ring : ''}`}
          >
            Always Allow
          </button>
        </div>
      </div>
    );
  }

  return (
    // Same §11/change-61 carve-out as the confirm row above: status colors stay,
    // radius normalizes. The `ring` here is NOT a focus ring — it tracks focusIdx,
    // the Arrow Left/Right roving selection. Arrow keys also move real DOM focus
    // (buttonsRef[next].focus()), so adding ui/Button's focus-visible ring would
    // paint an accent ring on top of this one on the selected button. Left alone
    // on purpose; don't "finish the migration" by adding FOCUS_RING here.
    <div className={bare ? 'space-y-1.5' : 'px-3 py-2 border-t border-edge bg-inset/30 space-y-1.5'}>
    <div className="flex items-center gap-2">
      <button
        ref={el => { buttonsRef.current[0] = el; }}
        disabled={responding}
        onClick={() => handleRespond({ decision: { behavior: 'allow' } })}
        className={`px-3 ${pad} text-xs font-medium rounded-lg bg-green-600/60 hover:bg-green-600/80 text-green-100 transition-colors disabled:opacity-50 ${focusIdx === 0 ? ring : ''}`}
      >
        Yes
      </button>
      {canAlwaysAllow ? (
        <button
          ref={el => { buttonsRef.current[1] = el; }}
          disabled={responding}
          onClick={onAlwaysAllow}
          className={`px-3 ${pad} text-xs font-medium rounded-lg bg-blue-600/60 hover:bg-blue-600/80 text-blue-100 transition-colors disabled:opacity-50 ${focusIdx === 1 ? ring : ''}`}
        >
          Always Allow
        </button>
      ) : null}
      <button
        ref={el => { buttonsRef.current[canAlwaysAllow ? 2 : 1] = el; }}
        disabled={responding}
        onClick={() => handleRespond({ decision: { behavior: 'deny' } })}
        className={`px-3 ${pad} text-xs font-medium rounded-lg bg-red-600/60 hover:bg-red-600/80 text-red-100 transition-colors disabled:opacity-50 ${focusIdx === (canAlwaysAllow ? 2 : 1) ? ring : ''}`}
      >
        No
      </button>
    </div>
      {/* Why there is no "Always Allow" here. Without it a missing button on a
          command the user runs constantly reads as a bug rather than a decision
          (compare R2·C). Shape-owned copy — see CommandShape.noGrantNote. */}
      {noGrantPossible && noGrantNote && (
        <p className="text-3xs text-fg-muted leading-relaxed">{noGrantNote}</p>
      )}
      {/* D2: the promise "Always allow" is about to make, in the user's words.
          Gated on canAlwaysAllow so it never describes a button that isn't
          rendered — the failure the noGrantNote above exists to avoid. */}
      {canAlwaysAllow && alwaysAllowNote && (
        <p className="text-3xs text-fg-muted leading-relaxed">{alwaysAllowNote}</p>
      )}
    </div>
  );
}

// --- ExitPlanMode UI ---
// The CLI shows a 4-option Ink menu for plan approval, not a standard Yes/No
// permission prompt. We render the real options and send PTY input (arrow keys
// + Enter) to select the chosen option in the Ink menu, then close the hook
// socket so the relay exits cleanly.

const PLAN_INTENT_STYLES = {
  accept: 'bg-green-600/60 hover:bg-green-600/80 text-green-100',
  reject: 'bg-red-600/60 hover:bg-red-600/80 text-red-100',
  neutral: 'bg-blue-600/60 hover:bg-blue-600/80 text-blue-100',
};

const PLAN_OPTIONS = [
  { label: 'Yes, and bypass permissions', intent: 'accept' as const },
  { label: 'Yes, manually approve edits', intent: 'accept' as const },
  { label: 'No, refine plan', intent: 'reject' as const },
  { label: 'Tell Claude what to change', intent: 'neutral' as const },
];

function PlanApprovalButtons({ requestId, sessionId, onResponded }: {
  requestId: string;
  sessionId: string;
  onResponded?: () => void;
}) {
  const [responding, setResponding] = useState(false);
  const DOWN = '\u001b[B';

  const handleSelect = useCallback((optionIndex: number) => {
    setResponding(true);
    // Send arrow-down keys to navigate from option 1 (default) to the target,
    // then Enter to confirm the selection in the Ink menu
    const input = DOWN.repeat(optionIndex) + '\r';
    window.claude.session.sendInput(sessionId, input);
    // Close the hook socket — the Ink menu handles the decision, so we don't
    // need to send a hook response. Closing prevents the relay from timing out.
    (window as any).claude.session.respondToPermission(requestId, { decision: { behavior: 'deny' } }).catch(() => {});
    if (onResponded) onResponded();
  }, [requestId, sessionId, onResponded, DOWN]);

  const pad = isAndroid() ? 'py-2' : 'py-1';

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-t border-edge bg-inset/30">
      {PLAN_OPTIONS.map((opt, idx) => (
        <button
          key={opt.label}
          disabled={responding}
          onClick={() => handleSelect(idx)}
          className={`px-3 ${pad} text-xs font-medium rounded-sm transition-colors disabled:opacity-50 ${PLAN_INTENT_STYLES[opt.intent]}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// --- AskUserQuestion UI ---
// Claude Code's AskUserQuestion tool sends 1-4 multiple-choice questions.
// Unlike regular tools (allow/deny), we must collect the user's selections
// and return them via updatedInput.answers so Claude gets the actual answer.

interface AskQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

// Fix: isValidQuestions only checked questions[0].question, so an object-valued
// header/label/description DEEPER in the array still reached React children in
// the expanded card ("Objects are not valid as a React child" crashes the whole
// Chat pane via its ErrorBoundary). Normalize the whole array up front with the
// same asString idiom as friendlyToolDisplay: coerce every rendered field, and
// drop members that can't render or be answered (no question text, no labeled
// options) so one malformed member degrades gracefully instead of crashing or
// invalidating the rest of the card.
function normalizeQuestions(input: Record<string, unknown>): AskQuestion[] {
  const raw = input.questions;
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const q of raw as Array<Record<string, unknown> | null | undefined>) {
    const question = asString(q?.question);
    if (!question) continue; // no question text — nothing to render or key answers by
    const rawOptions = Array.isArray(q?.options) ? (q.options as Array<Record<string, unknown> | null | undefined>) : [];
    const options: AskQuestion['options'] = [];
    for (const o of rawOptions) {
      const label = asString(o?.label);
      if (!label) continue; // an unlabeled option can't be selected or echoed back
      options.push({ label, description: asString(o?.description) || undefined });
    }
    if (options.length === 0) continue; // nothing selectable
    out.push({ question, header: asString(q?.header), multiSelect: q?.multiSelect === true, options });
  }
  return out;
}

function isValidQuestions(input: Record<string, unknown>): boolean {
  return normalizeQuestions(input).length > 0;
}

// Ledger G-2 (2026-08-26 harness comparison): every other harness lets the user
// type their own answer; ours only offered the listed choices, and Dismiss ended
// the turn. The card now adds an "Other" row per question plus one text box
// whose placeholder flips between "Explain…" (Other picked — the text IS the
// answer, so it's required) and "Add a note…" (a listed option picked — the
// text is optional steering that rides along with the choice).
//
// The sentinel is an internal selection key only; it never reaches the model.
// A model-authored option literally labelled "__other__" would collide, which
// is not a real risk worth a second code path.
const OTHER = '__other__';
const OTHER_LABEL = 'Other';
const OTHER_DESCRIPTION = 'Type your own answer';

/** What the text box is FOR depends on what is selected — say so in the placeholder. */
function textPlaceholder(sel: Set<string> | undefined): string {
  return sel?.has(OTHER) ? 'Explain…' : 'Add a note…';
}

function AskUserQuestionCard({ tool, requestId, onResponded, onFailed }: {
  tool: ToolCallState;
  requestId: string;
  onResponded?: () => void;
  onFailed?: () => void;
}) {
  // Fix: render (and echo back) the NORMALIZED questions, never the raw input —
  // see normalizeQuestions above. Memoized so the array identity is stable for
  // the hook deps below.
  const questions = useMemo(() => normalizeQuestions(tool.input), [tool.input]);
  // answers: map from question text → selected label(s)
  const [answers, setAnswers] = useState<Record<string, Set<string>>>({});
  // text: question text → what the user typed in that question's box. One
  // state serves both roles (Other's answer, or a note on a listed choice);
  // which role it plays is decided at submit from the selection.
  const [text, setText] = useState<Record<string, string>>({});
  const textRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [responding, setResponding] = useState(false);
  // Track which question is "active" for keyboard nav, and which option is focused
  const [focusedOption, setFocusedOption] = useState(0);

  const allAnswered = questions.every(q => {
    const sel = answers[q.question];
    if (!sel || sel.size === 0) return false;
    // "Other" with nothing typed is not an answer yet — Submit stays off until
    // the user explains, so the model never receives an empty "own answer".
    if (sel.has(OTHER) && !(text[q.question] ?? '').trim()) return false;
    return true;
  });

  const handleSelect = useCallback((question: string, label: string, multiSelect: boolean) => {
    setAnswers(prev => {
      const current = prev[question] || new Set<string>();
      const next = new Set(current);
      if (multiSelect) {
        // Toggle for multi-select
        if (next.has(label)) next.delete(label);
        else next.add(label);
      } else {
        // Replace for single-select
        next.clear();
        next.add(label);
      }
      return { ...prev, [question]: next };
    });
    // Picking Other is an invitation to type — put the cursor in the box so the
    // user doesn't have to click twice. (Deselecting Other leaves focus alone.)
    if (label === OTHER) {
      requestAnimationFrame(() => textRefs.current[question]?.focus());
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!allAnswered || responding) return;
    setResponding(true);
    // Build answers object: question text → "Label" or "Label1, Label2". When
    // Other is selected the typed text takes its place in the list (so a
    // multi-select can be "Charts, my own idea"); when it is NOT selected the
    // typed text becomes a note that rides alongside the choice.
    const answersObj: Record<string, string> = {};
    const notesObj: Record<string, string> = {};
    // Claude Code's own AskUserQuestion input carries free-text notes as
    // `annotations[question].notes` — send that shape too so a CC session
    // receives the note through the same contract its CLI uses.
    const annotationsObj: Record<string, { notes: string }> = {};
    for (const q of questions) {
      const sel = answers[q.question] ?? new Set<string>();
      const typed = (text[q.question] ?? '').trim();
      const labels = Array.from(sel).filter((l) => l !== OTHER);
      if (sel.has(OTHER) && typed) labels.push(typed);
      answersObj[q.question] = labels.join(', ');
      if (!sel.has(OTHER) && typed) {
        notesObj[q.question] = typed;
        annotationsObj[q.question] = { notes: typed };
      }
    }
    const hasNotes = Object.keys(notesObj).length > 0;
    try {
      const delivered = await (window as any).claude.session.respondToPermission(requestId, {
        decision: {
          behavior: 'allow',
          updatedInput: {
            questions,       // Echo back the (normalized) questions array
            answers: answersObj,
            ...(hasNotes ? { notes: notesObj, annotations: annotationsObj } : {}),
          },
        },
      });
      if (delivered === false) {
        setResponding(false);
        if (onFailed) onFailed();
        return;
      }
      if (onResponded) onResponded();
    } catch (err) {
      console.error('Failed to respond to AskUserQuestion:', err);
      setResponding(false);
      if (onFailed) onFailed();
    }
  }, [allAnswered, responding, questions, answers, text, requestId, onResponded, onFailed]);

  const handleDeny = useCallback(async () => {
    setResponding(true);
    try {
      const delivered = await (window as any).claude.session.respondToPermission(requestId, {
        decision: { behavior: 'deny' },
      });
      if (delivered === false) {
        setResponding(false);
        if (onFailed) onFailed();
        return;
      }
      if (onResponded) onResponded();
    } catch {
      setResponding(false);
      if (onFailed) onFailed();
    }
  }, [requestId, onResponded, onFailed]);

  // Total flat list of all options across questions (for keyboard nav). The
  // synthetic Other row is a real stop in the list, after each question's own
  // options, so arrow keys reach it like any other choice.
  const allOptions = questions.flatMap(q => [
    ...q.options.map(o => ({ q, o })),
    { q, o: { label: OTHER, description: OTHER_DESCRIPTION } },
  ]);
  const optionCount = allOptions.length;

  // Keyboard: Arrow Up/Down cycles options, Enter toggles selection, Ctrl+Enter submits
  useEffect(() => {
    if (responding) return;
    const handler = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target as Element)) return;

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedOption(prev =>
          e.key === 'ArrowDown' ? (prev + 1) % optionCount : (prev - 1 + optionCount) % optionCount
        );
      } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        // Select the focused option
        if (optionCount > 0) {
          const { q, o } = allOptions[focusedOption];
          handleSelect(q.question, o.label, q.multiSelect);
        }
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        // Ctrl/Cmd+Enter to submit
        e.preventDefault();
        handleSubmit();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [responding, focusedOption, optionCount, allOptions, handleSelect, handleSubmit]);

  const pad = isAndroid() ? 'py-2' : 'py-1.5';
  let flatIdx = 0; // Running index across all questions' options for keyboard focus

  return (
    <div className="border-t border-edge px-3 py-2 space-y-3">
      {questions.map((q, qi) => (
        <div key={qi}>
          <div className="text-xs font-medium text-fg-2 mb-1">
            {q.header && <span className="text-fg-muted mr-1">{q.header}:</span>}
            {q.question}
          </div>
          <div className="space-y-1">
            {[...q.options, { label: OTHER, description: OTHER_DESCRIPTION }].map((opt, oi) => {
              const idx = flatIdx++;
              const selected = answers[q.question]?.has(opt.label) ?? false;
              const focused = idx === focusedOption;
              const isOther = opt.label === OTHER;
              return (
                <button
                  key={oi}
                  aria-label={isOther ? `${OTHER_LABEL} — ${OTHER_DESCRIPTION}` : undefined}
                  disabled={responding}
                  onClick={() => handleSelect(q.question, opt.label, q.multiSelect)}
                  // P-18: one row shape for both states — a visible dim border
                  // when unselected, the accent border when selected — so rows
                  // don't jump between "flat" and "outlined" as the user picks.
                  className={`w-full text-left px-2.5 ${pad} rounded-md border text-xs transition-colors
                    ${selected
                      ? 'bg-accent/15 border-accent text-fg'
                      : 'bg-inset/40 border-edge-dim hover:bg-inset/70 text-fg-dim'}
                    ${focused ? 'ring-1 ring-white/30' : ''}
                    disabled:opacity-50`}
                >
                  <div className="flex items-center gap-2">
                    {/* Selection indicator. P-18: the two shapes are written out in
                        full — Tailwind only generates classes it can read verbatim,
                        so a computed `rounded-${...}` never produced any styling. */}
                    <span className={`w-3 h-3 shrink-0 border ${q.multiSelect ? 'rounded-sm' : 'rounded-full'}
                      ${selected ? 'bg-accent border-accent' : 'border-edge'}`}
                    />
                    <span className="font-medium">{isOther ? OTHER_LABEL : opt.label}</span>
                  </div>
                  {opt.description && (
                    <div className="text-fg-muted ml-5 mt-0.5">{opt.description}</div>
                  )}
                </button>
              );
            })}
            {/* One box per question. Its role follows the selection (see
                textPlaceholder): the answer itself when Other is picked, an
                optional steering note otherwise. Ctrl/Cmd+Enter submits from
                inside the box, matching the card-wide shortcut — the window
                handler skips typing targets, so the box handles it itself. */}
            <Textarea
              ref={(el) => { textRefs.current[q.question] = el; }}
              size="sm"
              rows={1}
              disabled={responding}
              value={text[q.question] ?? ''}
              placeholder={textPlaceholder(answers[q.question])}
              aria-label={textPlaceholder(answers[q.question])}
              onChange={(e) => {
                const value = e.target.value;
                setText(prev => ({ ...prev, [q.question]: value }));
                // Grow with the text instead of scrolling inside a one-line box.
                e.target.style.height = 'auto';
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSubmit(); }
              }}
              // Full row width, like the choices above it — a short box reads as an afterthought.
              className="mt-1 w-full text-xs"
            />
          </div>
        </div>
      ))}
      {/* Submit + Deny buttons.

          Unlike the permission triad above (which keeps its status colors), this
          pair DOES go through ui/Button — Destin's call, spec §11.8 B. Two things
          the migration deliberately drops:
            - Submit hand-rolled its own disabled look (bg-inset/50 + bg-accent/70)
              on top of a real `disabled` prop. The primitive's disabled:opacity-50
              replaces that branch, and the enabled state goes to full accent.
            - Dismiss had a grey→red hover as a bespoke "this rejects" signal.
              Dismissing a question isn't destructive — nothing is lost, Claude
              just doesn't get an answer — so it reads as `ghost`, and position
              plus label already carry "this is the negative option". */}
      <div className="flex items-center gap-2 pt-1">
        <Button
          disabled={!allAnswered || responding}
          onClick={handleSubmit}
          className={pad}
        >
          Submit
        </Button>
        <Button variant="ghost" disabled={responding} onClick={handleDeny} className={pad}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

interface Props {
  tool: ToolCallState;
  sessionId?: string;
  // inGroup: true when rendered inside a CollapsedToolGroup. Gates bg-inset so
  // the "lifted card" color only shows inside groups; standalone cards stay
  // transparent and inherit the bubble color.
  inGroup?: boolean;
}

export default React.memo(function ToolCard({ tool, sessionId, inGroup = false }: Props) {
  // Seed from the module-level mode so a card that mounts AFTER Ctrl+O fired
  // (e.g. when its parent tool group just opened) starts in the right state.
  // Chatsearch cards used to force-open here (their whole point was the
  // Preview/Resume buttons, hidden by a collapsed header) — reversed by the
  // owner (Task 4, compare surface 'chatsearch-results' R2 'b-closed'):
  // search results are skimmed once and scrolled past, so they now behave
  // like every other tool card and start collapsed same as anything else.
  // A helper's ask is the ONE thing that still force-opens a card, and it
  // applies to a chatsearch card too: its buttons are useless behind a
  // collapsed header (Specialists 1c).
  const [expanded, setExpanded] = useState(() => getInitialExpanded() || hasNestedAsk(tool));
  // Opens once per ask; the user can still collapse it afterwards.
  const nestedAsk = hasNestedAsk(tool);
  useEffect(() => { if (nestedAsk) setExpanded(true); }, [nestedAsk]);
  useExpandAllToggle(() => setExpanded(true), () => setExpanded(false));
  const dispatch = useChatDispatch();
  // Optional: the workbench tool gallery (?mode=workbench&view=tools) renders
  // ToolCard outside the ArtifactProvider. Missing cwd just drops the folder
  // name from the confirm header rather than crashing the card.
  const artifacts = useArtifactOptional();
  const sessionCwd = sessionId ? artifacts?.state.sessionCwd?.[sessionId] : undefined;
  // Specialists 1c: a `task_id` call names ANOTHER card's child — look up that
  // child's run so the header can say "Note to Wren…" (a narrow selector, so
  // this memoized card does not re-render on every session update).
  const taskTargetId = tool.toolName === 'Task' ? asString(tool.input.task_id) : '';
  const taskTarget = useSpecialistRunByChild(sessionId, taskTargetId || undefined);
  // Task 10: same lookup TaskConsentBlock uses, so the Always-allow gate
  // below and the consent envelope above never disagree about whether this
  // hire is a built-in. Hooks can't be called conditionally, so this runs
  // for every card — `agent` is '' for anything that isn't an untargeted
  // Task hire, and useSpecialistDefinition('') returns undefined for free.
  const hireAgent = tool.toolName === 'Task' && !taskTargetId ? asString(tool.input.agent) : '';
  // Fix (Task 10 review): cwd must be gated the SAME as agentId, not passed
  // through unconditionally — passing the real cwd for every card forced a
  // per-project specialists.list() disk read (three folders) off the FIRST
  // tool card of ANY kind in a session, hire or not, and every other card
  // then subscribed to that cache entry and re-rendered on its changes (the
  // roster hook is useState+useEffect, not useSyncExternalStore, so
  // React.memo on ToolCard does not stop it). A hire card still has a truthy
  // hireAgent, so it is unaffected — this only collapses NON-hire cards onto
  // the one shared empty-cwd cache entry instead of a fresh per-project read.
  const hireDefinition = useSpecialistDefinition(hireAgent ? sessionCwd : undefined, hireAgent || undefined);
  const display = friendlyToolDisplay(tool, {
    taskTargetTitle: taskTarget?.title,
    taskTargetRunning: taskTarget ? taskTarget.status === 'running' : undefined,
  });
  // Specialists 1c: the REAL status of a Task card is its run record, not its
  // tool result — a background hire's result is only the launch ack (Destin's
  // 1b hands-on, Test 4: the card read ✓ while the child was still working).
  const run = tool.toolName === 'Task' ? tool.specialistRun : undefined;
  // G-1: a Bash card with a shell-run record shows the RUN's state the same
  // way — its tool result is only the launch acknowledgment.
  const shell = tool.toolName === 'Bash' ? tool.shellRun : undefined;
  const runIcon: 'spinner' | 'check' | 'fail' | 'stopped' | null =
    tool.status === 'awaiting-approval' ? null
    : shell ? (shell.status === 'running' ? 'spinner' : shell.status === 'stopped' ? 'stopped' : shell.exitCode === 0 ? 'check' : 'fail')
    : !run ? null
    : run.status === 'running' ? 'spinner'
    : run.status === 'completed' ? (tool.specialistReport?.status === 'failed' ? 'fail' : 'check')
    : run.status === 'failed' ? 'fail'
    : 'stopped';
  // Skill tool calls always return "Launching skill: X" with success — the body
  // is pure ceremony. Render header only, no chevron, non-interactive, with a
  // lighter dashed border so it reads as an annotation, not an expandable card.
  const isCompactSkill = tool.toolName === 'Skill';
  // Same helper the header label and the body use, so all three agree.
  const isChatsearch = !!describeChatsearchCall(tool);

  const cardBorder = isCompactSkill
    ? 'border border-dashed border-edge-dim/60'
    : 'border border-edge';
  // select-none: the title row is chrome, not highlightable or copyable
  // (Destin, 2026-09-10). The expandable header is a <button>, which
  // globals.css already covers; the compact-skill header is a <div>, so the
  // class is what covers it. The card's BODY (commands, output) stays selectable.
  const headerClass = isCompactSkill
    ? 'w-full flex items-center gap-1.5 px-3 py-1.5 text-left select-none'
    : 'w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-inset/50 transition-colors select-none';
  const headerContent = (
    <>
      {/* Status indicator — a Task card with a run record shows the RUN's
          state (see runIcon); every other card shows the tool's. */}
      {runIcon === 'spinner' && <BrailleSpinner size="sm" />}
      {runIcon === 'check' && <CheckIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />}
      {runIcon === 'fail' && <FailIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />}
      {runIcon === 'stopped' && <StoppedIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />}
      {runIcon === null && tool.status === 'running' && (
        <BrailleSpinner size="sm" />
      )}
      {runIcon === null && tool.status === 'awaiting-approval' && (
        <QuestionIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
      )}
      {runIcon === null && tool.status === 'complete' && (
        // Skills get the note glyph on success — visually distinct from
        // the generic check used by every other tool, since "skill ran"
        // carries different meaning ("Claude consulted instructions/notes")
        // than "command finished." Failed skills still use the FailIcon.
        // A chatsearch card gets the chat bubble for the same reason (Destin,
        // 2026-08-27 gate, M-row): a tick says "the command exited 0", which
        // is the least interesting thing about a list of past conversations.
        isCompactSkill ? (
          <NoteIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
        ) : isChatsearch ? (
          <ChatIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
        ) : (
          <CheckIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
        )
      )}
      {runIcon === null && tool.status === 'failed' && (
        <FailIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
      )}
      {/* P-18: a real 1px divider instead of a typed "|" — takes the theme's
          edge colour and is silent to screen readers. */}
      <span aria-hidden="true" className="w-px h-3.5 bg-edge shrink-0" />
      <span className="text-xs font-medium text-fg-2">
        {/* Specialists 1c: a routed child ask that could NOT nest under its
            Task card still says who is asking, so it never reads as the
            parent's own request. */}
        {tool.specialist && tool.status === 'awaiting-approval' ? `${tool.specialist.title} wants to: ` : ''}
        {display.label}
      </span>
      {display.detail && (
        <span className="text-xs text-fg-muted truncate flex-1 min-w-0">{display.detail}</span>
      )}
      {run?.stale && run.status === 'running' && (
        <Tooltip text="No activity for a while — may be stuck"><span className="text-4xs uppercase tracking-wide text-amber-500 shrink-0">may be stuck</span></Tooltip>
      )}
      {runIcon === 'stopped' && (
        <span className="text-4xs uppercase tracking-wide text-fg-muted shrink-0">stopped</span>
      )}
      {!isCompactSkill && (
        <span data-testid="tool-card-chevron" className="shrink-0 inline-flex">
          <ChevronIcon className="w-3.5 h-3.5 text-fg-muted" expanded={expanded} />
        </span>
      )}
    </>
  );

  return (
    <div className={`${cardBorder} rounded-lg overflow-hidden ${inGroup ? 'bg-inset' : ''}`} data-tool-use-id={tool.toolUseId}>
      {/* Header */}
      {isCompactSkill ? (
        <div className={headerClass}>{headerContent}</div>
      ) : (
        <button onClick={() => setExpanded(!expanded)} className={headerClass}>
          {headerContent}
        </button>
      )}


      {/* Specialists 1c: the consent envelope for a hire / note / resume /
          stop — what Yes allows, in plain words, ABOVE the buttons and visible
          without expanding the card. Spec §5: approving the launch IS the grant. */}
      {tool.status === 'awaiting-approval' && tool.requestId && tool.toolName === 'Task' && (
        <TaskConsentBlock tool={tool} sessionId={sessionId} />
      )}

      {/* Permission / AskUserQuestion / ExitPlanMode UI */}
      {tool.status === 'awaiting-approval' && tool.requestId && (() => {
        // AskUserQuestion needs its own UI with option selection instead of Yes/No
        const isAskUser = tool.toolName === 'AskUserQuestion' && isValidQuestions(tool.input);
        // ExitPlanMode has a 4-option Ink menu in the CLI (bypass/manual/refine/feedback),
        // not a standard Yes/No permission — render the real options
        const isPlanApproval = tool.toolName === 'ExitPlanMode';
        const onRespondedCb = () => {
          if (sessionId && tool.requestId) {
            const action = { type: 'PERMISSION_RESPONDED' as const, sessionId, requestId: tool.requestId };
            dispatch(action);
            (window as any).claude?.remote?.broadcastAction(action);
          }
        };
        const onFailedCb = () => {
          if (sessionId && tool.requestId) {
            const action = { type: 'PERMISSION_EXPIRED' as const, sessionId, requestId: tool.requestId };
            dispatch(action);
            (window as any).claude?.remote?.broadcastAction(action);
          }
        };
        return isAskUser ? (
          <AskUserQuestionCard
            tool={tool}
            requestId={tool.requestId}
            onResponded={onRespondedCb}
            onFailed={onFailedCb}
          />
        ) : isPlanApproval && sessionId ? (
          <PlanApprovalButtons
            requestId={tool.requestId}
            sessionId={sessionId}
            onResponded={onRespondedCb}
          />
        ) : (
          <PermissionButtons
            requestId={tool.requestId}
            suggestions={tool.permissionSuggestions}
            denyListed={tool.denyListed}
            permissionMode={tool.permissionMode}
            command={typeof (tool.input as any)?.command === 'string' ? (tool.input as any).command : undefined}
            folderName={sessionCwd ? basename(sessionCwd) : undefined}
            // Budget gates are a plain Yes/No "Continue?" — no "Always Allow".
            // `tool.external` joins them: the engine forces an ask for every path
            // outside the session folder and never consults the stored rules
            // there, so offering "Always allow" would promise a grant that can
            // never fire. Spec 2026-08-11, finding 3.
            // Specialists 1c: a `task_id` management call (note / resume / stop)
            // grants nothing new, so there is nothing an "Always allow" could
            // remember — and offering it invited a blanket-delegation misread
            // (plan 1b checklist, Test 10).
            //
            // Task 10 / Global Constraint (hire grants — two independent
            // protections). Half (b) USED to hide Always-allow for every hire
            // whose source !== 'builtin'. D2 (2026-08-26) replaces the reason it
            // was hidden rather than removing the protection: the danger was
            // never "a file-defined helper gets a grant", it was "a grant keyed
            // by a NAME survives the file changing under it". The subject now
            // carries the file's content hash (tools/task.ts), so an edit that
            // widens the file's tools no longer matches the old grant — which
            // means the option can safely be offered, and Destin gets the
            // across-projects grant he asked for on helpers in his own folders.
            //
            // What half (b) still enforces, unchanged: DEFAULT-CLOSED while the
            // definition is unknown. `hireDefinition` is undefined until the
            // lookup POSITIVELY resolves (never shown-then-hidden), and an
            // unresolved hire must never be offered a grant optimistically —
            // we would not know which width it was even asking for.
            suppressAlwaysAllow={tool.toolName === 'max_steps' || tool.toolName === 'doom_loop' || tool.external === true
              || (tool.toolName === 'Task' && !!tool.input?.task_id)
              || (tool.toolName === 'Task' && !tool.input?.task_id && !hireDefinition)
              // A hire with no work_dir has NO permission subject at all
              // (tools/task.ts permissionSubject returns undefined), so
              // rememberedRuleFor mints nothing and execute() refuses the call
              // outright. Offering "Always allow" there — with a note promising
              // a width — promises a grant that nothing can keep.
              || (tool.toolName === 'Task' && !tool.input?.task_id && !tool.input?.work_dir)}
            // D2: say what the grant covers. A built-in already behaved this way
            // and its wording is unchanged from what shipped, so no existing
            // card's copy moves. A file-defined helper gets the sentence that
            // matches the subject tools/task.ts will actually build for it.
            alwaysAllowNote={tool.toolName === 'Task' && !tool.input?.task_id && hireDefinition
              // Destin's 2026-08-26/27 copy review: "covers", and the re-ask
              // clause reads from the file's side ("If its file changes").
              ? (hireDefinition.grantScope === 'user'
                  ? "Always allow covers this helper in every project. If its file changes, you'll be asked again."
                  : hireDefinition.grantScope === 'project'
                    ? `Always allow covers this helper in ${grantFolderName(tool.input?.work_dir, sessionCwd)} only, because it is defined inside the project. If its file changes, you'll be asked again.`
                    : undefined)
              : undefined}
            onResponded={onRespondedCb}
            onFailed={onFailedCb}
          />
        );
      })()}

      {/* Expanded details — per-tool parsed views, raw fallback otherwise.
          Skill cards never render a body (the only response is the redundant
          "Launching skill: X" line). */}
      {!isCompactSkill && expanded && (
        <div data-testid="tool-card-body">
          <ToolBody tool={tool} sessionId={sessionId} />
        </div>
      )}
    </div>
  );
})
