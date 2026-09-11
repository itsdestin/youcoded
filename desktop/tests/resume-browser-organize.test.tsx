// @vitest-environment jsdom
// desktop/tests/resume-browser-organize.test.tsx
//
// The Resume Browser's per-card organize affordances: the Complete check icon
// on the card, and the tag icon that opens an in-card sheet holding tags + note.
// Four of these behaviours are design decisions that are easy to undo by
// accident, so they are pinned here rather than left to a visual pass:
//
//   1. Complete is reachable in ONE click from the card, not behind the sheet.
//   2. Priority is applied through the tag picker like any other tag, but is
//      not a registry tag — toggling it writes a FLAG, and it never appears in
//      the tag manager (so it can't be renamed or deleted out from under the
//      sort that reads it).
//   3. The resume pane and the tag sheet are MUTUALLY EXCLUSIVE — a card shows
//      one or the other, never both stacked.
//   4. A row that cannot be resumed on this device can still be organized.
//      Inert rows never expand, and the sheet opens independently of expansion,
//      which is the only reason those rows are reachable at all.
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ResumeBrowser from '../src/renderer/components/ResumeBrowser';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

beforeAll(() => {
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(cleanup);

// These pin the SINGLE-COLUMN browser — the layout a phone, a narrow window or
// Android gets, where clicking a card still expands the resume controls inside
// it. On a wide desktop the same click fills the preview panel instead and the
// controls live in the card at its foot (the 2026-09-10 design rounds), so
// without this stub jsdom (which has no matchMedia, hence "wide") would run
// these against a layout whose cards deliberately never expand.
(window as any).matchMedia = (q: string) => ({
  matches: q === '(max-width: 639.98px)',
  media: q,
  addEventListener: () => {},
  removeEventListener: () => {},
});

const TAGS = [{ id: 'tag_a', label: 'Research', color: 'tag-blue', archived: false, createdAt: '' }];

function row(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'cc-1',
    name: 'CC Chat',
    projectSlug: 'proj',
    projectPath: '/tmp/proj',
    lastModified: Date.now(),
    size: 200,
    provider: 'claude',
    ...overrides,
  };
}

function mockWindowClaude(sessions: any[] = [row()]) {
  (window as any).claude = {
    session: {
      browse: vi.fn().mockResolvedValue(sessions),
      setFlag: vi.fn().mockResolvedValue({ ok: true }),
      setTag: vi.fn().mockResolvedValue({ ok: true }),
      setNote: vi.fn().mockResolvedValue({ ok: true }),
    },
    tags: {
      list: vi.fn().mockResolvedValue(TAGS),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    providers: { catalog: vi.fn().mockResolvedValue([]), list: vi.fn().mockResolvedValue([]) },
    on: {},
  };
}

const mount = () => render(<ResumeBrowser open={true} onClose={() => {}} onResume={() => {}} />);

describe('ResumeBrowser — organizing a conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWindowClaude();
  });

  it('opens rename from the full accessible name without expanding or resuming the card', async () => {
    (window as any).claude.sessionNaming = {
      title: vi.fn().mockResolvedValue({ title: 'CC Chat', manual: false }),
    };
    const onResume = vi.fn();
    const bubbled = vi.fn();
    render(<div onClick={bubbled}><ResumeBrowser open onClose={() => {}} onResume={onResume} /></div>);
    const name = await screen.findByText('CC Chat');
    const button = screen.getByRole('button', { name: 'Rename CC Chat' });
    expect(button).toContainElement(name);
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    expect(button).toHaveClass('coarse-hit');
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(name);
    expect(await screen.findByDisplayValue('CC Chat')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume Session' })).not.toBeInTheDocument();
    expect(onResume).not.toHaveBeenCalled();
    expect(bubbled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByDisplayValue('CC Chat')).not.toBeInTheDocument();
    expect(screen.getByText('CC Chat')).toBeInTheDocument();
  });

  it('opens rename on Enter without relying on a synthesized click', async () => {
    (window as any).claude.sessionNaming = {
      title: vi.fn().mockResolvedValue({ title: 'CC Chat', manual: false }),
    };
    mount();
    const name = await screen.findByRole('button', { name: 'Rename CC Chat' });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(await screen.findByDisplayValue('CC Chat')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume Session' })).not.toBeInTheDocument();
  });

  it('matches the file viewer styling with always-visible underline and pencil', async () => {
    // WHY: the viewer is the requested visual authority, not invented sizes or
    // adjacent organize icons. Read its local implementation without changing it.
    const viewer = readFileSync(resolve('src/renderer/components/SessionDrawer.tsx'), 'utf8');
    // The hint moved from a `title` attribute to the app's own <Tooltip>, so the
    // trigger is now the button INSIDE that wrapper. Same control, same check.
    const trigger = viewer.match(/<Tooltip text="Click to rename">\s*<button[\s\S]{0,120}?className="([^"]+)"/)!;
    const label = viewer.match(/<span className="([^"]+)">\s*\{fileName\}/)!;
    const icon = viewer.match(/<span className="([^"]+)"><Ic name="pencil" size=\{(\d+)\}/)!;
    const path = viewer.match(/pencil: '([^']+)'/)!;
    expect(trigger).not.toBeNull();
    expect(label).not.toBeNull();
    expect(icon).not.toBeNull();
    expect(path).not.toBeNull();
    (window as any).claude.sessionNaming = {};
    mount();
    const button = await screen.findByRole('button', { name: 'Rename CC Chat' });
    expect(button).toHaveClass(...trigger[1].split(' '));
    // WHY: R5-1 keeps the viewer's exact style, but makes both cues visible at rest.
    const name = screen.getByText('CC Chat');
    expect(name.className).toBe(label[1].replaceAll('group-hover:', ''));
    expect(name).toHaveClass('underline', 'decoration-dotted', 'decoration-fg-muted');
    const pencil = button.querySelector('svg')!;
    expect(pencil.parentElement!.className).toBe(icon[1].split(' ').filter((token) => !token.startsWith('opacity-') && !token.startsWith('group-hover:')).join(' '));
    for (const cue of [name, pencil.parentElement!]) {
      expect(cue.className).not.toMatch(/hover:|focus:|opacity-0|invisible|hidden|touch-reveal/);
    }
    expect(pencil.getAttribute('width')).toBe(icon[2]);
    expect(pencil.getAttribute('height')).toBe(icon[2]);
    expect([...pencil.querySelectorAll('path')].map((p) => p.getAttribute('d')).join('')).toBe(path[1]);
    const ic = viewer.match(/function Ic\([\s\S]*?<svg ([\s\S]*?)>/)![1];
    for (const attribute of ['viewBox', 'fill', 'stroke', 'strokeLinecap', 'strokeLinejoin']) {
      const value = ic.match(new RegExp(`${attribute}="([^"]+)"`))![1];
      const domAttribute = attribute.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      expect(pencil.getAttribute(attribute === 'viewBox' ? attribute : domAttribute)).toBe(value);
    }
    expect(pencil.getAttribute('stroke-width')).toBe(ic.match(/strokeWidth=\{(\d+)\}/)![1]);
  });

  it('marks a session complete from the card, without opening the menu', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark CC Chat complete' }));
    expect((window as any).claude.session.setFlag).toHaveBeenCalledWith('cc-1', 'complete', true);
  });

  it('offers to undo once complete', async () => {
    mockWindowClaude([row({ flags: { complete: true } })]);
    mount();
    // Complete rows are filtered out by default — turn Show Complete on so the
    // row is listed, then assert the icon has flipped to its undo affordance.
    fireEvent.click(await screen.findByRole('switch', { name: 'Show Complete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark CC Chat not complete' }));
    expect((window as any).claude.session.setFlag).toHaveBeenCalledWith('cc-1', 'complete', false);
  });

  it('applies Priority through the tag picker but writes a flag, not a tag', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Organize CC Chat/ }));
    // Listed among the tags, ahead of the registry ones.
    fireEvent.click(await screen.findByRole('button', { name: /^Priority/ }));
    expect((window as any).claude.session.setFlag).toHaveBeenCalledWith('cc-1', 'priority', true);
    expect((window as any).claude.session.setTag).not.toHaveBeenCalled();
  });

  it('keeps the "pins to top" explanation next to Priority', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Organize CC Chat/ }));
    expect(await screen.findByText('pins to top')).toBeInTheDocument();
  });

  it('does not offer Priority for renaming or deletion in the tag manager', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Organize CC Chat/ }));
    fireEvent.click(await screen.findByText('Manage tags…'));
    // The registry tag is editable there; the built-in has no row at all.
    expect(await screen.findByRole('textbox', { name: 'Rename Research' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Rename Priority' })).not.toBeInTheDocument();
  });

  it('shows the resume pane OR the tag sheet, never both', async () => {
    mount();
    // Expand to resume…
    fireEvent.click(await screen.findByText('CC Chat'));
    expect(await screen.findByRole('button', { name: 'Resume Session' })).toBeInTheDocument();

    // …opening tags replaces it rather than stacking a second panel under it,
    // which is what would push the Resume button down the screen as you typed.
    fireEvent.click(await screen.findByRole('button', { name: /Organize CC Chat/ }));
    expect(await screen.findByPlaceholderText('Search or create a tag…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume Session' })).not.toBeInTheDocument();

    // …and back the other way.
    fireEvent.click(await screen.findByText('CC Chat'));
    expect(await screen.findByRole('button', { name: 'Resume Session' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search or create a tag…')).not.toBeInTheDocument();
  });

  it('organizes a row that cannot be resumed on this device', async () => {
    mockWindowClaude([row({ sessionId: 'cc-2', name: 'Synced Elsewhere', missingProject: true })]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Organize Synced Elsewhere/ }));
    expect(await screen.findByPlaceholderText('Search or create a tag…')).toBeInTheDocument();
  });
});
