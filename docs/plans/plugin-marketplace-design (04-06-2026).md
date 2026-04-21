# YouCoded Plugin Marketplace — Design Document

**Date:** 2026-04-06
**Status:** Draft
**Supersedes:** earlier PTY-injection prompt-based approach (rejected — see git history)

---

## Summary

YouCoded manages its own plugin distribution system. Instead of injecting `/plugin install` commands into the Claude Code PTY, YouCoded installs plugins by placing files directly at `~/.claude/plugins/<name>/` — the same mechanism that YouCoded itself uses. This gives full control over the install/update/uninstall lifecycle with no dependency on an active Claude Code session.

The YouCoded Marketplace catalog (`wecoded-marketplace` repo) auto-imports all plugins from Anthropic's official registry and labels each by source. Custom YouCoded prompt shortcuts and plugin references coexist in the same catalog. Plugin updates are handled during `/update` alongside the rest of the toolkit.

---

## Architecture Decisions

### AD-1: Direct filesystem installation, not PTY injection

**Decision:** Install plugins by copying/cloning files to `~/.claude/plugins/<name>/`. Do not use `/plugin install` commands via PTY.

**Rationale:**
- No active Claude Code session required
- No timing hacks or fire-and-forget commands
- Deterministic completion — the app controls the entire operation
- Works identically on Android and desktop
- Same mechanism that installs YouCoded itself (proven pattern)
- Full control over error handling and user feedback

**How Claude Code discovers these plugins:** Claude Code auto-discovers any directory under `~/.claude/plugins/` containing `.claude-plugin/plugin.json` (or `plugin.json` at root). It scans for `commands/`, `agents/`, `skills/`, `hooks/hooks.json`, and `.mcp.json` at load time. No registration in `installed_plugins.json` is needed.

**Trade-off:** Plugins installed this way won't be tracked by Claude Code's built-in `/plugin update` mechanism. Updates are handled by YouCoded's `/update` flow instead (see AD-4).

### AD-2: Own marketplace repo clone, independent of Claude Code's

**Decision:** YouCoded maintains its own clone of the Anthropic marketplace repo at a YouCoded-managed path (e.g., `~/.claude/wecoded-marketplace-cache/`), separate from Claude Code's clone at `~/.claude/plugins/marketplaces/`.

**Rationale:**
- No dependency on Claude Code's internal file layout (which could change)
- YouCoded controls clone freshness, location, and lifecycle
- Avoids accidental interference if both systems try to update the same repo

### AD-3: Auto-import everything, label by source

**Decision:** Sync all plugins from all available Anthropic registries (official: ~123 plugins). Each entry carries a `sourceMarketplace` label identifying its origin. No manual curation gate — everything appears automatically.

**Rationale:**
- Zero maintenance burden for catalog freshness
- Users can see and filter by source
- YouCoded can override any field (description, category, tags) per-plugin via the overrides system
- If a plugin is low quality, it can be blocklisted rather than requiring an allowlist

### AD-4: Plugin updates via /update

**Decision:** When `/update` runs and merges a new YouCoded version, a new post-update phase (`phase_marketplace_plugins`) updates all marketplace-installed plugins by pulling the latest upstream code.

**Rationale:**
- Single update mechanism for the entire toolkit
- User explicitly triggers updates (no background auto-updates)
- Fits naturally into the existing `/update` flow (steps 12-19)
- Plugin updates can be shown alongside other changes ("These plugins were updated: ...")

### AD-5: Conflict detection with Claude Code marketplace installs

