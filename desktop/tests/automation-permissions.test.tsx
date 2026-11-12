// @vitest-environment jsdom
// Adding an automation's permission by hand (components/automations/AutomationPermissions.tsx, 2026-11-12 round):
// the Add menu lists kinds only; a kind with a detail opens a small form; "Describe it…" shows what was written
// before it is added; a new permission starts as Asks first.
import React, { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PermissionsField, type AddStep } from '../src/renderer/components/automations/AutomationPermissions';
import type { AutomationTool } from '../src/shared/automation-types';

function Host({ start = null, initial = [] as AutomationTool[], seen }: { start?: AddStep; initial?: AutomationTool[]; seen: { tools: AutomationTool[] } }) {
  const [tools, setTools] = useState(initial);
  const [menu, setMenu] = useState(start === null);
  seen.tools = tools;
  return <PermissionsField tools={tools} unlisted={{ sites: 'never', commands: 'never' }} onChange={setTools} onUnlisted={() => {}} menuOpen={menu} onMenu={setMenu} startStep={start} />;
}

describe('adding a permission by hand', () => {
  it('lists kinds only: no Gmail and no notifications (step 5 and the notifications work bring those)', () => {
    render(<Host seen={{ tools: [] }} />);
    const items = screen.getAllByRole('menuitem').map((m) => m.textContent);
    expect(items).toEqual(['Read its information', 'Change its information', 'A folder…', 'A command…', 'A website…', 'Describe it…']);
  });

  it('a folder is added with what it may do there, set to Asks first', () => {
    const seen = { tools: [] as AutomationTool[] };
    render(<Host start="folder" seen={seen} />);
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '~/Notes' } });
    fireEvent.click(screen.getByText('See and change files'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(seen.tools).toMatchObject([{ kind: 'folder', label: 'Change the files in a folder', exact: '~/Notes', mode: 'ask' }]);
  });

  it('a command keeps the person\'s own name for it over what it matches, and cannot be added empty', () => {
    const seen = { tools: [] as AutomationTool[] };
    render(<Host start="command" seen={seen} />);
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '  ' } });
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Back up my notes' } });
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'rsync ~/Notes/* /mnt/backup' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(seen.tools).toMatchObject([{ kind: 'command', label: 'Back up my notes', exact: 'rsync ~/Notes/* /mnt/backup', mode: 'ask' }]);
  });

  it('Describe it… shows the written permission first, and adds nothing until Add', () => {
    const seen = { tools: [] as AutomationTool[] };
    render(<Host start="describe" seen={seen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Write it' }));
    expect(screen.getByText('Written for you')).toBeInTheDocument();
    expect(seen.tools).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(seen.tools).toHaveLength(1);
    expect(seen.tools[0]).toMatchObject({ kind: 'command', mode: 'ask' });
  });

  it('Cancel adds nothing and brings the Add button back', () => {
    const seen = { tools: [] as AutomationTool[] };
    render(<Host start="site" seen={seen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(seen.tools).toEqual([]);
    expect(screen.getByRole('button', { name: 'Add a permission' })).toBeInTheDocument();
  });
});
