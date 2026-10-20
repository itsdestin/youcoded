import { DESTRUCTIVE_DENY_LIST, type PermissionDecision } from '../../shared/permission-types';
import { ruleMatches } from '../../shared/subject-glob';
import { baseName, commandIndex, INTERPRETERS, SHELL_FEEDERS, splitHeredocs, tokenize, type Word } from './tools/shell-words';

const SUDO = new Set(['sudo']);
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);

/** WHY: a broad admin grant covers a sudo command, not everything a shell can
 * chain onto it. Use the existing shell reader, not whitespace-dependent globs,
 * and fail toward asking for compound/indirect calls. Exact consent is separate. */
function canWaiveAdminAsk(command: string): boolean {
  const { text, bodies } = splitHeredocs(command);
  const { tokens, nested } = tokenize(text, process.platform !== 'win32');
  if (bodies.length || nested.length || tokens.some(token => token.op)) return false;
  const words = tokens as Word[];
  const sudo = words[commandIndex(words, SUDO)];
  const index = commandIndex(words);
  const executable = words[index];
  if (!sudo || baseName(sudo.value) !== 'sudo' || !executable || executable.vars.length || executable.subs.length) return false;
  const name = baseName(executable.value);
  const args = words.slice(index + 1);
  // WHY: attached flags (-eCODE/--eval=CODE), stdin and script files all run
  // indirect code. Do not guess that an unrecognized flag makes an interpreter safe.
  const family = name === 'nodejs' ? 'node' : name.replace(/\d+(?:\.\d+)*$/, '');
  if (INTERPRETERS.has(name) || INTERPRETERS.has(family) || SHELL_FEEDERS.has(family) || name === 'eval') return false;
  if (name === 'find' && args.some(arg => FIND_EXEC.has(arg.value))) return false;
  // Normalize executable paths and transparent wrappers before checking the
  // existing dangerous families. Git global options may precede its subcommand.
  if (name === 'git' && (args.some(arg => arg.value === 'push') ||
    (args.some(arg => arg.value === 'reset') && args.some(arg => arg.value === '--hard')))) return false;
  const canonical = [name, ...args.map(arg => arg.value)].join(' ');
  return !DESTRUCTIVE_DENY_LIST.some(rule => !rule.pattern?.includes('sudo ') &&
    (ruleMatches(rule, command) || ruleMatches(rule, canonical)));
}

/** Waive only the admin toll. Explicit denies and protected-path floors remain;
 * an exact remembered approval may cover a compound command because the person
 * explicitly approved that whole literal command, not just its sudo step. */
export function applyAdminApproval(configured: PermissionDecision, command: string, allowed: boolean): PermissionDecision {
  if (!allowed || configured.action === 'deny') return configured;
  return configured.passwordlessAdminExact === true || canWaiveAdminAsk(command)
    ? { ...configured, action: 'allow', denyListed: false }
    : { ...configured, action: 'ask', denyListed: true };
}
