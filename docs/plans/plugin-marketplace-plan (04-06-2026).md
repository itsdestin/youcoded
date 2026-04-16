# YouCoded Plugin Marketplace — Implementation Plan

**Date:** 2026-04-06
**Design doc:** `plugin-marketplace-design (04-06-2026).md`
**Depends on:** Existing skill marketplace (completed 04-05-2026)

---

## Overview

Three workstreams, buildable in sequence:
1. **Sync script** — populate the marketplace catalog with upstream plugins
2. **Plugin installer** — Android + desktop backend to download and place plugins
3. **Update integration** — add plugin update phase to `/update` flow

---

## Workstream 1: Sync Script

**Goal:** Auto-populate `wecoded-marketplace/index.json` with all ~123 official Anthropic plugins.

### Step 1.1: Create overrides directory

```
wecoded-marketplace/
+-- index.json          (existing - 29 entries)
+-- overrides/          (NEW)
|   +-- .gitkeep
+-- scripts/
    +-- sync.js         (NEW)
```

### Step 1.2: Build sync.js

**File:** `wecoded-marketplace/scripts/sync.js`

The script:
1. Fetches `marketplace.json` from the official registry via GitHub raw URL:
   `https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json`
2. For each entry, maps to our schema:
   ```
   upstream.name         -> id
   upstream.name (Title) -> displayName (auto Title Case from kebab-case)
   upstream.description  -> description
   upstream.category     -> category (kept as-is, no lossy mapping)
   upstream.author?.name -> author
   upstream.source       -> sourceType + sourceRef (see mapping below)
   upstream.homepage     -> repoUrl
   "claude-plugins-official" -> sourceMarketplace
   ```
3. Source type mapping:
   - `typeof source === "string"` (path) -> `sourceType: "local"`, `sourceRef: source`
   - `source.source === "url"` -> `sourceType: "url"`, `sourceRef: source.url`
   - `source.source === "git-subdir"` -> `sourceType: "git-subdir"`, `sourceRef: source.url`, `sourceSubdir: source.path`
   - `source.source === "github"` -> `sourceType: "url"`, `sourceRef: "https://github.com/" + source.repo + ".git"`
4. Checks for `overrides/<id>.json` and merges any custom fields on top
5. Loads existing `index.json`, separates YouCoded entries (`sourceMarketplace: "youcoded-core"` or no `sourceMarketplace`)
6. Combines: YouCoded entries first, then upstream entries
7. Validates: no duplicate ids, all entries have id + type + displayName + description
8. Writes `index.json`

**Run:** `node scripts/sync.js` from the marketplace repo root.

**GitHub Action:** `.github/workflows/sync.yml` — weekly schedule + manual trigger.

### Step 1.3: Backfill sourceMarketplace on existing entries

Add `"sourceMarketplace": "youcoded-core"` to all 29 existing entries in `index.json` so the sync script can distinguish them from upstream imports.

### Step 1.4: Category handling

Upstream uses: `productivity`, `security`, `database`, `deployment`, `monitoring`, `learning`, `design`, `testing`, `automation`, `location`, `math`, `development`.

Current YouCoded categories: `personal`, `work`, `development`, `admin`, `other`.

**Action:** Keep all upstream categories as-is. The React UI filter component should build the filter list dynamically from categories present in the index, not from a hardcoded list.

---

## Workstream 2: Plugin Installer

**Goal:** Make the "Get" button work for `type: "plugin"` entries.

### Step 2.1: Create PluginInstaller.kt (Android)

**File:** `app/src/main/kotlin/com/destin/code/skills/PluginInstaller.kt`

```kotlin
class PluginInstaller(
    private val homeDir: File,
    private val configStore: SkillConfigStore,
) {
    private val pluginsDir = File(homeDir, ".claude/plugins")
    private val cacheDir = File(homeDir, ".claude/wecoded-marketplace-cache")
    private val installsInProgress = mutableSetOf<String>()

    sealed class InstallResult {
        object Success : InstallResult()
        data class AlreadyInstalled(val via: String) : InstallResult()
        data class Failed(val error: String) : InstallResult()
        object InProgress : InstallResult()
    }

    suspend fun install(entry: JSONObject): InstallResult
    suspend fun uninstall(id: String): Boolean
    fun isInstalled(id: String): Boolean
    fun hasConflict(id: String): Boolean
}
```

**Key methods:**

