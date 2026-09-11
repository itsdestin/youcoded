// @vitest-environment jsdom
// ui-primitives.test.tsx — pinning tests for components/ui.
//
// These lock the recipes approved 2026-07-16 (see
// docs/active/specs/2026-07-16-ui-consistency-design-spec.md). They are
// deliberately assertions about CLASS OUTPUT and ARIA, not snapshots: the point
// is that a specific rejected idiom can never quietly come back. Each test that
// guards a rejected alternative says which one and why.

import React from 'react';
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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

// jsdom does not implement scrollIntoView. Select uses it to bring the current
// value into view when a long catalog opens; every real browser and the Android
// WebView have it, so this is a test-environment gap, not a product guard.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe('Button', () => {
  it('primary uses the accent fill with a background-fade hover', () => {
    const cls = buttonClasses('primary');
    expect(cls).toContain('bg-accent');
    expect(cls).toContain('text-on-accent');
    expect(cls).toContain('hover:bg-accent/90');
  });

  it('never uses the rejected hover idioms', () => {
    // brightness-110 is imperceptible on Light/Creme's near-black accent;
    // opacity-90 fades the LABEL too, and on glow themes (Halftone) the fill
    // fades out from under the theme's own box-shadow. Both were rendered and
    // rejected — this stops either coming back as a "polish" tweak.
    for (const v of ['primary', 'secondary', 'ghost', 'danger', 'danger-outline'] as const) {
      expect(buttonClasses(v)).not.toContain('brightness');
      expect(buttonClasses(v)).not.toMatch(/(^|\s|:)opacity-90/);
    }
  });

  it('danger takes its label from the derived token, never hardcoded white', () => {
    // --destructive is pack-overridable with NO contrast guard, so text-white
    // can render white-on-pale. Rule 15: every color is settable or derived.
    const cls = buttonClasses('danger');
    expect(cls).toContain('bg-destructive');
    expect(cls).toContain('text-on-destructive');
    expect(cls).not.toContain('text-white');
  });

  it('every variant carries the focus ring', () => {
    // ~80% of buttons had no focus-visible style before this existed (rule 4).
    for (const v of ['primary', 'secondary', 'ghost', 'danger', 'danger-outline'] as const) {
      expect(buttonClasses(v)).toContain('focus-visible:ring-2');
      expect(buttonClasses(v)).toContain('focus-visible:ring-accent');
    }
  });

  it('uses one control radius', () => {
    // Rule 2. Pills survive only as a documented className override.
    expect(buttonClasses('primary')).toContain('rounded-lg');
    expect(buttonClasses('primary')).not.toContain('rounded-sm');
    expect(buttonClasses('primary')).not.toContain('rounded-full');
  });

  it('maps each size to its approved scale', () => {
    expect(buttonClasses('primary', 'sm')).toContain('text-2xs');
    expect(buttonClasses('primary', 'md')).toContain('text-xs');
    expect(buttonClasses('primary', 'lg')).toContain('text-sm');
    expect(buttonClasses('primary', 'icon')).toContain('w-7 h-7');
  });

  it('expands the tap target only for the sizes below the touch guideline', () => {
    // This renderer is also the Android UI. sm is ~22px tall, icon is 28px.
    expect(buttonClasses('primary', 'sm')).toContain('coarse-hit');
    expect(buttonClasses('primary', 'icon')).toContain('coarse-hit');
    expect(buttonClasses('primary', 'md')).not.toContain('coarse-hit');
    expect(buttonClasses('primary', 'lg')).not.toContain('coarse-hit');
  });

  it('defaults to type=button so it cannot submit a surrounding form', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button>Save</Button>
      </form>,
    );
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
    fireEvent.click(screen.getByRole('button'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('still allows an explicit submit button', () => {
    render(<Button type="submit">Go</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');
  });

  it('carries the disabled affordance', () => {
    expect(buttonClasses('primary')).toContain('disabled:opacity-50');
    expect(buttonClasses('primary')).toContain('disabled:cursor-not-allowed');
  });

  it('forwards className so documented exceptions (first-run pills) can override', () => {
    render(<Button className="rounded-full px-8">Get started</Button>);
    expect(screen.getByRole('button')).toHaveClass('rounded-full', 'px-8');
  });

  // A className override has to REPLACE the base class, not sit beside it.
  // Tailwind resolves competing utilities by CSS source order, not by attribute
  // order — and measured in our bundle, .rounded-full (26057) is emitted BEFORE
  // .rounded-lg (26104), so both-present means rounded-lg wins and the pill
  // silently isn't a pill. Same for .text-base (51062) vs .text-sm (51252).
  describe('className override actually overrides', () => {
    it('drops the base radius when the caller supplies one (change 7 pills)', () => {
      const cls = buttonClasses('primary', 'lg', 'rounded-full');
      expect(cls).toContain('rounded-full');
      expect(cls).not.toContain('rounded-lg');
    });

    it('drops the base font size when the caller supplies one', () => {
      const cls = buttonClasses('primary', 'lg', 'text-base');
      expect(cls).toContain('text-base');
      expect(cls.split(/\s+/)).not.toContain('text-sm');
    });

    it('drops the base padding when the caller supplies its own', () => {
      const cls = buttonClasses('primary', 'lg', 'px-6 py-3');
      expect(cls).toContain('px-6');
      expect(cls).toContain('py-3');
      expect(cls.split(/\s+/)).not.toContain('px-4');
      expect(cls.split(/\s+/)).not.toContain('py-2');
    });

    it('lets the terminal scroll buttons keep w-10 h-10 over icon size (change 41)', () => {
      const cls = buttonClasses('ghost', 'icon', 'w-10 h-10');
      expect(cls).toContain('w-10');
      expect(cls).toContain('h-10');
      expect(cls.split(/\s+/)).not.toContain('w-7');
      expect(cls.split(/\s+/)).not.toContain('h-7');
    });

    it('never mistakes a text COLOR for a text size', () => {
      // text-on-accent / text-fg-2 must survive a text-base override.
      expect(buttonClasses('primary', 'md', 'text-base')).toContain('text-on-accent');
      expect(buttonClasses('secondary', 'md', 'text-base')).toContain('text-fg-2');
    });

    it('keeps variant-prefixed classes, which never conflict', () => {
      const cls = buttonClasses('primary', 'md', 'rounded-full');
      expect(cls).toContain('hover:bg-accent/90');
      expect(cls).toContain('disabled:opacity-50');
      expect(cls).toContain('focus-visible:ring-2');
    });

    it('leaves the base untouched when nothing is overridden', () => {
      expect(buttonClasses('primary', 'lg')).toContain('rounded-lg');
      expect(buttonClasses('primary', 'lg')).toContain('text-sm');
    });
  });
});

describe('CloseButton', () => {
  it('is an icon-size ghost with an accessible name', () => {
    render(<CloseButton />);
    const btn = screen.getByRole('button', { name: 'Close' });
    expect(btn).toHaveClass('w-7', 'h-7');
  });

  it('accepts a more specific label', () => {
    render(<CloseButton label="Close settings" />);
    expect(screen.getByRole('button', { name: 'Close settings' })).toBeInTheDocument();
  });
});

describe('Toggle', () => {
  it('is a switch with state, which only 2 of ~14 toggles used to be', () => {
    render(<Toggle checked={false} onChange={() => {}} />);
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('uses accent for the on-state, not green', () => {
    // Settings/sync toggles were green-600 (change 16).
    render(<Toggle checked onChange={() => {}} />);
    expect(screen.getByRole('switch').className).toContain('bg-accent');
    expect(screen.getByRole('switch').className).not.toContain('green');
  });

  it('uses the destructive token for danger toggles, not a raw hex', () => {
    // Skip Permissions / approve-all were a literal bg-[#DD4444] (change 17).
    render(<Toggle checked tone="danger" onChange={() => {}} />);
    const cls = screen.getByRole('switch').className;
    expect(cls).toContain('bg-destructive');
    expect(cls).not.toContain('#DD4444');
  });

  it('keeps the border in BOTH states so the knob cannot shift', () => {
    // Risk 3: absolutely-positioned children resolve against the PADDING box, so
    // a border that exists in only one state moves the knob 1px on flip. The
    // on-state border is transparent, not absent.
    const { rerender } = render(<Toggle checked={false} onChange={() => {}} />);
    expect(screen.getByRole('switch').className).toContain('border-edge-dim');
    rerender(<Toggle checked onChange={() => {}} />);
    expect(screen.getByRole('switch').className).toContain('border-transparent');
  });

  it('travels the knob 16px between symmetric ends', () => {
    const { rerender } = render(<Toggle checked={false} onChange={() => {}} />);
    const knob = () => screen.getByRole('switch').querySelector('span')!;
    expect(knob()).toHaveStyle({ left: '1px' });
    rerender(<Toggle checked onChange={() => {}} />);
    expect(knob()).toHaveStyle({ left: '17px' });
  });

  it('rings the knob so it stays visible on light tracks', () => {
    // Bare bg-white is ~1.2:1 against Creme's off-state track (--inset #DDD1BE).
    render(<Toggle checked={false} onChange={() => {}} />);
    expect(screen.getByRole('switch').querySelector('span')!.className).toContain('border-edge-dim');
  });

  it('reports the flipped value', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('Checkbox', () => {
  it('is a checkbox with state', () => {
    render(<Checkbox checked onChange={() => {}} />);
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps a literal 4px radius so it can never render as a circle', () => {
    // Radii are theme tokens; a big-radius pack would round a 14px box into a
    // Radio. The shape carries meaning, so it is not themeable.
    render(<Checkbox checked={false} onChange={() => {}} />);
    // Asserted via the style attribute rather than toHaveStyle: jsdom's CSSOM
    // doesn't expose the border-radius shorthand through getComputedStyle, so
    // toHaveStyle reports it as absent even when it renders.
    expect(screen.getByRole('checkbox').getAttribute('style')).toContain('border-radius: 4px');
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
  it('focuses by border color, not a ring or a gray', () => {
    // Retires focus:border-fg-muted (gray focus) and focus:ring-* focus.
    expect(FIELD).toContain('focus:border-accent');
    expect(FIELD).not.toContain('focus:ring');
    expect(FIELD).not.toContain('focus:border-fg-muted');
  });

  it('sits on inset, never canvas or well', () => {
    expect(FIELD).toContain('bg-inset');
    expect(FIELD).not.toContain('bg-canvas');
    expect(FIELD).not.toContain('bg-well');
  });

  it('keeps a disabled affordance', () => {
    // Disabled fields already exist (EngineCard, InputBar, ReportReviewButton).
    expect(FIELD).toContain('disabled:opacity-50');
  });

  it('applies to non-text inputs too, keeping their native type', () => {
    // Password/search/number all route through FIELD (change 20 + §9.I).
    const { container } = render(<TextInput type="password" defaultValue="k" />);
    const input = container.querySelector('input')!;
    expect(input).toHaveAttribute('type', 'password');
    expect(input.className).toContain('bg-inset');
  });

  it('Textarea defaults to non-resizable', () => {
    const { container } = render(<Textarea />);
    expect(container.querySelector('textarea')!.className).toContain('resize-none');
  });

  it('Textarea can opt back into resizing', () => {
    const { container } = render(<Textarea resizable />);
    expect(container.querySelector('textarea')!.className).not.toContain('resize-none');
  });
});

describe('InputGroup (change 77 — the action goes inside the field)', () => {
  it('moves the focus state to the wrapper', () => {
    // The whole reason this is a primitive and not a className: the input inside
    // is borderless, so `focus:border-accent` on it would paint nothing. If this
    // assertion ever fails, focusing one of these fields shows NO focus state.
    const { container } = render(
      <InputGroup>
        <InputGroup.Field />
      </InputGroup>,
    );
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).toContain('focus-within:border-accent');
    expect(wrapper.className).toContain('border-edge-dim');
  });

  it('gives the wrapper the surface and the input none of it', () => {
    const { container } = render(
      <InputGroup>
        <InputGroup.Field />
      </InputGroup>,
    );
    const wrapper = container.firstElementChild!;
    const input = container.querySelector('input')!;

    expect(wrapper.className).toContain('bg-inset');
    // The input must stay bare or you get a border inside a border.
    expect(input.className).toContain('bg-transparent');
    expect(input.className).toContain('border-0');
    expect(input.className).not.toContain('bg-inset');
  });

  it('passes its size down to the field without prop drilling', () => {
    const { container } = render(
      <InputGroup size="sm">
        <InputGroup.Field />
      </InputGroup>,
    );
    // sm padding, from FIELD_SIZE — same scale as every other field.
    expect(container.querySelector('input')!.className).toContain('px-2.5');
  });

  it('lets a field override the inherited size', () => {
    const { container } = render(
      <InputGroup size="sm">
        <InputGroup.Field size="md" />
      </InputGroup>,
    );
    expect(container.querySelector('input')!.className).toContain('px-3');
  });

  it('keeps the native input type', () => {
    const { container } = render(
      <InputGroup>
        <InputGroup.Field type="password" />
      </InputGroup>,
    );
    expect(container.querySelector('input')!).toHaveAttribute('type', 'password');
  });

  it('lets a caller override a field size deterministically', () => {
    // fieldClasses goes through mergeClasses for the same reason buttonClasses
    // does — Tailwind resolves competing utilities by CSS source order, so plain
    // concatenation left the winner up to emission order. If this regresses, a
    // caller passing text-sm/px-4 gets a coin flip, not an override.
    const { container } = render(<TextInput size="md" className="text-sm px-4" />);
    const cls = container.querySelector('input')!.className;
    expect(cls).toContain('text-sm');
    expect(cls).toContain('px-4');
    expect(cls).not.toContain('text-xs');
    expect(cls).not.toContain('px-3');
  });

  it('keeps non-conflicting base classes when overriding', () => {
    const { container } = render(<TextInput className="text-sm" />);
    const cls = container.querySelector('input')!.className;
    // Colors and the focus rule are a different group — they must survive.
    expect(cls).toContain('bg-inset');
    expect(cls).toContain('focus:border-accent');
  });

  it('shares one surface definition with the plain field', () => {
    // FIELD_SURFACE is split out of FIELD precisely so a bordered field and a
    // grouped one can't drift apart. Pin that they still agree.
    expect(FIELD).toContain(FIELD_SURFACE);
  });
});

describe('Select', () => {
  const OPTS = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
    { value: 'c', label: 'Gamma' },
  ];

  it('renders NO native select — that is the entire point', () => {
    // A styled trigger alone leaves the OS-rendered option list (the blue
    // highlight menu) dropping out of a themed app.
    const { container } = render(<Select options={OPTS} value="a" onChange={() => {}} aria-label="Pick" />);
    expect(container.querySelector('select')).toBeNull();
    expect(screen.getByRole('button')).toHaveAttribute('aria-haspopup', 'listbox');
  });

  it('opens a listbox of options', () => {
    render(<Select options={OPTS} value="a" onChange={() => {}} aria-label="Pick" />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('marks the selected option', () => {
    render(<Select options={OPTS} value="b" onChange={() => {}} aria-label="Pick" />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('option', { name: 'Beta' })).toHaveAttribute('aria-selected', 'true');
  });

  it('scrolls rather than clips a long catalog', () => {
    // RuntimeBinding's model select renders a provider's whole catalog; the
    // scroll MUST be on an inner element, because .layer-surface's
    // `overflow: hidden` is unlayered and would beat an overflow-y-auto utility.
    render(<Select options={OPTS} value="a" onChange={() => {}} aria-label="Pick" />);
    fireEvent.click(screen.getByRole('button'));
    const list = screen.getByRole('listbox');
    expect(list.className).toContain('overflow-y-auto');
    expect(list.className).toContain('max-h-64');
  });

  it('selects with the keyboard', () => {
    const onChange = vi.fn();
    render(<Select options={OPTS} value="a" onChange={onChange} aria-label="Pick" />);
    const trigger = screen.getByRole('button');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // opens
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // a -> b
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('jumps by first character', () => {
    const onChange = vi.fn();
    render(<Select options={OPTS} value="a" onChange={onChange} aria-label="Pick" />);
    const trigger = screen.getByRole('button');
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'g' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('skips disabled options when navigating', () => {
    const onChange = vi.fn();
    const opts = [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta', disabled: true },
      { value: 'c', label: 'Gamma' },
    ];
    render(<Select options={opts} value="a" onChange={onChange} aria-label="Pick" />);
    const trigger = screen.getByRole('button');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('c');
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

  it('uses option B for inactive tabs — transparent, tint on hover', () => {
    // DECIDED 2026-07-16. Option A (always-tinted inactive) was rendered and
    // not taken; Library tabs tinted inactive with bg-inset before this.
    render(<SegmentedTabs tabs={TABS} value="x" onChange={() => {}} aria-label="Sections" />);
    const inactive = screen.getByRole('tab', { name: 'Y' });
    expect(inactive.className).toContain('hover:bg-inset');
    expect(inactive.className).not.toMatch(/(^|\s)bg-inset(\s|$)/);
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

  it('tracks on inset, never well', () => {
    render(<ProgressBar percent={50} aria-label="p" />);
    const track = screen.getByRole('progressbar');
    expect(track.className).toContain('bg-inset');
    expect(track.className).not.toContain('bg-well');
  });

  it('rounds the fill and lets a status hue override the accent', () => {
    render(<ProgressBar percent={50} color="rgb(255, 0, 0)" aria-label="p" />);
    const fill = screen.getByRole('progressbar').firstElementChild as HTMLElement;
    expect(fill.className).toContain('rounded-full');
    expect(fill).toHaveStyle({ backgroundColor: 'rgb(255, 0, 0)' });
  });
});

describe('Toast', () => {
  it('announces politely without stealing focus', () => {
    render(<Toast message="Copied" onDismiss={() => {}} />);
    const toast = screen.getByRole('status');
    expect(toast).toHaveAttribute('aria-live', 'polite');
    expect(toast).toHaveTextContent('Copied');
  });

  it('owns its dismiss timer so call sites stop re-implementing it', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast message="Saved" onDismiss={onDismiss} durationMs={3000} />);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('does not fire its timer after unmount', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { unmount } = render(<Toast message="Saved" onDismiss={onDismiss} />);
    unmount();
    vi.advanceTimersByTime(5000);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('can require an explicit dismiss', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast message="Stay" onDismiss={onDismiss} durationMs={null} />);
    vi.advanceTimersByTime(60_000);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('state family', () => {
  it('loading always names what is loading', () => {
    // "Loading sessions…", never a bare "Loading…".
    render(<LoadingState what="sessions" />);
    expect(screen.getByText(/Loading sessions/)).toBeInTheDocument();
  });

  it('empty offers a way out when given one', () => {
    const onClick = vi.fn();
    render(<EmptyState message="No themes match" action={{ label: 'Clear filters', onClick }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClick).toHaveBeenCalled();
  });

  it('errors are NEUTRAL cards, not red-tinted boxes', () => {
    // Option C, chosen explicitly over B ("destructive-tinted callout").
    // The dot carries the failure; the container does not (rule 6).
    const { container } = render(<ErrorState message="Fetch failed" onRetry={() => {}} />);
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('bg-inset/50');
    expect(card.className).not.toContain('bg-destructive');
    expect(card.querySelector('.bg-destructive')).not.toBeNull(); // the mark
  });

  it('Retry is a FILLED primary', () => {
    // Explicit review correction from secondary — secondary reads as a dim
    // outline on dark themes.
    render(<ErrorState message="Fetch failed" onRetry={() => {}} />);
    expect(screen.getByRole('button', { name: 'Retry' }).className).toContain('bg-accent');
  });

  it('general errors ship the two documented actions', () => {
    // This IS the reusable two-action component docs/error-message-standards.md
    // schedules for v1.3.1.
    const onReportBug = vi.fn();
    const onDiagnose = vi.fn();
    render(
      <ErrorState
        mode="general"
        title="Unable to run local models"
        explainer="Something went wrong."
        onReportBug={onReportBug}
        onDiagnose={onDiagnose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Report bug' }));
    fireEvent.click(screen.getByRole('button', { name: 'Diagnose with the assistant' }));
    expect(onReportBug).toHaveBeenCalled();
    expect(onDiagnose).toHaveBeenCalled();
  });

  it('field errors use the destructive token at the named size', () => {
    // Change 34 (text-red-500 -> text-destructive) and rule 14 (§9.H fixed the
    // spec's own text-[10px] here).
    render(<FieldError>Required</FieldError>);
    const el = screen.getByText('Required');
    expect(el.className).toContain('text-destructive');
    expect(el.className).toContain('text-3xs');
    expect(el.className).not.toContain('text-red-500');
    expect(el.tagName).toBe('SPAN');
  });

  // The adoption sweep found the app split between two type steps and a mix of
  // block/inline hosts, so the primitive takes both as PROPS. Neither could be a
  // className pass-through: this component concatenates className onto its base,
  // and Tailwind resolves competing utilities by CSS source order, so a caller's
  // `text-2xs` would silently keep rendering at 3xs.
  it('size="2xs" replaces the base step rather than piling on next to it', () => {
    render(<FieldError size="2xs">Too short</FieldError>);
    const el = screen.getByText('Too short');
    expect(el.className).toContain('text-2xs');
    expect(el.className).not.toContain('text-3xs');
  });

  it('as="p" renders a block host so vertical margin still lays out', () => {
    // `mt-1` on an inline element does nothing; 21 of the swapped sites were
    // <p> carrying exactly that kind of spacing class.
    render(<FieldError as="p" className="mt-1">Nope</FieldError>);
    const el = screen.getByText('Nope');
    expect(el.tagName).toBe('P');
    expect(el.className).toContain('mt-1');
    expect(el.getAttribute('role')).toBe('alert');
  });
});
