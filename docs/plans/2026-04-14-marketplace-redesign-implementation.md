# Marketplace Redesign — Implementation Plan

**Status:** Planned — not yet implemented
**Date:** 2026-04-14 (revised after current-state audit + independent review)
**Companion doc:** [`2026-04-14-marketplace-redesign.md`](./2026-04-14-marketplace-redesign.md) (design/vision)

This plan translates the design doc into concrete file-level changes. The unified marketplace data layer is shipped; this work is UX + schema extension on top.

**Semantic anchors, not line numbers.** An earlier revision cited exact `Marketplace.tsx` line ranges. Those drift as soon as anyone edits the file. This revision names functions and JSX regions instead — treat the file as the source of truth and grep for the anchor when executing.

## What's already shipped (do not rebuild)

The 2026-04-08 unified marketplace plan is complete through Phase 4a. The redesign builds on this — does not replace it.

**Data layer:**
- `wecoded-marketplace/` — registry restructured with `skills/index.json` + `themes/index.json`; `marketplace.json` for local YouCoded entries; `scripts/sync.js` rewritten with diffing, SHA preservation, deprecation flags
- `featured.json` exists with `{skills, themes}` shape only. `hero` / `rails` arrays are **not** present — Phase 1 adds them. No UI consumer currently reads `featured.json`, so extending it is backwards-safe.
- Entry schema has `tags[]` (currently empty across the board), `sourceMarketplace`, `sourceType`, `sourceRef`, `sourceSha`, `deprecated` — all already live. `tagline`, `longDescription`, `lifeArea[]`, `audience`, `components{}` are **not** in the index — Phase 1 adds them.
- CI validation workflow merged

**Renderer:**
- `Marketplace.tsx` — three-tab unified modal (Installed / Skills / Themes), replaced the old separate SkillManager + Marketplace + ThemeMarketplace trio
- `state/marketplace-context.tsx` — unified data fetching, install/uninstall/update/publish API
- `youcoded-skills.json` version 1 in place (packages field migration prepped, not deployed)

**Theme previews:** Token-based preview (7-swatch grid from manifest `previewTokens`) is the primary path and always works. CI-generated PNG is secondary polish. Both ship. Android loads tokens fine; custom asset interception isn't wired (Phase 5c, deferred — out of scope for this redesign).

## What's open on the unified plan (deferred, not part of this work)

- `youcoded-skills.json` v2 migration with `packages` map (Phase 1d)
- Android theme-asset interception (Phase 5c)
- Sign-in chip / OAuth flow (Task 8 placeholder in header)

These are tracked in `wecoded-marketplace/docs/`. The redesign does not touch them; they progress independently.

---

## Summary of net-new work

| Area | What changes |
|---|---|
| **Schema** | Add `tagline`, `longDescription`, `lifeArea[]`, `audience`, `components{}` fields; populate `tags[]` (currently empty everywhere) |
| **Component extraction** | New `scripts/extract-components.js` — tree-walk for remote plugins, fs-walk for local. Lists skills/hooks/commands/agents/MCP servers per plugin |
| **`featured.json`** | Add `hero[]` and `rails[]` fields (not currently present). Existing `{skills, themes}` fields stay readable but become orphaned — no UI consumer. |
| **Full-screen route** | Replace `Marketplace.tsx` fixed modal with top-level `MarketplaceScreen.tsx` via `activeView` state in App.tsx. Wallpaper visible, glass surfaces. |
| **Layout** | New hero + sticky chip bar + horizontal rails + bottom grid. Replace `SkillsTab` / `ThemesTab` filter+sort UI and 2-col grids with `MarketplaceFilterBar` + `MarketplaceGrid` + `MarketplaceRail`. |
| **Your Library** | Extract the `InstalledTab` function from `Marketplace.tsx` into new `LibraryScreen.tsx` — separate top-level destination. Marketplace becomes acquisitional only. |
| **Integrations** | New content kind with dedicated card variant + install flow. Separate `integrations/index.json`. Google Workspace first. |
| **Curation tooling** | `/feature` admin skill in youcoded-core-admin for editing `featured.json` conversationally. |

