# Header Overflow Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the session switcher from overlapping the settings gear and announcement at narrow widths, and replace viewport-based breakpoints (640px) with space-aware layout so session pills and the chat/terminal toggle adapt to actual available room.

**Architecture:** Five coordinated changes in `destincode/desktop/src/renderer/`. (1) Relocate the announcement from HeaderBar into StatusBar as a new widget. (2) Fix the flex asymmetry in HeaderBar that lets the left column collapse below its content. (3) Move the chat/terminal toggle to the LEFT cluster on Windows/Linux (where OS window controls sit on the right) and keep it on the RIGHT cluster on macOS (where traffic lights sit on the left). (4) Replace `useIsCompact` in SessionStrip with a `ResizeObserver`-driven packer that chooses how many pills to expand based on measured widths. (5) Replace the toggle's `hidden sm:inline-block` label with a JS-controlled flag driven by the same ResizeObserver signal. The session-packing logic is extracted as a pure function with unit tests; the rest is manually verified against the dev build.

**Tech Stack:** React 18, TypeScript, Tailwind, Vitest, Electron (renderer). ResizeObserver is already used elsewhere in this codebase.

---

## File Structure

**New files:**
- `destincode/desktop/src/renderer/components/header/pack-sessions.ts` — pure packing function (takes measured pill widths + budget → returns which pills expand vs. collapse vs. overflow to dropdown)
- `destincode/desktop/tests/pack-sessions.test.ts` — vitest unit tests for the packer

**Modified files:**
- `destincode/desktop/src/renderer/components/StatusBar.tsx` — add `announcement` widget (new "Updates" category, `defaultVisible: true`), accept `announcement` prop
- `destincode/desktop/src/renderer/components/HeaderBar.tsx` — drop announcement span + prop; drop `min-w-0` from left column; move chat/terminal toggle into the left cluster on Windows/Linux (keep right on macOS); add ResizeObserver-based `showToggleLabels` state; re-run `measureEndpoints()` when label visibility or placement flips
- `destincode/desktop/src/renderer/components/SessionStrip.tsx` — remove `NARROW_BREAKPOINT` + `useIsCompact`, add ResizeObserver on `pillBarRef`, call `packSessions()` with measured pill widths
- `destincode/desktop/src/renderer/App.tsx` — pass `announcement` into `StatusBar`, drop from `HeaderBar` call site

**Docs to update after green build:**
- `destincode/desktop/docs/shared-ui-architecture.md` — note that the header is space-aware (no viewport breakpoint), announcement lives in StatusBar
- `docs/PITFALLS.md` (in workspace root) — add an entry about left/right flex symmetry in header

---

## Pre-flight

- [ ] **Step 0.1: Create worktree**

```bash
cd /c/Users/desti/destinclaude-dev/destincode
git fetch origin
git worktree add -b fix/header-overflow ../../destincode-header-overflow origin/master
cd ../../destincode-header-overflow/desktop
npm ci
```

Expected: clean worktree with deps installed.

- [ ] **Step 0.2: Confirm baseline tests pass**

Run: `cd destincode-header-overflow/desktop && npx vitest run`
Expected: all existing tests pass. Note the count for later regression check.

---

## Task 1: Extract session-packing as a pure function

**Files:**
- Create: `destincode/desktop/src/renderer/components/header/pack-sessions.ts`
- Create: `destincode/desktop/tests/pack-sessions.test.ts`

Packing algorithm:
1. Active session always visible AND name-expanded.
2. Remaining budget = total budget − active pill expanded width − gap × (N−1) − dropdown-trigger width.
3. Walk the rest of the sessions in order; for each, try `collapsed` (dot-only, ~20px) first; if it fits in remaining budget, add to visible; otherwise stop and push into overflow.
4. If all non-active fit collapsed, second pass: try to expand each to full name if budget allows (in order). Call this `allExpanded` mode.
5. Return `{ expanded: Set<id>, collapsed: id[], overflow: id[] }`.

**Inputs** (from SessionStrip via measurement):
```ts
interface PackInput {
  sessions: { id: string; expandedWidth: number; collapsedWidth: number }[];
  activeId: string | null;
  budget: number;           // px available inside the pill strip
  gap: number;              // px between pills
  triggerWidth: number;     // px reserved for the ▾ dropdown button
}

interface PackResult {
  expanded: Set<string>;    // pills shown with name
  collapsed: string[];      // pills shown as dot only (in original order)
  overflow: string[];       // pills hidden, reachable via dropdown
}
```

- [ ] **Step 1.1: Write the failing test**

