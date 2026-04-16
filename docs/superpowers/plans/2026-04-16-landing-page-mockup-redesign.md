# Landing Page Mockup Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all 5 mockups in `youcoded/docs/index.html` `#demo` section render at a consistent 960×600 (16:10) shape with all content visible and no clipping.

**Architecture:** Pure CSS change in a single static HTML file. Replace the 2-column `.showcase-item` grid with a single-column flex layout so each mockup spans the full container width (max 960px). Swap fixed `height: 480px` on `.demo-app` and `.mock-frame` for `aspect-ratio: 16/10`. Increase chat `gap` from 2px to 10px. All five mockups share the same rules, so this is four small CSS edits plus a visual verification pass.

**Tech Stack:** HTML/CSS (static landing page at `youcoded/docs/index.html`, hosted on GitHub Pages). No build step, no tests, no JS runtime changes.

**Related:** Design spec at `youcoded/docs/superpowers/specs/2026-04-16-landing-page-mockup-redesign.md`.

---

### Task 0: Create isolated worktree

**Files:** none yet

Per workspace rules (`youcoded-dev/CLAUDE.md`), any non-trivial work must happen in a separate git worktree so concurrent Claude sessions don't collide on the main repo.

- [ ] **Step 1: From `youcoded-dev/youcoded`, create a worktree branched off master**

```bash
cd /c/Users/desti/youcoded-dev/youcoded
git fetch origin
git worktree add ../../worktrees/landing-mockup-redesign -b landing-mockup-redesign origin/master
```

- [ ] **Step 2: Verify the worktree was created and switch into it**

```bash
cd /c/Users/desti/worktrees/landing-mockup-redesign
git status
```

Expected: clean working tree on branch `landing-mockup-redesign`, `docs/index.html` present.

- [ ] **Step 3: Start a local preview server for visual verification**

```bash
cd docs
python -m http.server 8765 &
```

Open `http://localhost:8765/` in a browser and navigate to the `#demo` section. Keep this tab open — each subsequent task's verification step means reloading it.

---

### Task 1: Stack layout — replace 2-column grid with single-column flex

**Files:**
- Modify: `docs/index.html` lines 1601–1615 (`.showcase-item` rule block)

The current 2-column grid forces the mockup into half-container width. We want each mockup to span the full container so a 16:10 frame can actually look like a desktop window.

- [ ] **Step 1: Apply the CSS change**

Use Edit with:

`old_string`:
```
  .showcase-item {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 32px;
    align-items: center;
  }

  .showcase-item.reverse { direction: rtl; }
  .showcase-item.reverse > * { direction: ltr; }
  /* Grid items default to min-width: auto (= min-content) which lets long
     mono-font bubble text or tool-detail strings push the grid track wider
     than 1fr. Pinning min-width:0 forces the cell to honor the 1fr share,
     and the .demo-app/.mock-frame inside then fill their cell without
     growing when mid-animation content appears. */
  .showcase-item > * { min-width: 0; }
```

`new_string`:
```
  /* Stacked layout: text description sits above a full-width mockup, so
     each mockup can render at a 960x600 desktop-shape without being
     squeezed into a half-width grid cell. */
  .showcase-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
  }

  /* Text block reads best at ~680px. The mockup below can still stretch
     to the container's 960px. */
  .showcase-item > .showcase-text {
    width: 100%;
    max-width: 680px;
    align-self: center;
  }

  /* Prevents long mono-font tool-detail strings from forcing a flex item
     above its max-width allocation. */
  .showcase-item > * { min-width: 0; }
```

- [ ] **Step 2: Reload the browser preview and eyeball the demo section**

Expected at this point: mockups and their text are stacked vertically but the mockups are still the wrong shape (tall/narrow, 480px height). That's fine — the frame-size change happens in Task 2.

- [ ] **Step 3: Do NOT commit yet** — changes will be bundled into one commit after Task 4.

---

### Task 2: Resize frames — swap fixed height for aspect-ratio, bump max-width

**Files:**
- Modify: `docs/index.html` lines 830–844 (`.demo-app`)
- Modify: `docs/index.html` lines 867–882 (`.mock-frame`)

This is the core fix. `aspect-ratio` keeps the shape constant at every viewport width; `max-width: 960px` lets the frame use the whole container.

- [ ] **Step 1: Update `.demo-app`**

Use Edit with:

`old_string`:
```
  /* --- Animated demo container --- */
  .demo-app {
    border-radius: 16px;
    overflow: hidden;
    border: 1px solid var(--border);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px var(--accent-glow);
    width: 100%;
    max-width: 680px;
    margin: 0 auto;
    position: relative;
    /* Fixed height + flex column so the frame never grows as animated
       bubbles/tool cards load in. Internal .demo-chat gets flex:1 and
       overflow:hidden below, which caps the content to this box. */
    height: 480px;
    display: flex;
    flex-direction: column;
```

`new_string`:
```
  /* --- Animated demo container --- */
  .demo-app {
    border-radius: 16px;
    overflow: hidden;
    border: 1px solid var(--border);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px var(--accent-glow);
    width: 100%;
    max-width: 960px;
    margin: 0 auto;
    position: relative;
    /* 16:10 aspect-ratio (replaces fixed 480px height). Keeps every mockup
       the same desktop-window shape at every viewport width, instead of
       drifting between tall-narrow and widescreen as the container resizes.
       Internal .demo-chat still gets flex:1 + overflow:hidden below to
       cap animated content to this box. */
    aspect-ratio: 16 / 10;
    display: flex;
    flex-direction: column;
```

- [ ] **Step 2: Update `.mock-frame`**

Use Edit with:

`old_string`:
```
  /* --- Static mockup container --- */
  .mock-frame {
    border-radius: 16px;
    overflow: hidden;
    border: 1px solid var(--border);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px var(--accent-glow);
    position: relative;
    /* Match .demo-app so every showcase mockup is the same rectangle.
       Internal .mock-chat flexes to fill the remaining space between the
       header and the input/status bars, and clips any overflow. */
    width: 100%;
    max-width: 680px;
    margin: 0 auto;
    height: 480px;
    display: flex;
    flex-direction: column;
  }
```

`new_string`:
```
  /* --- Static mockup container --- */
  .mock-frame {
    border-radius: 16px;
    overflow: hidden;
    border: 1px solid var(--border);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px var(--accent-glow);
    position: relative;
    /* Match .demo-app: same 960px max-width + 16:10 aspect-ratio so every
       mockup renders as the same desktop-window shape. */
    width: 100%;
    max-width: 960px;
    margin: 0 auto;
    aspect-ratio: 16 / 10;
    display: flex;
    flex-direction: column;
  }
```

- [ ] **Step 3: Reload the browser preview and check the demo section**

Expected: all 5 mockups are now the same width (full container, capped at 960px) and the same shape (16:10 widescreen). Desktop, tablet, and mobile viewports should all show the same aspect ratio.

Quick viewport sanity check: resize the browser to ~1280px, ~900px, ~600px, ~400px. Mockup should stay visibly widescreen (16:10) at each size, just scaled.

- [ ] **Step 4: Do NOT commit yet.**

---

### Task 3: Breathe the bubbles — increase chat gap

**Files:**
- Modify: `docs/index.html` line 1123 inside the `.demo-chat, .mock-chat` rule

`gap: 2px` was too tight for left/right alternating bubbles; they looked stuck together. Real chat UIs use 8–12px.

- [ ] **Step 1: Apply the CSS change**

Use Edit with:

`old_string`:
```
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    padding: 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    position: relative;
```

`new_string`:
```
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    padding: 16px 16px;
    display: flex;
    flex-direction: column;
    /* 10px between bubbles gives the left/right align-self alternation
       enough room to read as distinct turns. 2px was too cramped. */
    gap: 10px;
    position: relative;
```

- [ ] **Step 2: Reload the browser preview**

Expected: bubbles in the Journaling and Sync mockups now have visible breathing room between turns. The tight-together look is gone.

- [ ] **Step 3: Do NOT commit yet.**

---

### Task 4: Delete dead code — mobile grid override

**Files:**
- Modify: `docs/index.html` lines 1721–1725 (mobile `@media` block in showcase section)

The `@media (max-width: 768px) { .showcase-item, .showcase-item.reverse { grid-template-columns: 1fr; direction: ltr; } }` rule is now dead code — Task 1 made the layout single-column at every viewport width, and the `.reverse` variant was removed entirely. Leaving it in creates confusion for future readers.

- [ ] **Step 1: Remove only the `.showcase-item` rule from the mobile media query**

Use Edit with:

`old_string`:
```
  @media (max-width: 768px) {
    .showcase-item, .showcase-item.reverse {
      grid-template-columns: 1fr;
      direction: ltr;
    }
    .mock-game-panel { width: 180px; }
    .mock-games-btn-wrap { display: none; }
  }
```

`new_string`:
```
  @media (max-width: 768px) {
    /* .showcase-item mobile override removed: the layout is now single-column
       at every viewport width, so no breakpoint reshaping is needed. */
    .mock-game-panel { width: 180px; }
    .mock-games-btn-wrap { display: none; }
  }
```

