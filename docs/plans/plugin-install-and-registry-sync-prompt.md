# Plugin Installation & Registry Sync — Evaluation Prompt

## Your task

Evaluate, critique, and improve the plan below for two connected features:
1. **Plugin installation via PTY** — wiring the marketplace "Get" button to actually install Claude Code plugins
2. **Registry sync from upstream** — populating our marketplace with entries from Claude Code's official plugin registries

Be adversarial. Find the failure modes, race conditions, UX dead ends, and architectural mistakes. Then propose a revised plan that fixes them. The output should be a concrete, implementable plan — not just critique.

---

## Context: What YouCoded is

YouCoded is an Android app (with a companion Electron desktop app) that runs Claude Code natively. It has a React-based chat UI that communicates with Claude Code sessions running in a PTY. The app recently added a **Skill Marketplace** — a visual browse/install/manage layer over Claude Code's plugin and skill ecosystem.

The marketplace has two skill tiers:
- **Prompt shortcuts** — a display name + description + prompt string. Self-contained. Install = write to a JSON config file. **Fully working today.**
- **Full plugins** — Claude Code plugins with SKILL.md, scripts, hooks, MCP servers. Install requires cloning a repo and registering with Claude Code. **Currently throws "not yet implemented" on both platforms.**

## Context: How Claude Code installs plugins

Claude Code has a built-in plugin system. The relevant commands (sent as text input to the Claude Code PTY):

```
/plugin marketplace add <owner/repo>           # Register a marketplace source
/plugin install <name>@<marketplace-name>       # Install a plugin (non-interactive)
/reload-plugins                                 # Activate newly installed plugins
/plugin uninstall <name>@<marketplace-name>     # Remove a plugin
```

The official marketplace (`claude-plugins-official`) is auto-registered. Other marketplaces need `/plugin marketplace add` first.

After install, Claude Code writes to `~/.claude/plugins/installed_plugins.json`. Our existing `SkillScanner` already reads this file to discover installed plugins.

## Context: How YouCoded sends commands to Claude Code

Both platforms have an established pattern of injecting slash commands into the Claude Code PTY:

**Android (SessionService.kt):**
```kotlin
// Model switching — already works
"model:switch" -> {
    val session = sessionRegistry.sessions.value[sessionId]
    session?.writeInput("/model $model\r")
}

// BTW messages — already works  
fun sendBtw(message: String) {
    writeInput("/btw $message\r")
}
```

`writeInput()` writes raw text to the PTY. `\r` is Enter. The PTY handles escape sequences with a split+delay to prevent Ink rendering issues.

**Desktop (Electron):**
The desktop has a `SessionManager` with PTY access but the `LocalSkillProvider` currently has no reference to it. The `install()` method lives in `skill-provider.ts` (main process).

## Context: Upstream registries available

Four public GitHub registries with `marketplace.json` files:

| Registry | Repo | Entries | Quality |
|----------|------|---------|---------|
| Bundled | `anthropics/claude-code` | 13 | Anthropic-authored, ships with Claude Code |
| Official | `anthropics/claude-plugins-official` | ~120 | Curated, vetted by Anthropic |
| Community | `anthropics/claude-plugins-community` | 300+ | Open submissions, variable quality |
| Skills | `anthropics/skills` | ~15 | Example skills (docs, design, art) |

Each `marketplace.json` entry has:
```json
{
  "name": "code-review",
  "description": "Automated code review for pull requests...",
  "category": "productivity",
  "source": "./plugins/code-review",
  "author": { "name": "Boris Cherny", "email": "boris@anthropic.com" }
}
```

Our `index.json` entry format:
```json
{
  "id": "code-review",
  "type": "plugin",
  "displayName": "Code Review",
  "description": "Automated code review for pull requests...",
  "category": "development",
  "author": "@boris",
  "authorGithub": "boris",
  "version": "1.0.0",
  "publishedAt": "2026-04-05T00:00:00Z",
  "repoUrl": "https://github.com/anthropics/claude-code",
  "marketplace": "claude-plugins-official",
  "tags": ["review", "pr"]
}
```

## Context: Current marketplace state

Our `wecoded-marketplace` repo has 29 entries in `index.json`, all are YouCoded-specific prompt shortcuts and local plugin references. Zero entries from upstream Claude Code registries.

The `MarketplaceFetcher` on both platforms fetches from:
```
https://raw.githubusercontent.com/anthropics/wecoded-marketplace/main/index.json
```
with 24-hour cache TTL for the index and 1-hour for stats.

## Context: Key files

**Android:**
- `app/src/main/kotlin/com/destin/code/skills/LocalSkillProvider.kt` — `install()` at line 154, throws for plugins
- `app/src/main/kotlin/com/destin/code/skills/MarketplaceFetcher.kt` — HTTP fetch + cache
- `app/src/main/kotlin/com/destin/code/runtime/SessionService.kt` — `skills:install` handler at line 417, `sessionRegistry` access
- `app/src/main/kotlin/com/destin/code/runtime/SessionRegistry.kt` — `getCurrentSession()`, `sessions` StateFlow
- `app/src/main/kotlin/com/destin/code/runtime/PtyBridge.kt` — `writeInput()` at line 155
- `app/src/main/kotlin/com/destin/code/runtime/ManagedSession.kt` — `writeInput()` delegates to PtyBridge