Create `destincode/desktop/tests/pack-sessions.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { packSessions } from '../src/renderer/components/header/pack-sessions';

const mk = (id: string, expanded = 120, collapsed = 20) =>
  ({ id, expandedWidth: expanded, collapsedWidth: collapsed });

describe('packSessions', () => {
  it('returns nothing when there are no sessions', () => {
    const r = packSessions({ sessions: [], activeId: null, budget: 500, gap: 2, triggerWidth: 20 });
    expect(r.expanded.size).toBe(0);
    expect(r.collapsed).toEqual([]);
    expect(r.overflow).toEqual([]);
  });

  it('shows only the active pill when budget is tight', () => {
    const sessions = [mk('a'), mk('b'), mk('c')];
    // Budget fits only the active expanded pill + trigger.
    const r = packSessions({ sessions, activeId: 'b', budget: 145, gap: 2, triggerWidth: 20 });
    expect(r.expanded.has('b')).toBe(true);
    expect(r.collapsed).toEqual([]);
    expect(r.overflow).toEqual(['a', 'c']);
  });

  it('collapses non-active pills to dot-only when names would not fit', () => {
    const sessions = [mk('a'), mk('b'), mk('c')];
    // Active expanded (120) + 2 collapsed (20 each) + 3 gaps (6) + trigger (20) = 186
    const r = packSessions({ sessions, activeId: 'b', budget: 200, gap: 2, triggerWidth: 20 });
    expect(r.expanded).toEqual(new Set(['b']));
    expect(r.collapsed).toEqual(['a', 'c']);
    expect(r.overflow).toEqual([]);
  });

  it('expands all pills when budget allows (allExpanded mode)', () => {
    const sessions = [mk('a'), mk('b'), mk('c')];
    // 3×120 + 2 gaps + trigger = 384
    const r = packSessions({ sessions, activeId: 'b', budget: 500, gap: 2, triggerWidth: 20 });
    expect(r.expanded).toEqual(new Set(['a', 'b', 'c']));
    expect(r.collapsed).toEqual([]);
    expect(r.overflow).toEqual([]);
  });

  it('overflows pills that do not fit even when collapsed', () => {
    const sessions = [mk('a'), mk('b'), mk('c'), mk('d'), mk('e')];
    // Active (120) + trigger (20) + 2 gaps (4) = 144; 30 px left = one collapsed pill fits
    const r = packSessions({ sessions, activeId: 'a', budget: 170, gap: 2, triggerWidth: 20 });
    expect(r.expanded).toEqual(new Set(['a']));
    expect(r.collapsed.length).toBe(1);
    expect(r.overflow.length).toBe(3);
  });

  it('preserves original session order in collapsed list', () => {
    const sessions = [mk('x'), mk('y'), mk('z')];
    const r = packSessions({ sessions, activeId: 'y', budget: 250, gap: 2, triggerWidth: 20 });
    expect(r.collapsed).toEqual(['x', 'z']);
  });

  it('never expands more than the active pill when budget forces collapse', () => {
    // Three pills that could all collapse (60+40+40) but not all expand (3×120).
    const sessions = [mk('a'), mk('b'), mk('c')];
    const r = packSessions({ sessions, activeId: 'a', budget: 230, gap: 2, triggerWidth: 20 });
    expect(r.expanded).toEqual(new Set(['a']));
    expect(r.collapsed).toEqual(['b', 'c']);
    expect(r.overflow).toEqual([]);
  });

  it('falls back to showing only active as a collapsed dot if budget is below expanded width', () => {
    const r = packSessions({ sessions: [mk('a', 120, 20)], activeId: 'a', budget: 50, gap: 2, triggerWidth: 20 });
    // Active must always be visible, prefer expanded but fall back to collapsed.
    expect(r.collapsed).toEqual(['a']);
    expect(r.expanded.size).toBe(0);
    expect(r.overflow).toEqual([]);
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `cd destincode-header-overflow/desktop && npx vitest run tests/pack-sessions.test.ts`
Expected: FAIL — `Cannot find module '../src/renderer/components/header/pack-sessions'`.

- [ ] **Step 1.3: Implement `packSessions`**

Create `destincode/desktop/src/renderer/components/header/pack-sessions.ts`:
```ts
// Pure packing function for session pills. Given measured pill widths and
// an available budget, decides which pills show expanded (name + dot),
// which collapse to dot-only, and which overflow into the dropdown.
//
// Priority: active pill always visible. Prefer expanded over collapsed;
// prefer visible over overflow. Budget is in CSS px.

export interface SessionMeasurement {
  id: string;
  expandedWidth: number;
  collapsedWidth: number;
}

export interface PackInput {
  sessions: SessionMeasurement[];
  activeId: string | null;
  budget: number;
  gap: number;
  triggerWidth: number;
}

export interface PackResult {
  expanded: Set<string>;
  collapsed: string[];
  overflow: string[];
}

function sumWithGaps(widths: number[], gap: number): number {
  if (widths.length === 0) return 0;
  return widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
}

