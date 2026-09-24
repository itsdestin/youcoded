// startup-scenarios.mjs — every Claude Code startup situation the app has to
// cope with, as data. capture-startup-dialogs.mjs records each one;
// check-startup-drift.mjs re-records them against another Claude Code and
// compares. Add a scenario here when you learn of a new startup dialog.
//
// Fields:
//   folder   'plain' | 'home' (the temp HOME itself) | 'git' — where claude starts
//   trusted  pre-mark the folder as trusted in the temp ~/.claude.json
//   args     extra claude arguments
//   files    { relPath: content } written into the folder first
//   auth     true = needs the access-token copy (skipped with --no-auth, e.g. in CI)
//   cols/rows terminal size
//   steps    what to do with each dialog, in order:
//              { pick: '<exact option label>' }  arrows (verified) then Enter
//              { keys: '<bytes>', expect: 'stays' }  type keys; the dialog must NOT change
//              { keys: '\u001b' }                 type keys (e.g. Esc) and let it act
//              { record: true }                  record it, answer nothing, stop
//   until    'main-prompt' (wait for Claude Code's input box) | 'exit' | 'none'
//
// None of these sends a message to a model: they stop at, or before, the input box.

const MCP_ONE = JSON.stringify({ mcpServers: { demo: { command: 'node', args: ['server.js'] } } });
const MCP_TWO = JSON.stringify({
  mcpServers: {
    demo: { command: 'node', args: ['server.js'] },
    other: { type: 'http', url: 'http://127.0.0.1:9/mcp' },
  },
});
const PROJECT_SETTINGS = JSON.stringify({
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo project-hook' }] }] },
});
const PROJECT_HOOKS_ONLY = JSON.stringify({
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo project-hook' }] }] },
});

const TRUST_YES = { pick: 'Yes, I trust this folder' };
const BYPASS_YES = { pick: 'Yes, I accept' };

export const SCENARIOS = [
  { name: 'untrusted', folder: 'plain', steps: [TRUST_YES], until: 'main-prompt' },
  { name: 'untrusted-answer-no', folder: 'plain', steps: [{ pick: 'No, exit' }], until: 'exit' },
  // Pins WHY the app navigates with arrows: on 2.1.281 a typed digit does nothing here.
  { name: 'untrusted-digit-ignored', folder: 'plain', steps: [{ keys: '2', expect: 'stays' }, { keys: '\u001b' }], until: 'exit' },
  { name: 'home-folder', folder: 'home', steps: [TRUST_YES], until: 'main-prompt' },
  { name: 'git-repo', folder: 'git', steps: [TRUST_YES], until: 'main-prompt' },
  { name: 'project-settings', folder: 'plain', files: { '.claude/settings.json': PROJECT_SETTINGS }, steps: [TRUST_YES], until: 'main-prompt' },
  { name: 'project-hooks-only', folder: 'plain', files: { '.claude/settings.json': PROJECT_HOOKS_ONLY }, steps: [TRUST_YES], until: 'main-prompt' },
  { name: 'mcp-one', folder: 'plain', files: { '.mcp.json': MCP_ONE }, steps: [TRUST_YES, { pick: 'Continue without using this MCP server' }], until: 'main-prompt' },
  { name: 'mcp-two', folder: 'plain', files: { '.mcp.json': MCP_TWO }, steps: [TRUST_YES, { keys: '\u001b' }], until: 'main-prompt' },
  { name: 'trusted', folder: 'plain', trusted: true, steps: [], until: 'main-prompt' },
  { name: 'bypass-trusted', folder: 'plain', trusted: true, args: ['--dangerously-skip-permissions'], steps: [BYPASS_YES], until: 'main-prompt' },
  { name: 'bypass-answer-no', folder: 'plain', trusted: true, args: ['--dangerously-skip-permissions'], steps: [{ pick: 'No, exit' }], until: 'exit' },
  { name: 'bypass-untrusted', folder: 'plain', args: ['--dangerously-skip-permissions'], steps: [TRUST_YES, BYPASS_YES], until: 'main-prompt' },
  // Terminal widths: the app's terminal can be phone-narrow or a wide monitor.
  { name: 'untrusted', folder: 'plain', cols: 50, rows: 30, steps: [TRUST_YES], until: 'main-prompt' },
  { name: 'untrusted', folder: 'plain', cols: 180, rows: 50, steps: [TRUST_YES], until: 'main-prompt' },
  { name: 'bypass-untrusted', folder: 'plain', cols: 50, rows: 30, args: ['--dangerously-skip-permissions'], steps: [TRUST_YES, BYPASS_YES], until: 'main-prompt' },
  { name: 'mcp-one', folder: 'plain', cols: 40, rows: 30, files: { '.mcp.json': MCP_ONE }, steps: [TRUST_YES, { pick: 'Continue without using this MCP server' }], until: 'main-prompt' },
  { name: 'project-settings', folder: 'plain', cols: 50, rows: 30, files: { '.claude/settings.json': PROJECT_SETTINGS }, steps: [TRUST_YES], until: 'main-prompt' },
  // Signed in (access-token copy, no model call): proves sign-in does not
  // change the dialogs, so the signed-out captures CI can make stand for both.
  { name: 'untrusted-signed-in', folder: 'plain', auth: true, steps: [TRUST_YES], until: 'main-prompt' },
  { name: 'bypass-untrusted-signed-in', folder: 'plain', auth: true, args: ['--dangerously-skip-permissions'], steps: [TRUST_YES, BYPASS_YES], until: 'main-prompt' },
];

export const DEFAULT_COLS = 100;
export const DEFAULT_ROWS = 35;

/** The fixture file stem for a scenario: <name>-<cols>x<rows>. */
export function scenarioKey(s) {
  return `${s.name}-${s.cols ?? DEFAULT_COLS}x${s.rows ?? DEFAULT_ROWS}`;
}