**Note:** The two remaining rules (`.mock-game-panel` and `.mock-games-btn-wrap`) are NOT dead code — they tune the Connect 4 mockup specifically for small screens. Keep them.

- [ ] **Step 2: Reload preview, confirm demo section still renders correctly at both desktop (≥769px) and mobile (<769px) widths.**

- [ ] **Step 3: Do NOT commit yet.**

---

### Task 5: Visual verification — all 5 mockups at target size

**Files:** no edits (read-only pass)

This is where we confirm nothing clips. Walk through each mockup with the preview at desktop width (~1280px), then again at narrow mobile width (~400px).

- [ ] **Step 1: Desktop pass — for each of the 5 mockups, verify:**

At ~1280px browser width, each mockup renders at ~960×600:

1. **Theme Builder** (animated, first): let the animation run through. The "midnight" → "golden-sunbreak" transition should play; user bubble, assistant bubble, and both sequenced tool cards must all be visible in the final state.
2. **WeCoded Marketplace** (second): filter bar, featured hero block, and both "Destin's picks" / "New this week" rails must be visible. Card rails may scroll horizontally — that's intentional, not a bug.
3. **Journaling** (third): all 4 bubbles (user, assistant, user, assistant-with-3-tool-cards) must fit vertically. No scroll bar, no visible clipping at the bottom.
4. **Cross-Device Sync** (fourth): both tool cards plus the 8-line info block ("All caught up" through "Anything you start here…") must be fully visible.
5. **Connect 4** (fifth): game board + right-side chat panel must both be visible. Board should not overflow horizontally.

- [ ] **Step 2: Mobile pass — resize browser to ~400px width and repeat the walk**

At ~400px, each mockup renders at ~400×250 (aspect-ratio preserved). Content inside will be small but should not clip.

- [ ] **Step 3: Record outcomes**

For each mockup, note PASS or describe what clipped. If all 5 pass on both desktop and mobile, skip Task 6. If any mockup clips, proceed to the relevant sub-task in Task 6.

---

### Task 6: Per-mockup overflow fixes (conditional)

**Files:**
- Modify: `docs/index.html` (targeted per-mockup rules)

Only apply these if Task 5 flagged a specific mockup. Each sub-task is scoped to one mockup so the global shared CSS stays clean.

The fixes below are the most likely candidates based on content density. Apply *only* what the verification pass shows is needed.

- [ ] **Step 6a (only if Sync overflows): tighten Sync info block**

The Sync mockup's 8-line text block (`All caught up` through `Anything you start here…`) has the tightest fit. If it clips at the bottom:

