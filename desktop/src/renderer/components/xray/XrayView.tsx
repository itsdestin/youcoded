// desktop/src/renderer/components/xray/XrayView.tsx
//
// X-ray: a developer view of one session that shows every line of its saved file
// in exact order — including what normal chat hides — each tagged with what chat
// did with it. It replaces the message list only; the message box below and the
// Stop button keep working (Destin's deck 2026-10-04, Q-xray-type).
//
// Mounted by ChatView ONLY while this session is on screen and in X-ray, so a
// hidden session pays nothing (performance.md rule 2) — there is no hidden
// X-ray to keep idle.
//
// Helpers (Q-xray-tools: he picked filter, and "trust your judgement" for the
// rest — kept to the ones that answer "why is it looping / stuck"):
//   • filter chips + search  — cut a long session to the kind of line you want
//   • repeat finder          — the same tool call made again within a few calls
//   • pauses                 — a marker where nothing was written for a minute+
//   • call ↔ result jump     — a result can land far from its call
//   • copy                   — the exact saved line, for a bug report or a fixing session
// Left out: per-line size as its own column (shown inside an opened line instead).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, FilterChip, TextInput, Tooltip } from '../ui';
import { ErrorState } from '../ui/states';
import { copyText } from '../context-menu/clipboard';
import { ScreenMark } from '../../shoot-mode';
import { setXray } from '../../state/dev-tools-store';
import type { XrayRawLine, XrayReadResult } from '../../../shared/xray-types';
import {
  classifyLine, findRepeats, formatBytes, formatGap, prettyRaw,
  GAP_MS, KIND_GROUP, KIND_LABEL, type XrayGroup, type XrayLine,
} from './xray-lines';

/** Rows drawn at once; "Show earlier" adds this many more (renderer-lists.md:
 *  a session can be thousands of lines, and nothing off screen is built). */
export const XRAY_WINDOW = 200;

const GROUPS: ReadonlyArray<{ id: XrayGroup; label: string; hint: string }> = [
  { id: 'conversation', label: 'Messages', hint: 'Your messages, the assistant’s replies and its thinking' },
  { id: 'tools', label: 'Tools', hint: 'Every tool call and what it returned' },
  { id: 'behind-scenes', label: 'Behind the scenes', hint: 'Reminders, loaded instructions, hook messages and summaries the model saw but chat hides' },
  { id: 'app', label: 'Bookkeeping', hint: 'Lines Claude Code or the app writes for itself' },
];

const FATE_TEXT = {
  shown: 'In chat',
  hidden: 'Hidden',
  trimmed: 'Trimmed',
} as const;
const FATE_HINT = {
  shown: 'Normal chat shows this line',
  hidden: 'Normal chat does not show this line',
  trimmed: 'Normal chat shows this line with part of its text removed',
} as const;

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; result: Extract<XrayReadResult, { ok: false }> | null }
  | { phase: 'ready'; file: string; total: number; raw: XrayRawLine[] };

/** Reads the session's saved file once, then appends lines as they are written. */
function useXrayLines(sessionId: string, attempt: number): LoadState {
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  useEffect(() => {
    const api = window.claude?.xray;
    if (!api) { setState({ phase: 'error', result: null }); return; }
    let cancelled = false;
    setState({ phase: 'loading' });
    // Subscribe before reading so a line written in between is not lost; the
    // n-based merge below drops anything the read already returned.
    const pending: XrayRawLine[] = [];
    let ready = false;
    const off = api.onLines(sessionId, (lines) => {
      if (cancelled) return;
      if (!ready) { pending.push(...lines); return; }
      setState((s) => (s.phase === 'ready' ? appendLines(s, lines) : s));
    });
    api.read(sessionId).then((res) => {
      if (cancelled) return;
      if (!res.ok) { setState({ phase: 'error', result: res }); return; }
      ready = true;
      setState(appendLines({ phase: 'ready', file: res.file, total: res.total, raw: res.lines }, pending));
    }).catch(() => { if (!cancelled) setState({ phase: 'error', result: null }); });
    return () => { cancelled = true; off(); };
  }, [sessionId, attempt]);
  return state;
}

