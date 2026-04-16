# Marketplace Redesign

**Status:** Design — not yet implemented
**Date:** 2026-04-14
**Owner:** Destin

## Goal

Transform the marketplace from a settings-panel-feeling catalog into a full-screen, browseable destination. Fix the three core problems:

1. **Vibe** — feels clerical, not inviting. Like a settings menu, not a store.
2. **Discovery** — hard to find things; no sense of "what's here" at a glance.
3. **Navigability** — tab system (Skills / Themes / etc.) forces users to know what they're looking for.

## Design

### Full-screen route (not a drawer)

Marketplace becomes a top-level view of the app, alongside chat and terminal — not a panel inside settings. Wallpaper shows through, glassmorphism surfaces float on top. Same visual family as the chat view, not the settings panel.

**Entry point:** stays in the command drawer (Cmd-K → Marketplace). No header button — header is already crowded and a persistent entry isn't needed if the drawer surfaces it.

**Marketplace is purely acquisitional** — browse, discover, install. Managing what you've already installed (favorites, updates, uninstall) lives in a separate **Your Library** top-level destination, not in the marketplace. Clean split: Marketplace = discovery, Library = management. Library gets its own command-drawer entry.

**Exit / back model (modal-style):**
- Marketplace is one flat "place"
- Plugin detail opens as an overlay *within* marketplace (not a new route)
- Esc closes detail overlay → second Esc exits marketplace back to chat
- Android back button maps to the same two-step

### Layout, top to bottom

1. **Hero** — Destin's Featured (rotating 3–5 slots, big art). Low glass opacity so wallpaper reads through strongly. Sets the vibe on entry.
2. **Sticky filter bar** — multi-select chips (not tabs):
   - Type: Skills / Themes / Integrations / Plugins
   - Vibe: For school / For work / Creative / Health / Fun / Utilities / Dev
   - Meta: New / Popular / Destin's picks
   - Free-text search + Cmd-K focus
   - Heavier glass (header-bar-like) so it reads as chrome
3. **Curated rails** (horizontal, Netflix-style):
   - Evergreen (auto-filled): Most installed, New this month
   - Curated (you rotate): Destin's picks, themed rails ("Perfect for students", "If you journal")
   - Rail containers are transparent; only cards are solid. Vertical rhythm: solid cards, airy gaps.
   - Desktop: arrow buttons appear on hover + "See all →" link expands into filtered grid
4. **Integrations rail** — dedicated rail with purpose-built cards (wider, logo-forward, status pill on the right). Integrations never mix into skill/theme grids.
5. **"Explore everything" grid** — full catalog at the bottom, same filter chips apply. Denser glass (more opaque) — signals "settle in and browse."

**Visual logic:** vertical opacity gradient. Airy/transparent at top (browse mode) → solid/opaque at bottom (search mode). Guides users from discovery to catalog naturally.

### Soft tags (replaces rigid categories)

Each plugin gets multi-valued `tags`: `["school", "writing", "focus"]`. Tags drive filter chips, rail membership, search relevance. A plugin appears in multiple rails without forcing an either/or category choice.

**Developer plugins filter in/out contextually.** No walled-off "Developers" zone. `/commit` never shows in "School" rail; "journal" never shows in dev rails. Driven by the tags + rail queries, not a hard audience split.

**Tag governance:**
- Fixed enum in `wecoded-marketplace/` — CI rejects unknown tags on submission
- Aliases map synonyms (`students → school`, `productive → productivity`) — accepts lenient input, normalizes at render
- Adding a tag to the enum is a PR to Destin

### Curation model

**Hybrid: evergreen auto + curated manual**

- **Evergreen rails** — data-driven, zero curation ("Most installed", "New this month"). Auto-populate from install counts + recent-commit dates.
- **Curated rails** — 1–2 slots max, you rotate ("Destin's picks", seasonal rails). Edit via a small `/feature` admin skill in `youcoded-core-admin` that makes it conversational: `/feature add <slug> to picks`.
- Budget: ~1 minute/week. Low enough to actually sustain.

`featured.json` in `wecoded-marketplace/` is the single source of truth:
```json
{
  "hero": [{ "slug": "...", "blurb": "...", "accentColor": "..." }],
  "rails": [
    { "title": "Destin's picks", "slugs": [...], "description": "..." }
  ]
}
```
Apps cache for 24h. Edit JSON → push → next cache refresh shows it.

### Schema changes

Coordinated migration — one schema bump, not three PRs. New fields on plugin entries:

```json
{
  "tagline": "string, ≤60 chars, shown on card",
  "longDescription": "markdown, shown in detail overlay",
  "tags": ["array of enum values"],
  "audience": "general | developer",
  "lifeArea": ["school", "work", "creative", ...]
}
```

**Backfill strategy:** Destin + script (option A from discussion).
- `scripts/generate-descriptions.js` reads `SKILL.md` / `plugin.json`, drafts summaries via Claude
- Destin reviews and commits for ~15 core plugins
- Community plugins: fields are optional, contributors add if they want

