import React, { useState, useEffect } from 'react';
import BrailleSpinner from './BrailleSpinner';

const THINKING_LINES = [
  'Thinking',
  'Cogitating',
  'Pondering',
  'Ruminating',
  'Noodling',
  'Percolating',
  'Brainstorming',
  'Deliberating',
  'Marinating',
  'Musing',
  'Contemplating',
  'Stewing',
  'Mulling it over',
  'Chewing on it',
  'Untangling',
  'Connecting dots',
  'Rearranging neurons',
  'Consulting the vibes',
  'Findangling',
  'Embellishing',
  'Simmering',
  'Calibrating',
  'Perplexing',
];

export default function ThinkingIndicator() {
  const [lineIndex, setLineIndex] = useState(() =>
    Math.floor(Math.random() * THINKING_LINES.length),
  );

  useEffect(() => {
    const id = setInterval(() => {
      setLineIndex(Math.floor(Math.random() * THINKING_LINES.length));
    }, 2500);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center gap-2 px-4 py-1.5">
      <div className="flex items-center gap-2 bg-inset rounded-2xl rounded-bl-sm px-4 py-2.5">
        <BrailleSpinner size="base" />
        <span className="text-sm text-fg-dim">
          {THINKING_LINES[lineIndex]}
        </span>
      </div>
    </div>
  );
}
