import React, { useState, useCallback } from 'react';

const BRAILLE_CHARS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
function getThemeColors(): string[] {
  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue('--accent').trim() || '#85C1E9';
  const fg2 = style.getPropertyValue('--fg-2').trim() || '#D0D0D0';
  const fgDim = style.getPropertyValue('--fg-dim').trim() || '#B0B0B0';
  const fgMuted = style.getPropertyValue('--fg-muted').trim() || '#A8D8A8';
  const fgFaint = style.getPropertyValue('--fg-faint').trim() || '#D4A5D4';
  return [fgDim, fg2, accent, fgMuted, fgFaint];
}
const PARTICLE_COUNT = 5;

interface Particle {
  id: number;
  char: string;
  color: string;
  angle: number;
  dist: number;
  delay: number;
}

let idCounter = 0;

interface Props {
  children: React.ReactNode;
  onTrigger: () => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}

export default function BrailleBurst({ children, onTrigger, disabled, className, title }: Props) {
  const [particles, setParticles] = useState<Particle[]>([]);

  const burst = useCallback(() => {
    if (disabled) return;
    const colors = getThemeColors();
    const batch: Particle[] = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      batch.push({
        id: ++idCounter,
        char: BRAILLE_CHARS[Math.floor(Math.random() * BRAILLE_CHARS.length)],
        color: colors[Math.floor(Math.random() * colors.length)],
        angle: (360 / PARTICLE_COUNT) * i + (Math.random() * 20 - 10),
        dist: 8 + Math.random() * 6,
        delay: Math.random() * 60,
      });
    }
    setParticles(batch);
    onTrigger();
    // Clean up after animation completes
    setTimeout(() => setParticles([]), 500);
  }, [disabled, onTrigger]);

  return (
    <button
      type="button"
      onClick={burst}
      disabled={disabled}
      className={`relative ${className || ''}`}
      title={title}
    >
      {children}
      {particles.map((p) => {
        const rad = (p.angle * Math.PI) / 180;
        const tx = Math.cos(rad) * p.dist;
        const ty = Math.sin(rad) * p.dist;
        return (
          <span
            key={p.id}
            className="absolute pointer-events-none text-[10px]"
            style={{
              color: p.color,
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
              animation: `braille-burst 380ms ease-out ${p.delay}ms forwards`,
              opacity: 0,
              '--burst-x': `${tx}px`,
              '--burst-y': `${ty}px`,
            } as React.CSSProperties}
          >
            {p.char}
          </span>
        );
      })}
    </button>
  );
}
