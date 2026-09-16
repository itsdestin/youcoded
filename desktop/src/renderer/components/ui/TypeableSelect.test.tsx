// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TypeableSelect } from './TypeableSelect';

afterEach(cleanup);

const options = [{ value: '', label: 'None' }, { value: '10', label: '10 steps' }, { value: '20', label: '20 steps' }];

describe('TypeableSelect', () => {
  it('commits menu choices and arbitrary typed values', () => {
    const onCommit = vi.fn();
    render(<TypeableSelect value="" options={options} onCommit={onCommit} aria-label="Step guard" />);
    const input = screen.getByRole('combobox', { name: 'Step guard' });
    fireEvent.focus(input);
    fireEvent.click(screen.getByRole('option', { name: '10 steps' }));
    expect(onCommit).toHaveBeenCalledWith('10');
    fireEvent.change(input, { target: { value: '125' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenLastCalledWith('125');
  });

  it('exposes the popup relationship and active option only while open', () => {
    render(<TypeableSelect value="10" options={options} onCommit={() => {}} aria-label="Step guard" />);
    const input = screen.getByRole('combobox', { name: 'Step guard' });
    expect(input).not.toHaveAttribute('aria-controls');
    expect(input).not.toHaveAttribute('aria-activedescendant');
    fireEvent.focus(input);
    const listbox = screen.getByRole('listbox');
    expect(input).toHaveAttribute('aria-controls', listbox.id);
    expect(input.getAttribute('aria-activedescendant')).toBe(`${listbox.id}-1`);
  });

  it('closes and restores the saved value on outside click or focus exit', () => {
    render(<><TypeableSelect value="10" options={options} onCommit={() => {}} aria-label="Step guard" /><button>Outside</button></>);
    const input = screen.getByRole('combobox', { name: 'Step guard' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '125' } });
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input).toHaveValue('10');

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '130' } });
    fireEvent.blur(input, { relatedTarget: screen.getByRole('button', { name: 'Outside' }) });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input).toHaveValue('10');
  });

  it('never opens while disabled and disabled options cannot become active or commit', () => {
    const onCommit = vi.fn();
    const disabledOptions = [...options, { value: '30', label: '30 steps', disabled: true }];
    const { rerender } = render(<TypeableSelect disabled value="" options={disabledOptions} onCommit={onCommit} aria-label="Step guard" />);
    const input = screen.getByRole('combobox', { name: 'Step guard' });
    expect(input).toBeDisabled();
    fireEvent.focus(input);
    expect(screen.queryByRole('listbox')).toBeNull();

    rerender(<TypeableSelect value="20" options={disabledOptions} onCommit={onCommit} aria-label="Step guard" />);
    fireEvent.focus(input);
    fireEvent.mouseEnter(screen.getByRole('option', { name: '30 steps' }));
    expect(input.getAttribute('aria-activedescendant')).not.toBe(`${screen.getByRole('listbox').id}-3`);
    fireEvent.click(screen.getByRole('option', { name: '30 steps' }));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('remeasures on ancestor scroll and window resize', () => {
    const rect = vi.fn()
      .mockReturnValueOnce({ left: 1, bottom: 10, width: 100 })
      .mockReturnValueOnce({ left: 2, bottom: 20, width: 110 })
      .mockReturnValueOnce({ left: 3, bottom: 30, width: 120 });
    render(<TypeableSelect value="" options={options} onCommit={() => {}} aria-label="Step guard" />);
    const input = screen.getByRole('combobox', { name: 'Step guard' });
    input.getBoundingClientRect = rect;
    fireEvent.focus(input);
    fireEvent.scroll(window);
    fireEvent.resize(window);
    expect(rect).toHaveBeenCalledTimes(3);
  });

  it('supports arrows and Escape without committing a partial edit', () => {
    const onCommit = vi.fn();
    render(<TypeableSelect value="10" options={options} onCommit={onCommit} aria-label="Step guard" />);
    const input = screen.getByRole('combobox', { name: 'Step guard' });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('20');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'bad' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input).toHaveValue('10');
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('skips disabled options during keyboard navigation', () => {
    const onCommit = vi.fn();
    const disabledMiddle = options.map((option) => option.value === '10' ? { ...option, disabled: true } : option);
    render(<TypeableSelect value="" options={disabledMiddle} onCommit={onCommit} aria-label="Step guard" />);
    const input = screen.getByRole('combobox', { name: 'Step guard' });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const listbox = screen.getByRole('listbox');
    expect(input).toHaveAttribute('aria-activedescendant', `${listbox.id}-2`);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('20');
  });

  it('removes its portal when disabled or unmounted', () => {
    const { rerender, unmount } = render(<TypeableSelect value="" options={options} onCommit={() => {}} aria-label="Step guard" />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Step guard' }));
    expect(document.querySelector('[data-select-portal]')).not.toBeNull();
    rerender(<TypeableSelect disabled value="" options={options} onCommit={() => {}} aria-label="Step guard" />);
    expect(document.querySelector('[data-select-portal]')).toBeNull();
    unmount();
    expect(document.querySelector('[data-select-portal]')).toBeNull();
  });

  it('never points aria-activedescendant at a disabled option', () => {
    const disabledOptions = options.map((option) => ({ ...option, disabled: true }));
    render(<TypeableSelect value="" options={disabledOptions} onCommit={() => {}} aria-label="Step guard" />);
    const input = screen.getByRole('combobox', { name: 'Step guard' });
    fireEvent.focus(input);
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });
});
