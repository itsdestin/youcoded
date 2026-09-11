// @vitest-environment jsdom
// permissions-section.test.tsx
// Render tests for Settings → Permissions (PermissionsSection.tsx) — the screen
// that explains the three permission modes, names what a native session will
// never stop asking about, lists every "Always allow" it remembered, and lets
// the user take each one back.
// Plan: docs/active/plans/2026-08-11-native-permissions-management-ui-plan.md
//
// The screen was designed in the workbench as one of three candidates and then
// promoted into this file. These tests pin the behaviour that had to survive the
// promotion, plus the two things the owner rejected earlier drafts for:
//
//   · the folder rows are an OVERVIEW, not a log — collapsed on arrival, count
//     on the band, rows two levels down;
//   · the modes block is REFERENCE CONTENT, not a control. Every selector shape
//     tried there read as a live setting, and nothing on this screen can change
//     a mode (it is per-conversation state set from the status-bar chip). The
//     "no interactive element" test below is the pin for that.
//
// The jsdom docblock on line 1 is mandatory — vitest.config.ts runs the suite in
// the `node` environment and the per-glob override for .tsx was removed in
// Vitest 4, so without it this file dies on `document is not defined`.
//
// Cleanup is explicit for the same reason: `globals` is off, so
// @testing-library/react never finds a global afterEach to auto-register its
// unmount hook, and every render would otherwise stack in one document — which
// turns the single-match getByRole queries below into ambiguous-match failures.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import PermissionsSection from '../src/renderer/components/PermissionsSection';
import { CROSS_PROJECT_SLUG } from '../src/shared/permission-types';
import { PERMISSIONS_EXPLAINER_SECTIONS } from '../src/renderer/components/permissions/permissions-explainer';

const list = vi.fn();
const remove = vi.fn();
const removeProject = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as any).window.claude = { permissions: { list, remove, removeProject } };
});

afterEach(() => {
  cleanup();
});

/** N distinct Bash grants — enough to trip the "Show all" cut. */
function commands(n: number) {
  return Array.from({ length: n }, (_, i) => ({ tool: 'Bash', pattern: `cmd-${i}`, action: 'allow' }));
}

/**
 * Open a folder card by its visible name.
 *
 * EVERY folder starts collapsed now — the default-open heuristic was cut,
 * because a screen whose height depends on how much you happened to approve is a
 * different screen every time you open it. So any test that looks at a rule row
 * has to open its folder first, and that is the point rather than boilerplate.
 */
async function openFolder(name: RegExp | string) {
  const header = await screen.findByRole('button', { name });
  fireEvent.click(header);
  return header;
}

