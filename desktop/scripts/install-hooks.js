#!/usr/bin/env node
// The app's OWN Claude Code hooks (relay, permission relay, auto-title,
// write-guard, statusline): where their scripts are staged and what their
// settings.json entries look like.
//
// WHY this file exports functions instead of running on require (2026-09-16
// audit W3/D5/W4): it used to copy every script over itself, then read,
// mutate and unconditionally rewrite ~/.claude/settings.json on every launch,
// with its own reader and writer. Now `stageHookScripts()` skips the copy when
// the staged version stamp already matches this build, and `applyAppHooks()`
// edits a settings object it is handed — main/launch-settings-chores.ts runs
// it inside claude-settings.ts's single locked read/compare/write, so nothing
// is written when nothing changed. It stays plain CommonJS under scripts/
// because that directory is packaged (and asar-unpacked) as-is.
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Resolve hook scripts to a STABLE location -----------------------------
//
// In packaged builds __dirname is inside app.asar; the hook scripts are
// extracted to app.asar.unpacked so Claude Code (an external process) can read
// them. But on Linux YouCoded ships as an AppImage, which mounts at a
// *different* random /tmp/.mount_XXXXXX path on EVERY launch. Baking that
// volatile path into ~/.claude/settings.json means every hook (relay,
// auto-title, statusline) silently breaks the moment the app is closed — and
// for any `claude` CLI session run outside the app.
//
// Fix: copy the bundled hook scripts into a fixed directory under ~/.claude
// (once per app version — see the stamp), and point settings.json at that
// stable copy instead.
const rawHookSrcDir = path.resolve(__dirname, '..', 'hook-scripts');
const HOOK_SRC_DIR = rawHookSrcDir.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

// Resolved per call so a stubbed os.homedir (tests) is honoured.
function stableHookDir() {
  return path.join(os.homedir(), '.claude', 'youcoded-hooks');
}

// The stamp file: "<app version>|<packaged|dev>". A downgrade, an upgrade, or
// switching between a packaged build and an unpackaged one all change it, so
// each restages; the same build launched twice does not.
const VERSION_STAMP_FILE = '.version';

// Safety: refuse to run when the bundled scripts live inside a dev worktree.
// settings.json is a shared resource — staging worktree-version scripts into
// the stable dir would have the installed app run dev code. Belt-and-suspenders
// backstop for the YOUCODED_PROFILE gate in main.ts.
function isWorktreeSource(srcDir = HOOK_SRC_DIR) {
  return srcDir.includes(`${path.sep}.worktrees${path.sep}`);
}