`install(entry)`:
1. Check `installsInProgress` — return `InProgress` if already installing this id
2. Check `hasConflict(id)` — return `AlreadyInstalled("Claude Code")` if in `installed_plugins.json`
3. Check `isInstalled(id)` — return `AlreadyInstalled("YouCoded")` if already at `plugins/<id>/`
4. Add to `installsInProgress`
5. Dispatch based on `sourceType`:
   - `"local"` -> `installFromLocal(entry)`
   - `"url"` -> `installFromUrl(entry)`
   - `"git-subdir"` -> `installFromGitSubdir(entry)`
6. Ensure `.claude-plugin/plugin.json` exists (some upstream plugins may only have root `plugin.json`)
7. Record in `configStore` under `installed_plugins`
8. Remove from `installsInProgress`
9. Return `Success`

`installFromLocal(entry)`:
1. Ensure marketplace repo is cloned at `cacheDir/claude-plugins-official/`
   - If not: `git clone --depth 1 https://github.com/anthropics/claude-plugins-official.git <path>`
2. Copy `<cacheDir>/claude-plugins-official/<sourceRef>/` to `<pluginsDir>/<id>/`

`installFromUrl(entry)`:
1. `git clone --depth 1 <sourceRef> <pluginsDir>/<id>/`

`installFromGitSubdir(entry)`:
1. Clone to temp dir with sparse checkout
2. Copy subdirectory to `<pluginsDir>/<id>/`
3. Clean up temp dir

`hasConflict(id)`:
1. Read `<pluginsDir>/installed_plugins.json`
2. Check if any key starts with `<id>@`

`uninstall(id)`:
1. Delete `<pluginsDir>/<id>/` recursively
2. Remove from `configStore.installed_plugins`

**Git execution on Android:** Use process execution through the linker64 wrapper, same pattern as existing Bootstrap git operations:

```kotlin
private suspend fun runGit(vararg args: String): Boolean = withContext(Dispatchers.IO) {
    val cmd = arrayOf(
        "/system/bin/linker64",
        File(homeDir, "usr/bin/git").absolutePath,
        *args
    )
    val env = Bootstrap.buildGitEnv(homeDir)
    val process = Runtime.getRuntime().exec(cmd, env)
    process.waitFor(120, TimeUnit.SECONDS)
    process.exitValue() == 0
}
```

### Step 2.2: Wire into SessionService (Android)

**File:** `app/src/main/kotlin/com/destin/code/runtime/SessionService.kt`

Changes to `handleBridgeMessage` for `"skills:install"`:

- If entry type is `"prompt"` -> existing path (unchanged)
- If entry type is `"plugin"` -> delegate to `pluginInstaller.install(entry)`
- Map `InstallResult` to JSON response with appropriate status
- On success: optionally send `/reload-plugins\r` to active Claude Code session

Initialize `pluginInstaller` in `initBootstrap()`:
```kotlin
pluginInstaller = PluginInstaller(bs.homeDir, skillProvider!!.configStore)
```

Update `skills:uninstall` handler similarly for plugin type entries.

### Step 2.3: Add getMarketplaceEntry to LocalSkillProvider

**File:** `app/src/main/kotlin/com/destin/code/skills/LocalSkillProvider.kt`

New method that looks up a single entry from the marketplace index by id:

```kotlin
fun getMarketplaceEntry(id: String): JSONObject? {
    val index = fetcher.fetchIndex()
    for (i in 0 until index.length()) {
        if (index.getJSONObject(i).optString("id") == id) {
            return index.getJSONObject(i)
        }
    }
    return null
}
```

### Step 2.4: Update getInstalled to include marketplace plugins

**File:** `app/src/main/kotlin/com/destin/code/skills/LocalSkillProvider.kt`

The existing `getInstalled()` merges scanner results with prompt shortcuts. Add a third source: `configStore.getInstalledPlugins()` — the plugins installed via PluginInstaller.

For each installed plugin, check if the directory still exists at the recorded `installPath`. If not, mark as `"status": "missing"` so the UI can show a warning.

### Step 2.5: React UI updates

**File:** `app/src/main/assets/web/` (shared React UI)

Changes needed:
- **Install button states:** `Get` -> `Installing...` (disabled) -> `Installed` / `Error`
- **Handle new response statuses:** `"installing"`, `"already_installed"`, `"failed"`
- **Show `sourceMarketplace` badge** on plugin cards (e.g., "Official", "Community", "YouCoded")
- **Category filter:** dynamically build filter list from categories present in the index
- **Conflict warning:** if `already_installed` with `via: "Claude Code"`, show informative message

### Step 2.6: Desktop parity

**File:** `desktop/src/main/plugin-installer.ts` (NEW)

TypeScript port of the same logic. Uses safe process execution for git operations (the `execFileNoThrow` pattern from `src/utils/`). Wired into the `SKILLS_INSTALL` IPC handler.

