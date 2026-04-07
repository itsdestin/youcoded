# Command Palette — Design Document

**Date:** 2026-03-22
**Feature:** Browsable command/skill drawer for the desktop app
**Status:** Design complete, ready for implementation

## Problem

Users who aren't familiar with Claude Code don't know what skills, commands, and capabilities are available. The current quick chips cover 5 items, but there are 50+ installed skills across multiple plugins. Non-technical users need a browsable, categorized interface that explains what each thing does in plain language.

## Design

### UI: Categorized Bottom Drawer

A panel that slides up from the bottom, covering ~45% of the screen. Content behind it dims. Has a grab handle at top center and closes on click-outside or Escape.

### Two Entry Points

1. **Menu button** — a grid/compass icon in the input bar (next to the paperclip). Always visible. Opens the drawer in browse mode.
2. **Slash trigger** — typing `/` in the input bar opens the drawer in search-first mode (search bar auto-focused, filtering as the user types). Backspacing past the `/` closes the drawer.

### Layout Inside the Drawer

```
┌─────────────────────────────────────────────┐
│                 ─── (grab handle)            │
│  ┌─────────────────────────────────────────┐ │
│  │ 🔍 Search skills and commands...        │ │
│  └─────────────────────────────────────────┘ │
│                                              │
│  PERSONAL                                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│  │ Journal  │ │  Inbox   │ │ Briefing │    │
│  │ Write... │ │ Process..│ │ Get a ...│    │
│  │ DC       │ │ DC       │ │ DC       │    │
│  └──────────┘ └──────────┘ └──────────┘    │
│                                              │
│  WORK                                        │
│  ┌──────────┐ ┌──────────┐                  │
│  │ Google   │ │ Google   │                  │
│  │ Drive    │ │ Workspce │                  │
│  │ DC       │ │ DC       │                  │
│  └──────────┘ └──────────┘                  │
│                                              │
│  DEVELOPMENT                                 │
│  ...                                         │
│                                              │
│  DESTINCLAUDE ADMIN                          │
│  ...                                         │
│                                              │
│  OTHER SKILLS                                │
│  ...                                         │
└─────────────────────────────────────────────┘
```

### Categories

Skills are assigned to categories based on their purpose, not their plugin layer:

| Category | Purpose | Examples |
|----------|---------|----------|
| **Personal** | Daily life, memory, journaling | Journal, Inbox, Briefing, Encyclopedia, Food Tracker, Draft Text, Write in My Voice |
| **Work** | Professional tools, productivity | Google Drive, Google Workspace, any work-specific skills |
| **Development** | Code, builds, technical tasks | Code Review, Feature Dev, Commit, Plugin Dev skills |
| **DestinClaude Admin** | Toolkit management | Sync, Update, Health Check, Setup Wizard, Teach Workflow |
| **Other Skills** | Catch-all for unrecognized skills | Anything without curated metadata |

### Each Card Shows

- **Display name** — human-friendly, e.g. "Journal" not "journaling-assistant"
- **Description** — one plain-English sentence, e.g. "Write about your day in a guided conversation"
- **Source badge** — small label at bottom: `DC` (DestinClaude), `Self` (user-created), `Plugin` (third-party)
- **Prompt** — what gets sent to the PTY when clicked (hidden from UI, used on tap)

### Data Architecture: Hybrid Registry

#### Curated Registry (ships with desktop app)

A JSON file at `src/renderer/data/skill-registry.json` that maps known skill IDs to display metadata:

```json
{
  "journaling-assistant": {
    "displayName": "Journal",
    "description": "Write about your day in a guided conversation",
    "category": "personal",
    "prompt": "let's journal",
    "source": "destinclaude"
  },
  "inbox-processor": {
    "displayName": "Inbox",
    "description": "Process notes and screenshots captured from your phone",
    "category": "personal",
    "prompt": "check my inbox",
    "source": "destinclaude"
  }
}
```

#### Dynamic Discovery (runtime)

