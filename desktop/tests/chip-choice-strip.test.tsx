// @vitest-environment jsdom
// Card #143 c (Destin picked "strip above box"): a quick chip tapped over typed words asks Replace / Add to end instead of
// silently overwriting; an empty box fills as it always did.
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
import { EscCloseProvider, useEscClose, usePopupOpen } from '../src/renderer/hooks/use-esc-close';
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

let popupOpenNow: () => boolean = () => false;
function Probe() { popupOpenNow = usePopupOpen(); return null; }
function RealPopup() { useEscClose(true, () => {}); return null; }
const tree = (sid: string, extra?: React.ReactNode) => (
  <ChatProvider><SkillProvider><EscCloseProvider><Probe />{extra}<InputBar sessionId={sid} provider="native" /></EscCloseProvider></SkillProvider></ChatProvider>
);
async function composer() {
  render(tree('s1'));
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

  // Review 2026-11-13 ---------------------------------------------------------------------------------------------------------
  it('the strip is not counted as a popup, so Enter still reaches the message box and chat cards; a real popup still is', async () => {
    const { box, chip } = await composer();
    typeWords(box, 'Draft a reply to Maya');
    fireEvent.click(chip);
    expect(strip()).not.toBeNull();
    expect(popupOpenNow()).toBe(false);
    cleanup();
    render(tree('s1', <RealPopup />));
    expect(popupOpenNow()).toBe(true); // control: the probe does see a real popup
  });
  it('Enter on a strip button is not seen by window-level Enter handlers (a waiting card cannot answer the same key press)', async () => {
    const { box, chip } = await composer();
    typeWords(box, 'Draft a reply to Maya');
    fireEvent.click(chip);
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Add to end' }), { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Add to end' }), { key: 'ArrowLeft' });
    window.removeEventListener('keydown', seen);
    expect(seen).toHaveBeenCalledTimes(1); // the arrow reached it; the Enter did not
  });
  it('emptying the box while the strip is open drops the question', async () => {
    const { box, chip } = await composer();
    typeWords(box, 'Draft a reply to Maya');
    fireEvent.click(chip);
    typeWords(box, '');
    expect(strip()).toBeNull();
  });
  it('sending the message while the strip is open drops the question', async () => {
    const { box, chip } = await composer();
    typeWords(box, 'Draft a reply to Maya');
    fireEvent.click(chip);
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe(''));
    expect(strip()).toBeNull();
  });
  it('switching to another session drops the question', async () => {
    const { box, chip } = await composer();
    typeWords(box, 'Draft a reply to Maya');
    fireEvent.click(chip);
    expect(strip()).not.toBeNull();
    cleanup();
    const { rerender } = render(tree('s1'));
    const b = screen.getByPlaceholderText('Message your assistant...') as HTMLTextAreaElement;
    typeWords(b, 'words');
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Inbox' })));
    expect(strip()).not.toBeNull();
    rerender(tree('s2'));
    expect(strip()).toBeNull();
  });
  // A click as the browser makes it: a pointer click carries its pointerType ('' for a keyboard-made one); React reads it from there.
  const tap = (el: Element, type: string) => { const e = new MouseEvent('click', { bubbles: true, cancelable: true }); Object.defineProperty(e, 'pointerType', { value: type }); act(() => { el.dispatchEvent(e); }); };
  it('a tap leaves focus where it is (the keyboard stays up); a mouse click moves focus to Add to end', async () => {
    const { box, chip } = await composer();
    typeWords(box, 'Draft a reply to Maya');
    box.focus();
    tap(chip, 'touch');
    expect(strip()).not.toBeNull();
    expect(document.activeElement).toBe(box);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    typeWords(box, 'Draft a reply to Maya');
    tap(chip, 'mouse');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add to end' }));
  });
  it('a pen counts as touch, and a keyboard-made click counts as keyboard', async () => {
    const { box, chip } = await composer();
    typeWords(box, 'Draft a reply to Maya');
    box.focus();
    tap(chip, 'pen');
    expect(document.activeElement).toBe(box);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    typeWords(box, 'Draft a reply to Maya');
    tap(chip, ''); // a keyboard-made click has no pointer type
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add to end' }));
  });

  it('no window-level pointer or key listener is added while a chat composer sits idle (hidden means idle)', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    render(tree('s9'));
    const types = add.mock.calls.map((c) => String(c[0]));
    // The composer's own long-standing listeners are not the question; the chip question must not add ITS pointerdown listener.
    expect(types.filter((t) => t === 'pointerdown').length).toBeLessThanOrEqual(1);
    add.mockRestore();
  });
});