---

## Workstream 3: Update Integration

**Goal:** Plugin updates happen automatically during `/update`.

### Step 3.1: Add step to /update command

**File:** `~/.claude/plugins/youcoded-core/core/commands/update.md`

Add a new step after step 17 (Register missing plugins) and before step 18 (Verify):

```
17.5. **Update marketplace plugins.**
    bash "$TOOLKIT_ROOT/scripts/post-update.sh" marketplace-plugins

    For each [UPDATED] line: show what changed.
    For [FAILED]: show error and continue.
    For [SKIPPED]: note why.
```

### Step 3.2: Add phase_marketplace_plugins to post-update.sh

**File:** `~/.claude/plugins/youcoded-core/scripts/post-update.sh`

New phase function that:

1. Reads `installed_plugins` from `youcoded-skills.json`
2. If none installed, emits `[INFO]` and returns
3. Updates the marketplace repo cache (`git pull` in the cache dir)
4. For each installed plugin based on `sourceType`:
   - **local**: re-copy from updated marketplace cache to `~/.claude/plugins/<name>/`
   - **url**: `git -C ~/.claude/plugins/<name>/ pull --ff-only`
   - **git-subdir**: skip (these need re-install for updates)
5. Emits `[UPDATED]`, `[WARN]`, or `[SKIP]` per plugin
6. Summary count at end

### Step 3.3: Register in dispatcher

Add `marketplace-plugins` case to the dispatcher `case` statement and to the verify/post-update sequence.

---

## Build Sequence

### Phase A: Sync (can ship independently)
1. Step 1.1 — Create overrides directory
2. Step 1.3 — Backfill sourceMarketplace on existing entries
3. Step 1.2 — Build sync.js
4. Run sync, review output, commit
5. Set up GitHub Action for weekly sync

**Result:** Marketplace index grows from 29 to ~152 entries. Users can browse upstream plugins immediately. "Get" still throws for plugins until Phase B.

### Phase B: Install (Android first)
1. Step 2.1 — PluginInstaller.kt
2. Step 2.3 — getMarketplaceEntry
3. Step 2.2 — Wire into SessionService
4. Step 2.4 — Update getInstalled
5. Step 2.5 — React UI updates
6. Test: install, uninstall, conflict detection, no-session install

**Result:** Android users can install plugins from the marketplace.

### Phase C: Desktop parity
1. Step 2.6 — Port to TypeScript

**Result:** Desktop users can install plugins from the marketplace.

### Phase D: Update integration
1. Step 3.1 — Update /update command
2. Step 3.2 — phase_marketplace_plugins
3. Step 3.3 — Register in dispatcher

**Result:** `/update` keeps marketplace plugins fresh.

---

## Testing Checklist

- [ ] Sync script produces valid index.json with all ~123 upstream entries
- [ ] Sync preserves all 29 existing YouCoded entries unchanged
- [ ] Override files merge correctly (custom description overrides upstream)
- [ ] "local" source plugin installs from cache copy
- [ ] "url" source plugin installs via git clone
- [ ] "git-subdir" source plugin installs via sparse checkout
- [ ] Installed plugin is discovered by Claude Code on session start
- [ ] Plugin hooks fire correctly after install
- [ ] MCP servers in .mcp.json are registered by Claude Code
- [ ] Conflict detection catches plugins already in installed_plugins.json
- [ ] Double-tap "Get" doesn't duplicate install
- [ ] Uninstall removes directory and config entry
- [ ] /update updates "local" plugins from refreshed cache
- [ ] /update updates "url" plugins via git pull
- [ ] Install works with no active Claude Code session
- [ ] Install works on Android (git through linker64)
- [ ] React UI shows correct states: Get -> Installing -> Installed
- [ ] sourceMarketplace badge shows on plugin cards
- [ ] Category filter includes upstream categories dynamically

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Git clone fails on Android (SELinux/linker64) | Medium | Test early in Phase B. Fallback: download tarball via GitHub API |
| Large plugin repos slow to clone | Low | `--depth 1` keeps clones shallow. Sparse checkout for git-subdir |
| Anthropic changes marketplace.json schema | Low | Sync script validates schema; aborts on unexpected format |
| Plugin not discovered at ~/.claude/plugins/<name>/ | Very Low | Verified empirically (YouCoded pattern). Fallback: write to installed_plugins.json |
| Two plugins with same name from different sources | Low | Sync script deduplicates; YouCoded entries always win |
| Plugin has post-install setup (npm install, etc.) | Medium | Most MCP plugins use npx (auto-downloads). Document any that need manual setup |
