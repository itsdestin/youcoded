// @vitest-environment jsdom
// Card #143 c (Destin picked "strip above box"): a quick chip tapped over typed words asks Replace / Add to end instead of
// silently overwriting; an empty box fills as it always did.
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
import { EscCloseProvider } from '../src/renderer/hooks/use-esc-close';
import InputBar from '../src/renderer/components/InputBar';

class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }

beforeEach(() => {
  (global as any).ResizeObserver = NoopResizeObserver;
  (window as any).claude = {
    native: { supported: true, send: vi.fn().mockResolvedValue({ status: 'sent' }) },
    session: { sendInput: vi.fn() },
    dialog: {},
    skills: {
      list: vi.fn().mockResolvedValue([]), getFavorites: vi.fn().mockResolvedValue([]),
      getChips: vi.fn().mockResolvedValue([{ label: 'Inbox', prompt: 'Check my inbox' }]), getCuratedDefaults: vi.fn().mockResolvedValue([]),
    },
  };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function composer() {
  render(<ChatProvider><SkillProvider><EscCloseProvider><InputBar sessionId="s1" provider="native" /></EscCloseProvider></SkillProvider></ChatProvider>);
  const box = screen.getByPlaceholderText('Message your assistant...') as HTMLTextAreaElement;
  const chip = await waitFor(() => screen.getByRole('button', { name: 'Inbox' }));
  return { box, chip };
}
const typeWords = (box: HTMLTextAreaElement, v: string) => fireEvent.change(box, { target: { value: v } });
const strip = () => document.querySelector('[data-chip-choice-strip]');

describe('quick chip over typed words', () => {
  it('an empty box is filled at once, no question (unchanged)', async () => {
    const { box, chip } = await composer();
    fireEvent.click(chip);
    expect(box.value).toBe('Check my inbox');
    expect(strip()).toBeNull();
  });
  it('with words in the box a strip asks, and the words are untouched until answered', async () => {
    const { box, chip } = await composer();
    typeWords(box, 'Draft a reply to Maya');
    fireEvent.click(chip);
    expect(strip()).not.toBeNull();
    expect(box.value).toBe('Draft a reply to Maya');
  });
  it('Replace swaps the words for the chip', async () => {
    const { box, chip } = await composer();
    typeWords(box, 'Draft a reply to Maya');
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(box.value).toBe('Check my inbox');
    expect(strip()).toBeNull();
  });
  it('Add to end keeps the words and puts the chip after them', async () => {
    const { box, chip } = await composer();
    typeWords(box, 'Draft a reply to Maya');
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole('button', { name: 'Add to end' }));
    expect(box.value).toBe('Draft a reply to Maya Check my inbox');
    expect(strip()).toBeNull();
  });
  it('Add to end does not double a space the person already typed', async () => {
    const { box, chip } = await composer();
    typeWords(box, 'Draft a reply to Maya ');
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole('button', { name: 'Add to end' }));
    expect(box.value).toBe('Draft a reply to Maya Check my inbox');
  });
  it('the close button keeps the words and closes the strip', async () => {
    const { box, chip } = await composer();
    typeWords(box, 'Draft a reply to Maya');
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(box.value).toBe('Draft a reply to Maya');
    expect(strip()).toBeNull();
  });
  it('Escape closes it, keeping the words; focus starts on the safe answer', async () => {
    const { box, chip } = await composer();
    typeWords(box, 'Draft a reply to Maya');
    fireEvent.click(chip);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add to end' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(strip()).toBeNull();
    expect(box.value).toBe('Draft a reply to Maya');
  });
});
