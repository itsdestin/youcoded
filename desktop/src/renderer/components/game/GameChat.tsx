import React, { useState, useRef, useEffect } from 'react';
import { useGameState } from '../../state/game-context';
import { GameConnection } from '../../state/game-types';
import { SectionLabel, TextInput } from '../ui';

interface Props {
  connection: GameConnection;
}

export default function GameChat({ connection }: Props) {
  const state = useGameState();
  const [text, setText] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to newest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.chatMessages]);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    connection.sendChat(trimmed);
    setText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  };

  // Retheme (§5.4/§5.5): the sender's name was coloured by their Connect 4
  // disc (red/yellow), which is meaningless in a game with no discs and
  // identical in every theme. Speakers now use the app's you-vs-them pair —
  // the same one the board, the leaderboard and chat itself use — so the name
  // above a message matches the piece on the board without a lookup.
  const colorForSender = (from: string): string =>
    from === state.username ? 'text-accent' : 'text-fg-muted';

  return (
    // `flex-1 min-h-0` instead of the old 120–160px cap: the chat fills the
    // rest of the pane so the input sits at the bottom, rather than the board
    // and a stub of chat huddling at the top of a tall pane (Destin, G-7).
    <div className="border-t border-edge flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="px-3 py-1.5 border-b border-edge shrink-0">
        {/* WHY SectionLabel, sentence case (labels batch, guide: no spaced
            capitals — decisions H-3/L-1…L-4). This header labels the panel,
            not a chat bubble, so it isn't covered by the bubble exemption. */}
        <SectionLabel>Game chat</SectionLabel>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-1.5 flex flex-col gap-1">
        {state.chatMessages.length === 0 ? (
          <p className="text-xs text-fg-muted italic">No messages yet</p>
        ) : (
          state.chatMessages.map((msg, i) => (
            <div key={i} className="flex gap-1.5 text-xs">
              <span className={`font-medium shrink-0 ${colorForSender(msg.from)}`}>
                {msg.from}:
              </span>
              <span className="text-fg-2 break-words min-w-0">{msg.text}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-3 py-2 border-t border-edge shrink-0">
        {/* Change 20: bg-well + the gray focus (`focus:border-fg-dim`) → the shared
            FIELD surface. Enter-to-send and the 200-char cap are unchanged. NOT an
            InputGroup: this composer has no visible submit button to move inside —
            Enter is the only way to send. */}
        <TextInput
          type="text"
          size="md"
          aria-label="Game chat message"
          className="w-full"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Say something..."
          maxLength={200}
        />
      </div>
    </div>
  );
}
