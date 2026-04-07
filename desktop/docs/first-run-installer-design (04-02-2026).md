# First-Run Installer Design

**Date:** 2026-04-02
**Status:** Draft
**Scope:** DestinCode desktop app + landing page + setup wizard adaptation

## Problem

The current DestinClaude installation requires non-technical users to open a terminal and paste a curl/PowerShell command. This is the primary barrier to adoption for users unfamiliar with developer tools. The goal is to make installation feel like any other desktop app: download, double-click, done.

## Design Principles

1. **Zero terminal for the user** — the entire install happens through GUI interactions and conversation
2. **The app is the entry point** — DestinCode replaces the bootstrap scripts as the primary installation path
3. **Silent where possible, conversational where valuable** — prerequisites install silently; personalization stays conversational via the setup wizard
4. **Clean boundary** — the first-run module gets Claude Code running; the wizard handles everything else
5. **Resilient** — crashes, restarts, and partial installs recover gracefully

## New User Journey

```
CURRENT                                    NEW
-------                                    ---
1. Visit landing page                      1. Visit landing page
2. Open terminal                           2. Click "Download for Windows/Mac"
3. Copy-paste curl/PowerShell command      3. Run installer (.exe / .dmg)
4. Watch terminal install Node, Git, etc.  4. Open DestinCode
5. Claude Code CLI launches                5. App shows "Setting up..." progress UI
6. Type /setup-wizard                      6. Prerequisites install silently
7. Conversational wizard runs              7. Auth screen (OAuth or API key)
                                           8. App transitions to Claude Code session
                                           9. Setup wizard auto-launches conversationally
```

Steps 1-7 require zero terminal knowledge.

---

## Component 1: Platform Installers (Slim)

The installers become simpler — they only put the app on disk.

### Windows (.exe via NSIS)

- Installs DestinCode to `%LOCALAPPDATA%\Programs\DestinCode\`
- Creates Start Menu shortcut and optional Desktop shortcut
- Registers uninstaller
- No prerequisites, no Developer Mode

### macOS (.dmg)

- Standard drag-to-Applications disk image
- Code-signed and notarized (for Gatekeeper)
- No Homebrew, no terminal

### What the installer does NOT do

- No Node.js installation
- No Git installation
- No Claude Code CLI installation
- No toolkit cloning
- No symlink creation

All of that shifts to the app's first-run module.

---

## Component 2: First-Run Detection & State Machine

### Detection Logic

New module: `src/main/first-run.ts`

```
App launches
    |
    +-- ~/.claude/toolkit-state/config.json exists AND setup_completed === true?
    |   +-- YES -> Normal app launch (current behavior)
    |
    +-- config.json exists but setup_completed === false?
    |   +-- INTERRUPTED -> Resume first-run from last completed state
    |
    +-- config.json doesn't exist?
        +-- FRESH -> Enter first-run mode
```

### State Machine

Persisted to `~/.claude/toolkit-state/first-run-state.json` so it survives crashes/restarts.

```
DETECT_PREREQUISITES
    -> check what's already installed (Node, Git, Claude Code CLI)
    |
INSTALL_PREREQUISITES
    -> install what's missing, one at a time
    |
CLONE_TOOLKIT
    -> git clone the toolkit repo to ~/.claude/plugins/destinclaude/
    -> Claude Code auto-discovers the plugin, making the setup-wizard skill available
    |
ENABLE_DEVELOPER_MODE  (Windows only)
    -> prompt for UAC elevation to enable symlinks
    |
AUTHENTICATE
    -> ensure Claude Code is logged in (opens browser for OAuth)
    |
LAUNCH_WIZARD
    -> spawn Claude Code session with setup wizard auto-triggered
    |
COMPLETE
    -> write setup_completed: true, transition to normal app