function appendLines(s: Extract<LoadState, { phase: 'ready' }>, lines: XrayRawLine[]): LoadState {
  const last = s.raw.length ? s.raw[s.raw.length - 1].n : 0;
  const fresh = lines.filter((l) => l.n > last);
  if (!fresh.length) return s;
  return { ...s, raw: [...s.raw, ...fresh], total: Math.max(s.total, fresh[fresh.length - 1].n) };
}

interface Props { sessionId: string }

export function XrayView({ sessionId }: Props) {
  const [attempt, setAttempt] = useState(0);
  const load = useXrayLines(sessionId, attempt);

  if (load.phase === 'loading') {
    return <div className="flex-1 flex items-center justify-center text-sm text-fg-muted select-none">Reading the saved session…</div>;
  }
  if (load.phase === 'error') {
    // Specific when main told us why; general otherwise (error-message-standards.md).
    const noFile = load.result?.error === 'no-file';
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        {noFile ? (
          <ErrorState message="This session has no saved file yet. It appears once the first message is sent."
            onRetry={() => setAttempt((a) => a + 1)} />
        ) : (
          <ErrorState title="Couldn’t read this session’s saved file"
            explainer={load.result?.detail ?? 'Try again. If it keeps happening, switch back to normal chat — the conversation itself is unaffected.'}
            onRetry={() => setAttempt((a) => a + 1)} />
        )}
      </div>
    );
  }
  return <XrayTimeline sessionId={sessionId} file={load.file} total={load.total} raw={load.raw} />;
}

