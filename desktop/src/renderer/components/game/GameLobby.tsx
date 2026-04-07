import React, { useState, useEffect } from 'react';
import { useGameState, useGameDispatch } from '../../state/game-context';
import BrailleSpinner from '../BrailleSpinner';
import { GameConnection } from '../../state/game-types';

interface LeaderboardEntry {
  username: string;
  wins: number;
  losses: number;
}

interface Props {
  connection: GameConnection;
  incognito?: boolean;
  onToggleIncognito?: () => void;
}

function ErrorScreen() {
  const state = useGameState();
  const dispatch = useGameDispatch();
  const isConnectionError = !state.connected;

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4 py-8">
      <div className="w-16 h-16 rounded-full bg-red-900/30 flex items-center justify-center">
        <span className="text-2xl">!</span>
      </div>
      <p className="text-sm text-red-400 text-center">{state.partyError}</p>
      {isConnectionError ? (
        <p className="text-xs text-fg-muted text-center">Make sure GitHub CLI is installed and authenticated: gh auth login</p>
      ) : (
        <button
          onClick={() => dispatch({ type: 'CLEAR_CHALLENGE' })}
          className="text-xs text-[#66AAFF] hover:text-[#88CCFF] transition-colors"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

function LobbyScreen({ connection, incognito, onToggleIncognito }: Props) {
  const state = useGameState();
  const dispatch = useGameDispatch();
  const [joinCode, setJoinCode] = useState('');
  const [favorites, setFavorites] = useState<string[]>([]);

  useEffect(() => {
    (window as any).claude?.getFavorites?.().then((favs: string[]) => {
      if (favs) setFavorites(favs);
    });
  }, []);

  const toggleFavorite = (username: string) => {
    const updated = favorites.includes(username)
      ? favorites.filter(f => f !== username)
      : [...favorites, username];
    setFavorites(updated);
    (window as any).claude?.setFavorites?.(updated);
  };

  return (
    <div className="flex flex-col gap-0">
      {/* Player info bar */}
      <div className="px-3 py-2 border-b border-edge flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${incognito ? 'bg-fg-faint' : 'bg-green-400'}`} />
          <span className="text-sm font-medium text-fg">{state.username}</span>
          {incognito && <span className="text-[10px] text-fg-muted">Incognito</span>}
        </div>
        {onToggleIncognito && (
          <button
            onClick={onToggleIncognito}
            className={`text-[10px] px-1.5 py-0.5 rounded-sm transition-colors ${
              incognito
                ? 'bg-inset text-fg-2 hover:bg-edge'
                : 'text-fg-muted hover:text-fg-2'
            }`}
            title={incognito ? 'Go online — appear in player lists' : 'Go incognito — hide from player lists'}
          >
            {incognito ? 'Go Online' : 'Go Incognito'}
          </button>
        )}
      </div>

      {/* Incoming challenge */}
      {state.challengeFrom && (
        <div className="px-3 py-2 border-b border-edge bg-indigo-950/50">
          <p className="text-sm text-fg mb-2">
            <span className="font-medium text-[#66AAFF]">{state.challengeFrom}</span> wants to play!
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => {
                connection.respondToChallenge(state.challengeFrom!, true);
                connection.joinGame(state.challengeCode!);
                dispatch({ type: 'CLEAR_CHALLENGE' });
              }}
              className="flex-1 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded-lg py-1.5 transition-colors"
            >
              Accept
            </button>
            <button
              onClick={() => { connection.respondToChallenge(state.challengeFrom!, false); dispatch({ type: 'CLEAR_CHALLENGE' }); }}
              className="flex-1 bg-inset hover:bg-edge text-fg-2 text-xs font-medium rounded-lg py-1.5 transition-colors"
            >
              Decline
            </button>
          </div>
        </div>
      )}

      {/* Challenge declined notification */}
      {state.challengeDeclinedBy && (
        <div className="px-3 py-2 border-b border-edge">
          <p className="text-xs text-fg-dim">
            <span className="text-fg-2">{state.challengeDeclinedBy}</span> declined your challenge.
            <button onClick={() => dispatch({ type: 'CLEAR_CHALLENGE' })} className="text-[#66AAFF] ml-1">Dismiss</button>
          </p>
        </div>
      )}

      {/* Create / Join */}
      <div className="px-3 py-3 border-b border-edge flex flex-col gap-2">
        <button
          onClick={() => connection.createGame()}
          className="w-full bg-accent hover:bg-accent text-on-accent text-sm font-medium rounded-lg py-2 transition-colors"
        >
          Create Game
        </button>
        <div className="flex gap-2">
          <input
            type="text"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="Room code"
            maxLength={6}
            className="flex-1 bg-well border border-edge rounded-lg px-3 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-fg-dim transition-colors uppercase tracking-widest"
          />
          <button
            onClick={() => { if (joinCode.trim()) connection.joinGame(joinCode.trim()); }}
            disabled={!joinCode.trim()}
            className="bg-inset hover:bg-edge disabled:opacity-40 disabled:cursor-not-allowed text-fg text-sm font-medium rounded-lg px-3 py-2 transition-colors"
          >
            Join
          </button>
        </div>
      </div>

      {/* Online users */}
      {(() => {
        const otherUsers = state.onlineUsers.filter(u => u.username !== state.username);
        const onlineFavorites = otherUsers.filter(u => favorites.includes(u.username));
        const onlineNonFavorites = otherUsers.filter(u => !favorites.includes(u.username));
        const offlineFavorites = favorites
          .filter(f => f !== state.username && !otherUsers.some(u => u.username === f))
          .map(f => ({ username: f, status: 'offline' as const }));
        const sortedUsers = [...onlineFavorites, ...onlineNonFavorites, ...offlineFavorites];
        return (
          <div className="px-3 py-2 border-b border-edge">
            <div className="text-[10px] uppercase tracking-wider text-fg-muted mb-2">
              Players ({otherUsers.length} online{offlineFavorites.length > 0 ? `, ${offlineFavorites.length} favorite offline` : ''})
            </div>
            {sortedUsers.length === 0 ? (
              <p className="text-xs text-fg-faint italic">No one else online yet</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {sortedUsers.map((user) => {
                  const isOnline = user.status !== 'offline';
                  const isFav = favorites.includes(user.username);
                  return (
                    <li key={user.username} className="flex items-center gap-2">
                      <button
                        onClick={() => toggleFavorite(user.username)}
                        className={`text-xs shrink-0 transition-colors ${isFav ? 'text-yellow-400' : 'text-fg-faint hover:text-fg-dim'}`}
                        title={isFav ? 'Remove from favorites' : 'Add to favorites'}
                      >
                        {isFav ? '★' : '☆'}
                      </button>
                      <span className={`w-2 h-2 rounded-full shrink-0 ${
                        !isOnline ? 'bg-fg-faint' :
                        user.status === 'idle' ? 'bg-green-400' : 'bg-yellow-400'
                      }`} />
                      <span className={`text-sm truncate flex-1 ${isOnline ? 'text-fg-2' : 'text-fg-faint'}`}>
                        {user.username}
                      </span>
                      {isOnline && user.status === 'in-game' ? (
                        <span className="text-[10px] text-yellow-500 ml-auto">in game</span>
                      ) : isOnline ? (
                        <button
                          onClick={() => connection.challengePlayer(user.username)}
                          className="text-[10px] text-[#66AAFF] hover:text-[#88CCFF] ml-auto transition-colors"
                        >
                          Challenge
                        </button>
                      ) : (
                        <span className="text-[10px] text-fg-faint ml-auto">offline</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })()}

      {/* Leaderboard preview */}
      <div className="px-3 py-2">
        <div className="text-[10px] uppercase tracking-wider text-fg-muted mb-2">Top Players</div>
        <p className="text-xs text-fg-faint italic">No stats yet</p>
      </div>
    </div>
  );
}

function JoiningScreen({ connection }: Props) {
  const state = useGameState();
  const dispatch = useGameDispatch();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), 120_000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (timedOut) {
      connection.leaveGame();
      dispatch({ type: 'RETURN_TO_LOBBY' });
    }
  }, [timedOut, connection, dispatch]);

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 px-4 py-8">
      <div className="flex flex-col items-center gap-3">
        <p className="text-xs text-fg-muted uppercase tracking-wider">Joining Room</p>
        <p className="text-lg font-mono font-bold text-fg tracking-widest">{state.roomCode}</p>
      </div>

      <div className="flex flex-col items-center gap-2">
        <BrailleSpinner size="lg" />
        <p className="text-sm text-fg-dim">Connecting...</p>
      </div>

      <button
        onClick={() => { connection.leaveGame(); dispatch({ type: 'RETURN_TO_LOBBY' }); }}
        className="text-sm text-fg-muted hover:text-fg-2 transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

function WaitingScreen({ connection }: Props) {
  const state = useGameState();
  const dispatch = useGameDispatch();
  const code = state.roomCode ?? '';
  const [copied, setCopied] = useState(false);

  const copyCode = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 px-4 py-8">
      <div className="flex flex-col items-center gap-3">
        <p className="text-xs text-fg-muted uppercase tracking-wider">Room Code</p>
        <div className="flex gap-1.5">
          {code.split('').map((ch, i) => (
            <span
              key={i}
              className="w-9 h-10 flex items-center justify-center bg-inset border border-edge rounded-lg text-lg font-mono font-bold text-fg"
            >
              {ch}
            </span>
          ))}
        </div>
        <button
          onClick={copyCode}
          className="text-xs text-[#66AAFF] hover:text-[#88CCFF] transition-colors"
        >
          {copied ? 'Copied!' : 'Copy Code'}
        </button>
      </div>

      <div className="flex flex-col items-center gap-2">
        <BrailleSpinner size="lg" />
        <p className="text-sm text-fg-dim">Waiting for opponent...</p>
      </div>

      <button
        onClick={() => { connection.leaveGame(); dispatch({ type: 'RETURN_TO_LOBBY' }); }}
        className="text-sm text-fg-muted hover:text-fg-2 transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

export default function GameLobby({ connection, incognito, onToggleIncognito }: Props) {
  const state = useGameState();
  if (state.partyError && !incognito) return <ErrorScreen />;
  if (state.screen === 'joining') return <JoiningScreen connection={connection} />;
  if (state.screen === 'waiting') return <WaitingScreen connection={connection} />;
  return <LobbyScreen connection={connection} incognito={incognito} onToggleIncognito={onToggleIncognito} />;
}
