// Skill loading for the native harness.
//
// WHY this exists: scanSkills() solves DISCOVERY — it finds every skill across
// three roots and parses each SKILL.md's frontmatter. But it returns
// `prompt: '/<id>'` (a slash command for the UI to send to Claude Code) and used
// to drop the directory, so nothing in the app could actually READ a skill's
// instructions. Claude Code performs that step itself; the native harness has to.
//
// One place knows the on-disk layout (<skillDir>/SKILL.md). Do not add a second.
import * as fs from 'fs';
import * as path from 'path';
import { scanProjectSkills, scanSkills } from '../../skill-scanner';
import type { SkillEntry } from '../../../shared/types';

export interface LoadedSkill {
  id: string; displayName: string; description: string; body: string;
  /** Absolute path to the SKILL.md that was read. Lets the UI open the real file
   *  in the artifact viewer instead of dumping its text into the timeline. */
  file: string;
}

export interface SkillCatalog {
  /** id + description only — this is what rides in the tool schema on EVERY turn,
   *  so it must stay small. Never put bodies here. */
  list(): Array<{ id: string; description: string }>;
  load(id: string): LoadedSkill;
}

export class SkillNotFound extends Error {
  constructor(public readonly id: string, public readonly known: string[]) {
    // Naming what IS available turns a dead end into a next step — a bare
    // "not found" leaves the model guessing at ids.
    super(`No skill named '${id}'. Available skills: ${known.length ? known.join(', ') : '(none installed)'}.`);
    this.name = 'SkillNotFound';
  }
}

export class SkillAmbiguous extends Error {
  constructor(public readonly name: string, public readonly matches: string[]) {
    // Picking one silently would run the wrong plugin's skill. Naming both lets
    // the user qualify it, which the exact-match path already accepts.
    super(`Several plugins provide a skill called '${name}': ${matches.join(', ')}. Use the full name to pick one.`);
    this.name = 'SkillAmbiguous';
  }
}


// The literal placeholder a plugin skill writes in its SKILL.md. It is data, not a
// template we evaluate — so the lint rule that warns about ${...} inside a plain
// string is disabled here on purpose.
// eslint-disable-next-line no-template-curly-in-string
const PLUGIN_ROOT_TOKEN = '${CLAUDE_PLUGIN_ROOT}';
export class SkillUnreadable extends Error {
  constructor(public readonly id: string, public readonly cause: string) {
    // Specific and accurate per docs/error-message-standards.md — surface the
    // real reason (missing path, unreadable file), never a guess.
    super(`The skill '${id}' is installed but its instructions could not be read: ${cause}`);
    this.name = 'SkillUnreadable';
  }
}

/** Drop YAML frontmatter. The model needs the instructions; the metadata is ours. */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return raw;              // unterminated block — keep the text rather than eat the file
  const afterFence = raw.indexOf('\n', end + 1);
  return afterFence === -1 ? '' : raw.slice(afterFence + 1);
}

export function createSkillCatalog(entries?: SkillEntry[], projectCwd?: string): SkillCatalog {
  // Project skills take precedence only within this catalog. The global scanner
  // deliberately excludes them, because its app-wide inventory has no cwd.
  const discovered = entries ?? [
    ...(projectCwd ? scanProjectSkills(projectCwd) : []),
    ...scanSkills(),
  ].filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) === index);
  const byId = new Map(discovered.map((e) => [e.id, e]));
  return {
    list: () => discovered.map((e) => ({ id: e.id, description: e.description })),
    load(id: string): LoadedSkill {
      // Exact id first, then BARE NAME. scanSkills namespaces plugin skills as
      // `<plugin>:<skill>` (wecoded-themes-plugin:theme-builder), but users — and
      // ThemeScreen's own button — type `/theme-builder`, which is what Claude
      // Code accepts. Without this, a correctly-installed skill reported as
      // missing (Destin, 2026-07-28).
      let entry = byId.get(id);
      if (!entry) {
        const qualified = discovered.filter((e) => e.id.slice(e.id.lastIndexOf(':') + 1) === id);
        // Ambiguity is refused, never guessed: two plugins can ship the same
        // skill name, and silently picking one runs the wrong plugin's code.
        if (qualified.length > 1) throw new SkillAmbiguous(id, qualified.map((e) => e.id));
        entry = qualified[0];
      }
      if (!entry) throw new SkillNotFound(id, [...byId.keys()]);
      if (!entry.skillDir) throw new SkillUnreadable(id, 'it has no installed directory on this machine');
      const file = path.join(entry.skillDir, 'SKILL.md');
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (err: any) {
        throw new SkillUnreadable(id, `${file} could not be read (${err?.code ?? err?.message ?? 'unknown error'})`);
      }
      // WHY: Claude Code fills ${CLAUDE_PLUGIN_ROOT} when it renders a plugin skill;
      // our harness must too, or every plugin's documented command runs as `node /skills/…`.
      const pluginRoot = path.dirname(path.dirname(entry.skillDir));
      const body = stripFrontmatter(raw).trim().split(PLUGIN_ROOT_TOKEN).join(pluginRoot);
      // entry.id, NOT the requested id: a bare name resolves to a qualified one,
      // and the caller labels the injected block with what actually ran.
      return { id: entry.id, displayName: entry.displayName, description: entry.description, body, file };
    },
  };
}