export function packSessions(input: PackInput): PackResult {
  const { sessions, activeId, budget, gap, triggerWidth } = input;
  if (sessions.length === 0) {
    return { expanded: new Set(), collapsed: [], overflow: [] };
  }

  const active = sessions.find(s => s.id === activeId) ?? null;
  const others = sessions.filter(s => s.id !== activeId);

  // Budget available to pills, after reserving the ▾ trigger + one gap to it.
  const pillBudget = Math.max(0, budget - triggerWidth - gap);

  // Always include the active pill. Try expanded first, fall back to collapsed
  // if even its expanded width does not fit.
  if (active === null) {
    // No active session — fall back to packing all as collapsed by priority order.
    return greedyCollapsed(sessions, pillBudget, gap);
  }

  let activeExpanded = active.expandedWidth <= pillBudget;
  let activeWidth = activeExpanded ? active.expandedWidth : active.collapsedWidth;
  if (activeWidth > pillBudget) {
    // Active does not even fit collapsed — still show it (it is the active
    // pill; UX requires at least a dot). Everything else overflows.
    return {
      expanded: new Set(),
      collapsed: [active.id],
      overflow: others.map(o => o.id),
    };
  }

  // First pass: pack others as collapsed dots in original order.
  const collapsedIds: string[] = [];
  const overflowIds: string[] = [];
  let used = activeWidth;
  for (const s of others) {
    const candidate = used + gap + s.collapsedWidth;
    if (candidate <= pillBudget) {
      collapsedIds.push(s.id);
      used = candidate;
    } else {
      overflowIds.push(s.id);
    }
  }

  // Second pass: if every session is visible AND expanding all of them fits,
  // upgrade to allExpanded mode. This matches the old `allExpanded` UX
  // (names visible when there is room) but is budget-driven.
  if (overflowIds.length === 0 && activeExpanded) {
    const allExpandedWidth = sumWithGaps(
      [active.expandedWidth, ...others.map(o => o.expandedWidth)],
      gap,
    );
    if (allExpandedWidth <= pillBudget) {
      return {
        expanded: new Set(sessions.map(s => s.id)),
        collapsed: [],
        overflow: [],
      };
    }
  }

  return {
    expanded: activeExpanded ? new Set([active.id]) : new Set(),
    collapsed: activeExpanded ? collapsedIds : [active.id, ...collapsedIds],
    overflow: overflowIds,
  };
}

// Fallback when there is no active session — pack collapsed dots greedily.
function greedyCollapsed(
  sessions: SessionMeasurement[],
  budget: number,
  gap: number,
): PackResult {
  const collapsed: string[] = [];
  const overflow: string[] = [];
  let used = 0;
  for (const s of sessions) {
    const candidate = collapsed.length === 0
      ? s.collapsedWidth
      : used + gap + s.collapsedWidth;
    if (candidate <= budget) {
      collapsed.push(s.id);
      used = candidate;
    } else {
      overflow.push(s.id);
    }
  }
  return { expanded: new Set(), collapsed, overflow };
}
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `npx vitest run tests/pack-sessions.test.ts`
Expected: all 8 tests PASS.

- [ ] **Step 1.5: Commit**

```bash
git add destincode/desktop/src/renderer/components/header/pack-sessions.ts \
        destincode/desktop/tests/pack-sessions.test.ts
git commit -m "feat(header): add pure packSessions function for space-aware pill layout"
```

---

## Task 2: Add announcement widget to StatusBar

**Files:**
- Modify: `destincode/desktop/src/renderer/components/StatusBar.tsx`

Announcement data already flows through `statusData.announcement` in `App.tsx`. We add a new widget, `announcement`, `defaultVisible: true`, rendered with the same ★ + orange palette the header currently uses.

- [ ] **Step 2.1: Add widget id + category**

In `StatusBar.tsx` at line 160, extend the `WidgetId` union:
```ts
type WidgetId =
  | 'usage-5h' | 'usage-7d' | 'context' | 'git-branch' | 'sync-warnings' | 'theme' | 'version'
  | 'session-cost' | 'tokens-in' | 'tokens-out' | 'cache-stats' | 'code-changes' | 'session-time'
  | 'cache-hit-rate' | 'active-ratio' | 'output-speed'
  | 'announcement';
```

Then add a new "Updates" category at the end of `WIDGET_CATEGORIES` (around line 180 — find the closing `];` of the array and insert before it):
```ts
  {
    name: 'Updates',
    widgets: [
      {
        id: 'announcement',
        label: 'Announcement',
        defaultVisible: true,
        description: 'Platform announcements from the DestinCode team — new releases, outages, tips. Pulled every 6 hours from the announcement cache.',
        bestFor: 'Everyone. Hides automatically when there is no active announcement.',
      },
    ],
  },
```

- [ ] **Step 2.2: Extend StatusData interface + props**

In `StatusBar.tsx` around line 23, add to `StatusData`:
```ts
interface StatusData {
  usage: {
    five_hour?: { utilization: number; resets_at: string };
    seven_day?: { utilization: number; resets_at: string };
  } | null;
  updateStatus: {
    current: string;
    latest: string;
    update_available: boolean;
    download_url: string | null;
  } | null;
  announcement: { message: string } | null;
  contextPercent: number | null;
  gitBranch: string | null;
  sessionStats: SessionStats | null;
  syncStatus: string | null;
  syncWarnings: string | null;
}
```

- [ ] **Step 2.3: Render the announcement pill**

Find the `show('version')` block (~line 847). Insert a new block immediately above it:
```tsx
      {/* Platform announcement — ★ orange pill, truncates long copy */}
      {show('announcement') && statusData.announcement?.message && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm border truncate max-w-[280px]"
          style={{
            backgroundColor: 'rgba(255,152,0,0.15)',
            color: '#FF9800',
            borderColor: 'rgba(255,152,0,0.25)',
          }}
          title={statusData.announcement.message}
        >
          <span aria-hidden>★</span>
          <span className="truncate">{statusData.announcement.message}</span>
        </span>
      )}
```

Note: the containing status bar already uses `flex flex-wrap` and the widget pattern — no layout changes needed at the wrapper level.

- [ ] **Step 2.4: Thread `announcement` through App.tsx**

