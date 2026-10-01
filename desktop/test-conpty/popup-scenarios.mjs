// popup-scenarios.mjs — the situations capture-popup-corpus.mjs records.
//
// Each one says, step by step, what the driver types and what the screen is
// TRULY showing afterwards: 'none' (Claude Code's message box is live — a chat
// send lands there), 'popup' (a Claude Code pop-up holds the keyboard — a chat
// send would be swallowed or answer it). Look-alikes matter as much as real
// pop-ups: replies that QUOTE menus, numbered lists, footers, a tool running.
//
// Step fields: keys (typed as one write; `type: true` = one key at a time),
// state + note (the truth from here on), waitFor (regex: wait for it, and date
// the state from when it was drawn), gone (regex: wait for it to leave),
// pending (unscored transition), wait (ms), resize [cols, rows].
// Scenario fields: args, cfg (~/.claude.json extras), settings (settings.json),
// files (project), env, cols/rows, auth ('fake' default | 'real' | 'none'),
// script (stand-in API turns, see fake-anthropic.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ESC = '\u001b';
// Claude Code's message box: a rule, the input row, a rule.
export const BOX = '^─{20,}\\s*\\n^(❯|!).*\\n^─{20,}';

const QUOTED_MENU = [
  'When Claude Code asks for permission it looks like this:',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and always allow access to /tmp from this project',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
  '',
  'and the folder-trust dialog:',
  '',
  '```',
  '────────────────────────────────────────',
  ' Accessing workspace:',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
  '```',
  '',
  'Pick one:',
  '',
  '1. Yes, do it',
  '2. No, stop',
  '3. Maybe later',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

const LONG_REPLY = Array.from({ length: 12 }, (_, i) => [
  `## Section ${i + 1}`,
  '',
  `${i + 1}. A numbered point that is long enough to wrap on a narrow terminal, which matters for the parser`,
  `${i + 2}. Another point`,
  '',
  '| Option | Meaning |',
  '|---|---|',
  '| ❯ Yes | proceed |',
  '| No | stop |',
  '',
].join('\n')).join('\n') + '\n\nEsc to cancel · Enter to confirm';

const sendMessage = (text, note = 'reply streaming') => [
  { keys: text, type: true, typeMs: 8, state: 'none', note: 'typing a message' },
  { keys: '\r', state: 'none', note },
];

/** Open a slash-command pop-up, hold it, close it with Esc. */
const slash = (cmd, anchor, { close = ESC, holdMs = 1200 } = {}) => [
  { keys: `/${cmd}`, type: true, state: 'none', note: `typing /${cmd} (suggestions list)` },
  { wait: 500 },
  { keys: '\r', pending: true, note: `/${cmd} opening` },
  { waitFor: anchor, state: 'popup', note: `/${cmd}` },
  { wait: holdMs },
  { keys: close, pending: true, note: `/${cmd} closing` },
  { waitFor: BOX, state: 'none', note: `after /${cmd}` },
  { wait: 800 },
];

const idleUntilBox = (note) => ({ waitFor: BOX, state: 'none', note, timeout: 20000 });

const PERM = 'Do you want to proceed\\?';

const BASE = [
  // ── Ordinary screens: no pop-up anywhere ─────────────────────────────────
  {
    name: 'idle-typing',
    description: 'typing in the message box: plain, multi-line, bash mode, @ and / suggestions',
    steps: [
      { keys: 'a plain draft that is not sent', type: true, state: 'none', note: 'draft' },
      { keys: '\u0015', wait: 300 }, // ctrl+u clears
      { keys: 'line one\\\r', type: true, note: 'multi-line draft' },
      { keys: 'line two', type: true, wait: 500 },
      { keys: '\u0015\u0015\u0015', wait: 300 },
      { keys: '!echo hi', type: true, note: 'bash-mode draft', wait: 500 },
      { keys: '\u007f\u007f\u007f\u007f\u007f\u007f\u007f\u007f', wait: 500 },
      { keys: '@', type: true, note: '@ suggestions', wait: 1200 },
      { keys: '\u007f', wait: 300 },
      { keys: '/', note: '/ suggestions', wait: 1200 },
      { keys: 'mo', type: true, wait: 800 },
      { keys: '\u007f\u007f\u007f', wait: 600 },
    ],
  },
  {
    name: 'reply-quoted-menus',
    description: 'a reply that quotes permission and trust menus, a numbered list, and ends on a footer line',
    script: [{ text: QUOTED_MENU, wordMs: 25 }],
    steps: [...sendMessage('show me what the menus look like'), idleUntilBox('after the reply'), { wait: 1500 }],
  },
  {
    name: 'reply-exact-live-menu',
    description: 'a reply whose LAST lines are exactly a live menu: ❯ cursor, numbered options, footer — then the message box',
    script: [{ text: 'Choose how to continue:\n\n❯ 1. Yes, and switch to auto mode\n  2. Yes, just this once\n  3. No, and tell Claude what to do differently\n\nEnter to confirm · Esc to cancel', wordMs: 20 }],
    steps: [...sendMessage('which one?'), { waitFor: 'Enter to confirm · Esc to cancel', state: 'none', note: 'after the reply' }, { wait: 2500 }],
  },
  {
    name: 'reply-long-scrolling',
    description: 'a reply taller than the screen: numbered lists, tables with ❯, a footer-like last line',
    script: [{ text: LONG_REPLY, wordMs: 4 }],
    steps: [...sendMessage('long answer please'), idleUntilBox('after the reply'), { wait: 1500 }],
  },
  {
    name: 'reply-narrow',
    description: 'the quoted-menu reply on a 40-column terminal',
    cols: 40, rows: 30,
    script: [{ text: QUOTED_MENU, wordMs: 20 }],
    steps: [...sendMessage('menus'), idleUntilBox('after the reply'), { wait: 1500 }],
  },
  {
    name: 'reply-resize',
    description: 'the terminal is resized while a reply streams and after',
    script: [{ text: LONG_REPLY, wordMs: 12 }],
    steps: [
      ...sendMessage('long answer'),
      { wait: 1500 },
      { resize: [60, 25], state: 'none', note: 'resized mid-reply' },
      idleUntilBox('after the reply'),
      { wait: 1000 },
    ],
  },
  {
    name: 'thinking-slow',
    description: 'a long wait before the reply (spinner only), then thinking + text',
    script: [{ delayMs: 5000, thinking: 'Let me think about options 1. and 2. Esc to cancel', text: 'Here you go.' }],
    steps: [...sendMessage('think hard'), idleUntilBox('after the reply'), { wait: 800 }],
  },
  {
    name: 'tool-running',
    description: 'an allowed shell command runs for a few seconds, then a TodoWrite list, then text',
    settings: { permissions: { allow: ['Bash(sleep:*)', 'Bash(echo:*)'] } },
    args: ['--permission-mode', 'default'],
    script: [
      { text: 'Running it.', tools: [{ name: 'Bash', input: { command: 'sleep 4; echo "1. Yes 2. No Esc to cancel"', description: 'wait' } }] },
      { tools: [{ name: 'TodoWrite', input: { todos: [
        { content: 'Yes, do the first thing', status: 'completed', activeForm: 'Doing the first thing' },
        { content: 'No, skip the second', status: 'in_progress', activeForm: 'Skipping the second' },
        { content: 'Esc to cancel', status: 'pending', activeForm: 'Cancelling' },
      ] } }] },
      { text: 'All done:\n\n1. ran it\n2. listed todos' },
    ],
    steps: [...sendMessage('run the thing', 'tool running'), idleUntilBox('after the turn'), { wait: 1000 }],
  },
  {
    name: 'background-task',
    description: 'a shell command started in the background (the background-task pill)',
    settings: { permissions: { allow: ['Bash(sleep:*)'] } },
    args: ['--permission-mode', 'default'],
    script: [
      { tools: [{ name: 'Bash', input: { command: 'sleep 20', description: 'long wait', run_in_background: true } }] },
      { text: 'Started it in the background.' },
    ],
    steps: [...sendMessage('start it'), idleUntilBox('after the turn'), { wait: 2500 }],
  },
  {
    name: 'queued-and-interrupted',
    description: 'a second message queued while a slow reply streams, then Esc interrupts',
    script: [{ text: Array.from({ length: 60 }, (_, i) => `${i + 1}. item`).join('\n'), wordMs: 80 }, { text: 'ok' }],
    steps: [
      ...sendMessage('slow list'),
      { wait: 1500 },
      { keys: 'and another thing', type: true, typeMs: 8, state: 'none', note: 'typing while busy' },
      { keys: '\r', state: 'none', note: 'queued' },
      { wait: 1500 },
      { keys: ESC, state: 'none', note: 'interrupted' },
      idleUntilBox('after interrupt'),
      { wait: 2500 },
    ],
  },
  {
    name: 'api-errors',
    description: 'the API fails (500, then overloaded) and Claude Code retries',
    script: [{ status: 500 }, { status: 529, errorBody: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }, { text: 'Recovered.' }],
    steps: [...sendMessage('hello'), idleUntilBox('after recovery'), { wait: 1000 }],
  },
  {
    name: 'mode-cycling',
    description: 'shift+tab through the permission modes (status line changes only)',
    steps: [
      { keys: '\u001b[Z', state: 'none', note: 'mode 2', wait: 700 },
      { keys: '\u001b[Z', wait: 700 },
      { keys: '\u001b[Z', wait: 700 },
      { keys: '\u001b[Z', wait: 700 },
    ],
  },
  {
    name: 'keys-toggles',
    description: 'ctrl+o (detailed transcript view — the message box is replaced and typing is swallowed) and ctrl+t (tasks)',
    script: [{ text: 'A short reply with a list:\n\n1. one\n2. two' }],
    steps: [
      ...sendMessage('hi'), { waitFor: 'two', state: 'none', note: 'after reply' }, { wait: 800 },
      { keys: '\u000f', pending: true, note: 'ctrl+o' },
      // Verified 2026-09-29: text + Enter typed here is dropped, nothing sent.
      { waitFor: 'Showing detailed transcript', state: 'modal', note: 'transcript view' },
      { wait: 1200 },
      { keys: '\u000f', pending: true },
      { waitFor: BOX, state: 'none', note: 'back from transcript view' },
      { wait: 600 },
      { keys: '\u0014', state: 'none', note: 'ctrl+t', wait: 1200 },
      { keys: '\u0014', wait: 800 },
    ],
  },

  // ── Permission pop-ups (the app's hook card normally owns these) ─────────
  {
    name: 'perm-bash',
    description: 'a shell command asks permission; answered No with Esc',
    args: ['--permission-mode', 'default'],
    script: [{ text: 'I will remove it.', tools: [{ name: 'Bash', input: { command: 'rm -rf ./build-output', description: 'Remove build output' } }] }, { text: 'Understood, I will not.' }],
    steps: [
      ...sendMessage('clean up'),
      { waitFor: PERM, state: 'popup', note: 'bash permission' },
      { wait: 1500 },
      { keys: ESC, pending: true },
      idleUntilBox('after answering'),
      { wait: 1000 },
    ],
  },
  {
    name: 'perm-bash-yes',
    description: 'a shell command asks permission; answered Yes with 1, it runs, reply follows',
    args: ['--permission-mode', 'default'],
    script: [{ tools: [{ name: 'Bash', input: { command: 'touch hello-from-capture.txt', description: 'Make a file' } }] }, { text: 'It printed hello.\n\n1. Yes\n2. No' }],
    steps: [
      ...sendMessage('say hello'),
      { waitFor: PERM, state: 'popup', note: 'bash permission' },
      { wait: 1000 },
      { keys: '1', pending: true },
      idleUntilBox('after the turn'),
      { wait: 1000 },
    ],
  },
  {
    name: 'perm-mid-reply',
    description: 'a long numbered reply, then a permission pop-up in the same turn (list still on screen above it)',
    args: ['--permission-mode', 'default'],
    script: [{ text: LONG_REPLY, wordMs: 3, tools: [{ name: 'Bash', input: { command: 'git push --force', description: 'Force push' } }] }, { text: 'Stopped.' }],
    steps: [
      ...sendMessage('push it'),
      { waitFor: PERM, state: 'popup', note: 'bash permission under a long reply' },
      { wait: 1500 },
      { keys: ESC, pending: true },
      idleUntilBox('after answering'),
      { wait: 800 },
    ],
  },
  {
    name: 'perm-two-in-a-row',
    description: 'two tool calls in one message: two permission pop-ups back to back',
    args: ['--permission-mode', 'default'],
    script: [
      { tools: [
        { name: 'Bash', input: { command: 'touch one.txt', description: 'first' } },
        { name: 'Bash', input: { command: 'touch two.txt', description: 'second' } },
      ] },
      { text: 'Both handled.' },
    ],
    steps: [
      ...sendMessage('make two files'),
      { waitFor: 'touch one\\.txt[\\s\\S]*' + PERM, state: 'popup', note: 'first permission' },
      { wait: 1000 },
      { keys: '1', pending: true },
      // The second pop-up shows the second command INSIDE it ("Bash command" then
      // the command) — the first pop-up's screen also lists both tool calls above.
      { waitFor: 'Bash command\\n(.*\\n){0,3}\\s*touch two\\.txt', state: 'popup', note: 'second permission' },
      { wait: 1000 },
      { keys: '1', pending: true },
      idleUntilBox('after both'),
      { wait: 800 },
    ],
  },
  {
    name: 'perm-edit',
    description: 'an edit to an existing file asks permission (a tall diff pop-up)',
    args: ['--permission-mode', 'default'],
    files: { 'notes.md': Array.from({ length: 30 }, (_, i) => `${i + 1}. line ${i + 1}`).join('\n') + '\n' },
    script: [
      { tools: [{ name: 'Read', input: { file_path: '$CWD/notes.md' } }] },
      { tools: [{ name: 'Edit', input: { file_path: '$CWD/notes.md', old_string: '5. line 5', new_string: '5. line five\n6a. inserted' } }] },
      { text: 'Edit declined.' },
    ],
    steps: [
      ...sendMessage('edit the notes'),
      { waitFor: 'Do you want to make this edit|Do you want to proceed', state: 'popup', note: 'edit permission' },
      { wait: 1500 },
      { keys: ESC, pending: true },
      idleUntilBox('after answering'),
      { wait: 800 },
    ],
  },
  {
    name: 'perm-write-narrow',
    description: 'creating a file asks permission, on a 40-column terminal',
    cols: 40, rows: 30,
    args: ['--permission-mode', 'default'],
    script: [{ tools: [{ name: 'Write', input: { file_path: '$CWD/new-file.txt', content: '1. Yes\n2. No\nEsc to cancel\n' } }] }, { text: 'Declined.' }],
    steps: [
      ...sendMessage('write a file'),
      { waitFor: 'Do you want to create|Do you want to proceed|Do you want to make', state: 'popup', note: 'write permission (narrow)' },
      { wait: 1500 },
      { keys: ESC, pending: true },
      idleUntilBox('after answering'),
      { wait: 800 },
    ],
  },
  {
    name: 'perm-webfetch',
    description: 'fetching a web page asks permission',
    args: ['--permission-mode', 'default'],
    script: [{ tools: [{ name: 'WebFetch', input: { url: 'https://example.com/docs', prompt: 'summarise' } }] }, { text: 'Skipped.' }],
    steps: [
      ...sendMessage('read the docs'),
      { waitFor: PERM + '|Fetch', state: 'popup', note: 'fetch permission', from: PERM },
      { wait: 1500 },
      { keys: ESC, pending: true },
      idleUntilBox('after answering'),
      { wait: 800 },
    ],
  },
  {
    name: 'ask-user-question',
    description: 'AskUserQuestion: a single question, then two questions with multi-select',
    script: [
      { tools: [{ name: 'AskUserQuestion', input: { questions: [{ question: 'Which colour scheme do you want?', header: 'Colours', multiSelect: false, options: [
        { label: 'Dark', description: 'Dark background' }, { label: 'Light', description: 'Light background' }, { label: 'Auto', description: 'Follow the system' },
      ] }] } }] },
      { tools: [{ name: 'AskUserQuestion', input: { questions: [
        { question: 'Which features?', header: 'Features', multiSelect: true, options: [{ label: 'Search', description: 'Find things' }, { label: 'Sync', description: 'Keep devices in step' }] },
        { question: 'Ship when?', header: 'Timing', multiSelect: false, options: [{ label: 'Today', description: 'Now' }, { label: 'Next week', description: 'Later' }] },
      ] } }] },
      { text: 'Thanks.' },
    ],
    steps: [
      ...sendMessage('ask me things'),
      { waitFor: 'Which colour scheme', state: 'popup', note: 'single question' },
      { wait: 1200 },
      { keys: '1', pending: true },
      { waitFor: 'Which features\\?', state: 'popup', note: 'multi-question', from: 'Which features\\?' },
      { wait: 1200 },
      { keys: ESC, pending: true },
      idleUntilBox('after the questions'),
      { wait: 800 },
    ],
  },
  {
    name: 'plan-approval',
    description: 'plan mode: the plan-approval pop-up',
    args: ['--permission-mode', 'plan'],
    script: [
      { tools: [{ name: 'ExitPlanMode', input: { plan: '# Plan\n\n1. Do the first thing\n2. Do the second thing\n\nEsc to cancel' } }] },
      { text: 'Staying in plan mode.' },
    ],
    steps: [
      ...sendMessage('make a plan'),
      { waitFor: 'Exit plan mode\\?|Would you like to proceed', state: 'popup', note: 'plan approval' },
      { wait: 1500 },
      { keys: ESC, pending: true },
      idleUntilBox('after answering'),
      { wait: 800 },
    ],
  },

  // ── Pop-ups the user opens with a slash command ──────────────────────────
  { name: 'slash-config', description: '/config settings panel (search box, tabs); first Esc clears the search, second closes', steps: slash('config', 'Search settings', { close: [ESC, ESC] }) },
  { name: 'slash-model', description: '/model picker', steps: slash('model', 'Select model') },
  { name: 'slash-permissions', description: '/permissions (tabs + search)', steps: slash('permissions', 'Recently denied') },
  { name: 'slash-hooks', description: '/hooks (a list; reworded in 2.1.286, so anchored on its read-only notice)', steps: slash('hooks', 'This menu is read-only') },
  { name: 'slash-resume', description: '/resume (search, wrapped footer)', steps: slash('resume', 'Resume session') },
  { name: 'slash-add-dir', description: '/add-dir (a text-entry pop-up)', steps: slash('add-dir', 'Add directory to workspace') },
  { name: 'slash-export', description: '/export (short menu, "Esc to cancel" only)', steps: slash('export', 'Export conversation') },
  { name: 'slash-status', description: '/status (information panel)', steps: slash('status', 'Session ID') },
  { name: 'slash-theme', description: '/theme (menu with a diff preview inside)', steps: slash('theme', 'Choose the text style') },
  { name: 'slash-login', description: '/login (menu)', steps: slash('login', 'Select login method') },
  { name: 'slash-help', description: '/help (tabs, shortcut table)', steps: slash('help', 'for shell mode') },
  { name: 'slash-usage', description: '/usage (information panel)', steps: slash('usage', 'Total cost') },
  { name: 'slash-effort', description: '/effort (slider)', steps: slash('effort', 'Faster') },
  { name: 'slash-memory', description: '/memory (menu)', steps: slash('memory', 'Auto-memory') },
  {
    name: 'slash-inline-output',
    description: 'slash commands that print text instead of opening a pop-up (/agents, /mcp, /output-style)',
    steps: [
      { keys: '/agents', type: true, state: 'none', note: 'typing' }, { wait: 400 }, { keys: '\r', wait: 1500 },
      { keys: '/mcp', type: true }, { wait: 400 }, { keys: '\r', wait: 1500 },
      { keys: '/output-style', type: true }, { wait: 400 }, { keys: '\r', wait: 1500 },
    ],
  },
  {
    name: 'rewind',
    description: 'Esc Esc after a message opens the rewind picker',
    script: [{ text: 'First reply.' }],
    steps: [
      ...sendMessage('first message'), idleUntilBox('after reply'), { wait: 800 },
      { keys: ESC, pending: true }, { wait: 150 }, { keys: ESC },
      { waitFor: 'Rewind', state: 'popup', note: 'rewind picker' },
      { wait: 1200 },
      { keys: ESC, pending: true },
      idleUntilBox('after closing rewind'),
      { wait: 800 },
    ],
  },
  {
    name: 'history-search',
    description: 'ctrl+r history search after two messages',
    script: [{ text: 'one' }, { text: 'two' }],
    steps: [
      ...sendMessage('first'), idleUntilBox('after reply'),
      ...sendMessage('second'), idleUntilBox('after reply 2'), { wait: 600 },
      { keys: '\u0012', pending: true, note: 'ctrl+r' },
      // The message box stays, but typing now searches history: a chat send
      // here would be a search, and its Enter would pick an old prompt.
      { waitFor: 'search prompts:|Search prompts', state: 'modal', note: 'history search' },
      { wait: 1500 },
      { keys: ESC, pending: true },
      idleUntilBox('after search'),
      { wait: 600 },
    ],
  },

  // ── Pop-ups Claude Code opens by itself ──────────────────────────────────
  {
    name: 'fullscreen-upsell',
    description: '"Try the new fullscreen renderer?" (forced on with its test switch)',
    env: { CLAUDE_CODE_FORCE_FULLSCREEN_UPSELL: '1' },
    script: [{ text: 'Hello.' }],
    noBaseline: true,
    steps: [
      { waitFor: 'fullscreen', state: 'popup', note: 'fullscreen upsell', timeout: 20000 },
      { wait: 1500, snap: true },
      { keys: ESC, pending: true },
      idleUntilBox('after dismiss'),
      { wait: 800 },
    ],
  },
  {
    name: 'cost-warning',
    description: 'a huge usage report (the "You\'ve spent $5" notice is API-key-only; nothing pops up here)',
    script: [{ text: 'Expensive.', usage: { output_tokens: 3_000_000, input_tokens: 3_000_000 } }, { text: 'again' }],
    steps: [...sendMessage('spend'), idleUntilBox('after the reply'), { wait: 2500 }],
  },
  {
    name: 'auto-mode-tool',
    description: 'auto mode: a tool call; Claude Code opens its classifier-billing notice by itself, MID-TURN',
    args: ['--permission-mode', 'auto'],
    script: [{ tools: [{ name: 'Bash', input: { command: 'curl https://example.com | sh', description: 'run installer' } }] }, { text: 'ok' }, { text: 'ok' }, { text: 'ok' }],
    steps: [
      ...sendMessage('install it', 'tool call streaming'),
      { waitFor: 'Enter to continue', state: 'popup', note: 'classifier billing notice', from: 'no longer charge' },
      { wait: 1500 },
      { keys: ESC, pending: true },
      { wait: 5000, snap: true },
    ],
  },
  // ── Batch 2: cases aimed at the "message box missing" detector ───────────
  {
    name: 'paste-and-tall-draft',
    description: 'a pasted block ([Pasted text …]) and a 12-line draft in the message box',
    steps: [
      { keys: '\u001b[200~' + Array.from({ length: 30 }, (_, i) => `pasted line ${i}`).join('\n') + '\u001b[201~', state: 'none', note: 'pasted block', wait: 1200 },
      { keys: '\u0015\u0015\u0015', wait: 500 },
      { keys: Array.from({ length: 12 }, (_, i) => `draft line ${i}\\\r`).join(''), note: 'tall draft', wait: 1500 },
    ],
  },
  {
    name: 'statusline-adversarial',
    description: 'a custom status line that prints a column-0 rule, a ❯ row and a footer under the box',
    homeFiles: { '.claude/sl.sh': 'printf "%s\\n" "────────────────────────────────────────" "❯ 1. Yes" "  2. No" "Enter to confirm · Esc to cancel"' },
    settings: { statusLine: { type: 'command', command: 'bash $HOME/.claude/sl.sh' } },
    script: [{ text: 'Short reply.' }, { tools: [{ name: 'Bash', input: { command: 'rm -rf ./dist', description: 'Remove dist' } }] }, { text: 'ok' }],
    args: ['--permission-mode', 'default'],
    steps: [
      { wait: 1500, state: 'none', note: 'idle with the status line' },
      ...sendMessage('hi'), { waitFor: 'Short reply', state: 'none', note: 'after reply' }, { wait: 1200 },
      ...sendMessage('clean'),
      { waitFor: PERM, state: 'popup', note: 'permission with the status line' },
      { wait: 1200 },
      { keys: ESC, pending: true },
      { waitFor: BOX, state: 'none', note: 'after answering' }, { wait: 1200 },
    ],
  },
  {
    name: 'vim-mode',
    description: 'vim editing mode: insert and normal mode in the message box',
    settings: { editorMode: 'vim' },
    steps: [
      { keys: 'ihello vim', type: true, state: 'none', note: 'insert mode draft', wait: 800 },
      { keys: ESC, note: 'normal mode', wait: 1200 },
      { keys: 'dd', wait: 800 },
    ],
  },
  {
    name: 'resize-during-popup',
    description: 'the terminal shrinks and grows while a permission pop-up is open, and while a slash pop-up is open',
    args: ['--permission-mode', 'default'],
    script: [{ text: LONG_REPLY, wordMs: 2, tools: [{ name: 'Bash', input: { command: 'rm -rf ./cache', description: 'Remove cache' } }] }, { text: 'ok' }],
    steps: [
      ...sendMessage('clean'),
      { waitFor: PERM, state: 'popup', note: 'permission' },
      { wait: 800 },
      { resize: [50, 24], pending: true, note: 'shrinking' }, { waitFor: PERM, state: 'popup', note: 'permission at 50x24' }, { wait: 1200 },
      { resize: [120, 40], pending: true, note: 'growing' }, { waitFor: PERM, state: 'popup', note: 'permission at 120x40' }, { wait: 1200 },
      { keys: ESC, pending: true },
      { waitFor: BOX, state: 'none', note: 'after answering' }, { wait: 1000 },
      { keys: '/model', type: true, state: 'none', note: 'typing /model' }, { wait: 500 },
      { keys: '\r', pending: true },
      { waitFor: 'Select model', state: 'popup', note: '/model' }, { wait: 600 },
      { resize: [60, 20], pending: true, note: 'shrinking' }, { waitFor: 'Esc to cancel', state: 'popup', note: '/model at 60x20' }, { wait: 1200 },
      { keys: ESC, pending: true },
      { waitFor: BOX, state: 'none', note: 'after /model' }, { wait: 1000 },
    ],
  },
  {
    name: 'short-terminal-tall-popup',
    description: 'a 14-row terminal: an edit pop-up much taller than the screen',
    rows: 14,
    args: ['--permission-mode', 'default'],
    files: { 'big.md': Array.from({ length: 40 }, (_, i) => `row ${i}`).join('\n') + '\n' },
    script: [
      { tools: [{ name: 'Read', input: { file_path: '$CWD/big.md' } }] },
      { tools: [{ name: 'Write', input: { file_path: '$CWD/big.md', content: Array.from({ length: 40 }, (_, i) => `ROW ${i}`).join('\n') } }] },
      { text: 'ok' },
    ],
    steps: [
      ...sendMessage('rewrite it'),
      { waitFor: 'Esc to cancel', state: 'popup', note: 'tall overwrite pop-up', from: 'Do you want|Esc to cancel' },
      { wait: 1500 },
      { keys: ESC, pending: true },
      { waitFor: BOX, state: 'none', note: 'after answering' }, { wait: 1000 },
    ],
  },
  {
    name: 'agents-view',
    description: '← on an empty message box opens the agents view: its box starts a NEW background session',
    steps: [
      { keys: '\u001b[D', pending: true, note: 'left arrow' },
      // Verified 2026-09-29: text + Enter here is a task for a new session.
      { waitFor: 'describe a task for a new session|enter to return', state: 'modal', note: 'agents view' },
      { wait: 1500 },
      { keys: ESC, pending: true },
      { waitFor: BOX + '(\\n.*){1,6}(for agents|shift\\+tab to cycle)', state: 'none', note: 'back from agents view' },
      { wait: 1200 },
    ],
  },
  {
    name: 'compact',
    description: '/compact summarises the conversation (a side request)',
    script: [{ text: 'A reply worth summarising.' }, { text: '<summary>1. Yes 2. No</summary>' }, { text: 'Summary.' }],
    steps: [
      ...sendMessage('hello'), { waitFor: 'worth summarising', state: 'none', note: 'after reply' }, { wait: 800 },
      { keys: '/compact', type: true, state: 'none', note: 'typing /compact' }, { wait: 500 },
      { keys: '\r', pending: true, note: 'compacting' },
      { wait: 6000, snap: true },
    ],
  },
  {
    name: 'popup-over-draft',
    description: 'a permission pop-up opens while the user has a draft typed in the box (a queued message)',
    args: ['--permission-mode', 'default'],
    script: [{ text: 'Working on it', wordMs: 60, tools: [{ name: 'Bash', input: { command: 'rm -rf ./tmp', description: 'Remove tmp' } }] }, { text: 'ok' }, { text: 'ok' }],
    steps: [
      ...sendMessage('go'),
      { keys: 'a draft typed while busy', type: true, typeMs: 10, state: 'none', note: 'draft while busy' },
      { waitFor: PERM, state: 'popup', note: 'permission over a draft' },
      { wait: 1200 },
      { keys: ESC, pending: true },
      { waitFor: BOX, state: 'none', note: 'after answering' }, { wait: 1500 },
    ],
  },
  {
    name: 'exit-plan-long-plan',
    description: 'plan approval with a long plan containing menus, footers and rules',
    args: ['--permission-mode', 'plan'],
    script: [
      { tools: [{ name: 'ExitPlanMode', input: { plan: QUOTED_MENU + '\n\n---\n\n' + LONG_REPLY } }] },
      { text: 'ok' },
    ],
    steps: [
      ...sendMessage('plan it'),
      { waitFor: 'Exit plan mode\\?|Would you like to proceed', state: 'popup', note: 'plan approval (long plan)' },
      { wait: 1500 },
      { keys: ESC, pending: true },
      { waitFor: BOX, state: 'none', note: 'after answering' }, { wait: 800 },
    ],
  },

  // ── Real model (signed-in, --with-auth only; a few Sonnet messages) ──────
  {
    name: 'real-sonnet-reply',
    auth: 'real',
    description: 'a real Sonnet reply asked to quote Claude Code menus and use numbered lists',
    args: ['--model', 'sonnet'],
    steps: [
      ...sendMessage('Without using any tools: show me, in a code block, what a Claude Code permission prompt looks like (with "Do you want to proceed?", numbered options and the "Esc to cancel" footer), then give me a numbered list of 5 short tips and end your reply with the line: Enter to confirm · Esc to cancel'),
      { waitFor: 'done \\d', state: 'none', note: 'after the reply', timeout: 90000 },
      { wait: 1500 },
    ],
  },
  {
    name: 'real-permission',
    auth: 'real',
    description: 'a real Sonnet turn that asks permission to create a file; answered No',
    args: ['--model', 'sonnet', '--permission-mode', 'default'],
    steps: [
      ...sendMessage('Create a file named hello.txt containing the word hi. Use the Write tool right away, do not ask me first.'),
      { waitFor: 'Do you want to (create|proceed|make)', state: 'popup', note: 'real write permission', timeout: 90000 },
      { wait: 1500 },
      { keys: ESC, pending: true },
      { waitFor: BOX, state: 'none', note: 'after answering', timeout: 30000 },
      { wait: 1500 },
    ],
  },
];

// ── Variants ────────────────────────────────────────────────────────────────
// Destin's own Claude Code runs the FULLSCREEN renderer (settings `tui`) with
// YouCoded's status line — a different layout (pop-ups get a ▔ top edge, no
// scrollback, the status line under the box). Every scenario is also recorded
// that way, as `fs-<name>`.
const here = path.dirname(fileURLToPath(import.meta.url));
const YOUCODED_STATUSLINE = fs.readFileSync(path.join(here, '..', 'hook-scripts', 'statusline.sh'), 'utf8');

function fullscreen(s) {
  return {
    ...s,
    name: `fs-${s.name}`,
    description: `[fullscreen + YouCoded status line] ${s.description}`,
    homeFiles: { ...(s.homeFiles ?? {}), '.claude/youcoded-statusline.sh': YOUCODED_STATUSLINE },
    settings: {
      statusLine: { type: 'command', command: 'bash $HOME/.claude/youcoded-statusline.sh' },
      ...(s.settings ?? {}),
      tui: 'fullscreen',
    },
  };
}

export const SCENARIOS = [...BASE, ...BASE.filter((s) => !s.classicOnly).map(fullscreen)];
