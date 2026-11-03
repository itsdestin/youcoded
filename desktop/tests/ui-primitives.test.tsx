// @vitest-environment jsdom
// Pinning tests for components/ui: class output and ARIA (not snapshots), so a rejected idiom cannot quietly come back.

import React from 'react';
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { Button, buttonClasses } from '../src/renderer/components/ui/Button';
import { CloseButton } from '../src/renderer/components/ui/CloseButton';
import { Toggle } from '../src/renderer/components/ui/Toggle';
import { Checkbox } from '../src/renderer/components/ui/Checkbox';
import { Radio, RadioGroup } from '../src/renderer/components/ui/Radio';
import { TextInput } from '../src/renderer/components/ui/TextInput';
import { Textarea } from '../src/renderer/components/ui/Textarea';
import { Select } from '../src/renderer/components/ui/Select';
import { SegmentedTabs } from '../src/renderer/components/ui/SegmentedTabs';
import { ProgressBar } from '../src/renderer/components/ui/ProgressBar';
import { Toast } from '../src/renderer/components/ui/Toast';
import { LoadingState, EmptyState, ErrorState, FieldError } from '../src/renderer/components/ui/states';
import { FIELD, FIELD_SURFACE } from '../src/renderer/components/ui/field';
import { InputGroup } from '../src/renderer/components/ui/InputGroup';

// jsdom lacks scrollIntoView, which Select uses when a long catalog opens.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe('Button', () => {
  const VARIANTS = ['primary', 'secondary', 'ghost', 'danger', 'danger-outline'] as const;

  it('primary uses the accent fill with a background-fade hover; danger takes its label from the derived token', () => {
    const cls = buttonClasses('primary');
    expect(cls).toContain('bg-accent');
    expect(cls).toContain('text-on-accent');
    expect(cls).toContain('hover:bg-accent/90');
    // WHY: --destructive is pack-overridable with no contrast guard, so hardcoded text-white can render white-on-pale.
    const danger = buttonClasses('danger');
    expect(danger).toContain('bg-destructive');
    expect(danger).toContain('text-on-destructive');
    expect(danger).not.toContain('text-white');
  });

  // WHY: brightness-110 is imperceptible on Light/Creme's near-black accent; opacity-90 fades the label and the glow themes' fill.
  it.each(VARIANTS)('%s never uses the rejected hover idioms and carries the focus ring', (v) => {
    expect(buttonClasses(v)).not.toContain('brightness');
    expect(buttonClasses(v)).not.toMatch(/(^|\s|:)opacity-90/);
    expect(buttonClasses(v)).toContain('focus-visible:ring-2');
    expect(buttonClasses(v)).toContain('focus-visible:ring-accent');
  });

  it('uses the theme control radius, a disabled affordance, and the approved size scale', () => {
    const base = buttonClasses('primary');
    expect(base).toContain('rounded-control');
    expect(base).not.toContain('rounded-sm');
    expect(base).not.toContain('rounded-full');
    expect(base).toContain('disabled:opacity-50');
    expect(base).toContain('disabled:cursor-not-allowed');
    expect(buttonClasses('primary', 'sm')).toContain('text-2xs');
    expect(buttonClasses('primary', 'md')).toContain('text-xs');
    expect(buttonClasses('primary', 'lg')).toContain('text-sm');
    expect(buttonClasses('primary', 'icon')).toContain('w-7 h-7');
  });

  // The renderer is also the Android UI: sm is ~22px tall, icon 28px.
  it.each([['sm', true], ['icon', true], ['md', false], ['lg', false]] as const)(
    'size %s expands the tap target: %s', (size, expands) => {
      expect(buttonClasses('primary', size).includes('coarse-hit')).toBe(expands);
    });

  it('defaults to type=button so it cannot submit a surrounding form, but allows an explicit submit', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(<form onSubmit={onSubmit}><Button>Save</Button></form>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
    fireEvent.click(screen.getByRole('button'));
    expect(onSubmit).not.toHaveBeenCalled();
    cleanup();
    render(<Button type="submit">Go</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');
  });

  it('forwards className so documented exceptions (first-run pills) can override', () => {
    render(<Button className="rounded-full px-8">Get started</Button>);
    expect(screen.getByRole('button')).toHaveClass('rounded-full', 'px-8');
  });

  // WHY: an override has to REPLACE the base class — Tailwind resolves competing utilities by CSS source order, and
  // in our bundle .rounded-full is emitted BEFORE .rounded-lg, so both-present would silently lose the pill.
  describe('className override actually overrides', () => {
    it.each([
      ['radius', ['primary', 'lg', 'rounded-full'], ['rounded-full'], ['rounded-lg']],
      ['font size', ['primary', 'lg', 'text-base'], ['text-base'], ['text-sm']],
      ['padding', ['primary', 'lg', 'px-6 py-3'], ['px-6', 'py-3'], ['px-4', 'py-2']],
      ['icon size', ['ghost', 'icon', 'w-10 h-10'], ['w-10', 'h-10'], ['w-7', 'h-7']],
    ] as const)('drops the base %s when the caller supplies one', (_n, args, kept, dropped) => {
      const tokens = (buttonClasses as (...a: readonly string[]) => string)(...args).split(/\s+/);
      for (const k of kept) expect(tokens).toContain(k);
      for (const d of dropped) expect(tokens).not.toContain(d);
    });

    it('never mistakes a text COLOR for a text size, and keeps variant-prefixed classes', () => {
      expect(buttonClasses('primary', 'md', 'text-base')).toContain('text-on-accent');
      expect(buttonClasses('secondary', 'md', 'text-base')).toContain('text-fg-2');
      const cls = buttonClasses('primary', 'md', 'rounded-full');
      expect(cls).toContain('hover:bg-accent/90');
      expect(cls).toContain('disabled:opacity-50');
      expect(cls).toContain('focus-visible:ring-2');
    });

    it('leaves the base untouched when nothing is overridden', () => {
      expect(buttonClasses('primary', 'lg')).toContain('rounded-control');
      expect(buttonClasses('primary', 'lg')).toContain('text-sm');
    });
  });
});

