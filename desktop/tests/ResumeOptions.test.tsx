// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ResumeOptionsForm, useResumeOptions } from '../src/renderer/components/ResumeOptions';
import type { PastSession } from '../src/shared/types';
import { REMOTE_SCREEN_CAPABILITIES } from '../src/shared/capabilities';

afterEach(cleanup);

it('passes the selected saved title separately from the runtime creation placeholder', async () => {
  const row = { sessionId: 'saved-id', name: 'My saved research', projectSlug: 'project',
    projectPath: '/project', provider: 'claude', lastModified: 1 } as PastSession;
  const onResume = vi.fn().mockResolvedValue(true);
  function Choice() {
    const options = useResumeOptions('sonnet');
    return <button onClick={() => { void options.resume(row, onResume); }}>Resume saved conversation</button>;
  }
  render(<Choice />);
  fireEvent.click(screen.getByRole('button', { name: 'Resume saved conversation' }));
  await waitFor(() => expect(onResume).toHaveBeenCalledWith('saved-id', 'project', '/project',
    'sonnet', false, false, 'claude', undefined, 'My saved research'));
});

it('resuming a native conversation from a phone still offers the native models: the computer resumes it', async () => {
  (window as any).claude = {
    capabilities: REMOTE_SCREEN_CAPABILITIES,
    providers: { list: async () => [{ id: 'cloud', type: 'openrouter', label: 'Cloud', ready: true }], catalog: async () => [{ id: 'nimbus-1', providerId: 'cloud', label: 'Nimbus Native One' }] },
    models: { onDownloadProgress: () => () => {} },
  };
  const row = { sessionId: 'n1', name: 'Native chat', projectSlug: 'p', projectPath: '/p', provider: 'native', lastModified: 1 } as PastSession;
  function Form() {
    const options = useResumeOptions('sonnet');
    return <ResumeOptionsForm session={row} options={options} onResume={() => {}} />;
  }
  render(<Form />);
  fireEvent.click(await screen.findByRole('button', { name: 'Model' }));
  fireEvent.change(await screen.findByLabelText('Search all models'), { target: { value: 'Nimbus' } });
  expect(await screen.findByText('Nimbus Native One')).toBeTruthy();
  delete (window as any).claude;
});
