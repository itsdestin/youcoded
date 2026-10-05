// @vitest-environment jsdom
// EditorFrame's opening half (Task 5 fix round 1): what it says when main refuses, and that a
// frame gone before main answered still hands its share of the document back.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { EditorFrame } from '../../src/renderer/components/office/EditorFrame';
import type { OfficeBridge, OfficeFile } from '../../src/shared/office-types';

const FILE: OfficeFile = { path: '/home/you/plan.docx', name: 'plan.docx', kind: 'document', folder: 'you', at: '2026-09-28T00:00:00Z' };

function withOffice(office: Partial<OfficeBridge>) {
  (window as unknown as { claude: unknown }).claude = { office };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { claude?: unknown }).claude;
});

describe('EditorFrame opening a document', () => {
  it('says Office is not available here when the host refuses Office outright', async () => {
    withOffice({ open: () => Promise.reject(new Error('remote-unsupported: office:open')), close: vi.fn(async () => {}) });
    const { findByText, queryByRole } = render(<EditorFrame file={FILE} />);
    expect(await findByText(/Office isn't available/)).toBeTruthy();
    // Retrying can never help here, so there is nothing to press.
    expect(queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it("shows main's own reason when it declines to open the file", async () => {
    withOffice({ open: async () => ({ ok: false, message: 'This file no longer exists.' }), close: vi.fn(async () => {}) });
    const { findByText } = render(<EditorFrame file={FILE} />);
    expect(await findByText('This file no longer exists.')).toBeTruthy();
  });

  it('hands back its share of the document when it was gone before main answered', async () => {
    let answer!: (r: { ok: true; token: string; origin: string }) => void;
    const close = vi.fn(async () => {});
    withOffice({ open: () => new Promise((r) => (answer = r)), close });
    const { unmount } = render(<EditorFrame file={FILE} />);
    unmount();
    answer({ ok: true, token: 't1', origin: 'office://t1' });
    await waitFor(() => expect(close).toHaveBeenCalledWith('t1'));
  });
});