In `destincode/desktop/src/renderer/App.tsx`, find the `<StatusBar statusData={{ ... }} ...>` call (~line 1350). Add the `announcement` key to the inline `statusData` object:
```tsx
                <StatusBar
                  statusData={{
                    usage: statusData.usage,
                    updateStatus: statusData.updateStatus,
                    announcement: statusData.announcement,
                    contextPercent: sessionId ? (statusData.contextMap[sessionId] ?? null) : null,
                    gitBranch: sessionId ? (statusData.gitBranchMap[sessionId] ?? null) : null,
                    sessionStats: sessionId ? (statusData.sessionStatsMap[sessionId] ?? null) : null,
                    syncStatus: statusData.syncStatus,
                    syncWarnings: statusData.syncWarnings,
                  }}
```

- [ ] **Step 2.5: Build and verify**

Run: `npm run build`
Expected: build succeeds with no type errors.

Then `npm run dev` — when dev build is running, confirm the ★ pill appears in the status bar (if `~/.claude/.announcement-cache.json` has content) and can be toggled off via the pencil popup in the "Updates" category.

- [ ] **Step 2.6: Commit**

```bash
git add destincode/desktop/src/renderer/components/StatusBar.tsx \
        destincode/desktop/src/renderer/App.tsx
git commit -m "feat(status-bar): move announcement from header into status bar widget"
```

---

## Task 3: Remove announcement from HeaderBar + fix column symmetry

**Files:**
- Modify: `destincode/desktop/src/renderer/components/HeaderBar.tsx`
- Modify: `destincode/desktop/src/renderer/App.tsx`

- [ ] **Step 3.1: Drop `announcement` prop and span in HeaderBar**

In `HeaderBar.tsx`:

(a) Remove the `announcement: string | null;` line from the `Props` interface (~line 55).

(b) Remove `announcement,` from the destructured props at the function signature (~line 73).

(c) Delete the announcement span (~lines 194-198):
```tsx
        {announcement && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-[#FF9800]/15 text-[#FF9800] border border-[#FF9800]/25 truncate max-w-[200px] hidden sm:inline" title={announcement}>
            ★ {announcement}
          </span>
        )}
```

- [ ] **Step 3.2: Remove `min-w-0` from left column**

In `HeaderBar.tsx` at line 175, change:
```tsx
      <div className="flex-1 flex items-center gap-1 sm:gap-2 min-w-0">
```
to:
```tsx
      <div className="flex-1 flex items-center gap-1 sm:gap-2">
```

Rationale: the left column now holds only the settings gear (`shrink-0`, ~28px) and an optional `REMOTE` badge (`shrink-0`). No child should truncate, so removing `min-w-0` means the column's min-content-width is respected by flex layout, mirroring the right column. The gear can no longer be overdrawn by SessionStrip.

- [ ] **Step 3.3: Drop `announcement` from App.tsx HeaderBar call**

In `App.tsx` find the `<HeaderBar ... announcement={announcementText} ... />` call (~line 1281). Remove the `announcement={announcementText}` line. Also remove the now-unused local at line 1175:
```tsx
  const announcementText = statusData.announcement?.message || null;
```

- [ ] **Step 3.4: Typecheck + build**

Run: `npm run build`
Expected: succeeds. If TypeScript complains about unused `announcement` or `announcementText`, delete them.

- [ ] **Step 3.5: Manual verification**

Start `npm run dev`. With 3+ active sessions and narrow window (~700px):
- Gear is never covered by the session strip.
- REMOTE badge (if in remote mode) stays visible.
- Resizing from wide → narrow → wide returns to expected layout with no flicker.

- [ ] **Step 3.6: Commit**

```bash
git add destincode/desktop/src/renderer/components/HeaderBar.tsx \
        destincode/desktop/src/renderer/App.tsx
git commit -m "fix(header): remove announcement from left column, restore flex symmetry

Left column no longer collapses below the settings gear's shrink-0 width,
so the session strip can no longer paint over it. Announcement moved to
status bar in previous commit."
```

---

## Task 4: Platform-aware toggle placement

**Files:**
- Modify: `destincode/desktop/src/renderer/components/HeaderBar.tsx`

**Rule:** Put the chat/terminal toggle on the opposite side of the header from the OS window controls, so both sides are visually balanced.

- **macOS** — native traffic lights sit on the left → toggle stays in the RIGHT cluster (current behavior).
- **Windows + Linux** — custom or native frame controls sit on the right → toggle moves to the LEFT cluster, rendered immediately after the settings gear.

Gamepad pill stays in the right cluster on all platforms. Only the toggle moves.

- [ ] **Step 4.1: Add a platform detection flag**

In `HeaderBar.tsx` near the top of the file (after the `showCaptionButtons` constant around line 9), add:

```tsx
/** Toggle sits on the opposite side of the OS window-control buttons
 *  so the header is balanced. macOS traffic lights live on the left,
 *  so the toggle goes right. Windows/Linux window controls live on
 *  the right, so the toggle goes left. */
const toggleOnLeft = typeof navigator !== 'undefined'
  && !navigator.platform.startsWith('Mac');
```

- [ ] **Step 4.2: Extract the toggle JSX into a local**

Inside the `HeaderBar` component, before the `return`, extract the existing toggle block (the `<div ref={containerRef} className="relative flex bg-inset rounded-md p-0.5 gap-0.5"> ... </div>` spanning lines ~221-276) into a const expression:

