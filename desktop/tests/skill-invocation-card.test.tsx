// @vitest-environment jsdom
// The skill-invocation card's link affordance.
//
// Destin, 2026-07-28: "instead of a separate 'SKILL.md' card i'd rather this
// appear as dotted underline under 'theme-builder'." The name is already the
// most natural thing to click; a file chip beside it repeated the same thing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import SkillInvocationCard from '../src/renderer/components/SkillInvocationCard';

beforeEach(() => { (window as any).claude = { artifacts: {} }; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('SkillInvocationCard', () => {
  it('shows the BARE skill name, not the plugin-qualified id', () => {
    render(<SkillInvocationCard skillId="wecoded-themes-plugin:theme-builder" displayName="Theme Builder" sessionId="s" skillPath="/x/SKILL.md" />);
    expect(screen.getByText('theme-builder')).toBeTruthy();
    expect(screen.queryByText(/wecoded-themes-plugin:/)).toBeNull();
  });

  it('makes the NAME the link — no separate SKILL.md chip', () => {
    render(<SkillInvocationCard skillId="p:theme-builder" displayName="T" sessionId="s" skillPath="/x/SKILL.md" />);
    const link = screen.getByText('theme-builder');
    expect(link.tagName).toBe('BUTTON');
    expect(link.className).toContain('decoration-dotted');
    // The old design rendered the basename as its own pill beside the name.
    expect(screen.queryByText('SKILL.md')).toBeNull();
  });

  it('the link carries the real path for the click handler and tooltip', () => {
    render(<SkillInvocationCard skillId="p:x" displayName="X" sessionId="s" skillPath="/plugins/x/SKILL.md" />);
    expect(document.querySelector('[data-hint="/plugins/x/SKILL.md"]')).toBeTruthy();
  });

  it('renders plain text when there is no path to open', () => {
    // A skill the harness could name but not locate must not look clickable.
    render(<SkillInvocationCard skillId="p:x" displayName="X" sessionId="s" />);
    const el = screen.getByText(/Invoked skill:/);
    expect(el.textContent).toContain('x');
    expect(el.querySelector('button')).toBeNull();
  });

  it('shows the user\'s own arguments when present', () => {
    render(<SkillInvocationCard skillId="p:x" displayName="X" sessionId="s" args="make it purple" />);
    expect(screen.getByText('make it purple')).toBeTruthy();
  });

  it('never renders the instructions', () => {
    const { container } = render(<SkillInvocationCard skillId="p:x" displayName="X" sessionId="s" skillPath="/x/SKILL.md" />);
    expect(container.textContent).not.toContain('skill-instructions');
  });
});
