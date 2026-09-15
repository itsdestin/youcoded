// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CloudReadDialog, readWithCloudConsent, dismissCloudRead } from '../src/renderer/components/project-view/CloudReadDialog';
afterEach(() => { dismissCloudRead(); cleanup(); });
const needs = { ok: false, error: 'needs-download', path: 'C:\\Files\\paper.pdf', name: 'paper.pdf', operationToken: 'exact-token' };
it('production viewer dialog denies without invoking a consent read', async () => {
  const read = vi.fn().mockResolvedValue(needs);
  render(<CloudReadDialog />);
  let result!: Promise<any>;
  await act(async () => { result = readWithCloudConsent(read, () => false); });
  expect(screen.getByText(needs.path)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
  expect(await result).toMatchObject({ error: 'download-dismissed' });
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith({ intent: 'explicit' });
});
it('sends only the exact token on Allow and X prevents late auto-open', async () => {
  let finish!: (result: any) => void;
  const read = vi.fn().mockResolvedValueOnce(needs).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<CloudReadDialog />);
  let result!: Promise<any>;
  await act(async () => { result = readWithCloudConsent(read, () => false); });
  fireEvent.click(screen.getByRole('button', { name: 'Download and open' }));
  expect(read).toHaveBeenLastCalledWith({ intent: 'explicit', operationToken: 'exact-token' });
  expect(screen.getByText('Downloading file. You may wait or leave this page.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /Close/ }));
  await act(async () => { finish({ ok: true, base64: 'Zm9v' }); });
  expect(await result).toMatchObject({ error: 'download-dismissed' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
