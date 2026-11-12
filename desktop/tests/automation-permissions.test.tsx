// @vitest-environment jsdom
// Adding an automation's permission by hand (components/automations/AutomationPermissions.tsx, 2026-11-12 round):
// the Add menu lists kinds only; a kind with a detail opens ONE control (the folder chooser, or a field with its
// action inside); "Describe it…" shows what was written
// before it is added; a new permission starts as Asks first.
import React, { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PermissionsField, type AddStep } from '../src/renderer/components/automations/AutomationPermissions';
import type { AutomationTool } from '../src/shared/automation-types';

function Host({ start = null, initial = [] as AutomationTool[], seen }: { start?: AddStep; initial?: AutomationTool[]; seen: { tools: AutomationTool[] } }) {
  const [tools, setTools] = useState(initial);
  const [menu, setMenu] = useState(start === null);
  seen.tools = tools;
  return <PermissionsField chooseFolder={async () => '~/Notes'} tools={tools} unlisted={{ sites: 'never', commands: 'never' }} onChange={setTools} onUnlisted={() => {}} menuOpen={menu} onMenu={setMenu} startStep={start} />;
}

describe('adding a permission by hand', () => {
  it('lists kinds only: no Gmail and no notifications (step 5 and the notifications work bring those)', () => {
    render(<Host seen={{ tools: [] }} />);
    const items = screen.getAllByRole('menuitem').map((m) => m.textContent);
    expect(items).toEqual(['Read its information', 'Change its information', 'See the files in a folder…', 'Change the files in a folder…', 'Run a command…', 'Visit a website…', 'Describe it…']);
  });

  it('a folder is chosen in the computer\'s own folder window and added at once, set to Asks first', async () => {
    const seen = { tools: [] as AutomationTool[] };
    (window as any).claude = { capabilities: { openInOs: true } };
    render(<Host start="folder-change" seen={seen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    await waitFor(() => expect(seen.tools).toHaveLength(1));
    expect(seen.tools).toMatchObject([{ kind: 'folder', label: 'Change the files in a folder', exact: '~/Notes', mode: 'ask' }]);
    delete (window as any).claude;
  });

  it('a command is one box with Add inside it, and cannot be added empty', () => {
    const seen = { tools: [] as AutomationTool[] };
    render(<Host start="command" seen={seen} />);
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '  ' } });
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'rsync ~/Notes/* /mnt/backup' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(seen.tools).toMatchObject([{ kind: 'command', label: 'Run a command', exact: 'rsync ~/Notes/* /mnt/backup', mode: 'ask' }]);
  });

  it('Describe it… shows the written permission first, and adds nothing until Add', () => {
    const seen = { tools: [] as AutomationTool[] };
    render(<Host start="describe" seen={seen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Write it' }));
    expect(screen.getByText('Written for you')).toBeInTheDocument();
    expect(seen.tools).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(seen.tools).toHaveLength(1);
    expect(seen.tools[0]).toMatchObject({ kind: 'command', label: 'Turn recordings into text', mode: 'ask' });
  });

  it('the × adds nothing and brings the Add button back', () => {
    const seen = { tools: [] as AutomationTool[] };
    render(<Host start="site" seen={seen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(seen.tools).toEqual([]);
    expect(screen.getByRole('button', { name: 'Add a permission' })).toBeInTheDocument();
  });
});