function XrayTimeline({ sessionId, file, total, raw }: { sessionId: string; file: string; total: number; raw: XrayRawLine[] }) {
  // Classify once per line. Appends re-classify only the new tail.
  const cacheRef = useRef(new Map<number, XrayLine>());
  const lines = useMemo(() => raw.map((r) => {
    let l = cacheRef.current.get(r.n);
    if (!l || l.raw !== r.raw) { l = classifyLine(r); cacheRef.current.set(r.n, l); }
    return l;
  }), [raw]);

  const repeats = useMemo(() => findRepeats(lines), [lines]);
  const gaps = useMemo(() => {
    const m = new Map<number, number>();
    let prev: number | null = null;
    for (const l of lines) {
      if (l.at != null) { if (prev != null && l.at - prev >= GAP_MS) m.set(l.n, l.at - prev); prev = l.at; }
    }
    return m;
  }, [lines]);
  const partner = useMemo(() => {
    // callId → [call line, result line], for the jump buttons.
    const calls = new Map<string, number>();
    const m = new Map<number, number>();
    for (const l of lines) {
      if (!l.callId) continue;
      if (l.kind === 'tool-call') calls.set(l.callId, l.n);
      else if (l.kind === 'tool-result') {
        const c = calls.get(l.callId);
        if (c != null) { m.set(c, l.n); m.set(l.n, c); }
      }
    }
    return m;
  }, [lines]);
  // A result carries its call's tool name, which Claude Code's result line lacks.
  const toolOf = useMemo(() => {
    const m = new Map<number, string>();
    for (const l of lines) if (l.kind === 'tool-result' && !l.tool) {
      const c = partner.get(l.n);
      const call = c != null ? lines.find((x) => x.n === c) : undefined;
      if (call) m.set(l.n, call.tool);
    }
    return m;
  }, [lines, partner]);

  const [groups, setGroups] = useState<ReadonlySet<XrayGroup>>(new Set());
  const [onlyHidden, setOnlyHidden] = useState(false);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const visible = useMemo(() => lines.filter((l) =>
    (groups.size === 0 || groups.has(KIND_GROUP[l.kind]))
    && (!onlyHidden || l.chat !== 'shown')
    && (!q || l.raw.toLowerCase().includes(q))), [lines, groups, onlyHidden, q]);

  const [shown, setShown] = useState(XRAY_WINDOW);
  const filterKey = `${[...groups].join(',')}|${onlyHidden}|${q}`;
  useEffect(() => { setShown(XRAY_WINDOW); }, [filterKey]);
  const drawn = visible.length > shown ? visible.slice(visible.length - shown) : visible;

  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [flash, setFlash] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // Stay pinned to the newest line while the reader is at the bottom, like chat.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [drawn.length, lines.length]);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  const jumpTo = useCallback((n: number) => {
    // A target hidden by the filters or outside the drawn window is brought in
    // first; the scroll happens once it is on the page.
    const inVisible = visible.findIndex((l) => l.n === n);
    if (inVisible < 0) { setGroups(new Set()); setOnlyHidden(false); setQuery(''); }
    else if (visible.length - inVisible > shown) setShown(visible.length - inVisible + 20);
    stickRef.current = false;
    setFlash(n);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      scrollRef.current?.querySelector(`[data-xray-line="${n}"]`)?.scrollIntoView({ block: 'center' });
    }));
  }, [visible, shown]);

  const repeatLines = useMemo(() => [...repeats.keys()], [repeats]);
  const nextRepeat = useCallback(() => {
    if (!repeatLines.length) return;
    const after = repeatLines.find((n) => n > (flash ?? 0)) ?? repeatLines[0];
    jumpTo(after);
  }, [repeatLines, flash, jumpTo]);

  // Handlers behind a ref so memoised rows keep stable props (renderer-lists.md).
  const handlers = useRef({ toggle: (_n: number) => {}, jump: (_n: number) => {} });
  handlers.current.toggle = (n) => setOpen((s) => { const x = new Set(s); if (x.has(n)) x.delete(n); else x.add(n); return x; });
  handlers.current.jump = jumpTo;

  const hiddenCount = useMemo(() => lines.filter((l) => l.chat !== 'shown').length, [lines]);

  return (
    <>
      <ScreenMark name="chat/xray" />
      <div className="find-row px-3 pb-2 shrink-0 select-none">
        <div className="xray-toolbar flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-panel px-3 py-2">
          <span className="text-xs font-semibold text-fg">X-ray</span>
          <span className="text-2xs text-fg-muted">
            {total.toLocaleString()} lines · {hiddenCount.toLocaleString()} hidden in chat
          </span>
          <Tooltip text="Copy the saved file’s location" placement="bottom">
            <button type="button" className="text-2xs text-fg-muted hover:text-fg truncate max-w-[22rem] font-mono" onClick={() => { void copyText(file); }}>
              {file}
            </button>
          </Tooltip>
          <span className="flex-1" />
          {repeatLines.length > 0 && (
            <Button size="sm" variant="secondary" onClick={nextRepeat}>
              {repeatLines.length} repeated {repeatLines.length === 1 ? 'call' : 'calls'} — next
            </Button>
          )}
          {/* A way out where the eye already is, besides the lit header button. */}
          <Button size="sm" variant="ghost" onClick={() => setXray(sessionId, false)}>Back to chat</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {GROUPS.map((g) => (
            <FilterChip key={g.id} active={groups.has(g.id)} title={g.hint}
              onClick={() => setGroups((s) => { const x = new Set(s); if (x.has(g.id)) x.delete(g.id); else x.add(g.id); return x; })}>
              {g.label}
            </FilterChip>
          ))}
          <FilterChip active={onlyHidden} onClick={() => setOnlyHidden((v) => !v)} title="Only lines normal chat hides or trims">
            Only hidden in chat
          </FilterChip>
          <span className="flex-1" />
          <TextInput size="sm" className="w-56" placeholder="Search saved lines" value={query}
            onChange={(e) => setQuery(e.target.value)} aria-label="Search saved lines" />
        </div>
      </div>
      <div ref={scrollRef} onScroll={onScroll}
        className="chat-scroll chat-scroll--below-find-row flex-1 min-h-0 overflow-y-auto px-3">
        {visible.length > drawn.length && (
          <div className="flex justify-center py-2 select-none">
            <Button size="sm" variant="ghost" onClick={() => setShown((s) => s + XRAY_WINDOW)}>
              Show {Math.min(XRAY_WINDOW, visible.length - drawn.length).toLocaleString()} earlier lines
            </Button>
          </div>
        )}
        {drawn.length === 0 && (
          <p className="text-sm text-fg-muted text-center py-8 select-none">No saved lines match.</p>
        )}
        {/* A solid card: rows of small text straight on a wallpaper were unreadable. */}
        <div className="font-mono text-xs rounded-lg border border-edge bg-panel py-1 mb-2" role="list" aria-label="Saved session lines">
          {drawn.map((l) => (
            <XrayRow key={l.n} line={l} open={open.has(l.n)} flash={flash === l.n}
              repeat={repeats.get(l.n) ?? 0} gapBefore={gaps.get(l.n) ?? 0}
              partner={partner.get(l.n) ?? 0} tool={l.tool || toolOf.get(l.n) || ''}
              handlers={handlers} />
          ))}
        </div>
      </div>
    </>
  );
}

