import type { CSSProperties } from 'react';
import './default-mascot-paint.css';

const PALETTES: Record<string, { body: string; face: string; catchlight: string }> = {
  light: { body: '#DCE5E2', face: '#263832', catchlight: '#FFFFFF' },
  creme: { body: '#EAD7B4', face: '#3D2D23', catchlight: '#FFF4D0' },
};

/** WHY: mascot art is not a button inversion. Only default-art callers opt in;
 * authored community rigs retain their existing token contract and fills. */
export function defaultMascotPaint(theme: string, small = false): CSSProperties & Record<string, string> {
  const palette = PALETTES[theme];
  return {
    '--default-mascot-body': palette?.body ?? 'var(--accent)',
    '--default-mascot-face': palette?.face ?? 'var(--on-accent)',
    '--default-mascot-catchlight': palette?.catchlight ?? 'var(--accent)',
    '--default-mascot-rim': small && palette ? palette.face : 'none',
    ...(palette ? { '--default-icon-face': palette.face, '--default-icon-body': palette.body } : {}),
  };
}