### Integrations — new content type

Separate schema (lives alongside skills/themes in the marketplace):

```json
{
  "slug": "google-workspace",
  "kind": "mcp | cli-tool | applescript",
  "setup": { "type": "script", "path": "...", "requiresOAuth": true },
  "status": "available | coming-soon"
}
```

Install flow: guided setup per integration (OAuth redirect for GWS, API key prompt for Todoist, macOS-only gate for AppleScript).

**Initial roster:** Google Workspace, Todoist, AppleScript (Notes/Reminders), iMessage bridge.

**Card shape:** dedicated variant (wider, logo-forward, status-right). Lives only in the Integrations rail; never mixed into skill/theme grids.

### Card & detail polish

**Card:**
- Theme-tinted gradient border on hover, 200ms scale 1.02
- Status dot for "new" / "updated this week"
- Install count + rating on the card itself

**Detail overlay:**
- Hero banner tinted with plugin accent color
- Install count + star rating strip
- `longDescription` markdown (What it does / Why you'd use it / Example prompts)
- Example prompts as clickable chips that prefill chat

## Known risks

Captured from the design conversation — flag these during implementation.

1. **Curation becomes a job.** Entire UX is premised on freshness. Mitigated by evergreen auto-rails + `/feature` admin skill keeping manual load near zero. If this drifts, the marketplace will feel staler than the old tab system.
2. **Horizontal scroll on desktop mouse.** Shift-scroll is non-obvious. Mitigated by hover arrow buttons + "See all" escape hatch into grid.
3. **"Where's my installed stuff?"** Tabs currently double as "my library." Needs an explicit `Installed` filter chip or library entry in the drawer.
4. **Filter chips × rails interaction.** Chips collapse rails and jump to filtered grid (search mode). Rails are for discovery mode. Two distinct patterns — don't combine.
5. **Detail pages are the weak link.** Gorgeous landing + plain detail page = vibe collapse. Detail redesign is as much work as landing, don't under-scope.
6. **Search has to be really good.** Bigger surface means higher cost of finding specific things. Fuzzy, searches descriptions not just titles, keyboard-first.
7. **Android vertical budget.** Hero + chips + rail headline can eat the full first viewport on phone. Compact hero on mobile; rail must start within first screen.
8. **`backdrop-filter` layering.** Wallpaper + glass + many cards + rails = lots of composite layers. Keep glass shallow — wallpaper at bottom, surfaces composite directly. Don't stack backdrop-filter 5 deep.

## Open questions (resolved)

| # | Question | Decision |
|---|----------|----------|
| 1 | Entry point | Command drawer only; no header button |
| 2 | Back navigation | Modal-style; detail is overlay within marketplace; Esc closes detail → Esc exits |
| 3 | Rail curation cadence | Hybrid: evergreen auto + 1–2 curated rails via `/feature` admin skill |
| 4 | Integration card shape | Dedicated wider variant in own rail; never mixed into skill/theme grids |
| 5 | Schema backfill | Destin + generation script; core set manually reviewed; community optional |
| 6 | Tag governance | Fixed enum + CI enforcement + alias map for synonyms |
| 7 | Rail ordering | `featured.json` order wins; evergreen auto-rails append at bottom in fixed order |
| 8 | Where do users see installed plugins? | **"Your Library" is its own top-level destination** — not a marketplace chip or rail. Three destinations: Chat, Marketplace (acquisitional), Your Library (management). |
| 9 | Ratings/install counts on cards | Live fetch from Worker every 15min via existing `marketplace-stats-context`; cards render skeleton until stats load |
| 10 | Theme previews in cards | Match current behavior (pre-rendered thumbnails). Verify in `ThemesTab` before Phase 2 build. |
| 11 | Integration state file | Hybrid: `~/.claude/integrations.json` (lightweight manifest — slug/installed/connected/lastSync) + `~/.claude/integrations/<slug>/` dir for credentials + per-integration settings |

## Phasing (rough)

Not a commitment, just sequencing to think about when we write the implementation plan.

**Phase 1 — Foundation (renderer + schema)**
- Full-screen marketplace route with wallpaper + glass
- New schema fields in `wecoded-marketplace/` with backfill script
- Tag enum + CI validation
- `featured.json` file + cache pipeline

**Phase 2 — Layout**
- Hero + sticky filter bar + rails + grid
- Modal-style detail overlay
- Card polish (hover, status dots, ratings on card)

**Phase 3 — Integrations**
- Integration schema + dedicated card variant
- Install flows for initial roster (Google Workspace first, it's the most valuable)

**Phase 4 — Admin tooling**
- `/feature` skill in youcoded-core-admin for rail curation

## Next step

Write implementation plan that translates this into concrete file changes across `youcoded/desktop/src/renderer/`, `wecoded-marketplace/`, and `youcoded-core-admin/`. Should include which existing components get replaced/refactored (current marketplace UI, SettingsPanel skill section) and whether the full-screen route needs new routing infrastructure.