---

## Phase 1 — Schema + component extraction

**Goal:** Land new fields end-to-end, auto-populate `components` for all plugins, backfill curated descriptions for ~15 core plugins. Nothing UI-visible.

### `wecoded-marketplace/` changes

**`scripts/schema.js`** *(new)* — single source of truth:
```js
export const ALLOWED_TAGS = [...];        // ~30 values
export const ALLOWED_LIFE_AREAS = ['school', 'work', 'creative', 'health', 'personal', 'finance', 'home'];
export const ALLOWED_AUDIENCE = ['general', 'developer'];
export const TAG_ALIASES = { students: 'school', productive: 'productivity', /* ... */ };
```

**`scripts/extract-components.js`** *(new)* — two functions:
- `extractLocalComponents(pluginDir)` — walks the local filesystem for `sourceType: "local"` entries (YouCoded plugins). Reads `skills/*/SKILL.md` frontmatter, `hooks/hooks-manifest.json`, `commands/*.md`, `agents/*.md`, `.mcp.json` or `mcp/servers.json`. Returns `{ skills, hooks, commands, agents, mcpServers }`.
- `extractRemoteComponents(owner, repo, ref, subdir?)` — single GitHub Tree API call per plugin (`GET /repos/:owner/:repo/git/trees/:sha?recursive=1`), parses paths by naming convention. V1 extracts **names only** from paths (no frontmatter fetches — fast, ~135 API calls total for Anthropic). V2 can backfill descriptions from SKILL.md later if the UI demands it.

**GITHUB_TOKEN provisioning:**
- Local dev: optional `GITHUB_TOKEN` env var. Unauthenticated runs work (60 req/hr), enough for one fresh sync but not iterated runs.
- CI: `${{ secrets.GITHUB_TOKEN }}` (the built-in Actions token) — `public_repo` scope is sufficient, already provided by GH Actions, no manual rotation. Exposed as env var in the sync workflow step.
- Scope explicitly: read-only, no `repo`/`workflow` scopes.

**Failure handling (non-negotiable — one bad plugin must not break sync):**
- Per-plugin try/catch. On extraction failure, log to `sync-report.json` (slug, error class, http status) and emit the entry with `components: null` and `componentsError: <class>`.
- `truncated: true` in Tree API response (>100k entries / >7MB): skip tree-walk, mark `components: null` + `componentsError: "truncated"`. Don't retry with pagination in V1 — document as known limitation.
- 404 on the pinned `sourceSha`: plugin was force-pushed or sha is stale. Mark `componentsError: "sha-missing"`; leave stale `components` value if present.
- Rate-limit (HTTP 403 with `X-RateLimit-Remaining: 0`): abort the run with a clear error. Do not partial-write the index — last-good state wins.
- Malformed path (spaces, unicode): log and skip individual entry; plugin still gets partial components.

**Cache by `sourceSha`** — sync.js only re-extracts when the pinned SHA changes. **Gap:** if a plugin author force-pushes the tag without changing `sourceSha` in the upstream marketplace catalog, extraction won't re-run. Accepted limitation; fix would be a nightly full re-extract workflow (not scoped here).

**`scripts/sync.js`** — in `mapEntry()` (the function that maps an upstream catalog entry into an index entry; grep for `function mapEntry` or `const mapEntry`), after `parseSource()` returns, call `extractLocal`/`extractRemote` depending on `sourceType` and populate `components`. Extend the entry-merge step to preserve `tagline`, `longDescription`, `tags`, `audience`, `lifeArea` from `marketplace.json` overrides. Normalize tags through `TAG_ALIASES` at write time.

