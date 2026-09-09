// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { defaultMascotPaint } from '../src/renderer/components/mascot/default-mascot-paint';
import { DEFAULT_BUDDY_RIG } from '../src/renderer/components/mascot/default-buddy-rig';
import { MascotRig } from '../src/renderer/components/mascot/MascotRig';

describe('approved default mascot paint', () => {
  it.each([
    ['light', '#DCE5E2', '#263832', '#FFFFFF'],
    ['creme', '#EAD7B4', '#3D2D23', '#FFF4D0'],
  ])('%s has independent body, face and catchlight', (theme, body, face, spark) => {
    expect(defaultMascotPaint(theme)).toMatchObject({ '--default-mascot-body': body, '--default-mascot-face': face, '--default-mascot-catchlight': spark });
    expect(defaultMascotPaint(theme, true)['--default-mascot-rim']).toBe(face);
    expect(defaultMascotPaint(theme)['--default-mascot-rim']).toBe('none');
  });
  it.each(['dark', 'midnight', 'community'])('preserves %s token mapping', theme => {
    expect(defaultMascotPaint(theme, true)).toMatchObject({ '--default-mascot-body': 'var(--accent)', '--default-mascot-face': 'var(--on-accent)', '--default-mascot-catchlight': 'var(--accent)', '--default-mascot-rim': 'none' });
  });
  it('keeps all eight faces and gives every catchlight its own paint variable', () => {
    const doc = new DOMParser().parseFromString(DEFAULT_BUDDY_RIG, 'image/svg+xml');
    expect(doc.querySelectorAll('[id^="rig-face-"]')).toHaveLength(8);
    const catches = [...doc.querySelectorAll('.pupil circle')];
    expect(catches).toHaveLength(18);
    catches.forEach(c => expect(c.getAttribute('fill')).toContain('--default-mascot-catchlight'));
    expect(doc.querySelector('#rig-hand-peek-left rect')?.getAttribute('fill')).toContain('--default-mascot-body');
  });
  it('marks only the bundled rig for the small silhouette rim', () => {
    const { container } = render(<MascotRig svgUrl={null} pose="idle" reducedEffects motionRef={{ current: { vx: 0, vy: 0, dragging: false } }} />);
    expect(container.querySelector('svg')?.getAttribute('data-default-mascot')).toBe('rig');
  });
});