**Decision:** Before installing a plugin, check if it already exists in `~/.claude/plugins/cache/` (installed via Claude Code's `/plugin install`). If so, warn the user and skip — don't create a duplicate that would be loaded twice.

**Rationale:**
- Claude Code loads every discovered plugin. Two copies of the same plugin at different paths means double-loaded hooks, duplicate commands, duplicate MCP servers.
- The user may have installed plugins via the CLI before using the YouCoded marketplace.

---

## Data Model

### Marketplace catalog entry (index.json)

```json
{
  "id": "code-review",
  "type": "plugin",
  "displayName": "Code Review",
  "description": "Automated code review for pull requests using multiple specialized agents",
  "category": "development",
  "author": "Anthropic",
  "tags": ["review", "pr", "agents"],
  "version": "1.0.0",
  "publishedAt": "2026-04-06T00:00:00Z",

  "sourceMarketplace": "claude-plugins-official",
  "sourceType": "local",
  "sourceRef": "./plugins/code-review",
  "repoUrl": "https://github.com/anthropics/claude-plugins-official"
}
```

**Fields added for upstream plugins:**
- `sourceMarketplace` — Which registry this came from (e.g., `"claude-plugins-official"`, `"claude-plugins-community"`, `"youcoded-core"`)
- `sourceType` — How to download it: `"local"` (copy from marketplace repo), `"url"` (git clone external repo), `"git-subdir"` (clone + extract subdirectory), `"prompt"` (self-contained prompt shortcut — no download)
- `sourceRef` — The download reference: relative path for local, git URL for url/git-subdir
- `repoUrl` — For linking to homepage/docs in the UI

**Existing YouCoded entries** keep `sourceMarketplace: "youcoded-core"` and `sourceType: "prompt"` (or `"local"` for YouCoded plugin references).

### Install state tracking (youcoded-skills.json)

Marketplace-installed plugins are tracked in `youcoded-skills.json` alongside prompt shortcuts:

```json
{
  "installed_plugins": {
    "code-review": {
      "installedAt": "2026-04-06T12:00:00Z",
      "installedFrom": "claude-plugins-official",
      "installPath": "~/.claude/plugins/code-review",
      "version": "d6fb93c7e767",
      "sourceType": "local"
    }
  }
}
```

This is YouCoded's own bookkeeping — it does NOT write to Claude Code's `installed_plugins.json`.

---

## Plugin Structure on Disk

After installation, a plugin at `~/.claude/plugins/<name>/` follows the standard Claude Code layout:

```
~/.claude/plugins/code-review/
├── .claude-plugin/
│   └── plugin.json          # Plugin metadata (name, description, author)
├── commands/                 # Slash commands (auto-discovered)
│   └── code-review.md
├── agents/                   # Subagent definitions (auto-discovered)
│   └── code-reviewer.md
├── skills/                   # Skills with SKILL.md (auto-discovered)
├── hooks/                    # Event handlers (auto-registered)
│   └── hooks.json
├── .mcp.json                 # MCP server config (auto-registered)
└── README.md
```

Claude Code discovers all components automatically at session start or on `/reload-plugins`.

---

## Source Type Download Strategies

### "local" — Plugin code lives in the marketplace repo

```
Source: marketplace repo clone -> plugins/<name>/ or external_plugins/<name>/
Action: cp -r <marketplace-clone>/<sourceRef> -> ~/.claude/plugins/<name>/
```

Fastest install — no network needed if marketplace repo is already cloned.

### "url" — External git repository

```
Source: full git repo URL (e.g., https://github.com/user/plugin.git)
Action: git clone --depth 1 <url> ~/.claude/plugins/<name>/
```

Most common for third-party plugins (60 of 123 in official marketplace).

### "git-subdir" — Subdirectory of an external git repo

```
Source: repo URL + path within repo
Action: git clone --depth 1 --filter=blob:none --sparse <url> /tmp/plugin-staging/
        git -C /tmp/plugin-staging/ sparse-checkout set <path>
        cp -r /tmp/plugin-staging/<path>/ -> ~/.claude/plugins/<name>/
        rm -rf /tmp/plugin-staging/
```

Used by 14 plugins (e.g., AWS plugins that live in a monorepo).

---

## Integration Points

### Install flow (when user taps "Get")

1. UI sends `skills:install { id }` via IPC/WebSocket
2. `SessionService` (Android) or IPC handler (desktop) receives it
3. Look up entry in marketplace index
4. **Conflict check:** scan `installed_plugins.json` for `<id>@*` key. If found, respond with error: "Already installed via Claude Code"
5. **Type dispatch:**
   - `type: "prompt"` -> existing `configStore.createPromptSkill()` path (unchanged)
   - `type: "plugin"` -> new `PluginInstaller.install()` path
6. `PluginInstaller` executes the download strategy based on `sourceType`
7. Records install in `youcoded-skills.json` under `installed_plugins`
8. Responds with `{ status: "installed" }`
9. If a Claude Code session is active, sends `/reload-plugins\r` as a convenience (not required — plugin will be discovered on next session start)

### Uninstall flow

1. Delete `~/.claude/plugins/<name>/` directory
2. Remove from `youcoded-skills.json`
3. If session active, send `/reload-plugins\r`

### Update flow (during /update)

New phase in `post-update.sh`: `phase_marketplace_plugins`

For each plugin in `youcoded-skills.json`'s `installed_plugins`:
- **local** source: marketplace repo was already updated by git merge. Re-copy from updated repo clone to `~/.claude/plugins/<name>/`.
- **url** source: `git -C ~/.claude/plugins/<name>/ pull --ff-only` (or re-clone if pull fails)
- **git-subdir** source: re-clone + sparse checkout (same as initial install)

Report updated plugins: `[UPDATED] code-review — pulled latest from claude-plugins-official`

### Marketplace repo cache management

YouCoded maintains its own clone of the official marketplace repo:
- Location: `~/.claude/wecoded-marketplace-cache/claude-plugins-official/`
- Cloned on first plugin install that needs it (lazy)
- Updated during `/update` via `git pull`
- Used for "local" source type installs (copy from clone to plugins dir)

### Sync script (wecoded-marketplace repo)

```
scripts/sync.js
+-- Read marketplace.json from upstream (fetched via GitHub API or local clone)
+-- For each upstream plugin:
|   +-- Skip if id is in DESTINCLAUDE_IDS (our 29 existing entries)
|   +-- Map to our schema: name->id, add displayName, sourceMarketplace, sourceType, sourceRef
|   +-- Check for override file: overrides/<id>.json -> merge custom fields
|   +-- Add to output array
+-- Merge with existing YouCoded entries (always preserved first)
+-- Sort: youcoded-core entries first, then by sourceMarketplace, then alphabetical
+-- Validate: no duplicate ids, required fields present
+-- Write index.json
```

**Override files** (`overrides/<id>.json`) allow customizing any field for any upstream plugin:
```json
{
  "displayName": "Playwright Browser",
  "description": "Control a real browser from Claude — navigate, click, fill forms, take screenshots",
  "category": "development",
  "tags": ["browser", "testing", "automation", "mcp"]
}
```

Override fields are merged on top of upstream data. Unoverridden fields use upstream values.

---

## Platform Considerations

### Android

- Git is available through the bootstrap environment (runs via linker64)
- File operations use `java.io.File`
- `PluginInstaller` runs git commands via process execution through the linker64 wrapper, same pattern as other git operations in the app
- Install operations should run on `Dispatchers.IO` coroutine scope
- Progress/completion reported via `bridgeServer.broadcast()`

### Desktop (Electron)

- Git is available natively
- `PluginInstaller` is a new TypeScript class in main process
- Uses safe process execution (`execFileNoThrow` pattern) for git operations
- Progress/completion reported via IPC to renderer

### Shared

- React UI is identical on both platforms (remote-shim abstraction)
- `youcoded-skills.json` is the shared state file (last-write-wins)
- Install/uninstall/update operations are filesystem-only (no session required)

---

## Security Considerations

- Only install from known marketplace repos (sourceMarketplace must match a known registry)
- Plugin hooks run with the same permissions as Claude Code itself — users should understand they're installing executable code
- MCP servers specified in `.mcp.json` can run arbitrary commands (e.g., `npx <package>`) — this is by design (Claude Code's plugin contract)
- The sync script validates upstream schema and aborts if >20% of entries fail validation (guards against upstream format changes)
- A future `blocklist.json` in the marketplace repo can exclude specific plugins