**`scripts/generate-descriptions.js`** *(new)* — for curated core set only (slugs listed in `scripts/core-plugins.txt` *new*), reads `plugin.json` + `SKILL.md` files, drafts `tagline` (≤60 chars) + `longDescription` (markdown) via Claude API, writes into `marketplace.json` (the override file). Human-review-commit workflow; never auto-commits.

**`featured.json`** — extend in place. Current file has only `{skills, themes}` (no existing UI consumer). Add `hero` and `rails`; leave `skills`/`themes` for now to avoid touching anything that might read them, and delete in Phase 2 once we confirm nothing reads them. Example shape:
```jsonc
{
  "skills": [/* existing — keep */],
  "themes": [/* existing — keep */],
  "hero": [                                   // NEW
    { "id": "civic-report", "blurb": "...", "accentColor": "#..." }
  ],
  "rails": [                                  // NEW
    { "title": "Destin's picks", "description": "...", "slugs": [...] }
  ]
}
```
Old consumers of `skills[]`/`themes[]` keep working during transition; new consumers read `hero`/`rails`. Once redesign ships, deprecate `skills`/`themes` fields.

**`.github/workflows/validate-plugin-pr.yml`** — add validation step before final check: parse `tags`, `audience`, `lifeArea` on any modified entries; fail if any value is outside the enum in `schema.js`. Accept alias keys, normalize.

### `youcoded/desktop/src/renderer/` changes

**`state/marketplace-context.tsx`** — add `featured` to the parallel `fetchAll` on mount (the `Promise.all` block inside the mount-time loader; grep for `Promise.all`). Expose on context. Additive, doesn't break existing consumers.

**`types/marketplace.ts`** — either extend existing types or add new ones. Include the new fields as optional so pre-extension cache reads still type-check.

**`skill-provider.ts`** — add `fetchFeatured()` mirroring `fetchIndex()`. Same 24h cache, separate cache file `featured-cache.json`. Non-blocking for initial render.

### `youcoded/app/` changes

**`LocalSkillProvider.kt`** — no schema changes required. New fields flow through JSON pass-through automatically. Add `fetchFeatured()` to `MarketplaceFetcher` for Android parity.

### Acceptance

- `node scripts/sync.js` locally produces `index.json` with `components` populated for the majority of 135+ entries. `sync-report.json` lists any extraction failures; a manual review confirms failures are path-convention edge cases, not systemic bugs.
- Zero-components case is intentional (plugin has nothing to list) and renders as empty `components: {}`, not `null`. `null` strictly means extraction failed.
- CI rejects a PR adding `tags: ["nonexistent"]`.
- `featured.json` has `hero` + `rails` populated for ~5 picks.
- Current Marketplace.tsx UI continues to render exactly as before — redesign hasn't started.
- Android: `LocalSkillProvider.fetchFeatured()` returns the new shape without crashing on the `hero`/`rails` fields (JSON pass-through verified on device).

---

## Phase 2 — Full-screen marketplace + Your Library

**Goal:** Visible redesign. Replace modal with full-screen glass destination. Split Installed tab into its own "Your Library" destination.

### Routing / view layer

No prior framework exists. Extend App.tsx:

- Replace the `marketplaceTab` state (currently `'installed' | 'skills' | 'themes' | null`) with:
  - `activeView: 'chat' | 'terminal' | 'marketplace' | 'library'` — **app-scoped, not per-session**.
  - `marketplaceDetail: { slug, kind } | null` for the in-screen detail overlay.
- Command drawer gets `/market` and `/library` entries (currently only `/market`).
- SettingsPanel theme picker (the theme list in SettingsPanel.tsx — not pinned to a line) jumps to marketplace with `type: 'theme'` chip pre-applied.

**State-transition rules (load-bearing — decide once, implement consistently):**

