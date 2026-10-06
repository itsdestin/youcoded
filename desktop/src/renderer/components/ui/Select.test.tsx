// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { Select } from './Select';
import { POPOVER_Z } from '../overlays/Overlay';

// WHY: testing-library does not auto-cleanup in vitest; without this each test
// accumulates DOM (including the portaled menus on document.body) and queries
// match stale renders from a previous test.
afterEach(cleanup);

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
];

function openMenu(getByRole: ReturnType<typeof render>['getByRole'], label: string) {
  fireEvent.click(getByRole('button', { name: label }));
}

describe('Select popover tier (z-index)', () => {
  it('defaults the menu to the L4 overlay z-index (100)', () => {
    const { getByRole } = render(
      <Select options={OPTIONS} value="a" onChange={() => {}} aria-label="Plain" />,
    );
    openMenu(getByRole, 'Plain');
    const menu = getByRole('listbox', { name: 'Plain' }).closest('[data-select-portal]') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.style.zIndex).toBe('100');
  });

  it('renders the menu at POPOVER_Z when escapeHost is set (z-9000 host)', () => {
    // Pins the SessionStrip new-session fix: the provider/model Selects live in
    // the z-9000 SessionStrip dropdown, so their menus must escape above it or
    // they render behind the host and are unclickable. If this regresses, the
    // dropdowns silently vanish again.
    const { getByRole } = render(
      <Select options={OPTIONS} value="a" onChange={() => {}} aria-label="Hosted" escapeHost />,
    );
    openMenu(getByRole, 'Hosted');
    const menu = getByRole('listbox', { name: 'Hosted' }).closest('[data-select-portal]') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.style.zIndex).toBe(String(POPOVER_Z));
  });
});

describe('Select menu geometry', () => {
  it('matches the field width and centers the menu under the field', () => {
    // Pins Destin's ask: menu is exactly the trigger's width, centered under it
    // (equal widths → centers align), clamped to the viewport. jsdom reports
    // all rects as 0, so we stub the trigger's bounding rect to a known box.
    const { getByRole } = render(
      <Select options={OPTIONS} value="a" onChange={() => {}} aria-label="Geom" />,
    );
    const trigger = getByRole('button', { name: 'Geom' });
    trigger.getBoundingClientRect = () =>
      ({ left: 100, top: 50, bottom: 80, right: 300, width: 200, height: 30, x: 100, y: 50, toJSON: () => ({}) }) as DOMRect;
    fireEvent.click(trigger);
    const menu = getByRole('listbox', { name: 'Geom' }).closest('[data-select-portal]') as HTMLElement;
    // width = trigger width (200); centered left = 100 + 100 - 100 = 100.
    expect(menu.style.width).toBe('200px');
    expect(menu.style.left).toBe('100px');
  });

  it('clamps the menu to the viewport when the trigger sits near the left edge', () => {
    const { getByRole } = render(
      <Select options={OPTIONS} value="a" onChange={() => {}} aria-label="Edge" />,
    );
    const trigger = getByRole('button', { name: 'Edge' });
    trigger.getBoundingClientRect = () =>
      ({ left: 2, top: 50, bottom: 80, right: 202, width: 200, height: 30, x: 2, y: 50, toJSON: () => ({}) }) as DOMRect;
    fireEvent.click(trigger);
    const menu = getByRole('listbox', { name: 'Edge' }).closest('[data-select-portal]') as HTMLElement;
    // centered left would be negative → clamped to the 8px margin.
    expect(menu.style.left).toBe('8px');
  });
});

describe('Select portal marker', () => {
  it('marks the portaled menu with data-select-portal so hosts/other Selects can see it', () => {
    // The marker is what SessionStrip's outside-click exemption and the
    // cross-Select mousedown tolerance key off. Without it, clicking an option
    // closes the host menu (and unmounts the Select) before onChange fires.
    const { getByRole } = render(
      <Select options={OPTIONS} value="a" onChange={() => {}} aria-label="Marked" />,
    );
    openMenu(getByRole, 'Marked');
    expect(document.querySelector('[data-select-portal]')).not.toBeNull();
  });
});

describe('Select cross-portal mousedown tolerance', () => {
  it('does not close an open Select when the mousedown lands inside ANOTHER Select menu', () => {
    const { getByRole, queryByRole } = render(
      <>
        <Select options={OPTIONS} value="a" onChange={() => {}} aria-label="First" />
        <Select options={OPTIONS} value="a" onChange={() => {}} aria-label="Second" />
      </>,
    );
    // Open the first Select, then open the second (its own menu portals out).
    openMenu(getByRole, 'First');
    openMenu(getByRole, 'Second');
    // A mousedown on the SECOND menu's option must NOT be treated as "outside"
    // by the first Select's listener (which would close it); both portals live
    // on document.body outside either trigger.
    const secondMenu = getByRole('listbox', { name: 'Second' });
    fireEvent.mouseDown(secondMenu);
    // The first Select's menu is still open (its listbox still present).
    expect(queryByRole('listbox', { name: 'First' })).not.toBeNull();
  });
});

describe('Select trigger width', () => {
  // WHY (games-social friction, proposal 11): the trigger's own `w-full` and a caller's
  // `w-32` both reached the class list, so Tailwind's CSS source order picked `w-full` and
  // the dropdown silently filled its row — in round 2 it covered the friends card's summary
  // line. A caller's width now REPLACES the default, the same conflict-group rule Button uses.
  it('is full width by default', () => {
    const { getByRole } = render(<Select options={OPTIONS} value="a" onChange={() => {}} aria-label="Default" />);
    expect(getByRole('button', { name: 'Default' }).className.split(/\s+/)).toContain('w-full');
  });

  it("takes the caller's width instead of full width", () => {
    const { getByRole } = render(<Select options={OPTIONS} value="a" onChange={() => {}} aria-label="Sized" className="w-32 shrink-0" />);
    const cls = getByRole('button', { name: 'Sized' }).className.split(/\s+/);
    expect(cls).toContain('w-32');
    expect(cls).not.toContain('w-full');
    expect(cls).toContain('shrink-0');          // a class in no conflict group is kept
    expect(cls).toContain('justify-between');   // and the trigger's own layout survives
  });

  it("a caller's display or gap replaces the trigger's, never doubles it", () => {
    const { getByRole } = render(<Select options={OPTIONS} value="a" onChange={() => {}} aria-label="Gap" className="gap-1" />);
    const cls = getByRole('button', { name: 'Gap' }).className.split(/\s+/);
    expect(cls).toContain('gap-1');
    expect(cls).not.toContain('gap-2');
  });
});
