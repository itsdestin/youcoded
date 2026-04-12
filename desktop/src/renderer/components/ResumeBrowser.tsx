import React, { useState, useEffect, useRef, useMemo } from 'react';
import { MODELS, type ModelAlias } from './StatusBar';
import { Scrim, OverlayPanel } from './overlays/Overlay';

const MODEL_LABELS: Record<string, string> = {
  sonnet: 'Sonnet',
  'opus[1m]': 'Opus 1M',
  haiku: 'Haiku',
};

function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = Math.round(bytes / 1024);
  if (kb < 1024) return `${kb}KB`;
  return `${(kb / 1024).toFixed(1)}MB`;
}

interface PastSession {
  sessionId: string;
  name: string;
  projectSlug: string;
  projectPath: string;
  lastModified: number;
  size: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onResume: (sessionId: string, projectSlug: string, projectPath: string, model: string, dangerous: boolean) => void;
  defaultModel?: string;
  defaultSkipPermissions?: boolean;
}

export default function ResumeBrowser({ open, onClose, onResume, defaultModel, defaultSkipPermissions }: Props) {
  const [sessions, setSessions] = useState<PastSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [resumeModel, setResumeModel] = useState<string>(defaultModel || 'sonnet');
  const [resumeDangerous, setResumeDangerous] = useState(defaultSkipPermissions || false);

  // Fetch sessions when opened
  useEffect(() => {
    if (open) {
      setSearch('');
      setExpandedId(null);
      setResumeModel(defaultModel || 'sonnet');
      setResumeDangerous(defaultSkipPermissions || false);
      setLoading(true);
      (window as any).claude.session.browse()
        .then((list: PastSession[]) => setSessions(list))
        .catch(() => setSessions([]))
        .finally(() => setLoading(false));
      const t = setTimeout(() => searchRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (expandedId) { setExpandedId(null); }
        else { onClose(); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose, expandedId]);

  const filtered = useMemo(() => {
    if (!search.trim()) return sessions;
    const q = search.toLowerCase();
    return sessions.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.projectPath.toLowerCase().includes(q),
    );
  }, [sessions, search]);

  // Group by project path
  const grouped = useMemo(() => {
    if (search.trim()) return null;
    const groups = new Map<string, PastSession[]>();
    for (const s of filtered) {
      const list = groups.get(s.projectPath) || [];
      list.push(s);
      groups.set(s.projectPath, list);
    }
    return groups;
  }, [filtered, search]);

  const handleSelectSession = (sessionId: string) => {
    if (expandedId === sessionId) {
      setExpandedId(null);
    } else {
      setExpandedId(sessionId);
      setResumeModel(defaultModel || 'sonnet');
      setResumeDangerous(defaultSkipPermissions || false);
    }
  };

  const handleConfirmResume = (s: PastSession) => {
    onResume(s.sessionId, s.projectSlug, s.projectPath, resumeModel, resumeDangerous);
    onClose();
  };

  if (!open) return null;

  const renderExpandedOptions = (s: PastSession) => (
    <div className="px-4 pb-2">
      <div className="rounded-lg bg-inset/50 border border-edge-dim p-3 flex flex-col gap-2">
        {/* Model selector */}
        <div>
          <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Model</label>
          <div className="flex gap-1">
            {MODELS.map((m) => (
              <button
                key={m}
                onClick={() => setResumeModel(m)}
                className={`flex-1 px-1 py-1 rounded-sm text-[10px] transition-colors ${
                  resumeModel === m
                    ? 'bg-accent text-on-accent font-medium'
                    : 'bg-inset text-fg-dim hover:bg-edge'
                }`}
              >
                {MODEL_LABELS[m] || m}
              </button>
            ))}
          </div>
        </div>

        {/* Skip Permissions */}
        <div className="flex items-center justify-between">
          <label className="text-[10px] uppercase tracking-wider text-fg-muted">Skip Permissions</label>
          <button
            onClick={() => setResumeDangerous(!resumeDangerous)}
            className={`w-8 h-4.5 rounded-full relative transition-colors ${resumeDangerous ? 'bg-[#DD4444]' : 'bg-inset'}`}
          >
            <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${resumeDangerous ? 'left-[calc(100%-16px)]' : 'left-0.5'}`} />
          </button>
        </div>
        {resumeDangerous && (
          <p className="text-[10px] text-[#DD4444]">Claude will execute tools without asking for approval.</p>
        )}

        {/* Resume button */}
        <button
          onClick={() => handleConfirmResume(s)}
          className={`w-full text-sm font-medium rounded-md py-1.5 transition-colors ${
            resumeDangerous
              ? 'bg-[#DD4444] hover:bg-[#E55555] text-white'
              : 'bg-accent hover:bg-accent text-on-accent'
          }`}
        >
          {resumeDangerous ? 'Resume (Dangerous)' : 'Resume Session'}
        </button>
      </div>
    </div>
  );

  const renderSessionRow = (s: PastSession, showPath?: boolean) => (
    <div key={s.sessionId}>
      <button
        onClick={() => handleSelectSession(s.sessionId)}
        className={`w-full text-left px-4 py-2 flex items-center gap-3 transition-colors ${
          expandedId === s.sessionId
            ? 'bg-inset text-fg'
            : 'text-fg-dim hover:bg-inset hover:text-fg'
        }`}
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate">{s.name}</div>
          <div className="text-[10px] text-fg-faint">
            {showPath
              ? s.projectPath.replace(/\\/g, '/').split('/').pop()
              : formatSize(s.size)}
          </div>
        </div>
        <span className="text-[10px] text-fg-faint shrink-0">
          {formatRelativeTime(s.lastModified)}
        </span>
      </button>
      {expandedId === s.sessionId && renderExpandedOptions(s)}
    </div>
  );

  return (
    <>
      {/* L1 drawer-style modal — theme-driven via Scrim/OverlayPanel. */}
      <Scrim layer={1} onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <OverlayPanel
          layer={1}
          className="w-full max-w-md max-h-[70vh] flex flex-col pointer-events-auto"
          style={{ position: 'relative', zIndex: 'auto' }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-4 pt-4 pb-3 border-b border-edge">
            <h2 className="text-sm font-bold text-fg mb-3">Resume Session</h2>
            <div className="flex items-center gap-2 bg-inset rounded-lg px-3 py-2 border border-edge-dim">
              <svg className="w-4 h-4 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search sessions..."
                className="flex-1 bg-transparent text-sm text-fg placeholder-fg-muted outline-none"
              />
            </div>
          </div>

          {/* Session list */}
          <div className="flex-1 overflow-y-auto py-2">
            {loading ? (
              <p className="text-sm text-fg-muted text-center py-8">Loading sessions...</p>
            ) : filtered.length === 0 ? (
              <p className="text-sm text-fg-muted text-center py-8">
                {search.trim() ? 'No matching sessions' : 'No previous sessions found'}
              </p>
            ) : grouped ? (
              // Grouped by project
              [...grouped.entries()].map(([projectPath, items]) => (
                <div key={projectPath} className="mb-2">
                  <div className="px-4 py-1">
                    <span className="text-[10px] uppercase tracking-wider text-fg-muted">
                      {projectPath.replace(/\\/g, '/').split('/').pop() || projectPath}
                    </span>
                  </div>
                  {items.map((s) => renderSessionRow(s))}
                </div>
              ))
            ) : (
              // Flat search results
              filtered.map((s) => renderSessionRow(s, true))
            )}
          </div>
        </OverlayPanel>
      </div>
    </>
  );
}
