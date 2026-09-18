// @vitest-environment jsdom
// SkillCard — Task 10: the memo comparator used to ignore handler identity
// (favoriteFilled/name only), which meant a skipped render could keep calling
// a STALE onClick/onToggle forever. The fix reads handlers through a ref
// (the "RowMemo" pattern, see ResumeBrowser's rowActions.current) refreshed
// by an unmemoized outer wrapper, so the inner card can memoize on data alone
// (default shallow compare) and a skipped render still fires the latest
// handler at click time.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import type { SkillEntry } from '../src/shared/types';

// Mock FavoriteStar with something we can both click and count renders of —
// a render-count increase proves SkillCard's inner memo actually re-ran;
// its absence proves the render was skipped.
const favoriteStarRenders = vi.fn();
vi.mock('../src/renderer/components/marketplace/FavoriteStar', () => ({
  default: (props: { filled: boolean; onToggle: () => void }) => {
    favoriteStarRenders();
    return (
      // Real FavoriteStar stops propagation so the card's own onClick
      // doesn't also fire (FavoriteStar.tsx:41) — mirror that here.
      <button aria-label="favorite" onClick={(e) => { e.stopPropagation(); props.onToggle(); }}>
        {props.filled ? 'filled' : 'empty'}
      </button>
    );
  },
}));

import SkillCard from '../src/renderer/components/SkillCard';

afterEach(cleanup);

const skill: SkillEntry = {
  id: 'skill-1',
  displayName: 'Test Skill',
  description: 'Does a thing',
  category: 'other',
  prompt: '',
  source: 'self',
  type: 'prompt',
  visibility: 'private',
};

describe('SkillCard', () => {
  it('clicking the card calls onClick with the skill', () => {
    const onClick = vi.fn();
    render(<SkillCard skill={skill} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: /Test Skill/ }));
    expect(onClick).toHaveBeenCalledWith(skill);
  });

  it('clicking the favorite star calls onToggle, not the card onClick', () => {
    const onClick = vi.fn();
    const onToggle = vi.fn();
    render(<SkillCard skill={skill} onClick={onClick} favorite={{ filled: false, onToggle }} />);
    fireEvent.click(screen.getByRole('button', { name: 'favorite' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('a skipped re-render (identical data, new handler) still fires the LATEST onToggle', () => {
    favoriteStarRenders.mockClear();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    const { rerender } = render(
      <SkillCard skill={skill} onClick={vi.fn()} favorite={{ filled: false, onToggle: handlerA }} />
    );
    expect(favoriteStarRenders).toHaveBeenCalledTimes(1);

    // Same skill object, same `filled` — only the handler identity changes,
    // exactly what the old comparator ignored and the new ref exists for.
    rerender(
      <SkillCard skill={skill} onClick={vi.fn()} favorite={{ filled: false, onToggle: handlerB }} />
    );
    // The inner memoized card did NOT re-render — data was unchanged.
    expect(favoriteStarRenders).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'favorite' }));
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerA).not.toHaveBeenCalled();
  });

  it('re-renders (and updates the star) when favorite.filled actually changes', () => {
    favoriteStarRenders.mockClear();
    const { rerender } = render(
      <SkillCard skill={skill} onClick={vi.fn()} favorite={{ filled: false, onToggle: vi.fn() }} />
    );
    expect(screen.getByRole('button', { name: 'favorite' }).textContent).toBe('empty');

    rerender(<SkillCard skill={skill} onClick={vi.fn()} favorite={{ filled: true, onToggle: vi.fn() }} />);
    expect(screen.getByRole('button', { name: 'favorite' }).textContent).toBe('filled');
    expect(favoriteStarRenders.mock.calls.length).toBeGreaterThan(1);
  });
});