```tsx
  const toggleElement = (
    <div ref={containerRef} className="relative flex bg-inset rounded-md p-0.5 gap-0.5">
      {/* Sliding background pill — left/width come from CSS variables
          set once by measureEndpoints(). Plain CSS transition tweens
          between the two cached endpoints. */}
      <div
        className="absolute top-0.5 bottom-0.5 bg-accent rounded-[var(--radius-toggle)] transition-[left,width] duration-300 ease-in-out"
        style={{
          left:  viewMode === 'chat' ? 'var(--pill-chat-left)'  : 'var(--pill-term-left)',
          width: viewMode === 'chat' ? 'var(--pill-chat-width)' : 'var(--pill-term-width)',
          opacity: measured ? 1 : 0,
        }}
      />
      <button
        ref={chatBtnRef}
        onClick={() => onToggleView('chat')}
        className={`relative z-10 px-1.5 sm:px-2.5 py-1 rounded-[var(--radius-toggle)] flex items-center gap-1.5 transition-colors duration-300 ${
          viewMode === 'chat'
            ? 'text-on-accent'
            : 'text-fg-dim hover:text-fg-2'
        }`}
        title="Chat"
      >
        <ChatIcon className="w-3.5 h-3.5 shrink-0" />
        <span
          data-btn-text
          className="text-xs font-medium hidden sm:inline-block overflow-hidden whitespace-nowrap transition-all duration-300 ease-in-out"
          style={{
            maxWidth: viewMode === 'chat' ? '3rem' : '0',
            opacity: viewMode === 'chat' ? 1 : 0,
          }}
        >Chat</span>
      </button>
      <button
        ref={termBtnRef}
        onClick={() => onToggleView('terminal')}
        className={`relative z-10 px-1.5 sm:px-2.5 py-1 rounded-[var(--radius-toggle)] flex items-center gap-1.5 transition-colors duration-300 ${
          viewMode === 'terminal'
            ? 'text-on-accent'
            : 'text-fg-dim hover:text-fg-2'
        }`}
        title="Terminal"
      >
        <TerminalIcon className="w-3.5 h-3.5 shrink-0" />
        <span
          data-btn-text
          className="text-xs font-medium hidden sm:inline-block overflow-hidden whitespace-nowrap transition-all duration-300 ease-in-out"
          style={{
            maxWidth: viewMode === 'terminal' ? '4.5rem' : '0',
            opacity: viewMode === 'terminal' ? 1 : 0,
          }}
        >Terminal</span>
      </button>
    </div>
  );
```

Note: the `hidden sm:inline-block` is preserved here — Task 6 replaces it with the ResizeObserver-driven flag. Do not conflate the two changes.

- [ ] **Step 4.3: Render the toggle into the correct cluster**

In the left cluster (the `<div className="flex-1 flex items-center gap-1 sm:gap-2">` that now lacks `min-w-0` per Task 3), after the REMOTE badge conditional block, add:

```tsx
        {toggleOnLeft && toggleElement}
```

In the right cluster (the `<div className="flex-1 flex items-center justify-end gap-1 sm:gap-2">` around line 219), REPLACE the inline toggle block with:

```tsx
        {!toggleOnLeft && toggleElement}
```

The gamepad `<div className="bg-inset rounded-md p-0.5 hidden sm:block"> ... </div>` block and `{showCaptionButtons && <CaptionButtons />}` remain in the right cluster unchanged.

- [ ] **Step 4.4: Re-measure the pill endpoints when placement changes**

`toggleOnLeft` is effectively constant per session (derives from `navigator.platform`), so no runtime re-measure is needed for placement alone. But the pill container's ancestor chain differs between clusters — if measurements were captured before the React move, they'd be wrong. Because we only set `toggleOnLeft` once at module load and React mounts the toggle into the correct cluster on first render, the existing `useLayoutEffect(() => { measureEndpoints(); }, [measureEndpoints])` at line 154 will measure in the right place. Confirm by reading the effect — no code change needed for this step, just verification.

- [ ] **Step 4.5: Build + typecheck**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4.6: Manual verification**

`npm run dev`:
- On Windows: gear → toggle → (REMOTE?) on far left; SessionStrip centered; gamepad + caption buttons on far right.
- Toggling chat ↔ terminal still animates the sliding pill correctly.
- On macOS (if a Mac is available, otherwise skip): toggle stays on right, native traffic lights on far left — no change.

- [ ] **Step 4.7: Commit**

```bash
git add destincode/desktop/src/renderer/components/HeaderBar.tsx
git commit -m "feat(header): place chat/terminal toggle opposite OS window controls

On Windows/Linux the toggle now sits in the left cluster after the
settings gear, balancing the caption buttons on the right. On macOS it
stays on the right so the native traffic lights get the left side.
Driven by navigator.platform — a static check at module load since
platform cannot change mid-session.

Gamepad pill and caption buttons remain in the right cluster on all
platforms; only the chat/terminal toggle moves."
```

---

## Task 5: Dynamic session-strip packing via ResizeObserver

**Files:**
- Modify: `destincode/desktop/src/renderer/components/SessionStrip.tsx`

Replace the viewport-based `useIsCompact` with a ResizeObserver-driven packer that consumes `packSessions()` from Task 1.

The strategy:
1. Measure each session pill's expanded + collapsed widths once per session-list change, using an offscreen measurement pass (visibility: hidden, position: absolute).
2. ResizeObserver on `pillBarRef` fires `packSessions()` with the current budget.
3. Store `packResult` in state; render pills using it.