describe('PermissionsSection — the overview', () => {
  it('gives each folder one collapsible band carrying its count', async () => {
    list.mockResolvedValue([
      { slug: '-a', cwd: '/home/d/alpha', rules: commands(9) },
      { slug: '-b', cwd: '/home/d/beta', rules: commands(9) },
      { slug: '-c', cwd: '/home/d/gamma', rules: commands(9) },
    ]);
    render(<PermissionsSection />);
    const header = await screen.findByRole('button', { name: /alpha/i });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.textContent).toContain('9');
    // Collapsed: none of the rows are in the document at all.
    expect(screen.queryByText('cmd-0')).toBeNull();

    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('cmd-0')).toBeTruthy();
  });

  it('starts every folder collapsed, however small the list', async () => {
    // A single tiny folder used to open itself. That heuristic was cut: the
    // count on the band already says how much is inside without opening it.
    list.mockResolvedValue([{ slug: '-a', cwd: '/home/d/alpha', rules: commands(3) }]);
    render(<PermissionsSection />);
    const header = await screen.findByRole('button', { name: /alpha/i });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('cmd-0')).toBeNull();
  });

  // An earlier draft put the folder NAME through the section-label recipe, so it
  // rendered as YOUCODED-DEV/YOUCODED and a legacy no-cwd slug read as shouting.
  // A folder name is user data: the family renders data in rows and reserves
  // labels for authored strings.
  it('renders folder names as rows, never as section labels', async () => {
    list.mockResolvedValue([
      { slug: '-home-d-MyNotes', cwd: '/home/d/MyNotes', rules: commands(3) },
      { slug: '-home-destin-notes', rules: commands(3) },
    ]);
    render(<PermissionsSection />);

    // The labels on this screen are the two authored ones — that is what
    // uppercase is for.
    expect(await screen.findByRole('heading', { name: 'Always allowed' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Permission modes' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /MyNotes/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /-home-destin-notes/ })).toBeNull();

    // The name is a row title in its true casing; the path is its description.
    const title = screen.getByText('MyNotes');
    expect(title.className).not.toContain('uppercase');
    expect(title.className).toContain('text-xs');
    const header = screen.getByRole('button', { name: /MyNotes/ });
    expect(header.textContent).toContain('/home/d/MyNotes');

    // Kind headings inside an open folder ARE genuine labels and keep the
    // canonical recipe.
    fireEvent.click(header);
    expect(screen.getAllByRole('heading', { name: 'Commands' })[0].className)
      .toContain('tracking-wider uppercase');
  });

  it('groups an open folder by kind rather than listing everything in one run', async () => {
    list.mockResolvedValue([
      { slug: '-a', cwd: '/a', rules: [
        { tool: 'Bash', pattern: 'git status', action: 'allow' },
        { tool: 'Write', pattern: 'src/a.ts', action: 'allow' },
        { tool: 'WebFetch', pattern: 'example.com', action: 'allow' },
        { tool: 'Read', pattern: 'notes.md', action: 'allow' },
      ] },
    ]);
    render(<PermissionsSection />);
    await openFolder(/^a/);
    // Kind headings are <h3>; the folder band is a <button>, so these queries
    // cannot accidentally match it.
    expect(screen.getByRole('heading', { name: 'Commands' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'File changes' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Connections' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Other' })).toBeTruthy();

    // A kind with nothing in it is not rendered as an empty heading.
    cleanup();
    list.mockResolvedValue([{ slug: '-a', cwd: '/a', rules: commands(2) }]);
    render(<PermissionsSection />);
    await openFolder(/^a/);
    expect(screen.getByRole('heading', { name: 'Commands' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Connections' })).toBeNull();
  });

  it('truncates a long kind behind “Show all N”', async () => {
    list.mockResolvedValue([{ slug: '-a', cwd: '/a', rules: commands(8) }]);
    render(<PermissionsSection />);
    await openFolder(/^a/);
    // 8 rules, 5 shown.
    expect(screen.getByText('cmd-4')).toBeTruthy();
    expect(screen.queryByText('cmd-5')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show all 8' }));
    expect(screen.getByText('cmd-7')).toBeTruthy();
  });

  it('does not hide a single row behind a click', async () => {
    // 6 rules is one over the cut; hiding exactly one is worse than showing it.
    list.mockResolvedValue([{ slug: '-a', cwd: '/a', rules: commands(6) }]);
    render(<PermissionsSection />);
    await openFolder(/^a/);
    expect(screen.getByText('cmd-5')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /show all/i })).toBeNull();
  });
});

describe('PermissionsSection — the modes block is reference content', () => {
  // THE DEFECT THE OWNER REJECTED TWICE. Three selector shapes were tried in the
  // modes block — a radio list, a segmented control, and a "state first" row
  // with a Change button — and each one read as a live setting. Nothing on this
  // screen can set a mode: it is per-conversation state owned by
  // NativeSessionHost and changed from the status-bar chip at the bottom of the
  // chat. A control that sets nothing is a lie in the shape of a control, so the
  // block must stay definitions and nothing else.
  //
  // Asserted structurally rather than by naming the shapes that were rejected,
  // so a FOURTH shape nobody has thought of yet fails this too.
  const INTERACTIVE = [
    'button',
    'input',
    'select',
    'textarea',
    'a[href]',
    '[role="button"]',
    '[role="radio"]',
    '[role="radiogroup"]',
    '[role="tab"]',
    '[role="switch"]',
    '[role="checkbox"]',
    '[role="menuitem"]',
    '[onclick]',
    '[tabindex]',
  ].join(', ');

  /** The block under the modes heading: its label plus the card beneath it. */
  function modesBlock(): HTMLElement {
    return screen.getByRole('heading', { name: 'Permission modes' })
      .parentElement as HTMLElement;
  }

  it('contains no interactive element at all', async () => {
    // A folder open below it, so the page genuinely HAS buttons — otherwise a
    // zero here would prove only that nothing rendered.
    list.mockResolvedValue([{ slug: '-p', cwd: '/p', rules: commands(3) }]);
    render(<PermissionsSection />);
    await openFolder(/^p/);
    expect(screen.getAllByRole('button').length).toBeGreaterThan(1);

    const block = modesBlock();
    // Non-vacuity: this really is the modes block and it really did render.
    expect(block.textContent).toContain('Ask first');
    expect(block.textContent).toContain('Auto edit');
    expect(block.textContent).toContain('Full auto');

    const found = [...block.querySelectorAll(INTERACTIVE)].map(
      (el) => `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}`,
    );
    expect(
      found,
      'The permission modes are reference content. Mode is per-conversation state set from the '
        + 'status-bar chip — a control here would set nothing.',
    ).toEqual([]);
  });

  it('states all three modes at once and says where the mode is actually changed', async () => {
    // All three print together because a first-time reader is comparing them,
    // not choosing one; and the card closes by naming the control that does
    // exist, so the reader does not hunt this screen for one.
    list.mockResolvedValue([]);
    render(<PermissionsSection />);
    await screen.findByRole('heading', { name: 'Permission modes' });
    expect(modesBlock().textContent).toMatch(/bar at the bottom of the chat/i);
  });

  it('hangs the always-asks list off Full auto and nowhere else', async () => {
    // The four items are all commands, and Ask first and Auto edit already stop
    // before every command — under those two the list is a restatement, not an
    // exception. Under Full auto it is the whole exception, so it sits directly
    // under that definition and the sentence above it points at the next thing
    // on screen.
    list.mockResolvedValue([]);
    render(<PermissionsSection />);
    const fullAuto = await screen.findByText('Full auto');
    // <span> label → <p> definition → the wrapper that also holds the <ul>.
    const modeBlock = fullAuto.closest('p')!.parentElement as HTMLElement;
    const items = [...modeBlock.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toContain('Deleting files or folders');
    expect(items).toHaveLength(4);

    // The other two definitions carry no list.
    for (const label of ['Ask first', 'Auto edit']) {
      const other = screen.getByText(label).closest('p')!.parentElement as HTMLElement;
      expect(other.querySelectorAll('li')).toHaveLength(0);
    }
  });
});

describe('PermissionsSection — behavioural contracts', () => {
  it('shows the folder name and its path', async () => {
    list.mockResolvedValue([
      { slug: '-home-d-proj', cwd: '/home/d/proj', rules: [
        { tool: 'Bash', pattern: 'git push origin main', action: 'allow' },
      ] },
    ]);
    render(<PermissionsSection />);
    await openFolder(/proj/);
    expect(screen.getByText('/home/d/proj')).toBeTruthy();
    expect(screen.getByText('git push origin main')).toBeTruthy();
  });

  it('says so when the folder was never recorded, and never invents a path', async () => {
    list.mockResolvedValue([
      { slug: '-home-d-notes', rules: [{ tool: 'Bash', pattern: 'ls', action: 'allow' }] },
    ]);
    render(<PermissionsSection />);
    expect(await screen.findByText(/location wasn't recorded/i)).toBeTruthy();
    // The slug is the name — the only one we actually have.
    expect(screen.getByRole('button', { name: /-home-d-notes/ })).toBeTruthy();
  });

  it('marks a pattern-less grant as covering every use of the tool', async () => {
    list.mockResolvedValue([
      { slug: '-p', cwd: '/p', rules: [{ tool: 'Write', action: 'allow' }] },
    ]);
    render(<PermissionsSection />);
    await openFolder(/^p/);
    expect(screen.getByText(/every file/i)).toBeTruthy();
  });

  // Task 11: a specialist-keyed rule must read as what it actually is — a
  // grant a SPECIALIST holds, not the assistant itself — and it must be a
  // DISTINCT row from a root grant that happens to share the same tool/
  // pattern/action (ruleKey's identity axis; a React key collision would drop
  // one of the two rows silently instead of failing loudly).
  it('renders a specialist-keyed rule with its own row, distinct from the identical root grant', async () => {
    list.mockResolvedValue([
      { slug: '-p', cwd: '/p', rules: [
        { tool: 'Bash', pattern: 'npm test*', action: 'allow' },
        { tool: 'Bash', pattern: 'npm test*', action: 'allow', specialist: 'worker' },
      ] },
    ]);
    render(<PermissionsSection />);
    await openFolder(/^p/);
    expect(screen.getByRole('button', { name: /^Revoke permission: Run npm test\*$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Revoke permission: Let the Worker specialist run npm test\*$/ })).toBeTruthy();
  });

  it('passes the specialist through to remove() so the revoke matches the right grant', async () => {
    const rule = { tool: 'Bash', pattern: 'npm test*', action: 'allow', specialist: 'worker' };
    list.mockResolvedValue([{ slug: '-p', cwd: '/p', rules: [rule] }]);
    remove.mockResolvedValue(true);
    render(<PermissionsSection />);
    await openFolder(/^p/);
    fireEvent.click(screen.getByRole('button', { name: /^Revoke permission:/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Confirm revoking permission:/ }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('-p', { tool: 'Bash', pattern: 'npm test*', action: 'allow', specialist: 'worker' }));
  });

  // M5 2c: a scoped grant HAS a pattern but is narrow by construction. Putting
  // the breadth note on it would teach the user to ignore the note on the
  // tool-wide grants where it is true.
  it('renders a scoped push grant as a branch sentence, with no breadth note', async () => {
    list.mockResolvedValue([
      { slug: '-p', cwd: '/p', rules: [
        { tool: 'Bash', pattern: 'git push*origin master', action: 'allow', match: 'glob' },
      ] },
    ]);
    render(<PermissionsSection />);
    await openFolder(/^p/);
    expect(screen.getByText(/Pushing to master/)).toBeTruthy();
    expect(screen.queryByText(/every command/i)).toBeNull();
    // And never the raw pattern, on a screen written for people who have never
    // seen a glob.
    expect(screen.queryByText(/git push\*/)).toBeNull();
  });

  it('still shows the breadth note on a genuinely tool-wide Bash grant', async () => {
    list.mockResolvedValue([
      { slug: '-p', cwd: '/p', rules: [{ tool: 'Bash', action: 'allow' }] },
    ]);
    render(<PermissionsSection />);
    await openFolder(/^p/);
    expect(screen.getByText(/every command/i)).toBeTruthy();
  });

  // The confirm is the guard against a mis-click revoking something the user
  // wanted. A single-click revoke would be a regression, not a simplification.
  it('requires a confirm before removing, then calls remove with the SLUG', async () => {
    const rule = { tool: 'Bash', pattern: 'git push origin main', action: 'allow' };
    list.mockResolvedValue([{ slug: '-home-d-proj', cwd: '/home/d/proj', rules: [rule] }]);
    remove.mockResolvedValue(true);
    render(<PermissionsSection />);
    await openFolder(/proj/);

    fireEvent.click(screen.getByRole('button', { name: /^Revoke permission:/ }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByText(/asked the next time/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Confirm revoking permission:/ }));
    // The SLUG, not the cwd — a path cannot be reconstructed from a slug.
    await waitFor(() => expect(remove).toHaveBeenCalledWith('-home-d-proj', rule));
  });

  it('cancels the confirm on Escape', async () => {
    list.mockResolvedValue([{ slug: '-p', cwd: '/p', rules: [{ tool: 'Bash', pattern: 'ls', action: 'allow' }] }]);
    render(<PermissionsSection />);
    await openFolder(/^p/);
    fireEvent.click(screen.getByRole('button', { name: /^Revoke permission:/ }));
    const commit = screen.getByRole('button', { name: /^Confirm revoking permission:/ });
    fireEvent.keyDown(commit, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: /^Confirm revoking permission:/ })).toBeNull();
    // The trigger is back, so the row returned to rest rather than losing its action.
    expect(screen.getByRole('button', { name: /^Revoke permission:/ })).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps the row when the backend reports nothing matched', async () => {
    const rule = { tool: 'Bash', pattern: 'ls', action: 'allow' };
    list.mockResolvedValue([{ slug: '-p', cwd: '/p', rules: [rule] }]);
    remove.mockResolvedValue(false);   // stale list — the rule was already gone
    render(<PermissionsSection />);
    await openFolder(/^p/);
    fireEvent.click(screen.getByRole('button', { name: /^Revoke permission:/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Confirm revoking permission:/ }));
    await waitFor(() => expect(screen.getByText(/couldn't be found/i)).toBeTruthy());
    // The row is still on screen — reporting success would teach the user to
    // trust a list that lied to them.
    expect(screen.getByText('ls')).toBeTruthy();
    // …and nothing was re-read, because nothing changed.
    expect(list).toHaveBeenCalledTimes(1);
  });

  // Bulk removal is the one action here with no precedent in the settings
  // family, so it is gated exactly like a single row and lives at the bottom of
  // the open card rather than on the band.
  it('gates the per-folder bulk revoke behind the same confirm', async () => {
    list.mockResolvedValue([{ slug: '-p', cwd: '/p', rules: commands(3) }]);
    removeProject.mockResolvedValue(true);
    render(<PermissionsSection />);
    await openFolder(/^p/);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke all 3 permissions for p' }));
    expect(removeProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Confirm removing everything approved for/ }));
    await waitFor(() => expect(removeProject).toHaveBeenCalledWith('-p'));
  });

  it('offers no bulk action for a folder with a single approval', async () => {
    // "Revoke all 1" is the row's own button wearing a scarier label.
    list.mockResolvedValue([{ slug: '-p', cwd: '/p', rules: commands(1) }]);
    render(<PermissionsSection />);
    await openFolder(/^p/);
    expect(screen.getByText('cmd-0')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /revoke all/i })).toBeNull();
  });

  it('keeps the folder when the bulk removal reports nothing matched', async () => {
    list.mockResolvedValue([{ slug: '-p', cwd: '/p', rules: commands(2) }]);
    removeProject.mockResolvedValue(false);
    render(<PermissionsSection />);
    await openFolder(/^p/);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke all 2 permissions for p' }));
    fireEvent.click(screen.getByRole('button', { name: /^Confirm removing everything approved for/ }));
    await waitFor(() => expect(screen.getByText(/couldn't be found/i)).toBeTruthy());
    expect(screen.getByText('cmd-0')).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(1);
  });

  // The stress fixture's worktree shares its basename with its parent repo, so a
  // name built from basename alone renders two identical names over two
  // genuinely different rule sets — the user revokes from whichever they guessed.
  it('disambiguates two projects whose folders share a name', async () => {
    list.mockResolvedValue([
      { slug: '-home-d-youcoded-dev-youcoded', cwd: '/home/d/youcoded-dev/youcoded',
        rules: [{ tool: 'Bash', pattern: 'a', action: 'allow' }] },
      { slug: '-home-d-youcoded-dev-worktrees-youcoded', cwd: '/home/d/youcoded-dev/worktrees/youcoded',
        rules: [{ tool: 'Bash', pattern: 'b', action: 'allow' }] },
      // A third project whose name is already unique must NOT be widened.
      { slug: '-home-d-notes', cwd: '/home/d/notes',
        rules: [{ tool: 'Bash', pattern: 'c', action: 'allow' }] },
    ]);
    render(<PermissionsSection />);
    expect(await screen.findByText('youcoded-dev/youcoded')).toBeTruthy();
    expect(screen.getByText('worktrees/youcoded')).toBeTruthy();
    expect(screen.queryByText('youcoded')).toBeNull();
    expect(screen.getByText('notes')).toBeTruthy();
  });

  it('renders an empty state rather than an error when nothing is granted', async () => {
    list.mockResolvedValue([]);
    render(<PermissionsSection />);
    // First-run, not a failure — and the same sentence names the one action
    // that fills the list. Asserted on the empty state's own text rather than
    // with a page-wide query: the section's explanatory band says "Always
    // allow" too, so a loose match would pass without the empty state saying
    // anything at all.
    const empty = await screen.findByText(/nothing yet/i);
    expect(empty.textContent).toMatch(/always allow/i);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('uses the general two-action error card when the list cannot be read', async () => {
    list.mockRejectedValue(new Error('nope'));
    render(<PermissionsSection />);
    // <ErrorState mode="general"> — never a hand-rolled card, never a guessed cause.
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Report bug' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Diagnose with the assistant' })).toBeTruthy();
  });
});

describe('PermissionsSection — when the list is re-read', () => {
  // There is no Refresh button, so these two triggers are the whole freshness
  // story. If either stops firing the screen silently serves a stale list, which
  // is exactly the state the "couldn't be found" copy above exists to explain.

  it('reloads every time the screen is mounted, which is every time it opens', async () => {
    // <Dialog> is `if (!open) return null`, so closing it unmounts this
    // component and reopening mounts a fresh one — the mount effect IS the
    // reload. cleanup() is that unmount.
    list.mockResolvedValue([{ slug: '-p', cwd: '/p', rules: commands(2) }]);
    render(<PermissionsSection />);
    await screen.findByRole('button', { name: /^p/ });
    expect(list).toHaveBeenCalledTimes(1);

    cleanup();                       // the dialog closed
    render(<PermissionsSection />);  // …and was opened again
    await screen.findByRole('button', { name: /^p/ });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('re-reads after a removal actually lands', async () => {
    const rule = { tool: 'Bash', pattern: 'ls', action: 'allow' };
    list.mockResolvedValue([{ slug: '-p', cwd: '/p', rules: [rule] }]);
    remove.mockResolvedValue(true);
    render(<PermissionsSection />);
    await openFolder(/^p/);
    expect(list).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /^Revoke permission:/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Confirm revoking permission:/ }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('re-reads after a bulk revoke actually lands', async () => {
    list.mockResolvedValue([{ slug: '-p', cwd: '/p', rules: commands(2) }]);
    removeProject.mockResolvedValue(true);
    render(<PermissionsSection />);
    await openFolder(/^p/);
    expect(list).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke all 2 permissions for p' }));
    fireEvent.click(screen.getByRole('button', { name: /^Confirm removing everything approved for/ }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
});

// D2 (2026-08-26) — permissions.json grew ONE key that is not a folder: the
// bucket holding grants on the user's own file-defined specialists, which are
// in force wherever they are working. It arrives from permissions:list looking
// like any other StoredProject, and everything about how it READS has to say it
// is not a place — or the screen goes back to filing an everywhere-grant under
// one folder's name, which is the false claim this whole fix exists to end.
describe('PermissionsSection — the "All projects" card', () => {
  const taskRule = { tool: 'Task', pattern: 'read-write:file:docs-writer@a1b2c3d4e5f6', action: 'allow', match: 'exact' };
  const otherTaskRule = { tool: 'Task', pattern: 'read-only:file:notes@0f1e2d3c4b5a', action: 'allow', match: 'exact' };

  it('reads first, is titled in words, and explains itself instead of apologising for a missing path', async () => {
    list.mockResolvedValue([
      { slug: '-home-d-alpha', cwd: '/home/d/alpha', rules: commands(2) },
      { slug: CROSS_PROJECT_SLUG, rules: [taskRule] },
    ]);
    render(<PermissionsSection />);

    // The bucket arrives SECOND from the backend and must still read first.
    const headers = await screen.findAllByRole('button', { expanded: false });
    expect(headers).toHaveLength(2);
    expect(headers[0].textContent).toContain('All projects');
    expect(headers[1].textContent).toContain('alpha');

    expect(headers[0].textContent).toContain('These apply in every folder');
    // Never the raw storage key, and never the wording for a folder whose path
    // was lost — nothing is missing here, this card never had a path.
    expect(screen.queryByText(CROSS_PROJECT_SLUG)).toBeNull();
    expect(screen.queryByText(/wasn't recorded/i)).toBeNull();
  });

  it('takes one approval back with the reserved slug, like any other card', async () => {
    list.mockResolvedValue([{ slug: CROSS_PROJECT_SLUG, rules: [taskRule] }]);
    remove.mockResolvedValue(true);
    render(<PermissionsSection />);
    await openFolder(/All projects/);

    fireEvent.click(screen.getByRole('button', { name: /^Revoke permission:/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Confirm revoking permission:/ }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(
      CROSS_PROJECT_SLUG,
      expect.objectContaining({ tool: 'Task', pattern: taskRule.pattern }),
    ));
  });

  it('routes its "revoke all" with the reserved slug too', async () => {
    list.mockResolvedValue([{ slug: CROSS_PROJECT_SLUG, rules: [taskRule, otherTaskRule] }]);
    removeProject.mockResolvedValue(true);
    render(<PermissionsSection />);
    await openFolder(/All projects/);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke all 2 permissions for All projects' }));
    fireEvent.click(screen.getByRole('button', { name: /^Confirm removing everything approved for/ }));
    await waitFor(() => expect(removeProject).toHaveBeenCalledWith(CROSS_PROJECT_SLUG));
  });
});

// Destin's 2026-08-26/27 copy review found a CORRECTNESS bug in the (i)
// explainer, not just a wording one: it claimed every approval belongs to the
// folder it was given in. A grant on a helper from your own specialists folder
// is minted with no work dir (tools/task.ts permissionSubject), stored under
// CROSS_PROJECT_SLUG, and rendered on this very screen under "All projects" —
// so the old sentence contradicted the list right next to it. This pins the
// correction, which is the one claim on that screen a user could act on and be
// wrong about.
describe('the (i) explainer on where an approval reaches', () => {
  const section = () =>
    PERMISSIONS_EXPLAINER_SECTIONS.find((s) => s.heading === "Approvals you've already given");

  it('does not claim every approval is folder-scoped', () => {
    const text = (section()?.paragraphs ?? []).join(' ');
    expect(text).not.toMatch(/Every approval belongs to the folder/);
    expect(text).toMatch(/Most approvals belong to the folder you were working in/);
  });

  it('names your own specialists as the every-folder exception, under the heading the list uses', () => {
    const text = (section()?.paragraphs ?? []).join(' ');
    expect(text).toMatch(/The exception is your own specialists/);
    expect(text).toMatch(/applies in every folder, under \u201cAll projects\u201d/);
  });
});
