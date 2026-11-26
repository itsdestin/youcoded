// drawer-availability.ts — what the command drawer and skills list leave out or grey for THIS chat (waiting-notice T5).
//
// WHY (Destin, waiting-notice deck "Fewer chances to hit these"): the drawer used to offer commands and skills that could only
// answer "isn't available here" after they were pressed. A thing that cannot work in this chat is now not offered (commands) or
// greyed with one plain line saying why (skills). Typing one anyway still gets the explanation on the chat's strip.
import type { CommandEntry, SkillEntry } from '../../shared/types';
import { SKILL_NOT_HERE_NATIVE, SKILL_UNREADABLE_MARK } from './notice-words';

/** A YouCoded-runtime chat has no terminal, so a command that only runs in Claude Code is not offered there. Commands found on disk say nothing (runsIn absent) and stay. */
export function commandOfferedIn(entry: CommandEntry, provider: string | undefined): boolean {
  return !(provider === 'native' && entry.runsIn === 'claude-code');
}

/** The one line saying why this skill can't be started in this chat, or undefined when it can. */
export function skillUnavailableReason(skill: SkillEntry, provider: string | undefined): string | undefined {
  // Broken everywhere: both kinds of chat read the same file.
  if (skill.unreadable) return SKILL_UNREADABLE_MARK;
  // A YouCoded-runtime chat starts a skill by its name (/skill-name); a skill whose prompt is plain words has no way in yet.
  if (provider === 'native' && !skill.prompt.trim().startsWith('/')) return SKILL_NOT_HERE_NATIVE;
  return undefined;
}
