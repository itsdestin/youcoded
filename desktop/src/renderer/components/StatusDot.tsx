import React from 'react';

export type SessionStatusColor = 'green' | 'red' | 'blue' | 'gray';

interface Props {
  color: SessionStatusColor;
  className?: string;
}

/**
 * A small status indicator dot.
 * - green/red: pulsing animation (active/awaiting)
 * - blue: solid (response arrived, unseen)
 * - gray: solid (idle/seen)
 */
export default function StatusDot({ color, className = '' }: Props) {
  const pulsing = color === 'green' || color === 'red';

  const colorMap: Record<SessionStatusColor, string> = {
    green: 'bg-green-400/80',
    red: 'bg-red-400/80',
    blue: 'bg-blue-400/70',
    gray: 'bg-gray-500/50',
  };

  const glowMap: Record<SessionStatusColor, string> = {
    green: 'bg-green-400/30',
    red: 'bg-red-400/30',
    blue: '',
    gray: '',
  };

  return (
    <span className={`relative inline-flex items-center justify-center w-2 h-2 shrink-0 ${className}`}>
      {pulsing && (
        <span className={`absolute w-full h-full rounded-full animate-ping ${glowMap[color]}`} />
      )}
      <span className={`relative w-1.5 h-1.5 rounded-full ${colorMap[color]}`} />
    </span>
  );
}