Locate the inline `<div style="margin-top: 10px;">…</div>` near index.html line 2681 (inside the `.mock-halftone-dim` mockup's assistant bubble) and add a tighter font size on that element. Use Edit with:

`old_string`:
```
                <div style="margin-top: 10px;"><strong>All caught up.</strong>
```

`new_string`:
```
                <div style="margin-top: 10px; font-size: 12px; line-height: 1.45;"><strong>All caught up.</strong>
```

Reload and verify the info block now fits entirely inside the frame.

- [ ] **Step 6b (only if Connect 4 overflows): adjust game panel proportion**

At 960px frame width, the existing 220px chat panel is now only 23% of the frame instead of ~45%. If the board looks too large or the chat panel too cramped:

Use Edit on the existing `.mock-game-panel` rule (around index.html line 1654):

`old_string`:
```
  .mock-game-panel {
    width: 220px;
    border-left: 1px solid var(--m-edge);
```

`new_string`:
```
  .mock-game-panel {
    /* Widened for the new 960px frame so the chat panel stays readable
       instead of shrinking to a sliver next to the bigger board. */
    width: 320px;
    border-left: 1px solid var(--m-edge);
```

Reload and verify board and panel both read well.

- [ ] **Step 6c (only if Journaling overflows): tighten tool card font**

If the 3 stacked tool cards in Journaling's final assistant bubble push past the frame:

Locate the Journaling mockup's `.mock-frame.mock-midnight` (the second mock-midnight in the file, around index.html line 2622) and add a scoped rule. Add this CSS block immediately BEFORE the `.mock-halftone-dim` rule (around line 904):

Use Edit with:

`old_string`:
```
  .mock-midnight .mock-send { background: var(--m-accent); box-shadow: none; }

  .mock-halftone-dim {
```

`new_string`:
```
  .mock-midnight .mock-send { background: var(--m-accent); box-shadow: none; }

  /* Journaling mockup packs 4 bubbles + 3 tool cards — tighter tool-card
     font keeps everything inside the 16:10 frame. Scoped to the second
     .mock-midnight instance (Journaling) via a nth-of-type selector on
     .mock-frame would be overkill; instead we tighten the tool-card
     text globally — it's subtle and reads fine in other mockups too. */
  .mock-midnight .mock-tool-card-header { padding: 5px 10px; font-size: 11px; }

  .mock-halftone-dim {
```

Reload and verify.

- [ ] **Step 6d (catch-all): re-run Task 5 verification**

After any 6a/6b/6c edits, redo the full 5-mockup walk at desktop + mobile widths to confirm the fix didn't introduce a new clip somewhere else.

---

### Task 7: Commit, push, merge, clean up

**Files:** none (git ops only)

Per `youcoded-dev/CLAUDE.md`: "'Merge' means merge AND push." And: clean up worktrees after merging.

- [ ] **Step 1: From the worktree, stage only the mockup changes**

```bash
cd /c/Users/desti/worktrees/landing-mockup-redesign
git status
git add docs/index.html
```

Expected: `git status` shows only `docs/index.html` modified. No other files touched.

- [ ] **Step 2: Commit, following the repo's "docs:" prefix convention**

```bash
git commit -m "$(cat <<'EOF'
docs: redesign demo mockups — 960x600 16:10, stacked layout

Fixes inconsistent mockup aspect ratios and content clipping in the
landing page #demo section. All 5 mockups now render at the same
desktop-shape (16:10) at every viewport width, with every bubble and
tool card visible inside the frame.

- .showcase-item: 2-col grid -> flex column so mockups span full container
- .demo-app / .mock-frame: max-width 680 -> 960, height:480px -> aspect-ratio:16/10
- .demo-chat / .mock-chat: gap 2px -> 10px for breathable bubble spacing
- removed dead .showcase-item.reverse + its mobile grid override

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Push the branch and confirm upstream**

```bash
git push -u origin landing-mockup-redesign
```

Expected: branch pushed to `origin/landing-mockup-redesign`.

- [ ] **Step 4: Merge into master with a no-ff merge and push**

```bash
cd /c/Users/desti/youcoded-dev/youcoded
git fetch origin
git checkout master
git pull origin master
git merge --no-ff landing-mockup-redesign -m "Merge branch 'landing-mockup-redesign'"
git push origin master
```

Expected: master now contains the merge commit. `git log --oneline -3` shows the merge commit + the redesign commit.

- [ ] **Step 5: Verify commit is on master before removing the worktree**

```bash
git branch --contains $(git rev-parse landing-mockup-redesign)
```

Expected output: listing includes `master`. If it doesn't, STOP — do not remove the worktree until the merge has pushed successfully.

- [ ] **Step 6: Clean up worktree and branch**

```bash
git worktree remove /c/Users/desti/worktrees/landing-mockup-redesign
git branch -D landing-mockup-redesign
git push origin --delete landing-mockup-redesign
```

Expected: worktree directory gone, local branch deleted, remote branch deleted.

- [ ] **Step 7: Confirm GitHub Pages picks up the change**

Wait ~1–2 minutes, then reload `https://itsdestin.github.io/youcoded/` in a fresh browser tab (or hard-refresh with Ctrl+F5). Scroll to the `#demo` section and verify all 5 mockups are now at the consistent 16:10 shape.

If the live page still shows the old layout, check the Pages build status at `https://github.com/itsdestin/youcoded/actions` — look for the most recent `pages-build-deployment` workflow run.

---

## Notes for the implementing engineer

- **This is a static HTML/CSS landing page**, not a React app. There's no build step, no test runner, no hot-reload dev server. Visual verification in a browser *is* the test. A local Python http server is recommended over `file://` because some features (like `aspect-ratio` CSS and relative asset paths) behave slightly differently under each.
- **Don't touch anything outside `#demo`.** The landing page has other sections (hero, marketplace, FAQ, download) that share none of the mockup CSS. This plan is narrowly scoped.
- **Don't "improve" the bubble padding, radius, colors, or fonts.** They're deliberately tuned to match the real YouCoded app's rendering — that parity is a feature. The only spacing change in this plan is the chat `gap`.
- **`aspect-ratio` works in all modern browsers since 2021.** No fallback is needed.
- **Comments in CSS edits follow the repo convention** (see `youcoded-dev/CLAUDE.md`): every non-trivial change gets a WHY comment because the page owner is a non-developer and relies on inline comments to understand what changed.
