# Skill Marketplace Plan — Critique (04-05-2026)

> Critique of `skill-marketplace-plan (04-05-2026).md`

---

## Critical Issues

**1. Hidden prerequisite: marketplace registry repo doesn't exist**
`REGISTRY_BASE` points to `anthropics/destincode-marketplace` which isn't a real repo. Every `listMarketplace`, `fetchIndex`, `fetchStats`, `getCuratedDefaults` call silently returns `[]`. The plan has no task to create this repo or even flag it as a prerequisite. Marketplace UX will be a ghost town until that repo exists.

**2. Android `onCreate` deep link won't fire on re-launch (Task 10)**
The plan stores `pendingImportUrl` and sends it via bridge once connected. But for a `singleTask` or `singleTop` activity, tapping a link when the app is *already running* calls `onNewIntent`, not `onCreate`. The pending import is silently dropped. `onNewIntent` must be overridden, or the pending URL must be reprocessed from the override.

**3. `Environment.getExternalStorageDirectory()` is wrong for Android config path (Task 9)**
Per `CLAUDE.md`, config lives under the relocated Termux prefix at `context.filesDir.parentFile` — not external storage. Using `getExternalStorageDirectory()` would put `destincode-skills.json` in the wrong place on Android, breaking config persistence entirely. The plan needs to explicitly say: use `Bootstrap.getHomePath()`.

---

## Moderate Issues

**4. Silent config corruption on bad JSON (Task 2)**
If `destincode-skills.json` is corrupted, `SkillConfigStore.load()` silently calls `migrate([])`, wiping all user favorites and chips. Should log the error and throw, not auto-reset.

**5. Non-atomic config writes (Task 2)**
`fs.writeFileSync` is not atomic. A crash mid-write corrupts the file and triggers the silent reset above. Should write to `destincode-skills.json.tmp` then rename.

**6. `search()` only searches marketplace, not installed skills (Task 3)**
`search(query)` calls `listMarketplace({ query })`, which fetches from GitHub. If the network is down or the registry doesn't exist yet, searching your own installed skills returns nothing. The installed-skill search should run locally first, merged with marketplace results.

**7. No input validation on `importFromLink` (Task 3)**
`importFromLink` calls `createPromptSkill` directly with type-cast fields from the decoded URL, with no sanitization. A crafted link with a very long prompt or malformed category bypasses all validation. At minimum: validate `category` is one of the known enum values, clamp string lengths.

**8. IPC constants duplicated in `shared/types.ts` AND `preload.ts` (Tasks 1 & 4)**
The plan defines the same `skills:*` constants in both files. If one is updated and not the other, channels break silently. The plan should use the constants from `shared/types.ts` in `preload.ts` rather than redeclaring them.

**9. `_git-status`, `_review-pr` chip skillIds don't exist in installed skills (Tasks 2 & 6)**
`DEFAULT_CHIPS` references `skillId: '_git-status'`, `'_review-pr'`, etc. These aren't real installed skills — `drawerSkills` is `installed.filter(s => ids.has(s.id))`, so they'd never appear in the drawer. The plan doesn't explain how these virtual chips work. Either chips need their own data structure separate from skill IDs, or these need to be real skills.

---

## Minor Issues

**10. Tasks 7 & 8 are under-specified compared to Tasks 1-6**
Tasks 1-6 provide complete, production-quality TypeScript. Tasks 7-8 say "create the file with: search input, filter pill row..." with no code. For agentic execution, this asymmetry means Tasks 7-8 will produce speculative output that may not match the design spec. Either provide the code or explicitly note these tasks require manual authoring with the design spec.

**11. ShareSheet's QR code recommendation is misleading (Task 8)**
"QR code using inline canvas rendering (no external library needed)" — this is not accurate. Correct QR code generation requires the Reed-Solomon error correction algorithm. Should specify a library (e.g., `qrcode` on npm) rather than implying it's trivial.

**12. Drag-to-reorder in Quick Chips tab is unspecified (Task 8)**
HTML5 drag-and-drop doesn't work reliably in an Android WebView. The plan mentions it without picking an implementation. Should call out that `@dnd-kit/sortable` or a touch-based solution is needed, or defer reordering to V2.

**13. `(entry as any)._installed = true` in `listMarketplace` (Task 3)**
This mutates the returned object and bypasses TypeScript. Should either include `_installed?: boolean` in the interface or return a discriminated type.

**14. `drawerSkills` doesn't order favorites before defaults (Task 5)**
`favorites ∪ curatedDefaults` produces an unordered union filtered from `installed`. Favorited skills don't float to the top of the drawer — they're mixed in wherever the scanner finds them.

**15. No spec update task**
Per CLAUDE.md spec rules, after implementation the design spec at `docs/specs/skill-marketplace-design (04-05-2026).md` should be reviewed. The plan has no task or reminder for this.

---

## Strengths Worth Noting

- The `SkillProvider` interface abstraction is correctly designed — V2 will be a swap, not a rewrite.
- Per-task atomic commits are well-scoped.
- Cache TTL + stale fallback pattern in `fetchIndex`/`fetchStats` is solid.
- Migration path from hardcoded skills to config-backed state is handled cleanly.
- TypeScript in Tasks 1-6 is production-quality and complete enough for an agentic worker to execute without improvisation.

---

## Summary

Fix items 1-3 before execution (correctness blockers). Items 4-9 are worth patching in the plan now rather than discovering during implementation. Items 10-15 are quality issues that could wait for review feedback.