On app startup, the main process scans `~/.claude/plugins/*/plugin.json` to discover all installed plugins and their skills. For each skill:

1. Check the curated registry — if found, use curated display metadata
2. If not found, fall back to the skill's raw `name` and `description` from plugin.json
3. Assign to "Other Skills" category
4. Infer source from path:
   - `plugins/destinclaude/` → `DC`
   - `skills/` (user's own) → `Self`
   - `plugins/cache/` (marketplace) → `Plugin`
   - Everything else → `Plugin`

#### IPC

New channel: `skills:list` — main process reads plugin manifests, merges with curated registry, returns the full list to the renderer. Called once on app startup, cached in React state.

```typescript
interface SkillEntry {
  id: string;              // e.g. "journaling-assistant"
  displayName: string;     // e.g. "Journal"
  description: string;     // e.g. "Write about your day..."
  category: string;        // "personal" | "work" | "development" | "admin" | "other"
  prompt: string;          // what to send to PTY
  source: string;          // "destinclaude" | "self" | "plugin"
  pluginName?: string;     // e.g. "huggingface-skills"
}
```

### Card Styling

- Container: `bg-gray-900 border border-gray-700/50 rounded-lg p-3`
- Display name: `text-sm font-medium text-gray-200`
- Description: `text-[11px] text-gray-500 mt-1`
- Source badge: `text-[9px] font-medium px-1 py-0.5 rounded mt-2`
  - DC: `bg-[#4CAF50]/15 text-[#4CAF50] border border-[#4CAF50]/25`
  - Self: `bg-[#66AAFF]/15 text-[#66AAFF] border border-[#66AAFF]/25`
  - Plugin: `bg-gray-700/50 text-gray-400 border border-gray-600/25`
- Hover: `hover:bg-gray-800 hover:border-gray-600`
- Cards in a responsive grid: `grid grid-cols-3 gap-2` (could go to 2 cols on narrow windows)

### Search Behavior

- Filters across displayName, description, and category
- Case-insensitive substring match
- Results flatten into a single list (no category headers) when searching
- Empty search shows all categories

### Interaction Flow

1. User clicks menu button (or types `/`)
2. Drawer slides up with smooth animation (`transition-transform duration-300`)
3. Content behind dims (`bg-gray-950/60 backdrop-blur-sm`)
4. User browses categories or searches
5. User clicks a card
6. The card's prompt is sent to the active session's PTY
7. A user message bubble appears in chat
8. Drawer closes

### Quick Chips Relationship

The existing quick chips row stays — it's for the 5 most common actions (one-tap). The drawer is for everything else (two-tap: open drawer + select). The quick chips could optionally have a `⋯` button at the right end that opens the drawer.

### Components to Create

1. `src/renderer/components/CommandDrawer.tsx` — the drawer container with search + category layout
2. `src/renderer/components/SkillCard.tsx` — individual card component
3. `src/renderer/data/skill-registry.json` — curated display metadata
4. Main process: IPC handler for `skills:list` that scans plugin directories
5. Update `InputBar.tsx` — add menu button, handle `/` trigger
6. Update `App.tsx` — manage drawer open/close state

### Files to Modify

- `src/renderer/components/InputBar.tsx` — add menu button icon, `/` detection
- `src/renderer/components/Icons.tsx` — add menu/grid icon
- `src/renderer/App.tsx` — drawer state management
- `src/main/ipc-handlers.ts` — add skills:list IPC handler
- `src/main/preload.ts` — expose skills:list
- `src/renderer/hooks/useIpc.ts` — type declaration
- `src/shared/types.ts` — IPC channel constant

### Open Questions

- Should the drawer remember which category was last viewed?
- Should cards show a "last used" indicator?
- Should the curated registry also define the quick chips (replacing the hardcoded list in QuickChips.tsx)?
- How should slash commands (e.g. `/commit`, `/sync`) be differentiated from skills visually? They're invoked differently (slash prefix vs natural language prompt).