interface RowProps {
  line: XrayLine;
  open: boolean;
  flash: boolean;
  repeat: number;
  gapBefore: number;
  partner: number;
  tool: string;
  handlers: React.MutableRefObject<{ toggle: (n: number) => void; jump: (n: number) => void }>;
}

// 24-hour, so the column never wraps an AM/PM onto a second line.
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

const XrayRow = React.memo(function XrayRow({ line: l, open, flash, repeat, gapBefore, partner, tool, handlers }: RowProps) {
  const [copied, setCopied] = useState(false);
  const isError = l.kind === 'tool-result' && l.summary.startsWith('Error:');
  return (
    <div role="listitem" data-xray-line={l.n}>
      {gapBefore > 0 && (
        <div className="flex items-center gap-2 py-1 text-2xs text-fg-muted select-none font-sans">
          <span className="h-px flex-1 bg-edge" />
          {formatGap(gapBefore)} with nothing written
          <span className="h-px flex-1 bg-edge" />
        </div>
      )}
      {/* Square left edge: a rounded one drew the hidden-line marker as a bracket. */}
      <div className={`border-l-2 ${l.chat === 'shown' ? 'border-transparent' : 'border-accent'} ${flash ? 'bg-inset' : ''}`}>
        <button type="button" onClick={() => handlers.current.toggle(l.n)} aria-expanded={open}
          className="w-full text-left grid grid-cols-[3rem_4.75rem_7rem_minmax(0,1fr)_auto] gap-2 items-baseline px-2 py-1 hover:bg-inset select-text">
          <span className="text-fg-faint tabular-nums text-right">{l.n}</span>
          <span className="text-fg-muted tabular-nums">{l.at != null ? timeFmt.format(l.at) : '—'}</span>
          <span><Badge>{KIND_LABEL[l.kind]}</Badge></span>
          <span className={`truncate ${l.kind === 'you' || l.kind === 'assistant' ? 'text-fg' : 'text-fg-2'}`}>
            {tool && <span className="font-semibold text-fg mr-2">{tool}</span>}
            {repeat > 1 && <span className="font-sans font-semibold text-fg mr-2">Repeat ×{repeat}</span>}
            {isError && <span className="font-sans font-semibold text-fg mr-2">Failed</span>}
            {l.summary || <span className="text-fg-muted">(empty)</span>}
          </span>
          <Tooltip text={FATE_HINT[l.chat]} placement="top">
            <span className={`font-sans text-2xs ${l.chat === 'shown' ? 'text-fg-muted' : 'text-fg font-medium'}`}>{FATE_TEXT[l.chat]}</span>
          </Tooltip>
        </button>
        {open && (
          <div className="pl-[3.5rem] pr-2 pb-2">
            <div className="flex items-center gap-2 mb-1 font-sans select-none">
              <span className="text-2xs text-fg-muted">Line {l.n} · {formatBytes(l.bytes)}</span>
              <span className="flex-1" />
              {partner > 0 && (
                <Button size="sm" variant="ghost" onClick={() => handlers.current.jump(partner)}>
                  {l.kind === 'tool-call' ? `Go to result (line ${partner})` : `Go to call (line ${partner})`}
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => {
                void copyText(l.raw).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } });
              }}>
                {copied ? 'Copied' : 'Copy line'}
              </Button>
            </div>
            <pre className="yc-code-block bg-well text-fg-2 rounded-md p-3 max-h-96 overflow-auto whitespace-pre-wrap break-all select-text">{prettyRaw(l.raw)}</pre>
          </div>
        )}
      </div>
    </div>
  );
});