```

Each state is persisted before starting work. If the app crashes mid-install, reopening picks up from the last completed state. No re-downloading things that already succeeded.

### Architecture

The state machine lives in Electron's main process, not the renderer. The renderer receives progress updates via IPC and displays them. This keeps the logic testable and independent of the UI.

---

## Component 3: Prerequisite Installer Module

New module: `src/main/prerequisite-installer.ts`

### Detection Phase

Runs first. Fast, no downloads.

| Prerequisite     | Detection          | "Installed" means       |
|------------------|--------------------|-------------------------|
| Node.js          | `node --version`   | exits 0, version >= 18  |
| Git              | `git --version`    | exits 0                 |
| Claude Code CLI  | `claude --version` | exits 0                 |

Users who already have some/all of these skip those steps automatically.

### Installation Strategies

**Windows:**

| Tool            | Method                                        | Rationale                                          |
|-----------------|-----------------------------------------------|----------------------------------------------------|
| Node.js         | `winget install OpenJS.NodeJS.LTS --silent`   | Pre-installed on Windows 11, no UAC for user-scope |
| Git             | `winget install Git.Git --silent`             | Same — winget is the native package manager        |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code`    | Standard npm global install                        |

**macOS:**

| Tool            | Method                                        | Rationale                                          |
|-----------------|-----------------------------------------------|----------------------------------------------------|
| Node.js         | Download `.pkg` from nodejs.org, run `installer -pkg` | Avoids requiring Homebrew for just this     |
| Git             | Xcode CLT prompt (`xcode-select --install`)   | macOS prompts for this automatically               |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code`    | Same as Windows                                    |

**Note on Homebrew:** The first-run module intentionally does NOT install Homebrew. Homebrew is needed for layer-specific dependencies (gh, rclone, Go, gcloud, etc.) and is installed during the setup wizard's Phase 4, where conversational guidance helps non-technical users through the password prompt. The first-run module only installs the bare minimum to launch Claude Code.

### Key Design Decisions

1. **Sequential, not parallel** — install one thing at a time so the progress UI is clear and failures are identifiable
2. **PATH refresh after each install** — on Windows especially, winget installs don't update the current process's PATH. The module re-resolves PATH after each install by reading the registry/shell profile
3. **No admin/sudo unless necessary** — Node.js and Git install to user-space on both platforms. Only Windows Developer Mode needs elevation
4. **Idempotent** — running the installer when things are already installed is a no-op

### Fallback Strategy

If a silent install fails:

1. Show friendly message: "I couldn't install [tool] automatically. Here's what to do:"
2. Provide a direct download link and brief instructions
3. "Once you've installed it, click 'Try Again'"
4. State machine re-checks and advances

Happy path is fully silent. Failures degrade gracefully into guided manual steps.

---

## Component 4: Authentication Flow

The app checks if Claude Code is already authenticated:

```
Run: claude --version (confirms CLI exists)
Run: claude auth status (check exit code)
    |
    +-- Already authenticated -> advance to LAUNCH_WIZARD
    |
    +-- Not authenticated -> show auth screen
