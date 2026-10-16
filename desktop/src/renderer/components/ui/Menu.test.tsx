// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { EscCloseProvider } from '../../hooks/use-esc-close';
import { Menu, MenuItem, MenuNote, MenuRadioItem } from './Menu';

// The shared small menu (games-social friction, proposal 8): outside click, Escape, roles and
// keys are what the two hand copies it replaced got differently, so each is pinned here.
afterEach(cleanup);

function Harness({ onPick = () => {}, initial = false }: { onPick?: (v: string) => void; initial?: boolean }) {
  const [open, setOpen] = useState(initial);
  const [value, setValue] = useState('online');
  return (
    <EscCloseProvider>
      <p>Outside</p>
      <Menu
        open={open}
        onOpenChange={setOpen}
        label="Your status"
        trigger={<button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>Status</button>}
      >
        <MenuNote>Pick one</MenuNote>
        <MenuRadioItem checked={value === 'online'} onSelect={() => { setValue('online'); onPick('online'); }} hint="Friends see you">Online</MenuRadioItem>
        <MenuRadioItem checked={value === 'hidden'} onSelect={() => { setValue('hidden'); onPick('hidden'); }}>Incognito</MenuRadioItem>
        <MenuItem onSelect={() => onPick('out')}>Sign out</MenuItem>
      </Menu>
    </EscCloseProvider>
  );
}

const esc = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });

describe('Menu', () => {
  it('is a named menu of menuitemradio / menuitem choices, shown only while open', () => {
    const { getByRole, queryByRole, getAllByRole } = render(<Harness />);
    expect(queryByRole('menu')).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Status' }));
    expect(getByRole('menu', { name: 'Your status' })).toBeTruthy();
    const radios = getAllByRole('menuitemradio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(getByRole('menuitem', { name: 'Sign out' })).toBeTruthy();
    // The hint is part of the item's name, so a screen reader hears what choosing it does.
    expect(getByRole('menuitemradio', { name: /Online.*Friends see you/ })).toBeTruthy();
  });

  it('closes on a press outside it, and not on a press inside it', () => {
    const { getByRole, getByText, queryByRole } = render(<Harness initial />);
    fireEvent.mouseDown(getByRole('menu'));
    expect(queryByRole('menu')).not.toBeNull();
    fireEvent.mouseDown(getByText('Outside'));
    expect(queryByRole('menu')).toBeNull();
  });

  it('closes on Escape and gives focus back to the trigger when it had it', () => {
    const { getByRole, queryByRole } = render(<Harness />);
    const trigger = getByRole('button', { name: 'Status' });
    trigger.focus();
    fireEvent.click(trigger);
    // Opened with focus on the trigger: focus moves to the CHOSEN item, not just the first.
    expect(document.activeElement).toBe(getByRole('menuitemradio', { name: /Online/ }));
    esc();
    expect(queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('choosing an item runs it and closes the menu', () => {
    const onPick = vi.fn();
    const { getByRole, queryByRole } = render(<Harness onPick={onPick} initial />);
    fireEvent.click(getByRole('menuitemradio', { name: /Incognito/ }));
    expect(onPick).toHaveBeenCalledWith('hidden');
    expect(queryByRole('menu')).toBeNull();
  });

  it('arrow keys, Home and End move between the choices, skipping the plain note', () => {
    const { getByRole } = render(<Harness />);
    const trigger = getByRole('button', { name: 'Status' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });   // the menu-button pattern: ↓ opens it
    const online = getByRole('menuitemradio', { name: /Online/ });
    const incognito = getByRole('menuitemradio', { name: /Incognito/ });
    const out = getByRole('menuitem', { name: 'Sign out' });
    expect(document.activeElement).toBe(online);
    fireEvent.keyDown(online, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(incognito);
    fireEvent.keyDown(incognito, { key: 'End' });
    expect(document.activeElement).toBe(out);
    fireEvent.keyDown(out, { key: 'ArrowDown' });       // wraps round
    expect(document.activeElement).toBe(online);
    fireEvent.keyDown(online, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(out);
    fireEvent.keyDown(out, { key: 'Home' });
    expect(document.activeElement).toBe(online);
  });

  it('Tab leaves the menu and closes it', () => {
    const { getByRole, queryByRole } = render(<Harness initial />);
    fireEvent.keyDown(getByRole('menuitem', { name: 'Sign out' }), { key: 'Tab' });
    expect(queryByRole('menu')).toBeNull();
  });
});