describe('CloseButton', () => {
  it('is an icon-size ghost with an accessible name', () => {
    render(<CloseButton />);
    const btn = screen.getByRole('button', { name: 'Close' });
    expect(btn).toBeInTheDocument();
  });

  it('accepts a more specific label', () => {
    render(<CloseButton label="Close settings" />);
    expect(screen.getByRole('button', { name: 'Close settings' })).toBeInTheDocument();
  });
});

describe('Toggle', () => {
  const sw = () => screen.getByRole('switch');
  const noop = () => {};

  it('is a switch with state, in both tones', () => {
    render(<Toggle checked={false} onChange={noop} />);
    expect(sw()).toHaveAttribute('aria-checked', 'false');
    cleanup();
    render(<Toggle checked onChange={noop} />);
    expect(sw()).toHaveAttribute('aria-checked', 'true');
    cleanup();
    render(<Toggle checked tone="danger" onChange={noop} />);
    expect(sw()).toHaveAttribute('aria-checked', 'true');
  });

  // WHY: absolutely-positioned children resolve against the PADDING box, so a border present in only one state shifts the knob 1px.
  it('keeps the border in BOTH states, travels the knob 16px, and rings it so it shows on light tracks', () => {
    const { rerender } = render(<Toggle checked={false} onChange={noop} />);
    const knob = () => sw().querySelector('span')!;
    expect(knob()).toHaveStyle({ left: '1px' });
    rerender(<Toggle checked onChange={noop} />);
    expect(knob()).toHaveStyle({ left: '17px' });
  });

  it('reports the flipped value', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} />);
    fireEvent.click(sw());
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('Checkbox', () => {
  it('is a checkbox with state', () => {
    render(<Checkbox checked onChange={() => {}} />);
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
  });

  it('expands its tap target on touch', () => {
    render(<Checkbox checked={false} onChange={() => {}} />);
    expect(screen.getByRole('checkbox').className).toContain('coarse-hit');
  });
});

describe('Radio / RadioGroup', () => {
  const Group = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <RadioGroup options={['a', 'b', 'c']} value={value} onChange={onChange} aria-label="Modes">
      {['a', 'b', 'c'].map((id) => (
        <Radio key={id} checked={value === id} onChange={() => onChange(id)} aria-label={id} />
      ))}
    </RadioGroup>
  );

  it('exposes radio semantics', () => {
    render(<Group value="a" onChange={() => {}} />);
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
  });

  it('moves selection with arrow keys, like the native radios it replaces', () => {
    const onChange = vi.fn();
    render(<Group value="a" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowDown' });
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('wraps at the ends', () => {
    const onChange = vi.fn();
    render(<Group value="a" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowUp' });
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('does NOT navigate on arrow keys typed into a nested field', () => {
    // An option body can hold its own input (SyncSetupWizard's repo-name fields
    // sit inside the radio rows). Arrows there must move the text cursor, not
    // switch the selection — the guard change 39 added.
    const onChange = vi.fn();
    render(
      <RadioGroup options={['a', 'b']} value="a" onChange={onChange} aria-label="Modes">
        <Radio checked onChange={() => onChange('a')} aria-label="a" />
        <input aria-label="nested" />
        <Radio checked={false} onChange={() => onChange('b')} aria-label="b" />
      </RadioGroup>,
    );
    fireEvent.keyDown(screen.getByLabelText('nested'), { key: 'ArrowDown' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('field surface', () => {
  it('focuses by border color on inset, with a disabled affordance', () => {
    expect(FIELD).toContain('focus:border-accent');
    expect(FIELD).not.toContain('focus:ring');
    expect(FIELD).not.toContain('focus:border-fg-muted');
    expect(FIELD).toContain('bg-inset');
    expect(FIELD).not.toContain('bg-canvas');
    expect(FIELD).not.toContain('bg-well');
    expect(FIELD).toContain('disabled:opacity-50');
  });

  it('applies to non-text inputs too, keeping their native type', () => {
    const { container } = render(<TextInput type="password" defaultValue="k" />);
    const input = container.querySelector('input')!;
    expect(input).toHaveAttribute('type', 'password');
  });

  it.each([[false, false], [true, true]])('Textarea resizable=%s', (resizable, resizes) => {
    const { container } = render(<Textarea resizable={resizable} />);
    expect(container.querySelector('textarea')!.className.includes('resize-none')).toBe(!resizes);
  });
});

describe('InputGroup (the action goes inside the field)', () => {
  const group = (props: Omit<React.ComponentProps<typeof InputGroup>, 'children'> = {}, field: React.ComponentProps<typeof InputGroup.Field> = {}) => {
    const { container } = render(<InputGroup {...props}><InputGroup.Field {...field} /></InputGroup>);
    return { wrapper: container.firstElementChild!, input: container.querySelector('input')! };
  };

  it('keeps the native input type', () => {
    expect(group({}, { type: 'password' }).input).toHaveAttribute('type', 'password');
  });

  // WHY: fieldClasses goes through mergeClasses — concatenation left the winner of competing utilities to CSS emission order.
  it('lets a caller override a field size deterministically, keeping non-conflicting base classes', () => {
    const { container } = render(<TextInput size="md" className="text-sm px-4" />);
    const cls = container.querySelector('input')!.className;
    expect(cls).toContain('text-sm');
    expect(cls).toContain('px-4');
    expect(cls).not.toContain('text-xs');
    expect(cls).not.toContain('px-3');
    expect(cls).toContain('bg-inset');
    expect(cls).toContain('focus:border-accent');
  });

  it('shares one surface definition with the plain field', () => {
    expect(FIELD).toContain(FIELD_SURFACE);
  });
});

describe('Select', () => {
  const OPTS = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
    { value: 'c', label: 'Gamma' },
  ];
  const open = (props: Partial<React.ComponentProps<typeof Select>> = {}) =>
    render(<Select options={OPTS} value="a" onChange={() => {}} aria-label="Pick" {...props} />);

  it('renders NO native select (the OS option list would break theming) and opens a listbox', () => {
    const { container } = open();
    expect(container.querySelector('select')).toBeNull();
    expect(screen.getByRole('button')).toHaveAttribute('aria-haspopup', 'listbox');
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('marks the selected option', () => {
    open({ value: 'b' });
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('option', { name: 'Beta' })).toHaveAttribute('aria-selected', 'true');
  });

  // WHY: the scroll MUST be on an inner element; .layer-surface's unlayered `overflow: hidden` would beat an overflow-y-auto utility.
  it('scrolls rather than clips a long catalog', () => {
    open();
    fireEvent.click(screen.getByRole('button'));
    const list = screen.getByRole('listbox');
    expect(list.className).toContain('overflow-y-auto');
    expect(list.className).toContain('max-h-64');
  });

  it.each([
    ['arrow keys then Enter', ['ArrowDown', 'ArrowDown', 'Enter'], false, 'b'],
    ['first character then Enter', ['g', 'Enter'], true, 'c'],
    ['arrow keys, skipping a disabled option', ['ArrowDown', 'ArrowDown', 'Enter'], false, 'c'],
  ])('selects with %s', (title, keys, clickOpen, expected) => {
    const onChange = vi.fn();
    const options = title.includes('disabled') ? [OPTS[0], { ...OPTS[1], disabled: true }, OPTS[2]] : OPTS;
    open({ onChange, options });
    const trigger = screen.getByRole('button');
    if (clickOpen) fireEvent.click(trigger);
    for (const key of keys) fireEvent.keyDown(trigger, { key });
    expect(onChange).toHaveBeenCalledWith(expected);
  });
});

describe('SegmentedTabs', () => {
  const TABS = [
    { id: 'x', label: 'X' },
    { id: 'y', label: 'Y' },
  ];

  it('exposes tab semantics', () => {
    render(<SegmentedTabs tabs={TABS} value="x" onChange={() => {}} aria-label="Sections" />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'X' })).toHaveAttribute('aria-selected', 'true');
  });

  it('is one tab stop with arrow navigation', () => {
    const onChange = vi.fn();
    render(<SegmentedTabs tabs={TABS} value="x" onChange={onChange} aria-label="Sections" />);
    expect(screen.getByRole('tab', { name: 'Y' })).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('y');
  });
});

describe('ProgressBar', () => {
  it('exposes progress semantics', () => {
    render(<ProgressBar percent={42} aria-label="Download" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
  });

  it('clamps nonsense input instead of overflowing its track', () => {
    const { rerender } = render(<ProgressBar percent={999} aria-label="p" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    rerender(<ProgressBar percent={-5} aria-label="p" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    rerender(<ProgressBar percent={NaN} aria-label="p" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('lets a status hue override the accent', () => {
    render(<ProgressBar percent={50} color="rgb(255, 0, 0)" aria-label="p" />);
    const fill = screen.getByRole('progressbar').firstElementChild as HTMLElement;
    expect(fill).toHaveStyle({ backgroundColor: 'rgb(255, 0, 0)' });
  });
});

describe('Toast', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('announces politely without stealing focus', () => {
    render(<Toast message="Copied" onDismiss={() => {}} />);
    const toast = screen.getByRole('status');
    expect(toast).toHaveAttribute('aria-live', 'polite');
    expect(toast).toHaveTextContent('Copied');
  });

  it('owns its dismiss timer', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast message="Saved" onDismiss={onDismiss} durationMs={3000} />);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not fire its timer after unmount', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast message="Saved" onDismiss={onDismiss} />).unmount();
    vi.advanceTimersByTime(5000);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('can require an explicit dismiss', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast message="Stay" onDismiss={onDismiss} durationMs={null} />);
    vi.advanceTimersByTime(60_000);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe('state family', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('loading always names what is loading', () => {
    // The spinner's shared 40ms driver must tick without disturbing the label (fake timers make the tick deterministic, not a race on render speed).
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    render(<LoadingState what="sessions" />);
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByText(/Loading sessions/)).toBeInTheDocument();
  });

  it('empty offers a way out when given one', () => {
    const onClick = vi.fn();
    render(<EmptyState message="No themes match" action={{ label: 'Clear filters', onClick }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClick).toHaveBeenCalled();
  });

  it('errors offer Try again', () => {
    // Full guard: tests/error-state.test.tsx.
    const { container } = render(<ErrorState message="Fetch failed" onRetry={() => {}} />);
    const card = container.firstElementChild as HTMLElement;
    expect(card).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('general errors ship the two documented actions', () => {
    const onReportBug = vi.fn();
    const onDiagnose = vi.fn();
    render(<ErrorState mode="general" title="Unable to run local models" explainer="Something went wrong." onReportBug={onReportBug} onDiagnose={onDiagnose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Report bug' }));
    fireEvent.click(screen.getByRole('button', { name: 'Diagnose with the assistant' }));
    expect(onReportBug).toHaveBeenCalled();
    expect(onDiagnose).toHaveBeenCalled();
  });

  it('field errors render as a span', () => {
    render(<FieldError>Required</FieldError>);
    const el = screen.getByText('Required');
    expect(el.tagName).toBe('SPAN');
  });

  it('as="p" renders a block host so vertical margin still lays out', () => {
    render(<FieldError as="p" className="mt-1">Nope</FieldError>);
    const el = screen.getByText('Nope');
    expect(el.tagName).toBe('P');
    expect(el.className).toContain('mt-1');
    expect(el.getAttribute('role')).toBe('alert');
  });
});
