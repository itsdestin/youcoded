import React from 'react';
import { InteractivePrompt } from '../state/chat-types';
import { CheckIcon } from './Icons';

interface Props {
  prompt: InteractivePrompt;
  sessionId: string;
  onSelect: (input: string, label: string) => void;
}

// Classify button intent from label text
function buttonIntent(label: string): 'accept' | 'reject' | 'neutral' {
  const l = label.toLowerCase();
  if (/^(yes|allow|accept|trust|approve)\b/.test(l)) return 'accept';
  if (/always allow/.test(l)) return 'accept';
  if (/^(no|deny|reject|decline|skip|cancel|abort)\b/.test(l)) return 'reject';
  if (/don.t trust/.test(l)) return 'reject';
  return 'neutral';
}

const intentStyles = {
  accept: 'bg-green-600/60 hover:bg-green-600/80 text-green-100',
  reject: 'bg-red-600/60 hover:bg-red-600/80 text-red-100',
  neutral: 'bg-blue-600/60 hover:bg-blue-600/80 text-blue-100',
};

/**
 * Parser-detected prompt card — styled to match ToolCard layout.
 */
export default function PromptCard({ prompt, sessionId, onSelect }: Props) {
  if (prompt.completed) {
    return (
      <div className="flex justify-start px-4 py-0.5">
        <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-inset px-2 py-1">
          <div className="border border-edge rounded-lg px-3 py-2 flex items-center gap-1.5">
            <CheckIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
            <span className="text-fg-faint text-xs select-none">|</span>
            <span className="text-xs font-medium text-fg-2">{prompt.title}:</span>
            <span className="text-xs text-fg font-medium">{prompt.completed}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start px-4 py-1">
      <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-inset px-2 py-1">
        <div className="border border-edge rounded-lg overflow-hidden">
          {/* Header — matches ToolCard style with | separator */}
          <div className="flex items-center gap-1.5 px-3 py-2">
            <span className="text-fg-faint text-xs select-none">|</span>
            <span className="text-xs font-medium text-fg-2">{prompt.title}</span>
          </div>
          {/* Buttons */}
          <div className="flex items-center gap-2 px-3 py-2 border-t border-edge bg-inset/30">
            {prompt.buttons.map((btn) => (
              <button
                key={btn.label}
                onClick={() => onSelect(btn.input, btn.label)}
                className={`px-3 py-1 text-xs font-medium rounded-sm transition-colors ${intentStyles[buttonIntent(btn.label)]}`}
              >
                {btn.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
