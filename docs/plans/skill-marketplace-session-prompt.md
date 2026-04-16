# Skill Marketplace — Implementation Session Prompt

Copy everything below the line into a new Claude Code session.

---

Execute the skill marketplace implementation plan using subagent-driven development.

**Plan:** `~/youcoded/docs/plans/skill-marketplace-plan (04-05-2026).md`
**Design spec:** `~/youcoded/docs/specs/skill-marketplace-design (04-05-2026).md`
**Plan critique (all fixes already applied):** `~/youcoded/docs/plans/skill-marketplace-plan-critique (04-05-2026).md`

**Worktree already set up:**
- Path: `~/youcoded-core/.worktrees/feat-skill-marketplace`
- Branch: `feat/skill-marketplace`
- Desktop source: `~/youcoded-core/.worktrees/feat-skill-marketplace/desktop/src/`
- npm install already done, TypeScript compiles clean

**Android repo (not in worktree):** `~/youcoded/app/src/main/` — Tasks 9-10 modify this repo directly.

**Visual mockups** (for Tasks 7-8): `~/youcoded/.superpowers/brainstorm/49790-1775375392/content/marketplace-hybrid-v2.html`

## Execution order

Tasks 1 → 2 → 3 → 4 → 5 → then 6, 7, 8 can parallelize → 9 → 10 → 11 → 13.
Task 12 (GitHub registry scaffold) has NO code dependencies — run it in parallel with early tasks.

## Key implementation notes

- **Always edit source files** in the worktree (`~/youcoded-core/.worktrees/feat-skill-marketplace/desktop/src/`), never the Vite bundles in `~/youcoded/app/src/main/assets/web/`
- **IPC constants are duplicated by design** — Electron sandbox prevents imports in preload.ts. Update BOTH `shared/types.ts` and `preload.ts` when adding channels.
- **Android config path** must use `Bootstrap.getHomePath()`, NOT `Environment.getExternalStorageDirectory()`
- **QR code**: use `qrcode` npm package, not inline generation
- **Quick Chips reorder**: use up/down arrow buttons for V1, not HTML5 drag-and-drop (broken in Android WebView)
- **ChipConfig.skillId is optional** — chips like "Git Status" are just prompt shortcuts without a backing skill

## What to use

Use the `superpowers:subagent-driven-development` skill to dispatch one subagent per task with two-stage review (spec compliance then code quality). Read the full plan file first to extract all task text.