| Trigger | Effect |
|---|---|
| User switches session (sidebar click) | `activeView` stays put. Rationale: the user was just browsing; don't yank them back to chat. |
| User opens a new session via `/new` or new-session button | `activeView` → `'chat'`. Rationale: they're starting fresh work. |
| Esc inside marketplace/library with no detail open | `activeView` → previous non-marketplace view (`'chat'` or `'terminal'`). Track `previousView` in a ref. |
| Esc inside detail overlay | Close detail only; `activeView` stays on marketplace/library. |
| Session dies while marketplace is open | No view change. Surface the death via existing attention banner when user returns to chat. |
| Remote disconnect | No view change. Marketplace still works (fetches are cached / run through the same shim). |

Chat/terminal toggle (inside chat view) remains separate and per-session — driven by the existing `viewModes` Map. `activeView` sits above it.

Rejected: adding react-router. Four top-level views don't need URL matching.

### New components

Under `desktop/src/renderer/components/marketplace/` *(new directory)*:

- **`MarketplaceScreen.tsx`** — full-screen route, `bg-transparent` so wallpaper reads through.
- **`MarketplaceHero.tsx`** — rotating featured slots from `featured.hero[]`. Low `--panels-opacity`, strong `--panels-blur`. Theme-tinted accent border.
- **`MarketplaceFilterBar.tsx`** — sticky chip bar. Type (Skills/Themes/Integrations), Vibe (life areas as chips), Meta (New / Popular / Destin's picks), search. Heavier glass — header-bar-like.
- **`MarketplaceRail.tsx`** — horizontal scroll. Hover arrow buttons (absolute-positioned), "See all →" CTA expands to filtered grid. Transparent container.
- **`MarketplaceCard.tsx`** — unified card for skills/themes/plugins. `variant` prop selects layout specifics. Hover: 200ms `scale(1.02)` + accent gradient border. Status dots (new/updated). Install count + rating (from `marketplace-stats-context`, live 15min refresh — existing infra). Small "N skills · M hooks" badge from `components` field.
- **`MarketplaceGrid.tsx`** — bottom catalog; responsive columns (2/3/4 by width).
- **`MarketplaceDetailOverlay.tsx`** — replaces `SkillDetail.tsx` + `ThemeDetail.tsx`. Opens as `<OverlayPanel layer={2}>` within marketplace. Hero banner tinted with plugin accent color, markdown `longDescription`, **expandable "What's inside" section** driven by `components` field listing every skill/hook/command/agent with descriptions, example-prompt chips that call `window.claude.chat.prefill()`.

Under `desktop/src/renderer/components/library/` *(new directory)*:

- **`LibraryScreen.tsx`** — full-screen, same glass treatment. Sections: Favorites · Installed Skills · Installed Themes · Active Integrations · Updates Available. Reuses `MarketplaceCard.tsx` + `MarketplaceDetailOverlay.tsx`. No hero/rails — management surface.

### Context sharing — Marketplace ↔ Library

Both screens use the **same** `MarketplaceProvider` (already wrapped at App.tsx root). Do not fork or split the provider. Rationale: install/uninstall/update flows mutate the same backing state; forking invites stale-read bugs (user installs in Marketplace, switches to Library, sees old state).

What each screen reads:
- Marketplace: `index`, `featured`, `stats`, `installedSlugs` (to render "Installed" badges on discovery cards).
- Library: `installedSlugs`, per-package metadata, `updatesAvailable`, `favorites`.

Handlers (`installSkill`, `uninstallSkill`, `toggleFavorite`, `publish`) live on the context and are called from both screens. The current `Marketplace.tsx` `InstalledTab` already consumes these — preserve the calls, just relocate the JSX.

### Components migrated / deprecated

Semantic anchors — grep the current `Marketplace.tsx` for these function names / JSX regions:

| Current location | Action | Destination |
|---|---|---|
| `InstalledTab` function | Extract wholesale | `LibraryScreen.tsx` (becomes the main body) |
| `SkillsTab` function — content logic (card list, install buttons) | Migrate into `MarketplaceScreen` + `MarketplaceGrid` | `components/marketplace/` |
| `SkillsTab` — filter/sort UI | Delete | replaced by `MarketplaceFilterBar` chips |
| `ThemesTab` function — content logic | Migrate into `MarketplaceScreen`; themes become a `type: 'theme'` chip, not a tab | `components/marketplace/` |
| `ThemesTab` — filter/sort UI | Delete | replaced by `MarketplaceFilterBar` chips |
| 2-column responsive grid JSX (inside each tab) | Delete | replaced by `MarketplaceGrid` + `MarketplaceRail` |
| Outer `Marketplace` modal wrapper (tab switcher + Scrim/OverlayPanel) | Delete after `MarketplaceScreen` is the default | `activeView === 'marketplace'` renders `MarketplaceScreen` directly |
| `SkillDetail.tsx`, `ThemeDetail.tsx` | Delete | replaced by `MarketplaceDetailOverlay.tsx` |

Preserve handler identities (same function names, same call sites) so git blame stays meaningful.

### Glass strategy

Per shared-ui-architecture.md and PITFALLS.md:

- Wallpaper: existing `[data-wallpaper]` layer (below all UI).
- `MarketplaceScreen` root: `bg-transparent`.
- Hero: very low `--panels-opacity` override, strong blur.
- Sticky filter bar: header-bar glass treatment (existing class).
- Rail container: fully transparent; only cards are solid.
- Cards: `.layer-surface` (standard glass, reads theme tokens).
- Bottom grid: `.panel-glass` for denser surface.
- Detail overlay: `<OverlayPanel layer={2}>` — it IS a popup, appropriate to wrap.

Never stack `backdrop-filter` more than 2 deep. Cards composite onto wallpaper directly (rail is transparent). **Verify with DevTools Layers panel** before shipping — count real `backdrop-filter` layers on a loaded marketplace screen. If hero + filter bar + grid = 3 visible layers at once, drop one (most likely: grid loses its blur, keeps opacity).

Verify on Android separately — low-end devices choke on 2+ backdrop-filter layers even when desktop is fine.

### Filter ↔ rail interaction

- **Discovery mode** (no chips, no search): hero + rails + bottom grid visible.
- **Search mode** (any chip or search non-empty): hero collapses, rails hide, grid takes over filtered.
- Derived `mode = chipsActive ? 'search' : 'discovery'` in `MarketplaceScreen`.
- Clearing chips returns to discovery.

### Back navigation

- Esc in `marketplaceDetail` open → close detail.
- Esc in marketplace/library (no detail) → return to chat.
- Android back button: same two-step via existing `PlatformBridge`.

### Acceptance

- `/market` opens a full-screen marketplace, wallpaper visible.
- `/library` opens a full-screen library, same glass treatment.
- Cmd-K → "Marketplace" and "Library" both present.
- Cards show a "What's inside" peek via the `components` field. Cards for plugins with `components: null` (extraction failed) show the rest of the card normally and omit the peek — no error banner.
- Esc pattern works on desktop + Android; state-transition rules (table above) verified by hand.
- Install → switch session → reopen marketplace: card still shows "Installed" badge (context-sharing works).
- Performance on Android: rail scroll at 60fps on test device; first-paint of marketplace <500ms with warm cache, <2s cold.
- Empty states: zero-rails-curated case, zero-search-results case, offline case all render sanely.

---

## Phase 3 — Integrations

**Goal:** New first-class content kind. Google Workspace (vertical slice), then Todoist, AppleScript, iMessage.

### Schema

**`wecoded-marketplace/integrations/index.json`** *(new)* — parallel to skills/themes:
```json
{
  "integrations": [
    {
      "slug": "google-workspace",
      "displayName": "Google Workspace",
      "tagline": "Gmail, Calendar, Drive in-chat",
      "longDescription": "...",
      "kind": "mcp",
      "setup": { "type": "script", "path": "...", "requiresOAuth": true, "oauthProvider": "google" },
      "status": "available",
      "accentColor": "#..."
    }
  ]
}
```

### Sync

**`wecoded-marketplace/scripts/build-integrations.js`** *(new)* — reads `integrations/` source dir, emits `integrations/index.json`. Separate from sync.js.

### Renderer

**`window.claude.integrations`** IPC namespace *(new)* — `list()`, `install(slug)`, `uninstall(slug)`, `status(slug)`, `configure(slug, settings)`. Full 4-file parity required per PITFALLS.md:
1. `desktop/src/renderer/remote-shim.ts` (Android)
2. `desktop/src/preload.ts` (Desktop)
3. `desktop/src/main/ipc-handlers.ts` (Desktop handler)
4. `app/.../runtime/SessionService.kt` `handleBridgeMessage()` (Android handler)

**`desktop/src/main/integration-installer.ts`** *(new)* — handles install per integration. OAuth → browser (same device-code pattern as `marketplace-auth-context.tsx`). MCP integrations write to `~/.claude/mcp-servers.json`. AppleScript integrations verify macOS + write shell wrappers.

**`IntegrationCard.tsx`** *(new, in marketplace/)* — dedicated variant. Statuses: `not-installed` / `installing` / `needs-auth` / `connected` / `error`. Wider layout, logo-forward, status pill right-aligned.

**Integrations rail** in `MarketplaceScreen` — "Connect your stuff". Only IntegrationCards; never mixed with skill/theme cards.

### State persistence (hybrid model from design)

- **`~/.claude/integrations.json`** — lightweight manifest: `{ slug, installed, connected, lastSync }` per integration. Renderer reads once to paint all cards. Atomic rewrites.
- **`~/.claude/integrations/<slug>/credentials.json`** — OAuth tokens, API keys. Restricted permissions; macOS keychain where available.
- **`~/.claude/integrations/<slug>/settings.json`** — user prefs for that integration.

Cards render from the manifest alone — never open per-integration files.

### Android

- `SessionService.kt` `handleBridgeMessage()` — add cases for every `integrations:*` message type.
- OAuth on Android: reuse `MainActivity.onMarketplaceAuthUrlRequested` pattern (native browser + worker poll).

### Roster order

1. **Google Workspace** — ship first, validates the whole flow. CLI tool + OAuth.
2. **Todoist** — API-key flow only.
3. **AppleScript** — macOS-gated, shell wrappers.
4. **iMessage bridge** — macOS-gated, shell + db permissions.

### Acceptance

- Google Workspace installs via marketplace → OAuth in browser → returns → "Connected ✓" → usable from chat.
- Android parity verified.
- Uninstall removes MCP entry + revokes OAuth.

---

## Phase 4 — Curation tooling

**Goal:** Make rail editing ~1 minute so freshness sustains.

### `youcoded-core-admin/skills/admin/` *(new — first skill beyond announce/release)*

- `SKILL.md` — describes `/feature` commands:
  - `/feature hero <slug>` — add to hero rotation
  - `/feature rail <title> add|remove <slug>`
  - `/feature rail new <title> <description>`
  - `/feature rotate` — draws from `picks-pool.json`
- `scripts/edit-featured.js` — reads `wecoded-marketplace/featured.json`, applies edits, validates (slug exists in index, fields well-formed), writes, commits, pushes.
- `picks-pool.json` — slugs eligible for rotation.

**Commit/push mechanics:**
- Runs in the user's existing `wecoded-marketplace` clone (the skill locates it via `youcoded-core-admin` config, same pattern as `/release`). If the clone is absent, skill errors with a setup message — does not auto-clone.
- Direct push to `master`, not PR. Rationale: featured.json is low-risk, single-author, and the whole point is ~1 minute/week. Adding PR review defeats the purpose. CI on master will still validate; if CI fails, the skill surfaces the failure and suggests `/feature revert`.
- `/feature revert` — reverts the last featured.json commit and force-pushes. Guarded by "are you sure" confirmation.
- Secrets: relies on ambient `gh auth` / git credentials. The skill never handles tokens directly (same convention as `/release`).
- Sync.js does not re-run on featured.json changes — it's static data. The 24h client cache is the only propagation delay.

### Cache invalidation

- `window.claude.marketplace.invalidateCache()` IPC for force-refresh without waiting 24h (useful immediately after `/feature`).
- **Race:** if a user opens marketplace ~24h in and sync triggers a refresh mid-edit, they can see stale hero for up to one fetch cycle. Acceptable — `invalidateCache()` is the user-initiated escape hatch. Not worth a distributed cache-bust protocol.

### Acceptance

- `/feature hero my-skill` updates `featured.json`, commits, pushes to master.
- Invalid slug is rejected before commit (skill validates against `skills/index.json`).
- Next marketplace open (or `invalidateCache()`) reflects it.
- `/feature revert` undoes the last change.

---

## Cross-cutting concerns

### Protocol parity checklist

New IPC types to add to all 4 files: `integrations:list`, `integrations:install`, `integrations:uninstall`, `integrations:status`, `integrations:configure`, `marketplace:featured`, `marketplace:invalidate-cache`.

### Backwards compatibility

- Existing cache files remain readable (additive schema).
- Users on older app versions see current tabbed modal until update.
- `featured.json` absence or missing `hero`/`rails` → renderer falls back to evergreen-only rails.

### Feature flag + rollback

Phase 2 is a big UX shift. Gate it behind a boolean preference so it can be dark-launched:

- `preferences.ui.newMarketplace` (default: `false` through Phase 2 dev builds, flip to `true` for the release that ships).
- When `false`, App.tsx continues to render the current `Marketplace` modal on `marketplaceTab` truthy — no `activeView` state, no `MarketplaceScreen`.
- When `true`, `activeView` state is authoritative and `MarketplaceScreen`/`LibraryScreen` render.
- Both paths must compile and render for two release cycles so a quick patch can flip the flag back if the new UI breaks on a platform we didn't catch.
- After two cycles of stable new UI, remove the flag and delete the old modal code in a separate cleanup PR. Do NOT delete during Phase 2 itself.

### Android per-phase checklist

Each phase must verify Android parity before merge — the shared-React-UI architecture means regressions are invisible until you run the app on a device.

**Phase 1** (schema only):
- Sync APK from CI, open app, confirm marketplace loads without crash.
- Inspect `~/.claude-mobile/wecoded-marketplace-cache/` — new fields present in cached JSON.
- `LocalSkillProvider.fetchFeatured()` returns `hero`/`rails` through the WebSocket bridge.

**Phase 2** (full-screen UI):
- Hero + filter chips + one rail fit in the first viewport on a phone (< 400px width). If not: compact hero (smaller art, single slot) at < 600px.
- Rail scroll hits 60fps on test device (Pixel-class).
- Touch targets for chips ≥ 44px.
- Android back button honors the two-step (close detail → exit marketplace).
- `.layer-surface` backdrop-filter count on-screen ≤ 2 on Android WebView.

**Phase 3** (integrations):
- OAuth flow on Android uses `MainActivity.onMarketplaceAuthUrlRequested` — verify redirect lands.
- `integrations:*` message types handled in `SessionService.handleBridgeMessage()`.
- Credentials path (`~/.claude/integrations/<slug>/credentials.json`) resolves correctly on Android (app-private filesDir, not `$HOME`).

**Phase 4** (curation): admin skills run on Destin's desktop only — no Android verification needed.

### Observability

- `sync-report.json` written alongside `index.json` on every sync run: `{ timestamp, totalPlugins, extracted, failed: [{ slug, error }], truncated: [...], rateLimitRemaining }`. Committed alongside the index so any drift is visible in diffs.
- CI surfaces a failure count in the workflow summary; >10% extraction failure rate fails the build (sentinel for "something systemic broke").
- Client-side: if `featured.json` fetch returns 404 or malformed JSON, log through existing `reportError()` telemetry (same channel the marketplace context already uses).
- No user-visible error banners for background sync failures — they'd be noise. Failures surface via `sync-report.json` commits.

### Accessibility

- **Keyboard:** Tab order = hero slot → chips (arrow-key navigation within chip group) → rail cards (←/→ scrolls, Enter opens detail) → grid. Escape hierarchy per state-transition table.
- **ARIA:** Hero slots `role="region"` with descriptive label. Rails `role="list"`, cards `role="listitem"`. Chips `role="checkbox"` with `aria-checked`.
- **Reduced motion:** Hero rotation pauses, card hover scales disabled, when `prefers-reduced-motion: reduce`.
- **Touch:** Rail arrow-on-hover is desktop-only. On touch, arrows are always visible at rail edges (or rely on swipe — swipe is the primary on Android).
- **Screen reader:** `MarketplaceDetailOverlay` announces on open (focus moves in, aria-live polite for status changes).

### Testing priorities

- **Unit:** tag normalization (aliases), sync.js `mapEntry()` with new fields, `extract-components.js` for known plugin shapes, `mode` derivation in `MarketplaceScreen`.
- **Component (Playwright):** discovery-mode render, chip-to-search transition, detail overlay open/close, Esc handling.
- **Manual:** Android WebView parity after every renderer PR touching marketplace or library.

### Audit triggers

- After Phase 2 lands: `/audit ui` — overlay section needs a "full-screen destination route" entry.
- After Phase 3 lands: `/audit ipc` — verify 4-file parity for integration message types.

---

## Open questions — resolved

| # | Question | Decision |
|---|----------|----------|
| 1 | Rail ordering | `featured.json` order wins; evergreen auto-rails (Most installed, New this month) append bottom in fixed order |
| 2 | Where do users manage installed plugins? | **Separate "Your Library" top-level destination.** Not a chip, not a rail. |
| 3 | Rating display | Live fetch from Worker every 15min via existing `marketplace-stats-context`. Skeleton until load. |
| 4 | Theme previews | Current token-primary + PNG-secondary. No change. |
| 5 | Integration state persistence | Hybrid: manifest + per-integration dir. |
| 6 | Component extraction for remote plugins | GitHub Tree API, 1 call per plugin, names-only in V1. Cached by `sourceSha`. |

## Known corrections from earlier drafts

These flag issues in prior versions of this doc so future readers know what changed:

- **Unified marketplace is shipped** — earlier drafts framed backend work as net-new; it's already merged. This revision treats it as foundation.
- **`featured.json` has `{skills, themes}` only** — earlier drafts said it was "scaffolded" with `hero`/`rails`. It is not. Phase 1 adds those fields. No existing UI consumer reads `featured.json`, so the extension is backwards-safe.
- **Theme previews are token-primary + PNG-secondary** — earlier drafts speculated between them. Current reality is both; tokens always work, PNG is visual polish.
- **No line-number replace points** — an earlier revision cited exact line ranges in `Marketplace.tsx` (150–340, 365–478, etc.). Those were wrong (off by 60–170 lines) and would drift regardless. This revision uses function names and JSX-region anchors.
- **Component extraction is not yet implemented** — earlier phrasing ("extend sync.js line 170") implied an existing hook point. There isn't one. `extract-components.js` is net-new; `sync.js.mapEntry()` gets a new call.
- **`window.claude.integrations` does not yet exist** — not even as a stub. Phase 3 creates the namespace across all 4 parity files from scratch.
- **Plan line-numbers were wrong** — the audit that generated the earlier plan was done against an imagined state of `Marketplace.tsx`, not the actual file. An independent review caught this before implementation. Treat all future plan revisions the same way: verify line numbers against the file at write time, or skip them.
