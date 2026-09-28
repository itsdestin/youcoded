// @vitest-environment jsdom
/**
 * Ledger G-2 (docs/active/investigations/2026-08-26-native-tools-vs-other-harnesses.md):
 * the AskUserQuestion card offers an "Other" row and a text box per question.
 *   - Other picked → the box is the answer ("Explain…"), required for Submit,
 *     and its text is sent IN PLACE of a label.
 *   - a listed option picked → the box is an optional note ("Add a note…"),
 *     sent as `notes[question]` (and Claude Code's `annotations` shape).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { ToolCallState } from '../src/shared/types';

let respond: ReturnType<typeof vi.fn>;
beforeEach(() => {
  respond = vi.fn().mockResolvedValue(true);
  (window as any).claude = { session: { respondToPermission: respond }, remote: { broadcastAction: vi.fn() } };
});
afterEach(cleanup);

const askTool = (multiSelect = false): ToolCallState => ({
  id: 'tool-q',
  toolName: 'AskUserQuestion',
  input: { questions: [{ question: 'Which color?', header: 'Color', multiSelect, options: [{ label: 'Blue' }, { label: 'Red' }] }] },
  status: 'awaiting-approval',
  requestId: 'native-q1',
} as ToolCallState);

const renderCard = (tool: ToolCallState) =>
  render(<ChatProvider><ToolCard tool={tool} sessionId="s1" /></ChatProvider>);

const submit = () => screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const sentInput = () => respond.mock.calls[0][1].decision.updatedInput;

describe('AskUserQuestion card — Other + note', () => {
  it('keeps duplicate-worded native choices and notes independent through keyboard and submit', async () => {
    const tool = askTool();
    tool.input = { questions: [
      { question: 'Which color?', header: 'Walls', multiSelect: false, options: [{ label: 'Blue' }, { label: 'Red' }] },
      { question: 'Which color?', header: 'Trim', multiSelect: false, options: [{ label: 'Green' }, { label: 'Yellow' }] },
    ] };
    renderCard(tool);
    const boxes = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
    const blue = screen.getByRole('button', { name: /^Blue/ });
    fireEvent.click(blue);
    fireEvent.change(boxes[0], { target: { value: 'lighter shade' } });
    // Keyboard navigation crosses the repeated text into the second question.
    for (let i = 0; i < 3; i++) fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.getByRole('button', { name: /^Green/ }).className).toContain('border-accent');
    expect(blue.className).toContain('border-accent');
    const others = screen.getAllByRole('button', { name: /^Other/ });
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { cb(0); return 0; });
    try { fireEvent.click(others[1]); } finally { frame.mockRestore(); }
    fireEvent.change(boxes[1], { target: { value: 'teal trim' } });
    expect(boxes[0].value).toBe('lighter shade');
    expect(boxes[1].value).toBe('teal trim');
    expect(document.activeElement).toBe(boxes[1]);
    fireEvent.click(submit());
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(sentInput().orderedAnswers).toEqual([{ answer: 'Blue', note: 'lighter shade' }, { answer: 'teal trim' }]);
  });

  it('resets answers when the same tool card receives a new pending request ID', () => {
    const tool = askTool();
    const mounted = renderCard(tool);
    fireEvent.click(screen.getByRole('button', { name: /^Blue/ }));
    expect(submit().disabled).toBe(false);
    mounted.rerender(<ChatProvider><ToolCard tool={{ ...tool, requestId: 'native-q2' }} sessionId="s1" /></ChatProvider>);
    expect(submit().disabled).toBe(true);
    expect(screen.getByRole('button', { name: /^Blue/ }).className).not.toContain('border-accent');
  });

  it('preserves legacy wording-keyed CC duplicate choices and submission without ordered answers', async () => {
    const tool = askTool();
    tool.requestId = 'cc-question-duplicate';
    tool.input = { questions: [
      { question: 'Same?', header: 'First', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] },
      { question: 'Same?', header: 'Second', multiSelect: false, options: [{ label: 'Go' }, { label: 'Stop' }] },
    ] };
    renderCard(tool);
    fireEvent.click(screen.getByRole('button', { name: /^Yes/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Go/ }));
    // Baseline CC state is keyed by wording: the second pick replaces the
    // first in BOTH displayed selections and the one legacy payload key.
    expect(screen.getByRole('button', { name: /^Yes/ }).className).not.toContain('border-accent');
    expect(screen.getByRole('button', { name: /^Go/ }).className).toContain('border-accent');
    const boxes = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
    fireEvent.change(boxes[0], { target: { value: 'shared note' } });
    expect(boxes[1].value).toBe('shared note');
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(sentInput()).toEqual({ questions: tool.input.questions, answers: { 'Same?': 'Go' },
      notes: { 'Same?': 'shared note' }, annotations: { 'Same?': { notes: 'shared note' } } });
  });

  it('retains independent native selections after an unconfirmed response and resends the same order', async () => {
    respond.mockRejectedValueOnce(new Error('transport unavailable')).mockResolvedValueOnce(true);
    const tool = askTool();
    tool.input = { questions: [
      { question: 'Same?', header: 'One', multiSelect: false, options: [{ label: 'Blue' }, { label: 'Red' }] },
      { question: 'Same?', header: 'Two', multiSelect: false, options: [{ label: 'Green' }, { label: 'Yellow' }] },
    ] };
    renderCard(tool);
    fireEvent.click(screen.getByRole('button', { name: /^Blue/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Green/ }));
    fireEvent.click(submit());
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/couldn.t confirm/));
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(respond.mock.calls[0][1].decision.updatedInput.orderedAnswers).toEqual([{ answer: 'Blue' }, { answer: 'Green' }]);
    expect(respond.mock.calls[1][1].decision.updatedInput.orderedAnswers).toEqual([{ answer: 'Blue' }, { answer: 'Green' }]);
  });

  it('keeps the Claude Code unique-wording payload exactly legacy-shaped', async () => {
    const tool = askTool();
    tool.requestId = 'cc-question-1';
    renderCard(tool);
    fireEvent.click(screen.getByRole('button', { name: /^Blue/ }));
    fireEvent.change(box(), { target: { value: 'lighter shade' } });
    fireEvent.click(submit());
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(sentInput()).toEqual({ questions: tool.input.questions,
      answers: { 'Which color?': 'Blue' }, notes: { 'Which color?': 'lighter shade' },
      annotations: { 'Which color?': { notes: 'lighter shade' } } });
    expect(respond.mock.calls[0][0]).toBe('cc-question-1');
  });
  it('offers an Other row after the listed options, and the box reads "Add a note…" until Other is picked', () => {
    renderCard(askTool());
    expect(screen.getByRole('button', { name: /^Other — Type your own answer$/ })).toBeTruthy();
    expect(box().placeholder).toBe('Add a note…');
    fireEvent.click(screen.getByRole('button', { name: /^Other/ }));
    expect(box().placeholder).toBe('Explain…');
  });

  it('Other with nothing typed keeps Submit disabled; typing enables it and the text is sent as the answer', async () => {
    renderCard(askTool());
    fireEvent.click(screen.getByRole('button', { name: /^Other/ }));
    expect(submit().disabled).toBe(true);
    fireEvent.change(box(), { target: { value: 'teal, please' } });
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(sentInput().answers['Which color?']).toBe('teal, please');
    expect(sentInput().notes).toBeUndefined();
  });

  it('a listed option plus text sends the label as the answer and the text as a note (both shapes)', async () => {
    renderCard(askTool());
    fireEvent.click(screen.getByRole('button', { name: /^Blue/ }));
    fireEvent.change(box(), { target: { value: 'lighter shade' } });
    fireEvent.click(submit());
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(sentInput().answers['Which color?']).toBe('Blue');
    expect(sentInput().notes['Which color?']).toBe('lighter shade');
    expect(sentInput().annotations['Which color?']).toEqual({ notes: 'lighter shade' });
  });

  it('a listed option with an empty box sends no notes at all (unchanged wire shape)', async () => {
    renderCard(askTool());
    fireEvent.click(screen.getByRole('button', { name: /^Blue/ }));
    fireEvent.click(submit());
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(sentInput().answers['Which color?']).toBe('Blue');
    expect('notes' in sentInput()).toBe(false);
    expect('annotations' in sentInput()).toBe(false);
  });

  it('multi-select: Other joins the listed labels in the answer list', async () => {
    renderCard(askTool(true));
    fireEvent.click(screen.getByRole('button', { name: /^Blue/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Other/ }));
    fireEvent.change(box(), { target: { value: 'green' } });
    fireEvent.click(submit());
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(sentInput().answers['Which color?']).toBe('Blue, green');
  });

  it('Ctrl+Enter inside the box submits', async () => {
    renderCard(askTool());
    fireEvent.click(screen.getByRole('button', { name: /^Blue/ }));
    fireEvent.change(box(), { target: { value: 'note' } });
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
  });
});