// Copy every bundled hook script into the stable dir (overwrites, so app
// updates propagate) unless the stable dir already carries this build's stamp.
// Returns the directory settings.json should reference — the stable copy, or
// the bundled dir as a fallback if staging failed — and whether a copy ran.
function stageHookScripts({ stamp, srcDir = HOOK_SRC_DIR, stableDir = stableHookDir() }) {
  try {
    fs.mkdirSync(stableDir, { recursive: true });
    const stampPath = path.join(stableDir, VERSION_STAMP_FILE);
    let current = null;
    try { current = fs.readFileSync(stampPath, 'utf8'); } catch { /* never staged, or pre-stamp layout */ }
    // Trust a matching stamp only while the critical script is actually there
    // (a user who cleared the directory by hand must get it back).
    if (current === stamp && fs.existsSync(path.join(stableDir, 'relay.js'))) {
      return { hookDir: stableDir, copied: false };
    }
    for (const file of fs.readdirSync(srcDir)) {
      // recursive:true so a future lib/ subdir (statusline.sh sources one) copies too.
      fs.cpSync(path.join(srcDir, file), path.join(stableDir, file), { recursive: true });
      if (file.endsWith('.sh')) fs.chmodSync(path.join(stableDir, file), 0o755);
    }
    // Legal: usage-fetch.js (read the Claude.ai OAuth token, called Anthropic's
    // usage API) is no longer bundled — Anthropic's Claude Code terms forbid
    // third-party apps from using that token. The copy loop above only adds and
    // overwrites, so remove the copy earlier app versions staged here; nothing
    // runs it any more, but no token-reading code should be left on disk.
    // Mirrors Bootstrap.kt on Android.
    try { fs.rmSync(path.join(stableDir, 'usage-fetch.js'), { force: true }); } catch { /* best effort */ }
    // Trust the stable dir only if the critical script actually landed; stamp
    // it only then, so a half-failed copy is retried next launch.
    if (fs.existsSync(path.join(stableDir, 'relay.js'))) {
      try { fs.writeFileSync(stampPath, stamp, 'utf8'); } catch { /* unstamped = restage next time */ }
      return { hookDir: stableDir, copied: true };
    }
  } catch (e) {
    console.warn('install-hooks: failed to stage hook scripts to ' + stableDir + ':', e.message);
  }
  // Fallback: a volatile path is still better than a missing one.
  return { hookDir: srcDir, copied: true };
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

// Replace the entry at `idx` (or append) — counting a replacement whose
// command actually differed, which is what "a stale hook path" means for the
// app's own entries. Replaces the launch-time pre-scan that only produced a
// log line.
function upsert(list, idx, entry, stats) {
  if (idx >= 0) {
    // Update in place — preserves position relative to other hooks
    if (JSON.stringify(list[idx]) !== JSON.stringify(entry)) stats.repaired++;
    list[idx] = entry;
  } else {
    list.push(entry);
  }
}

// Mutate `settings` (the parsed ~/.claude/settings.json) so every app-owned
// hook points at `hookDir`. Pure over the object: no file I/O.
function applyAppHooks(settings, hookDir, srcDir = HOOK_SRC_DIR) {
  const stats = { repaired: 0 };
  if (!settings.hooks) {
    settings.hooks = {};
  }

  const expectedRelayCmd = `node ${JSON.stringify(path.join(hookDir, 'relay.js'))}`;
  const expectedBlockingCmd = `node ${JSON.stringify(path.join(hookDir, 'relay-blocking.js'))}`;

  // Register fire-and-forget events with standard relay
  for (const event of FIRE_AND_FORGET_EVENTS) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    // Find any existing relay hook (may have a stale path from a previous install)
    const existingIdx = settings.hooks[event].findIndex((matcher) =>
      matcher.hooks?.some((h) => h.command?.includes('relay.js') && !h.command?.includes('relay-blocking.js'))
    );

    upsert(settings.hooks[event], existingIdx, {
      matcher: '',
      hooks: [{ type: 'command', command: expectedRelayCmd, timeout: 10 }],
    }, stats);
  }

  // Register PermissionRequest with blocking relay (longer timeout for user response)
  if (!settings.hooks['PermissionRequest']) {
    settings.hooks['PermissionRequest'] = [];
  }

  // Remove any old fire-and-forget relay for PermissionRequest
  settings.hooks['PermissionRequest'] = settings.hooks['PermissionRequest'].filter((matcher) =>
    !matcher.hooks?.some((h) => h.command?.includes('relay.js') && !h.command?.includes('relay-blocking.js'))
  );

  const existingBlockingIdx = settings.hooks['PermissionRequest'].findIndex((matcher) =>
    matcher.hooks?.some((h) => h.command?.includes('relay-blocking.js'))
  );

  upsert(settings.hooks['PermissionRequest'], existingBlockingIdx, {
    matcher: '',
    hooks: [{ type: 'command', command: expectedBlockingCmd, timeout: 300 }],
  }, stats);

  // --- Auto-titling hook ---
  // Always use the app-bundled title-update script (app owns session naming),
  // resolved via the stable hook dir so it survives across AppImage launches.
  const activeTitlePath = path.join(hookDir, 'title-update.sh');

  if (!settings.hooks['PostToolUse']) {
    settings.hooks['PostToolUse'] = [];
  }

  const existingTitleIdx = settings.hooks['PostToolUse'].findIndex((matcher) =>
    matcher.hooks?.some((h) => h.command?.includes('title-update'))
  );

  upsert(settings.hooks['PostToolUse'], existingTitleIdx, {
    matcher: '',
    hooks: [{ type: 'command', command: `bash ${JSON.stringify(activeTitlePath)}`, timeout: 10 }],
  }, stats);

  // --- Write-guard hook ---
  // PreToolUse on Write|Edit matchers. Blocks concurrent writes to tracked
  // files when another active Claude session last modified them. Absorbed
  // from youcoded-core as part of toolkit deprecation (2026-04).
  const rawWriteGuardPath = path.join(srcDir, 'write-guard.sh');
  const unpackedWriteGuardPath = rawWriteGuardPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const activeWriteGuardPath = fs.existsSync(unpackedWriteGuardPath) ? unpackedWriteGuardPath : rawWriteGuardPath;

  if (!settings.hooks['PreToolUse']) {
    settings.hooks['PreToolUse'] = [];
  }

  const existingWriteGuardIdx = settings.hooks['PreToolUse'].findIndex((matcher) =>
    matcher.hooks?.some((h) => h.command?.includes('write-guard.sh'))
  );

  upsert(settings.hooks['PreToolUse'], existingWriteGuardIdx, {
    matcher: 'Write|Edit',
    hooks: [{ type: 'command', command: `bash ${JSON.stringify(activeWriteGuardPath)}`, timeout: 10 }],
  }, stats);

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
  const activeStatuslinePath = path.join(hookDir, 'statusline.sh');
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

  return stats;
}

// Deploy the Auto-Title instruction to ~/.claude/CLAUDE.md if not already present.
const autoTitleMarker = '## Auto-Title';
const autoTitleInstruction = `
## Auto-Title

When you see an \`[Auto-Title]\` reminder, do exactly what it asks, before continuing your response. If it says the conversation has no title yet, use Bash to write a 3-5 word Title Case summary to the file path it names. If it tells you the current title and that title still describes the conversation, do nothing at all — no tool call, no comment.
`;
function deployAutoTitleInstruction() {
  const claudeMdPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
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
}

module.exports = {
  HOOK_SRC_DIR,
  FIRE_AND_FORGET_EVENTS,
  isWorktreeSource,
  stageHookScripts,
  applyAppHooks,
  deployAutoTitleInstruction,
};
