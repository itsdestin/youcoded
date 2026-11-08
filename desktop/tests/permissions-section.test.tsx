// @vitest-environment jsdom
// Settings -> Permissions (PermissionsSection.tsx): explains the three modes, lists every remembered "Always allow", lets the user revoke each.
// The folder rows are an OVERVIEW (collapsed on arrival, count on the band); the modes block is REFERENCE CONTENT, not a control
// (the owner rejected three selector shapes because mode is per-conversation state set from the status-bar chip).
// The jsdom docblock is mandatory (vitest runs `node` by default); cleanup is explicit because `globals` is off.

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

/** Open a folder card by its visible name (every folder starts collapsed: a screen whose height depends on how much you approved is a different screen each time). */
async function openFolder(name: RegExp | string) {
  const header = await screen.findByRole('button', { name });
  fireEvent.click(header);
  return header;
}
const clickRevoke = () => {
  fireEvent.click(screen.getByRole('button', { name: /^Revoke permission:/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Confirm revoking permission:/ }));
};
const clickRevokeAll = (label: string) => {
  fireEvent.click(screen.getByRole('button', { name: label }));
  fireEvent.click(screen.getByRole('button', { name: /^Confirm removing everything approved for/ }));
};

describe('PermissionsSection — the overview', () => {
  it('gives each folder one collapsible band carrying its count, collapsed however small the list', async () => {
    list.mockResolvedValue([
      { slug: '-a', cwd: '/home/d/alpha', rules: commands(9) },
      { slug: '-b', cwd: '/home/d/beta', rules: commands(9) },
      { slug: '-c', cwd: '/home/d/gamma', rules: commands(9) },
    ]);
    render(<PermissionsSection />);
    const header = await screen.findByRole('button', { name: /alpha/i });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.textContent).toContain('9');
    expect(screen.queryByText('cmd-0')).toBeNull();

    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('cmd-0')).toBeTruthy();
    cleanup();
    list.mockResolvedValue([{ slug: '-a', cwd: '/home/d/alpha', rules: commands(3) }]);
    render(<PermissionsSection />);
    expect((await screen.findByRole('button', { name: /alpha/i })).getAttribute('aria-expanded')).toBe('false');
  });

  // WHY: a folder name is user data, rendered as a row; labels are reserved for authored strings (an early draft shouted YOUCODED-DEV).
  it('renders folder names as rows, never as section labels', async () => {
    list.mockResolvedValue([
      { slug: '-home-d-MyNotes', cwd: '/home/d/MyNotes', rules: commands(3) },
      { slug: '-home-destin-notes', rules: commands(3) },
    ]);
    render(<PermissionsSection />);

    // The labels on this screen are the two authored ones.
    expect(await screen.findByRole('heading', { name: 'Always allowed' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Permission modes' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /MyNotes/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /-home-destin-notes/ })).toBeNull();

    // The name is a row title in its true casing; the path is its description.
    expect(screen.getByText('MyNotes')).toBeTruthy();
    const header = screen.getByRole('button', { name: /MyNotes/ });
    expect(header.textContent).toContain('/home/d/MyNotes');

    // Kind headings inside an open folder ARE genuine labels.
    fireEvent.click(header);
    expect(screen.getAllByRole('heading', { name: 'Commands' })[0]).toBeTruthy();
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
  // WHY: a control that sets nothing is a lie in the shape of a control. Asserted structurally so a FOURTH rejected shape fails too.
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

  it('opens the modes card with the backup warning, before the first mode', async () => {
    list.mockResolvedValue([]);
    render(<PermissionsSection />);
    const block = modesBlock();
    const text = block.textContent ?? '';
    // WHY: the warning is found by its key word (not its sentence) and must sit before the first mode.
    const warningAt = text.search(/backup/i);
    expect(warningAt).toBeGreaterThanOrEqual(0);
    expect(warningAt).toBeLessThan(text.indexOf('Ask first'));
  });

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
    list.mockResolvedValue([]);
    render(<PermissionsSection />);
    await screen.findByRole('heading', { name: 'Permission modes' });
    expect(modesBlock().textContent).toMatch(/bar at the bottom of the chat/i);
  });

  it('hangs the always-asks list off Full auto and nowhere else', async () => {
    // WHY: Ask first and Auto edit already stop before every command, so the list is only an exception under Full auto.
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

  // WHY: a specialist grant must be a DISTINCT row from an identical root grant (a React key collision would silently drop one).
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
    clickRevoke();
    await waitFor(() => expect(remove).toHaveBeenCalledWith('-p', { tool: 'Bash', pattern: 'npm test*', action: 'allow', specialist: 'worker' }));
  });

  // WHY: a scoped grant is narrow by construction; a breadth note on it would teach users to ignore the note where it is true.
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

  // WHY: the confirm guards against a mis-click; a single-click revoke would be a regression.
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
    clickRevoke();
    await waitFor(() => expect(screen.getByText(/couldn't be found/i)).toBeTruthy());
    // The row is still on screen — reporting success would teach the user to
    // trust a list that lied to them.
    expect(screen.getByText('ls')).toBeTruthy();
    // …and nothing was re-read, because nothing changed.
    expect(list).toHaveBeenCalledTimes(1);
  });


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
    clickRevokeAll('Revoke all 2 permissions for p');
    await waitFor(() => expect(screen.getByText(/couldn't be found/i)).toBeTruthy());
    expect(screen.getByText('cmd-0')).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(1);
  });

  // WHY: a worktree shares its basename with its parent repo; identical names over different rule sets would make the user guess.
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
    // Asserted on the empty state's own text: the explanatory band says "Always allow" too, so a page-wide query would pass vacuously.
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
  // WHY: there is no Refresh button, so mount and a landed removal are the whole freshness story.

  it('reloads every time the screen is mounted, which is every time it opens', async () => {
    // <Dialog> unmounts on close, so the mount effect IS the reload; cleanup() is that unmount.
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

    clickRevoke();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('re-reads after a bulk revoke actually lands', async () => {
    list.mockResolvedValue([{ slug: '-p', cwd: '/p', rules: commands(2) }]);
    removeProject.mockResolvedValue(true);
    render(<PermissionsSection />);
    await openFolder(/^p/);
    expect(list).toHaveBeenCalledTimes(1);

    clickRevokeAll('Revoke all 2 permissions for p');
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
});

// WHY: one permissions.json key is not a folder but the everywhere-grants bucket; it must READ as not-a-place, or an everywhere-grant is filed under one folder.
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
    // The "Commands that never ask" fold is also a closed header; it is not a folder card.
    const folderHeaders = () => screen.getAllByRole('button', { expanded: false }).filter((b) => !(b.textContent ?? '').includes('Look-only commands'));
    await waitFor(() => expect(folderHeaders()).toHaveLength(2));
    const headers = folderHeaders();
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

    clickRevoke();
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

    clickRevokeAll('Revoke all 2 permissions for All projects');
    await waitFor(() => expect(removeProject).toHaveBeenCalledWith(CROSS_PROJECT_SLUG));
  });
});

// WHY: the (i) explainer once claimed every approval belongs to its folder, contradicting the "All projects" list beside it.
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