Measurement approach — instead of rendering hidden clones, we leverage the fact that collapsed width is visually constant (`~20px`, dot + padding) and measure the expanded width by rendering a hidden `<span>` with the session name in the current font. This avoids complex double-rendering.

- [ ] **Step 5.1: Add imports and constants**

At the top of `SessionStrip.tsx`, add the import:
```ts
import { packSessions, type SessionMeasurement, type PackResult } from './header/pack-sessions';
```

Remove these three imports/constants (lines 4, 11, 13-26) — `isAndroid` stays imported for other uses; only `useIsCompact` and `NARROW_BREAKPOINT` go:
```ts
/* ── Narrow viewport hook — mirrors Android's single-session behavior ── */
const NARROW_BREAKPOINT = 640;

function useIsCompact(): boolean { /* ... */ }
```

- [ ] **Step 5.2: Add measurement + packing state hook**

Inside the `SessionStrip` component, replace the `const isCompact = useIsCompact();` line (~line 415) and the derived `visibleSessions` / `allExpanded` (~lines 420-423) with this block:

```tsx
  // --- Space-aware packing ---
  // We measure each pill's expanded width offscreen using a hidden canvas
  // (no layout thrash). Collapsed width is constant (dot + padding ≈ 24 px).
  const [pack, setPack] = useState<PackResult>({
    expanded: new Set(),
    collapsed: sessions.map(s => s.id),
    overflow: [],
  });

  // Persistent measuring canvas — exists once per component, reused.
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  if (measureCanvasRef.current === null && typeof document !== 'undefined') {
    measureCanvasRef.current = document.createElement('canvas');
  }

  const measureExpandedWidth = useCallback((name: string): number => {
    const canvas = measureCanvasRef.current;
    if (!canvas) return 120; // fallback
    const ctx = canvas.getContext('2d');
    if (!ctx) return 120;
    // Match the pill's label styling: text-xs = 12px, medium weight.
    ctx.font = '500 12px system-ui, -apple-system, sans-serif';
    const textWidth = ctx.measureText(name).width;
    // Pill chrome: 6px left pad + dot (10) + 4px gap + text + 6px right pad + 2px border.
    return Math.ceil(textWidth + 28);
  }, []);

  const repack = useCallback(() => {
    const bar = pillBarRef.current;
    if (!bar) return;
    const budget = bar.clientWidth;
    const measurements: SessionMeasurement[] = sessions.map(s => ({
      id: s.id,
      expandedWidth: measureExpandedWidth(s.name),
      collapsedWidth: 24, // dot (10) + horizontal padding (12) + border (2)
    }));
    const result = packSessions({
      sessions: measurements,
      activeId: activeSessionId,
      budget,
      gap: 2,          // matches gap-0.5 on the strip
      triggerWidth: 24, // ▾ button is w-5 + ml-1
    });
    setPack(result);
  }, [sessions, activeSessionId, measureExpandedWidth]);

  // Pack on mount, on session-list change, and on any container resize.
  useLayoutEffect(() => { repack(); }, [repack]);
  useEffect(() => {
    const bar = pillBarRef.current;
    if (!bar) return;
    const ro = new ResizeObserver(() => repack());
    ro.observe(bar);
    return () => ro.disconnect();
  }, [repack]);

  // Android always forces single-session mode (no room for siblings on mobile chrome).
  const forceSingle = isAndroid();
  const visibleSessions = forceSingle
    ? sessions.filter(s => s.id === activeSessionId)
    : sessions.filter(s => pack.expanded.has(s.id) || pack.collapsed.includes(s.id));
```

Also add `useLayoutEffect` to the react import at the top:
```ts
import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
```

- [ ] **Step 5.3: Rewire the pill render loop**

Find the render of each pill (~line 430-484). Replace the per-pill `showName` computation:
```tsx
          const showName = allExpanded || isHovered || isActive;
```
with:
```tsx
          const showName = forceSingle
            ? isActive
            : pack.expanded.has(s.id) || isHovered || isActive;
```

And replace the `allExpanded` references in the transition styles (~line 475):
```tsx
                    transition: allExpanded ? 'none' : 'max-width 200ms ease, opacity 150ms ease',
```
with:
```tsx
                    transition: pack.expanded.has(s.id) ? 'none' : 'max-width 200ms ease, opacity 150ms ease',
```

And `onMouseEnter`/`onMouseLeave` (line 446-447):
```tsx
                  onMouseEnter={allExpanded ? undefined : () => handleEnter(s.id)}
                  onMouseLeave={allExpanded ? undefined : handleLeave}
```
to:
```tsx
                  onMouseEnter={pack.expanded.has(s.id) ? undefined : () => handleEnter(s.id)}
                  onMouseLeave={pack.expanded.has(s.id) ? undefined : handleLeave}
```

And the className conditional at line 451-454:
```tsx
                  ${showName && (isActive || !allExpanded)
                    ? 'border-edge bg-panel'
                    : 'border-transparent'
                  }
```
to:
```tsx
                  ${showName && (isActive || !pack.expanded.has(s.id))
                    ? 'border-edge bg-panel'
                    : 'border-transparent'
                  }
```

