// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useResumeOptions } from '../src/renderer/components/ResumeOptions';
import type { PastSession } from '../src/shared/types';

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
