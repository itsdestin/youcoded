// @vitest-environment jsdom
/**
 * "No tags yet" means there are no tags — not that they could not be read.
 *
 * Error inventory 2026-09-10, false message 16. A failed tag read became an empty list
 * in THREE places: main's `tags:list` handler (`catch { return []; }`), remote-server's
 * (`.catch(() => [])`), and useTagRegistry (`.catch(() => setTags([]))`, plus
 * `Array.isArray(list) ? list : []`). So the tag manager told someone with tags "No tags
 * yet — create one above" — inviting duplicates of tags they already had — and a failed
 * REFRESH wiped tags that were already on screen.
 *
 * The hosts now answer `{ ok: false, error }`; this drives the real hook and the real
 * popup against both that answer and a rejected call.
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react';
import { useTagRegistry } from '../src/renderer/hooks/useTagRegistry';
import { TagManagerPopup } from '../src/renderer/components/tags/TagManagerPopup';

const TAG = { id: 't1', label: 'Research', color: 'tag-gray', archived: false, createdAt: '2026-09-01T00:00:00.000Z' };

function stub(list: ReturnType<typeof vi.fn>) {
  let changed: (() => void) | null = null;
  (window as any).claude = {
    tags: {
      list,
      create: vi.fn().mockResolvedValue({ ok: true, tag: TAG }),
      update: vi.fn().mockResolvedValue({ ok: true }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
    },
    on: { tagsChanged: (cb: () => void) => { changed = cb; return () => {}; } },
  };
  return { pushTagsChanged: () => act(() => { changed?.(); }) };
}

function Harness() {
  const registry = useTagRegistry();
  return <TagManagerPopup open onClose={() => {}} registry={registry} />;
}

// A tag row may render its label as text or inside its rename field.
const tagShown = () => !!screen.queryByText('Research') || !!screen.queryByDisplayValue('Research');

describe('Tag manager — a read that failed is not "No tags yet"', () => {
  afterEach(() => { cleanup(); delete (window as any).claude; });

  it('a host that could not read the tags says so, with Retry', async () => {
    stub(vi.fn().mockResolvedValue({ ok: false, error: "EACCES: permission denied, open '/home/me/YouCoded/Personal/Tags/tags.json'" }));
    render(<Harness />);

    expect(await screen.findByText(/couldn.t load your tags/i)).toBeInTheDocument();
    expect(screen.getByText(/EACCES: permission denied/)).toBeInTheDocument();
    expect(screen.queryByText(/No tags yet/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('a rejected call says so too, without the transport wrapper', async () => {
    stub(vi.fn().mockRejectedValue(new Error("Error invoking remote method 'tags:list': Error: registry exploded")));
    render(<Harness />);

    expect(await screen.findByText(/couldn.t load your tags/i)).toBeInTheDocument();
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
    expect(screen.queryByText(/No tags yet/)).toBeNull();
  });

  it('Retry reloads, and a real empty registry is then allowed to say "No tags yet"', async () => {
    const list = vi.fn().mockResolvedValueOnce({ ok: false, error: 'not readable' }).mockResolvedValue([]);
    stub(list);
    render(<Harness />);

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/No tags yet/)).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('a failed refresh keeps the tags already on screen and says they may be stale', async () => {
    const list = vi.fn().mockResolvedValueOnce([TAG]).mockRejectedValueOnce(new Error('disk went away'));
    const { pushTagsChanged } = stub(list);
    render(<Harness />);
    await vi.waitFor(() => expect(tagShown()).toBe(true));

    pushTagsChanged();

    expect(await screen.findByText(/couldn.t refresh your tags/i)).toBeInTheDocument();
    expect(tagShown()).toBe(true);
    expect(screen.queryByText(/No tags yet/)).toBeNull();
  });

  it('with every loaded tag archived, a failed refresh still says the list may be stale (code review F9)', async () => {
    const list = vi.fn().mockResolvedValueOnce([{ ...TAG, archived: true }]).mockRejectedValueOnce(new Error('disk went away'));
    const { pushTagsChanged } = stub(list);
    render(<Harness />);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    pushTagsChanged();

    expect(await screen.findByText(/couldn.t refresh your tags/i)).toBeInTheDocument();
  });
});