**Desktop (worktree `feat-skill-marketplace`):**
- `desktop/src/main/skill-provider.ts` — `install()` at line 150, throws for plugins
- `desktop/src/main/remote-server.ts` — `skills:install` case at line 589
- `desktop/src/main/ipc-handlers.ts` — `SKILLS_INSTALL` handler at line 162
- `desktop/src/renderer/state/skill-context.tsx` — `installAction` calls `window.claude.skills.install()`

**Registry:**
- `~/wecoded-marketplace/index.json` — 29 entries, flat JSON array

---

## The proposed plan

### Part 1: Plugin installation via PTY

When `install(id)` is called and the entry's type is `"plugin"`:

1. Get the active Claude Code session from SessionRegistry
2. Determine the marketplace name from the entry (e.g., `"claude-plugins-official"`)
3. Send `/plugin install <name>@<marketplace>\r` to the PTY via `writeInput()`
4. Wait ~3 seconds, then send `/reload-plugins\r`
5. Invalidate the installed cache so `getInstalled()` re-scans

**Android implementation sketch:**
```kotlin
fun install(id: String, sessionRegistry: SessionRegistry) {
    val entry = /* look up in index */
    if (entry.optString("type") == "prompt") {
        // existing prompt install logic
    } else {
        val session = sessionRegistry.getCurrentSession()
            ?: throw Exception("No active Claude Code session")
        val marketplace = entry.optString("marketplace", "claude-plugins-official")
        val pluginName = entry.optString("id")
        session.writeInput("/plugin install $pluginName@$marketplace\r")
        // Delayed reload
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            session.writeInput("/reload-plugins\r")
        }, 3000)
    }
    installedCache = null
}
```

**Desktop implementation sketch:**
Similar — `LocalSkillProvider` would need a reference to the session/PTY to send input.

### Part 2: Registry sync from upstream

Build a sync script (Node.js or Python) that:
1. Fetches `marketplace.json` from all 3 Anthropic registries (bundled, official, community)
2. Deduplicates (same plugin name across registries → prefer official > bundled > community)
3. Maps each entry to our `index.json` schema (name → id, category remapping, add repoUrl, marketplace field)
4. Merges with our existing YouCoded-specific entries
5. Outputs updated `index.json`

Run via GitHub Action on a schedule (daily) or manually.

**Category mapping:**
- Claude Code: productivity, security, database, deployment, monitoring, learning, design, testing, automation, location, math
- YouCoded: personal, work, development, admin, other
- Proposed mapping: productivity/monitoring → work, security/testing → development, learning → other, etc.

**Filtering (for quality):**
- Tier 1 (always include): all 13 bundled plugins
- Tier 2 (curated): ~50-80 from official, skip vendor-specific niche (LegalZoom, airport-pickups-london, etc.)
- Tier 3 (skip for now): community registry (300+ entries, variable quality)

### Part 3: Marketplace registration

Before plugin install commands work, the marketplace source must be registered with Claude Code. Options:
- Send `/plugin marketplace add anthropics/claude-plugins-official\r` during session init (in PtyBridge or Bootstrap)
- Or check if already registered and skip if so

---

## What to evaluate

1. **PTY injection reliability** — Is fire-and-forget `writeInput` robust enough? What happens if the user is mid-prompt when install fires? What if Claude Code is processing a tool call? What if the session is in plan mode or permission prompt?
2. **Timing** — The 3-second delay before `/reload-plugins` is arbitrary. What if the plugin is large and takes 10 seconds to clone? What if it's instant? Is there a better signal?
3. **Session requirement** — Plugin install requires an active Claude Code session. What if the user is browsing the marketplace before starting a session? What if they're in a DirectShellBridge (standalone bash) instead of PtyBridge?
4. **Completion feedback** — How does the UI know the install succeeded or failed? `writeInput` returns void. The PTY output goes to the terminal, not back to the React UI.
5. **Uninstall** — Currently `uninstall()` only removes from `youcoded-skills.json`. Should it also send `/plugin uninstall <name>@<marketplace>\r`?
6. **Desktop parity** — The desktop `LocalSkillProvider` has no session reference. How should it get one? Constructor injection? Callback? Different architecture?
7. **Registry sync** — Is a daily GitHub Action the right approach? Should we fetch upstream directly at runtime instead? What about staleness vs. freshness vs. our ability to curate?
8. **Category mapping** — Is the lossy mapping acceptable? Should we expand our category set instead?
9. **Entry dedup** — A plugin might already be installed locally (via `/plugin install` in the terminal). The marketplace would show "Get" even though it's installed. How do we detect this?
10. **Marketplace registration** — When and how to ensure marketplaces are registered? What if the user has never run `/plugin` before?
11. **Schema coupling** — If Anthropic changes `marketplace.json` format, our sync breaks. How fragile is this?
12. **UX dead ends** — What does the user see while a plugin is installing? What if they tap "Get" twice? What if they close the marketplace during install?

## Constraints

- Android uses Kotlin + org.json (no Gson/Moshi/kotlinx.serialization)
- Desktop uses TypeScript + Electron
- IPC constants must be duplicated (Electron sandbox prevents imports in preload)
- Both platforms share `~/.claude/youcoded-skills.json` (last-write-wins)
- The React UI is the same codebase for both platforms (remote-shim swaps IPC for WebSocket)
- No new npm dependencies without justification
- The app targets non-developer "normie" users — complexity must be hidden

## Output format

1. **Critique** — What's wrong with the plan? What will break? What's missing?
2. **Revised plan** — Concrete implementation plan addressing the issues. Include file paths, method signatures, and pseudocode where helpful.
3. **Open questions** — Anything that needs user input or further research before implementation.