And the glow shadow conditional at line 462:
```tsx
                  boxShadow: (!isCompact && isActive) ? GLOW_SHADOW[color] : undefined,
```
to:
```tsx
                  boxShadow: (!forceSingle && isActive) ? GLOW_SHADOW[color] : undefined,
```

- [ ] **Step 5.4: Build + typecheck**

Run: `npm run build`
Expected: succeeds. Fix any leftover references to `isCompact` or `allExpanded` the compiler flags.

- [ ] **Step 5.5: Manual verification**

`npm run dev`, then with ≥4 sessions:
- Wide window: names visible for all pills (allExpanded).
- Medium window: active has name, others shrink to dots. Hovering a dot expands it.
- Narrow window: some pills overflow to dropdown, accessible via ▾.
- Slowly drag-resize the window: pills should flex smoothly; no pill ever overlaps the gear on the left or the toggle on the right.
- Dropdown (▾) still lists ALL sessions, including overflowed ones.

- [ ] **Step 5.6: Commit**

```bash
git add destincode/desktop/src/renderer/components/SessionStrip.tsx
git commit -m "feat(session-strip): space-aware pill packing via ResizeObserver

Replaces the 640px viewport breakpoint in useIsCompact with a measured
budget computed from the strip's actual clientWidth. Session pills now
expand, collapse to dot-only, or overflow into the dropdown based on what
fits — not what window.innerWidth says.

Expanded-width measurement uses a reused offscreen canvas; collapsed
width is a constant 24px (dot + padding). Re-packs on ResizeObserver
fires and on session-list change."
```

---

## Task 6: Dynamic chat/terminal toggle label visibility

**Files:**
- Modify: `destincode/desktop/src/renderer/components/HeaderBar.tsx`

Replace `hidden sm:inline-block` on the toggle label spans with a JS-driven class so labels hide when the header actually cannot fit them — not just at viewport < 640px.

- [ ] **Step 5.1: Add a header ResizeObserver + fit calculation**

In `HeaderBar.tsx`, inside the component (after existing refs declared around line 93), add:
```tsx
  const headerRef = useRef<HTMLDivElement>(null);
  const [showToggleLabels, setShowToggleLabels] = useState(true);

  // Measure whether the header has room for the toggle labels. The labels
  // are the first things to drop; below that threshold, flex still has
  // room for the icon-only toggle, gamepad, caption buttons, and the
  // session strip is allowed to pack more aggressively.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const compute = () => {
      // Empirical: at <560 px total header width, labels cause the strip
      // to lose meaningful room. Above 720 px, labels always fit.
      // Between, choose labels-visible unless the right cluster would
      // be narrower than the session strip's minimum viable width (~180px).
      const w = el.clientWidth;
      setShowToggleLabels(w >= 560);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
```

Also bind the ref to the outermost header div (line 173):
```tsx
    <div ref={headerRef} className="header-bar flex items-center h-10 px-2 sm:px-3 border-b border-edge shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
```

- [ ] **Step 6.2: Replace `hidden sm:inline-block` on both labels**

At line 249 (Chat label):
```tsx
              className="text-xs font-medium hidden sm:inline-block overflow-hidden whitespace-nowrap transition-all duration-300 ease-in-out"
```
→
```tsx
              className={`text-xs font-medium overflow-hidden whitespace-nowrap transition-all duration-300 ease-in-out ${showToggleLabels ? 'inline-block' : 'hidden'}`}
```

Same at line 269 (Terminal label):
```tsx
              className="text-xs font-medium hidden sm:inline-block overflow-hidden whitespace-nowrap transition-all duration-300 ease-in-out"
```
→
```tsx
              className={`text-xs font-medium overflow-hidden whitespace-nowrap transition-all duration-300 ease-in-out ${showToggleLabels ? 'inline-block' : 'hidden'}`}
```

- [ ] **Step 6.3: Re-measure the pill endpoints when labels flip**

Find the existing `useLayoutEffect(() => { measureEndpoints(); }, [measureEndpoints]);` at line 154. Immediately below it, add:
```tsx
  // Re-measure when toggle labels appear/disappear — button widths change
  // drastically between label-visible and icon-only states.
  useEffect(() => {
    // Wait one frame for the new class to apply before measuring.
    requestAnimationFrame(() => measureEndpoints());
  }, [showToggleLabels, measureEndpoints]);
```

- [ ] **Step 6.4: Build + typecheck**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 6.5: Manual verification**

`npm run dev`, then:
- Start wide (>720px): "Chat" and "Terminal" labels visible.
- Drag narrow past ~560px: labels disappear together, pill slides to new icon-only endpoints smoothly — no teleport.
- Drag wide again: labels reappear, pill realigns.
- Toggle between chat ↔ terminal at all widths: pill never lands misaligned.

- [ ] **Step 6.6: Commit**

```bash
git add destincode/desktop/src/renderer/components/HeaderBar.tsx
git commit -m "feat(header): toggle labels follow measured header width, not viewport

Replaces the hidden sm:inline-block breakpoint with a ResizeObserver on
the header that flips label visibility at measured 560px clientWidth.
Re-measures the sliding pill endpoints on flip so the animation stays
aligned."
```

---

## Task 7: Update docs + PITFALLS

**Files:**
- Modify: `destincode/desktop/docs/shared-ui-architecture.md`
- Modify: `docs/PITFALLS.md` (workspace root)

