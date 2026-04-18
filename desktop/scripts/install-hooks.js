#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(
  require('os').homedir(),
  '.claude',
  'settings.json'
);
// In packaged builds, __dirname points inside app.asar (which Electron can read),
// but Claude Code invokes relay.js externally via system node (which can't read asar).
// Convert to the unpacked path so the hook command works at runtime.
const rawRelayPath = path.resolve(__dirname, '..', 'hook-scripts', 'relay.js');
const unpackedRelayPath = rawRelayPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
// Use unpacked path if it exists, otherwise fall back to original
const RELAY_PATH = fs.existsSync(unpackedRelayPath) ? unpackedRelayPath : rawRelayPath;

// Blocking relay for PermissionRequest — holds socket open for bidirectional response
const rawBlockingRelayPath = path.resolve(__dirname, '..', 'hook-scripts', 'relay-blocking.js');
const unpackedBlockingRelayPath = rawBlockingRelayPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const BLOCKING_RELAY_PATH = fs.existsSync(unpackedBlockingRelayPath) ? unpackedBlockingRelayPath : rawBlockingRelayPath;

// Safety: refuse to install hooks whose paths point inside a worktree. The
// ~/.claude/settings.json file is a shared resource — if we write a worktree
// path and the worktree is later removed, every hook call fails with ENOENT
// until the built app is relaunched. This is a belt-and-suspenders backstop
// for the YOUCODED_PROFILE gate in main.ts; if any future refactor breaks
// that gate, this guard still prevents corruption.
if (RELAY_PATH.includes(`${path.sep}.worktrees${path.sep}`)) {
  console.log(
    'install-hooks: script path is inside a worktree (' + RELAY_PATH + ') — ' +
    'refusing to write worktree paths to ~/.claude/settings.json. ' +
    'If this was unexpected, check that YOUCODED_PROFILE is set when running dev.'
  );
  process.exit(0);
}

// Fire-and-forget events use the standard relay
const FIRE_AND_FORGET_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Notification',
  'SubagentStart',
  'SubagentStop',
];

function installHooks() {
  let settings = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  const expectedRelayCmd = `node ${JSON.stringify(RELAY_PATH)}`;
  const expectedBlockingCmd = `node ${JSON.stringify(BLOCKING_RELAY_PATH)}`;

  // Register fire-and-forget events with standard relay
  for (const event of FIRE_AND_FORGET_EVENTS) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    // Find any existing relay hook (may have a stale path from a previous install)
    const existingIdx = settings.hooks[event].findIndex((matcher) =>
      matcher.hooks?.some((h) => h.command?.includes('relay.js') && !h.command?.includes('relay-blocking.js'))
    );

    const relayEntry = {
      matcher: '',
      hooks: [{ type: 'command', command: expectedRelayCmd, timeout: 10 }],
    };

    if (existingIdx >= 0) {
      // Update in place — preserves position relative to other hooks
      settings.hooks[event][existingIdx] = relayEntry;
    } else {
      settings.hooks[event].push(relayEntry);
    }
  }

  // Register PermissionRequest with blocking relay (longer timeout for user response)
  if (!settings.hooks['PermissionRequest']) {
    settings.hooks['PermissionRequest'] = [];
  }

  // Remove any old fire-and-forget relay for PermissionRequest
  settings.hooks['PermissionRequest'] = settings.hooks['PermissionRequest'].filter((matcher) =>
    !matcher.hooks?.some((h) => h.command?.includes('relay.js') && !h.command?.includes('relay-blocking.js'))
  );

  const blockingEntry = {
    matcher: '',
    hooks: [{ type: 'command', command: expectedBlockingCmd, timeout: 300 }],
  };

  const existingBlockingIdx = settings.hooks['PermissionRequest'].findIndex((matcher) =>
    matcher.hooks?.some((h) => h.command?.includes('relay-blocking.js'))
  );

  if (existingBlockingIdx >= 0) {
    settings.hooks['PermissionRequest'][existingBlockingIdx] = blockingEntry;
  } else {
    settings.hooks['PermissionRequest'].push(blockingEntry);
  }

  // --- Auto-titling hook ---
  // Always use the app-bundled title-update script (app owns session naming).
  const rawTitlePath = path.resolve(__dirname, '..', 'hook-scripts', 'title-update.sh');
  const unpackedTitlePath = rawTitlePath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const activeTitlePath = fs.existsSync(unpackedTitlePath) ? unpackedTitlePath : rawTitlePath;

  if (!settings.hooks['PostToolUse']) {
    settings.hooks['PostToolUse'] = [];
  }

  const titleCmd = `bash ${JSON.stringify(activeTitlePath)}`;
  const titleEntry = {
    matcher: '',
    hooks: [{ type: 'command', command: titleCmd, timeout: 10 }],
  };

  const existingTitleIdx = settings.hooks['PostToolUse'].findIndex((matcher) =>
    matcher.hooks?.some((h) => h.command?.includes('title-update'))
  );

  if (existingTitleIdx >= 0) {
    settings.hooks['PostToolUse'][existingTitleIdx] = titleEntry;
  } else {
    settings.hooks['PostToolUse'].push(titleEntry);
  }

  // Deploy Auto-Title instruction to CLAUDE.md if not already present
  const claudeMdPath = path.join(require('os').homedir(), '.claude', 'CLAUDE.md');
  const autoTitleMarker = '## Auto-Title';
  const autoTitleInstruction = `
## Auto-Title

When you see an \`[Auto-Title]\` reminder, **immediately** use Bash to write a 3-5 word Title Case topic summary to the file path specified. Use: \`echo "Topic Here" > /path/to/file\`. Do this BEFORE continuing with your response — do not skip or defer it.
`;
  try {
    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf8');
      if (!content.includes(autoTitleMarker)) {
        fs.appendFileSync(claudeMdPath, autoTitleInstruction);
      }
    } else {
      fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });
      fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n' + autoTitleInstruction);
    }
  } catch (e) {
    console.warn('Failed to deploy Auto-Title instruction:', e.message);
  }

  // --- Remove done-sound.sh (app handles completion sounds natively) ---
  if (settings.hooks['Stop']) {
    settings.hooks['Stop'] = settings.hooks['Stop'].filter((matcher) =>
      !matcher.hooks?.some((h) => h.command?.includes('done-sound'))
    );
  }

  // --- Statusline ---
  // Always use the app-bundled statusline script (app owns context % display).
  // Only set if unset or pointing to a known youcoded-core/app path — don't overwrite
  // custom user scripts.
  const rawStatuslinePath = path.resolve(__dirname, '..', 'hook-scripts', 'statusline.sh');
  const unpackedStatuslinePath = rawStatuslinePath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const activeStatuslinePath = fs.existsSync(unpackedStatuslinePath) ? unpackedStatuslinePath : rawStatuslinePath;
  const currentStatuslineCmd = settings.statusLine?.command || '';
  const isOurStatusline = !currentStatuslineCmd
    || currentStatuslineCmd.includes('statusline.sh')
    || currentStatuslineCmd.includes('youcoded-core')
    || currentStatuslineCmd.includes('youcoded');

  if (isOurStatusline) {
    settings.statusLine = {
      type: 'command',
      command: `bash ${JSON.stringify(activeStatuslinePath)}`,
    };
  }

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log('Hooks installed for ' + FIRE_AND_FORGET_EVENTS.length + ' fire-and-forget events + PermissionRequest (blocking) + auto-title + statusline');
}

installHooks();