```

### Auth Screen

Two paths, presented in the UI:

**Path 1: "Log in with Claude" (primary, recommended)** — big friendly button

- App runs `claude login` in a background PTY
- Claude Code opens the user's default browser to Anthropic's OAuth page
- User logs in with their existing Claude account (same as claude.ai)
- CLI receives the token automatically
- App polls auth status until success, then advances
- UI shows: "Waiting for you to log in... (a browser window should have opened)"

**Path 2: "I have an API key" (secondary, smaller link)** — for developers

- App shows a text input field with security disclosure:
  "Your key is passed directly to Claude Code and stored in its secure config. DestinCode never stores, logs, or backs up your key."
- User pastes API key
- App passes it to Claude Code's auth mechanism
- Validates, then advances

### API Key Security

- The app never touches the API key itself — passes directly to `claude auth`
- Claude Code stores it in its own credential config
- DestinCode and the toolkit never read, copy, log, or back up the key
- The toolkit's sync/backup system explicitly excludes credential files
- Source code is open — developers can audit the auth flow

### Error Cases

| Failure                          | Recovery                                                       |
|----------------------------------|----------------------------------------------------------------|
| Browser doesn't open             | Show URL as clickable link: "Click here to open manually"      |
| User closes browser without auth | "Login not completed. Try again?" with retry button            |
| Invalid API key                  | "That key didn't work. Double-check it and try again."         |
| Network error                    | "Can't reach Anthropic's servers. Check your internet."        |

---

## Component 5: First-Run UI

New React component: `src/renderer/components/FirstRunView.tsx`

### Layout

```
+-----------------------------------------------------+
|                                                     |
|              [DestinCode logo]                      |
|                                                     |
|         Welcome to DestinCode                       |
|     This usually takes 2-3 minutes                  |
|                                                     |
|   OK  Node.js                          installed    |
|   >>  Git                              installing   |
|   --  Claude Code                      waiting      |
|   --  DestinClaude Toolkit             waiting      |
|   --  Sign in                          waiting      |
|                                                     |
|   [==============>                     ]  35%       |
|                                                     |
|   Installing Git...                                 |
|                                                     |
+-----------------------------------------------------+
```

### State-to-UI Mapping

| State machine step        | User sees                                                        |
|---------------------------|------------------------------------------------------------------|
| `DETECT_PREREQUISITES`    | "Checking your system..." (fast, ~2 seconds)                     |
| `INSTALL_PREREQUISITES`   | Checklist with progress bar, items advance one at a time         |
| `CLONE_TOOLKIT`           | "Downloading DestinClaude Toolkit..." with progress              |
| `ENABLE_DEVELOPER_MODE`   | Windows only: explanation + UAC prompt                           |
| `AUTHENTICATE`            | Auth screen (OAuth button / API key input)                       |
| `LAUNCH_WIZARD`           | "Starting your setup..." then transition to session view         |

### UX Decisions

1. **No "Next" buttons** — each step auto-advances on completion. Only auth and UAC need interaction.
2. **Estimated time** — "This usually takes 2-3 minutes" shown at top
3. **Skipped items acknowledged** — already-installed items show "already installed" instead of disappearing
4. **Seamless transition** — progress screen fades out, Claude Code session fades in with wizard already running

### Implementation

`App.tsx` conditionally renders `FirstRunView` vs normal session view based on first-run state received via IPC from the main process. The existing session view only mounts after first-run completes.

---

## Component 6: Setup Wizard Handoff

### Boundary

| Responsibility            | Owner             |
|---------------------------|-------------------|
| Node.js, Git, Claude Code CLI | First-run module |
| Toolkit clone             | First-run module  |
| Developer Mode (Windows)  | First-run module  |
| Authentication            | First-run module  |
| Fresh vs restore          | Setup wizard      |
| Comfort level             | Setup wizard      |
| Layer selection            | Setup wizard      |
| Homebrew (macOS)          | Setup wizard      |
| gh, rclone, Go, gcloud   | Setup wizard      |
| Messaging, Todoist        | Setup wizard      |
| Personalization           | Setup wizard      |
| Symlinks, hooks, MCP      | Setup wizard      |
| Verification              | Setup wizard      |

### Handoff Sequence

1. First-run module completes -> writes `first_run_state: "LAUNCH_WIZARD"`
2. App spawns a Claude Code session via `SessionManager`
3. Session starts with an initial prompt (e.g., "I just installed DestinCode. Help me set up.")
4. Claude sees the setup-wizard skill, recognizes intent, launches the wizard
5. Renderer transitions from `FirstRunView` to normal session view
6. Wizard asks fresh vs restore, comfort level, and proceeds as it does today

### Required Wizard Adaptation

The setup wizard currently assumes Homebrew is pre-installed on macOS (see Phase 4 note: "On macOS, the bootstrap installer already installs Homebrew before launching the setup wizard"). Since the first-run module does not install Homebrew, the wizard needs to:

- Check if Homebrew is installed before any `brew install` command in Phase 4
- If missing, install it with explanation and password prompt guidance
- This is a small change — just remove the pre-installed assumption

No other wizard changes are needed. The wizard already handles all personalization, dependency installation, and verification conversationally.

---

## Component 7: Error Recovery & Edge Cases

### Prerequisite Install Failures

| Failure                                | Recovery                                                                |
|----------------------------------------|-------------------------------------------------------------------------|
| winget not available (older Windows 10)| Show direct download links for Node.js and Git installers               |
| macOS .pkg needs password/fails        | Fall back to "download and run manually" with direct link               |
| npm install fails (network)            | "Couldn't download Claude Code. Check internet. Click Try Again"        |
| Git clone fails (network)              | "Couldn't download toolkit. Check internet. Click Try Again"            |
| Windows Developer Mode UAC denied      | Plain-language explanation + manual path (Settings > System > For Developers). "I've done it" button re-checks |

### State Machine Resilience

- Every state transition written to `first-run-state.json` before starting work
- App crash mid-install -> reopen picks up from last completed state
- "Start Over" link resets state machine and clears partial installs
- Closing app during auth -> reopen returns to auth screen

### Edge Cases

| Scenario                                    | Handling                                                     |
|---------------------------------------------|--------------------------------------------------------------|
| User already has Node/Git/Claude Code       | Detection marks them done, skips to next. May finish in seconds. |
| Old Node.js (< 18)                         | "Node.js is too old for Claude Code. I'll update it."        |
| Corporate proxy blocks npm                  | "npm couldn't connect. Ask IT about npm registry access." + manual alternative |
| Disk space < 500MB                          | Pre-check: "You need at least 500MB free. You have X."      |
| Partial setup from previous attempt          | State machine resumes from last completed state              |
| User installed toolkit via terminal already  | `config.json` with `setup_completed: true` -> skip first-run |
| Second app launch after complete setup      | Normal app launch, first-run never shown again               |

---

## File Changes

### New Files (Desktop App)

| File                                         | Purpose                                                    |
|----------------------------------------------|------------------------------------------------------------|
| `src/main/first-run.ts`                     | State machine — detection, state persistence, orchestration |
| `src/main/prerequisite-installer.ts`         | Platform-specific silent install logic                     |
| `src/renderer/components/FirstRunView.tsx`   | Progress UI — checklist, progress bar                      |
| `src/renderer/components/AuthScreen.tsx`     | OAuth button + API key input with security disclosure      |

### Modified Files (Desktop App)

| File                        | Change                                                            |
|-----------------------------|-------------------------------------------------------------------|
| `src/main/main.ts`         | Check first-run state on launch, route to first-run or normal app |
| `src/main/ipc-handlers.ts` | Add IPC channels for first-run state updates, auth triggers       |
| `src/main/preload.ts`      | Expose first-run IPC channels to renderer                         |
| `src/renderer/App.tsx`     | Conditionally render `FirstRunView` vs normal session view        |

### Modified Files (Toolkit)

| File                                    | Change                                                       |
|-----------------------------------------|--------------------------------------------------------------|
| `core/skills/setup-wizard/SKILL.md`    | Remove Homebrew pre-installed assumption. Add Homebrew detection + install to Phase 4 before any `brew install` commands. |

### Reframed (Not Deleted)

| File                    | New Role                                                |
|-------------------------|---------------------------------------------------------|
| `bootstrap/install.sh`  | Advanced/developer install path (still works, not primary) |
| `bootstrap/install.ps1` | Same                                                    |

### Landing Page

- Replace terminal install instructions with "Download for Windows" / "Download for Mac" buttons
- Link to GitHub Releases (or direct download URLs)
- Keep terminal instructions as an expandable "Advanced: Install via Terminal" section

---

## Out of Scope

- Linux support (can be added later with AppImage + apt/dnf strategies)
- Auto-update for the first-run module itself (handled by existing `/appupdate`)
- Changes to the update mechanism (`/update`) — still git-based, still works
- Changes to the uninstall mechanism (`/toolkit-uninstall`) — still works
- Any changes to the setup wizard beyond the Homebrew assumption fix