- [ ] **Step 7.1: Note space-aware layout in shared-ui docs**

Open `destincode/desktop/docs/shared-ui-architecture.md`. Find a reasonable section (or add one at the bottom) and add:
```markdown
## Header Layout (Space-Aware)

The header bar adapts to its measured width, not the viewport breakpoint.
Three measurement-driven behaviors:

- **SessionStrip packing** (`components/header/pack-sessions.ts` — pure, unit-tested). Session pills expand, collapse to dot-only, or overflow into the ▾ dropdown based on the strip container's `clientWidth`. Expanded widths are measured via an offscreen `canvas.measureText` pass in the current font.
- **Chat/Terminal label visibility.** The labels drop below 560 px measured header width. The sliding pill's cached endpoints are remeasured when labels flip.
- **Left/right flex symmetry.** The left column (settings + REMOTE badge) has no `min-w-0` — both children are `shrink-0`, so the column respects its min-content-width and never collapses underneath the SessionStrip. The right column has always behaved this way.

The announcement lives in StatusBar as the `announcement` widget (default-visible), not in the header.
```

- [ ] **Step 7.2: Add PITFALLS entries**

Open `docs/PITFALLS.md` (workspace root). Under the "Overlays (Popups, Modals, Drawers)" section (or a new "Header Bar" section before it), add:
```markdown
## Header Bar

- **Do not add `min-w-0` to the left cluster in `HeaderBar.tsx`.** It makes the column collapse below the settings gear's shrink-0 width, which lets SessionStrip paint over the gear. The left and right `flex-1` columns must stay symmetric — both omit `min-w-0`. If you need to truncate something inside, put `min-w-0` on the individual child, not the flex parent.
- **Header layout is space-aware, not viewport-aware.** The session strip uses `packSessions()` + ResizeObserver; the chat/terminal toggle labels follow a measured 560 px threshold on the header's own `clientWidth`. Do not reintroduce `@media`, `hidden sm:`, or `window.innerWidth` checks in header children — they lie when the app window is narrow but the viewport is wide, which is the default state on desktop.
- **Announcement lives in StatusBar.** A `announcement` widget in the "Updates" category. Do not re-thread announcement into HeaderBar — the status bar has room and user-toggleable widgets; the header does not.
```

- [ ] **Step 7.3: Commit docs**

```bash
git add destincode/desktop/docs/shared-ui-architecture.md docs/PITFALLS.md
git commit -m "docs: header is space-aware, announcement in status bar, flex symmetry required"
```

---

## Task 8: Final verification

- [ ] **Step 8.1: Full test run**

```bash
cd destincode-header-overflow/desktop
npx vitest run
npm run build
```
Expected: all tests pass (pre-existing + 8 new), build succeeds.

- [ ] **Step 8.2: Scripted manual QA**

`npm run dev`, then exercise:

1. **Wide window (~1600 px)** with 2 sessions: all pills expanded, toggle labels visible, announcement in status bar.
2. **Medium (~900 px)** with 5 sessions: active pill expanded, others dot-only, dropdown still shows all 5; toggle labels visible; nothing overlaps.
3. **Narrow (~550 px)** with 5 sessions: active pill only or active + 1 dot, rest in dropdown; toggle labels hide; gear visible; pill slide animation stays aligned after toggling chat ↔ terminal.
4. **Very narrow (~400 px)** (resize below Electron's min if permitted): falls back gracefully; gear always visible.
5. **Toggle announcement off** via status bar pencil: status bar no longer shows it. Re-enable: reappears.
6. **No announcement in cache**: status bar pill does not render (conditional on `statusData.announcement?.message`).

- [ ] **Step 8.3: Push and merge**

```bash
git push -u origin fix/header-overflow
# From destincode repo:
cd /c/Users/desti/destinclaude-dev/destincode
git fetch origin
git checkout master
git merge --no-ff fix/header-overflow -m "Merge fix/header-overflow: space-aware header, announcement in status bar"
git push origin master
git worktree remove ../../destincode-header-overflow
git branch -D fix/header-overflow
```

- [ ] **Step 8.4: Run `/audit` to catch any doc drift introduced**

Run the `/audit header` scope if available, or full `/audit`. Resolve any findings.

---

## Self-Review Notes

- **Spec coverage:** Every user request is covered — (a) review commit history [Pre-flight / prior turn], (b) sessions-limited-to-one-name dynamic improvement [Task 4], (c) chat/terminal toggle text dynamic [Task 5], (d) announcements to status bar default-visible [Task 2 + 3], plus the originating overlap fix [Task 3.2].
- **No placeholders:** Every code block is concrete; every test asserts specific outputs; every shell command is runnable.
- **Type consistency:** `SessionMeasurement`, `PackInput`, `PackResult` defined in Task 1 and used by name in Task 4. `WidgetId` extended in Task 2 and referenced in existing `loadVisibility` logic unchanged. `StatusData` shape extended in Task 2 and consumed in App.tsx in the same task.
- **Known tradeoffs:** Expanded-pill width measurement uses a canvas approximation, not a live layout pass. The constant `28 px` chrome estimate may be off by a few px for some fonts, but packing is conservative — a slight over-estimate just means we collapse one pill early, which is the safer failure mode. Worth revisiting only if users report pills flickering between expanded/collapsed at boundary widths.
