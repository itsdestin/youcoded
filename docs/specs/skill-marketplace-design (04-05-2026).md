---
name: Skill Marketplace & Management System
version: 1.1
status: implemented
date: 2026-04-05
---

# Skill Marketplace & Management System — Design Spec

## Overview

Transform the YouCoded command menu/dashboard into a comprehensive skill management system and marketplace. Users can browse, install, create, edit, share, and publish skills. The CommandDrawer becomes a curated quick-launch surface; a new full-screen Marketplace handles discovery; and a SkillManager provides local management and chip configuration.

## Key Decisions

### Distribution model: Hybrid Progressive (GitHub + static API)

- **V1:** GitHub repo as the marketplace registry. Static `stats.json` on GitHub Pages for install counts. All skill data cached locally.
- **V2:** Add a remote API for real ratings, server-tracked installs, user accounts, and cross-device sync.
- A `SkillProvider` interface abstracts the data layer so V2 is a swap, not a rewrite.

**Rationale:** Zero infrastructure at launch. Proven pattern (Claude Code's own marketplace is a GitHub repo). The provider abstraction costs ~20 lines and prevents a V2 rewrite.

### Two skill tiers

| Tier | What it is | Shareable? | Publishable? |
|------|-----------|------------|-------------|
| **Prompt shortcut** | Display name + description + prompt string | Yes (payload fits in a URL) | Yes (PR to registry) |
| **Full plugin** | SKILL.md + scripts + hooks + resources | Yes (link to repo) | Yes (PR to registry) |

Visually distinguished by type badges: `Prompt` (amber) vs `Plugin` (gray) vs `DC` (green).

### Three visibility levels

| Level | Where it appears | How others get it |
|-------|-----------------|-------------------|
| **Private** | User's drawer only (if favorited) | Not shareable — personal use only |
| **Shared** | User's drawer only (if favorited) | Direct share only (link/QR), not in marketplace |
| **Published** | Listed in marketplace for anyone | Browse + install, also shareable via link/QR |

Private vs Shared is a user-facing distinction: Private skills have sharing disabled (no 📤 button); Shared skills can generate links/QR but don't appear in the public marketplace. This is enforced in the UI — the `generateShareLink` provider method checks visibility and rejects Private skills.

### CommandDrawer shows favorites + curated defaults only

The drawer is no longer "show everything." It shows:
- Skills the user has favorited
- Skills in `curated-defaults.json` from the registry (the YouCoded default set)
- Deduplicated, grouped by category

A pencil icon in the drawer header opens the SkillManager for customization.

### Android works identically to desktop

A native Kotlin `LocalSkillProvider` mirrors the desktop's Node.js implementation. Same filesystem paths, same config file, same behavior. No feature gaps when running locally on Android.

---

## Data Model

### SkillEntry (extended)

```typescript
interface SkillEntry {
  // Existing
  id: string;
  displayName: string;
  description: string;
  category: 'personal' | 'work' | 'development' | 'admin' | 'other';
  prompt: string;
  source: 'youcoded-core' | 'self' | 'plugin' | 'marketplace';
  pluginName?: string;

  // New
  type: 'prompt' | 'plugin';
  author?: string;
  version?: string;
  rating?: number;          // 0-5, null in V1
  ratingCount?: number;     // null in V1
  installs?: number;
  visibility: 'private' | 'shared' | 'published';
  installedAt?: string;     // ISO timestamp
  updatedAt?: string;
  repoUrl?: string;
}
```

### UserSkillConfig

Stored at `~/.claude/youcoded-skills.json`. Shared between desktop and Android via filesystem.

```typescript
interface UserSkillConfig {
  version: 1;
  favorites: string[];
  chips: ChipConfig[];
  overrides: Record<string, MetadataOverride>;
  privateSkills: SkillEntry[];
}

interface ChipConfig {
  skillId?: string;  // optional — chips can exist without a backing skill
  label: string;
  prompt: string;
}

interface MetadataOverride {
  displayName?: string;
  description?: string;
  category?: SkillEntry['category'];
}
```

### SkillProvider interface

```typescript
interface SkillProvider {
  // Discovery
  listMarketplace(filters?: SkillFilters): Promise<SkillEntry[]>;
  getSkillDetail(id: string): Promise<SkillDetailView>;
  search(query: string): Promise<SkillEntry[]>;

  // Local state
  getInstalled(): Promise<SkillEntry[]>;
  getFavorites(): Promise<string[]>;
  getChips(): Promise<ChipConfig[]>;
  getOverrides(): Promise<Record<string, MetadataOverride>>;

  // Mutations
  install(id: string): Promise<void>;
  uninstall(id: string): Promise<void>;
  setFavorite(id: string, favorited: boolean): Promise<void>;
  setChips(chips: ChipConfig[]): Promise<void>;
  setOverride(id: string, override: MetadataOverride): Promise<void>;
  createPromptSkill(skill: Omit<SkillEntry, 'id'>): Promise<SkillEntry>;
  deletePromptSkill(id: string): Promise<void>;

  // Sharing
  publish(id: string): Promise<{ prUrl: string }>;
  generateShareLink(id: string): Promise<string>;
  importFromLink(encoded: string): Promise<SkillEntry>;
}
```

### SkillFilters

```typescript
interface SkillFilters {
  type?: 'prompt' | 'plugin';
  category?: SkillEntry['category'];
  sort?: 'popular' | 'newest' | 'rating' | 'name';
  query?: string;
}
```

### SkillDetailView

```typescript
interface SkillDetailView extends SkillEntry {
  fullDescription?: string;  // longer description from registry entry
  tags?: string[];
  publishedAt?: string;
  authorGithub?: string;
  sourceRegistry?: string;   // e.g., "claude-plugins-official"
}
```

V1: `LocalSkillProvider`. V2: `RemoteSkillProvider`. UI code is provider-agnostic.

---

## Architecture

### Desktop — new & modified files

```
desktop/src/
├── main/
│   ├── skill-provider.ts          # LocalSkillProvider
│   ├── skill-scanner.ts           # (existing, extended)
│   ├── skill-share.ts             # Deep link encoding/decoding, QR data
│   └── skill-publisher.ts         # GitHub PR creation
├── renderer/
│   ├── components/
│   │   ├── CommandDrawer.tsx       # Modified: favorites + curated only, pencil icon
│   │   ├── SkillCard.tsx           # Modified: ratings, author, Get button
│   │   ├── QuickChips.tsx          # Modified: reads from config
│   │   ├── Marketplace.tsx         # NEW: full-screen explore grid
│   │   ├── SkillDetail.tsx         # NEW: detail view
│   │   ├── SkillManager.tsx        # NEW: My Skills + Quick Chips
│   │   ├── SkillEditor.tsx         # NEW: edit metadata modal
│   │   ├── ShareSheet.tsx          # NEW: link + QR share
│   │   └── CreatePromptSheet.tsx   # NEW: create prompt shortcut
│   ├── state/
│   │   ��── skill-context.tsx       # NEW: React context for SkillProvider
│   └── data/
│       └── skill-registry.json     # Existing: becomes curated defaults reference
└── shared/
    └── types.ts                    # Extended with new interfaces
```

### Android — new files

```
app/src/main/kotlin/com/destin/code/skills/
├── LocalSkillProvider.kt           # Kotlin port of desktop provider
├── SkillScanner.kt                 # Walks ~/.claude/plugins/
├── SkillConfigStore.kt             # Reads/writes youcoded-skills.json
├── MarketplaceFetcher.kt           # HTTP fetch + cache of registry
└── SkillShareCodec.kt              # Encode/decode share links
```

> **V1 note:** `SkillPublisher` (GitHub PR creation) deferred to V2 — requires `gh` CLI auth.

`SessionService.kt` gets new bridge handlers wrapping `LocalSkillProvider.kt`.

### Data flow

```
React UI (CommandDrawer, Marketplace, SkillManager)
        │
        ▼
  SkillContext (React state)
        │
        ▼
  window.claude.skills.*
        │
        ▼  IPC (Electron) or WebSocket (Android)
  LocalSkillProvider
        │
        ├── SkillScanner → ~/.claude/plugins/ (installed skills)
        ├── SkillConfigStore → ~/.claude/youcoded-skills.json (preferences)
        └── MarketplaceFetcher → GitHub raw URLs (registry + stats)
```

### IPC additions

`window.claude.skills` expands from one method to:

```typescript
window.claude.skills = {
  list(): Promise<SkillEntry[]>;
  listMarketplace(filters?): Promise<SkillEntry[]>;
  getDetail(id): Promise<SkillDetailView>;
  search(query): Promise<SkillEntry[]>;
  install(id): Promise<void>;
  uninstall(id): Promise<void>;
  getFavorites(): Promise<string[]>;
  setFavorite(id, favorited): Promise<void>;
  getChips(): Promise<ChipConfig[]>;
  setChips(chips): Promise<void>;
  getOverride(id): Promise<MetadataOverride | null>;
  setOverride(id, override): Promise<void>;
  createPrompt(skill): Promise<SkillEntry>;
  deletePrompt(id): Promise<void>;
  publish(id): Promise<{ prUrl: string }>;
  getShareLink(id): Promise<string>;
  importFromLink(encoded): Promise<SkillEntry>;
};
```

---

## UI Screens

### CommandDrawer (modified)

- Shows only: `favorites ∪ curatedDefaults`, deduplicated, grouped by category
- Pencil icon in header → opens SkillManager
- Search filters within the visible set
- On first launch after migration, all current skills become favorites (no disruption)

### QuickChips (modified)

- Reads from `UserSkillConfig.chips` instead of hardcoded array
- Falls back to current defaults if no config exists
- No visual change to the chip bar itself

### Marketplace (new full-screen modal)

- Entry: button in SkillManager, possibly a storefront icon in CommandDrawer
- Search bar → filter pills (All/Prompts/Plugins + category) → sort dropdown
- Featured banner (from `featured.json`)
- 2-column card grid, each card showing: name, description, type badge, star rating, author, install count, Get/Installed button
- Tapping a card → SkillDetail sub-view

### SkillDetail (new sub-view)

- Centered header: name, author, star rating + count
- Action buttons: Install/Uninstall, Favorite, Share
- Stats row: type, installs, category
- Full description
- Metadata: version, source, updated date, visibility
- Edit Metadata button (if installed)
- Uninstall button (if installed)
- Publish button (if user-owned)

### SkillManager (new modal, from pencil icon)

- Segmented control: My Skills | Quick Chips
- **My Skills:** Create Prompt button, Marketplace link, filter pills (All/Favorites/Private), list with star toggle + edit/share/delete actions per row
- **Quick Chips:** Live preview of chip bar, up/down arrow reordering (not drag-and-drop), add/remove chips, each row shows label + prompt

### ShareSheet (new modal)

- QR code generated client-side
- Copyable deep link
- Publish to Marketplace button

### CreatePromptSheet (new modal)

- Fields: Name, Description, Prompt, Category dropdown, Visibility dropdown
- Create button

---

## Sharing & Publishing

### Deep link format

**Prompt shortcuts** (self-contained):
```
youcoded://skill/<base64url-encoded JSON payload>
```

Payload: `{ v, type, displayName, description, prompt, category, author }`

**Full plugins** (pointer to repo):
```
youcoded://plugin/<base64url-encoded JSON payload>
```

Payload: `{ v, type, name, displayName, description, repoUrl, pluginPath, author }`

### QR code

Generated client-side from the deep link URL. Scanned with existing `QrScannerOverlay.kt`.

### Import flow

1. Parse `youcoded://` URL
2. Validate and sanitize payload (length limits: 100 chars name, 500 desc, 2000 prompt)
3. Prompt shortcuts → written to `youcoded-skills.json`, Toast confirmation
4. Plugins → deferred to V2 (clone from repo)

> **V1 note:** Skips confirmation sheet — imports directly. Android handles via `MainActivity.handleDeepLink()`.

### Publishing (V2)

> Deferred to V2. The `publish()` IPC method exists but returns a stub error. V2 will:

1. User taps Publish in ShareSheet
2. App checks for GitHub auth (`gh` CLI token)
3. Creates a PR against the marketplace registry repo
4. Returns PR URL to user

### Android deep link registration

Intent filter in `AndroidManifest.xml` for `youcoded://` scheme. `MainActivity.kt` routes to import flow.

---

## GitHub Registry

### Repository structure

```
wecoded-marketplace/
├── featured.json         # hand-curated featured list
├── curated-defaults.json # CommandDrawer default skill IDs
├── stats.json            # rebuilt daily by GitHub Action
├── index.json            # flat array of all entries (29 skills at launch)
├── README.md
└── .github/
    └── workflows/
        └── rebuild-stats.yml
```

> **V1 note:** All entries live directly in `index.json` (flat array) rather than individual files under `registry/`. V2 may split into per-entry files if the registry grows large.

### Registry entry format

```json
{
  "id": "morning-standup",
  "type": "prompt",
  "displayName": "Morning Standup",
  "description": "Summarize yesterday and plan today's priorities",
  "prompt": "summarize what I did yesterday and help me plan today's priorities",
  "category": "work",
  "author": "@devjane",
  "authorGithub": "devjane",
  "version": "1.0.0",
  "publishedAt": "2026-04-01T00:00:00Z",
  "repoUrl": null,
  "tags": ["productivity", "daily"]
}
```

### Stats pipeline

GitHub Action rebuilds `stats.json` daily. V1: install counts approximated from GitHub API data. V2: real server-tracked counts. Rating fields exist in schema but return null in V1.

### Fetching

- On marketplace open: fetch `stats.json` + `featured.json` + `curated-defaults.json` via raw GitHub URLs (1-hour cache TTL)
- On search/browse: read `index.json` (24-hour cache TTL)
- Merge with local state (installed? favorited? overrides?) to produce final `SkillEntry[]`

---

## Error Handling & Edge Cases

### Offline

- CommandDrawer, QuickChips: always work (local data)
- Marketplace browse: cached data with "Last updated X ago" indicator
- Import prompt shortcuts from link: works (self-contained payload)
- Import plugins, install, publish: fail gracefully with retry option

### Conflicts

- User metadata overrides always win over registry data. "Reset to default" restores originals.
- Curated default removed from registry: disappears from drawer unless favorited.
- Desktop vs Android config: last write wins (same `youcoded-skills.json` file).

### Limits

- Max quick chips: 10
- Max private prompt shortcuts: 100
- Share link max size: ~2KB (long prompts truncated with warning)
- Registry cache TTL: 1 hour (stats), 24 hours (index)

### Migration (first launch after update)

1. Create `youcoded-skills.json` if missing
2. Populate `favorites` with all current `skill-registry.json` entries
3. Populate `chips` with current hardcoded `defaultChips`
4. No overrides or private skills initially
5. Zero disruption — user sees the same drawer and chips as before

---

## Change Log

### v1.1 (2026-04-05)
- Status → implemented
- Removed `SkillPublisher.kt` from Android file list (deferred to V2)
- Quick Chips reordering: changed from drag-to-reorder to up/down arrows
- Import flow: simplified to direct import with Toast (no confirmation sheet in V1)
- Publishing: marked as V2 with stub IPC method
- Registry structure: documented flat `index.json` layout (no per-entry files)

### v1.0 (2026-04-05)
- Initial design spec
