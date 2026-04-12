import React from 'react';
import type { CopyPickerOption } from '../state/chat-types';

// Inline picker shown when /copy [N] targets an assistant turn with multiple
// copyable units (the full text + each code block). On Android in particular,
// PTY clipboard escapes are unreliable — doing the copy ourselves via
// navigator.clipboard is the only way that works cross-platform.

interface Props {
  id: string;
  options: CopyPickerOption[];
  onCopy: (content: string, label: string) => void;
  onDismiss: () => void;
}

export default function CopyPicker({ options, onCopy, onDismiss }: Props) {
  return (
    <div className="flex justify-start px-4 py-1">
      <div className="max-w-[85%] w-full bg-inset border border-edge-dim rounded-2xl rounded-bl-sm px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs uppercase tracking-wider text-fg-muted font-medium">
            Copy to clipboard
          </div>
          <button
            onClick={onDismiss}
            className="text-fg-muted hover:text-fg text-xs"
            aria-label="Cancel copy"
          >
            ✕
          </button>
        </div>
        <div className="space-y-1.5">
          {options.map((opt) => (
            <button
              key={opt.id}
              onClick={() => onCopy(opt.content, opt.label)}
              className="w-full text-left px-3 py-2 rounded-lg bg-panel hover:bg-well border border-edge-dim transition-colors"
            >
              <div className="text-sm text-fg font-medium">{opt.label}</div>
              {opt.preview && (
                <div className="text-xs text-fg-muted mt-0.5 truncate font-mono">{opt.preview}</div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
