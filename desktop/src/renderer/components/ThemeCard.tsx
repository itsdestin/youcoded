import React from 'react';
import type { ThemeRegistryEntryWithStatus } from '../../shared/theme-marketplace-types';

interface ThemeCardProps {
  entry: ThemeRegistryEntryWithStatus;
  onClick: () => void;
}

/** Mini mock UI rendered from theme token colors */
function TokenPreview({ tokens, dark }: { tokens: NonNullable<ThemeRegistryEntryWithStatus['previewTokens']>; dark: boolean }) {
  return (
    <div className="w-full h-24 overflow-hidden relative" style={{ background: tokens.canvas }}>
      {/* Header bar */}
      <div
        className="h-5 flex items-center px-2 gap-1"
        style={{ background: tokens.panel, borderBottom: `1px solid ${tokens.edge}` }}
      >
        <div className="w-1.5 h-1.5 rounded-full" style={{ background: tokens.accent }} />
        <div className="h-1.5 rounded-sm flex-1 max-w-[40%]" style={{ background: tokens.fg, opacity: 0.15 }} />
      </div>
      {/* Chat area */}
      <div className="p-2 flex flex-col gap-1.5">
        {/* User bubble */}
        <div className="self-end rounded-md px-2 py-1 max-w-[55%]" style={{ background: tokens.accent }}>
          <div className="h-1 rounded-sm w-12" style={{ background: tokens['on-accent'], opacity: 0.7 }} />
          <div className="h-1 rounded-sm w-8 mt-0.5" style={{ background: tokens['on-accent'], opacity: 0.5 }} />
        </div>
        {/* Assistant bubble */}
        <div className="self-start rounded-md px-2 py-1 max-w-[65%]" style={{ background: tokens.panel, border: `1px solid ${tokens.edge}` }}>
          <div className="h-1 rounded-sm w-16" style={{ background: tokens.fg, opacity: 0.4 }} />
          <div className="h-1 rounded-sm w-20 mt-0.5" style={{ background: tokens.fg, opacity: 0.3 }} />
          <div className="h-1 rounded-sm w-10 mt-0.5" style={{ background: tokens.fg, opacity: 0.2 }} />
        </div>
      </div>
      {/* Input bar */}
      <div className="absolute bottom-0 left-0 right-0 h-5 flex items-center px-2" style={{ background: tokens.panel, borderTop: `1px solid ${tokens.edge}` }}>
        <div className="flex-1 h-2.5 rounded-sm mr-1.5" style={{ background: tokens.canvas, border: `1px solid ${tokens.edge}` }} />
        <div className="w-3 h-3 rounded-full" style={{ background: tokens.accent }} />
      </div>
    </div>
  );
}

export default function ThemeCard({ entry, onClick }: ThemeCardProps) {
  return (
    <button
      onClick={onClick}
      className="relative rounded-lg overflow-hidden border border-edge-dim hover:border-edge transition-colors text-left group"
    >
      {/* Preview: hosted image > token-based mock > gradient fallback */}
      {entry.preview ? (
        <div className="w-full h-24 bg-well overflow-hidden">
          <img
            src={entry.preview}
            alt={entry.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
            loading="lazy"
          />
        </div>
      ) : entry.previewTokens ? (
        <TokenPreview tokens={entry.previewTokens} dark={entry.dark} />
      ) : (
        <div
          className="w-full h-24"
          style={{
            background: entry.dark
              ? 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)'
              : 'linear-gradient(135deg, #f5f5f5 0%, #e8e8e8 50%, #ddd 100%)',
          }}
        />
      )}

      {/* Info */}
      <div className="px-2.5 py-2 bg-panel">
        <div className="flex items-center gap-1.5 mb-0.5">
          <p className="text-[11px] font-medium text-fg truncate flex-1">{entry.name}</p>
          {/* Dark/Light indicator */}
          <span
            className="w-2.5 h-2.5 rounded-full border border-edge-dim shrink-0"
            style={{ background: entry.dark ? '#1a1a2e' : '#f2f2f2' }}
            title={entry.dark ? 'Dark theme' : 'Light theme'}
          />
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[9px] text-fg-muted truncate">{entry.author}</span>
          <span
            className={`text-[8px] font-medium px-1.5 py-0.5 rounded-full shrink-0 ${
              entry.source === 'destinclaude'
                ? 'bg-accent/15 text-accent'
                : 'bg-fg-faint/20 text-fg-muted'
            }`}
          >
            {entry.source === 'destinclaude' ? 'Official' : 'Community'}
          </span>
        </div>

        {/* Feature pills */}
        {entry.features.length > 0 && (
          <div className="flex gap-1 mt-1.5 flex-wrap">
            {entry.features.slice(0, 3).map(f => (
              <span key={f} className="text-[8px] text-fg-faint bg-well px-1.5 py-0.5 rounded-sm">
                {f}
              </span>
            ))}
            {entry.features.length > 3 && (
              <span className="text-[8px] text-fg-faint">+{entry.features.length - 3}</span>
            )}
          </div>
        )}
      </div>

      {/* Installed badge */}
      {entry.installed && (
        <div className="absolute top-1.5 right-1.5 bg-accent text-on-accent text-[8px] font-bold px-1.5 py-0.5 rounded-sm">
          Installed
        </div>
      )}
    </button>
  );
}
