// desktop/src/renderer/components/xray/XrayView.tsx
//
// X-ray: a developer view of one session that shows everything in its saved file,
// in exact order — including what normal chat hides — grouped into turns, each
// step saying in plain words which way it went (to the model, from the model, or
// kept by the app) and whether chat shows it. It replaces the message list only;
// the message box and Stop button keep working (deck 2026-10-04, Q-xray-type).
//
// Round 2 (review 1, 2026-10-04): the first version was a flat table of raw rows —
// "too bare … doesn't feel app-native … should still be pretty and easily
// glanceable". So: a summary strip you can read at a glance, turns as cards, a
// tool call and its result as ONE step, readable fields first and the exact saved
// text one click further, and plain words instead of "bookkeeping".
//
// Mounted by ChatView ONLY while this session is on screen and in X-ray, so a
// hidden session pays nothing (performance.md rule 2).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, SegmentedTabs, TextInput, Tooltip } from '../ui';
import { ErrorState } from '../ui/states';
import { CheckIcon, ChevronIcon, EyeOffIcon, FailIcon } from '../Icons';
import { copyText } from '../context-menu/clipboard';
import { ScreenMark } from '../../shoot-mode';
import { setXray } from '../../state/dev-tools-store';
import type { XrayRawLine, XrayReadResult } from '../../../shared/xray-types';
import { classifyLine, formatBytes, formatGap, prettyRaw, type XrayLine } from './xray-lines';
import { buildTurns, fullText, inputFields, isProblem, type XrayStep, type XrayTurn } from './xray-model';

/** Steps drawn at once; "Show earlier" adds this many more (renderer-lists.md:
 *  a looping session can be thousands of steps, and nothing off screen is built). */
export const XRAY_WINDOW = 200;

type View = 'all' | 'hidden' | 'problems';
const VIEWS = [
  { id: 'all', label: 'Everything' },
  { id: 'hidden', label: 'Hidden from chat' },
  { id: 'problems', label: 'Problems' },
] as const;

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
    // n-based merge drops anything the read already returned.
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

export function XrayView({ sessionId }: { sessionId: string }) {
  const [attempt, setAttempt] = useState(0);
  const load = useXrayLines(sessionId, attempt);

  if (load.phase === 'loading') {
    return <div className="flex-1 flex items-center justify-center text-sm text-fg-muted select-none">Reading the saved session…</div>;
  }
  if (load.phase === 'error') {
    // Specific when main told us why; general otherwise (error-message-standards.md).
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        {load.result?.error === 'no-file' ? (
          <ErrorState message="This session has no saved file yet. It appears once the first message is sent."
            onRetry={() => setAttempt((a) => a + 1)} />
        ) : (
          <ErrorState title="Couldn’t read this session’s saved file"
            explainer={load.result?.detail ?? 'The conversation itself is unaffected — switch back to chat to keep working.'}
            onRetry={() => setAttempt((a) => a + 1)} />
        )}
      </div>
    );
  }
  return <XrayTimeline sessionId={sessionId} file={load.file} raw={load.raw} />;
}

function XrayTimeline({ sessionId, file, raw }: { sessionId: string; file: string; raw: XrayRawLine[] }) {
  // Classify once per line; an append re-classifies only the new tail.
  const cacheRef = useRef(new Map<number, XrayLine>());
  const lines = useMemo(() => raw.map((r) => {
    let l = cacheRef.current.get(r.n);
    if (!l || l.raw !== r.raw) { l = classifyLine(r); cacheRef.current.set(r.n, l); }
    return l;
  }), [raw]);
  const turns = useMemo(() => buildTurns(lines), [lines]);

  const totals = useMemo(() => {
    let tools = 0, failed = 0, repeats = 0, pauses = 0, hidden = 0, waiting = 0;
    for (const t of turns) for (const s of t.steps) {
      if (s.kind === 'tool') { tools += 1; if (s.outcome === 'failed') failed += 1; if ((s.repeat ?? 0) > 1) repeats += 1; if (!s.outcome) waiting += 1; }
      if (s.pauseBefore) pauses += 1;
      if (s.chat !== 'shown') hidden += 1;
    }
    return { tools, failed, repeats, pauses, hidden, waiting, turns: turns.filter((t) => t.id !== 0).length };
  }, [turns]);

  const [view, setView] = useState<View>('all');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const keep = useCallback((s: XrayStep) =>
    (view === 'all' || (view === 'hidden' ? s.chat !== 'shown' : isProblem(s)))
    && (!q || s.lines.some((l) => l.raw.toLowerCase().includes(q))), [view, q]);

  // Window over STEPS (newest kept), then regroup into turns for drawing.
  const [shown, setShown] = useState(XRAY_WINDOW);
  useEffect(() => { setShown(XRAY_WINDOW); }, [view, q]);
  const { drawnTurns, hiddenEarlier, matchCount } = useMemo(() => {
    const kept = turns.map((t) => ({ t, steps: t.steps.filter(keep) }));
    const count = kept.reduce((n, k) => n + k.steps.length, 0);
    let budget = shown;
    const out: Array<{ turn: XrayTurn; steps: XrayStep[] }> = [];
    for (let i = kept.length - 1; i >= 0 && budget > 0; i--) {
      const { t, steps } = kept[i];
      if (!steps.length) continue;
      const take = steps.slice(Math.max(0, steps.length - budget));
      budget -= take.length;
      out.unshift({ turn: t, steps: take });
    }
    return { drawnTurns: out, hiddenEarlier: count - (shown - budget), matchCount: count };
  }, [turns, keep, shown]);

  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [flash, setFlash] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [drawnTurns, lines.length]);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  // "Next" for each problem in the summary strip: jump to the next step of that
  // kind after the one last jumped to, wrapping round.
  const allSteps = useMemo(() => turns.flatMap((t) => t.steps), [turns]);
  const jumpNext = useCallback((match: (s: XrayStep) => boolean) => {
    const hits = allSteps.filter(match);
    if (!hits.length) return;
    const target = hits.find((s) => s.id > (flash ?? 0)) ?? hits[0];
    setView('all'); setQuery('');
    const fromEnd = allSteps.length - allSteps.indexOf(target);
    if (fromEnd > shown) setShown(fromEnd + 20);
    stickRef.current = false;
    setFlash(target.id);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      scrollRef.current?.querySelector(`[data-xray-step="${target.id}"]`)?.scrollIntoView({ block: 'center' });
    }));
  }, [allSteps, flash, shown]);

  // Handler behind a ref so memoised steps keep stable props (renderer-lists.md).
  const toggleRef = useRef((_id: number) => {});
  toggleRef.current = (id) => setOpen((s) => { const x = new Set(s); if (x.has(id)) x.delete(id); else x.add(id); return x; });

  return (
    <>
      <ScreenMark name="chat/xray" />
      <div className="find-row px-4 pb-2 shrink-0 select-none">
        <div className="rounded-xl border border-edge bg-panel px-4 py-3 space-y-3">
          <div className="flex items-center gap-3">
            <XrayGlyph className="w-4 h-4 text-fg-2 shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-fg">X-ray</div>
              <div className="text-2xs text-fg-muted">Everything saved for this session, in order — including what chat leaves out</div>
            </div>
            <span className="flex-1" />
            <Tooltip text={`Copy where this is saved: ${file}`} placement="bottom">
              <Button size="sm" variant="ghost" onClick={() => { void copyText(file); }}>Copy file location</Button>
            </Tooltip>
            <Button size="sm" variant="secondary" onClick={() => setXray(sessionId, false)}>Back to chat</Button>
          </div>
          {/* The glance: one number per question you'd ask of a misbehaving
              session. The problem ones jump to the next occurrence. */}
          <div className="flex flex-wrap gap-2">
            <Stat value={totals.turns} label={totals.turns === 1 ? 'turn' : 'turns'} />
            <Stat value={totals.tools} label={totals.tools === 1 ? 'tool use' : 'tool uses'} />
            <Stat value={totals.hidden} label="not in chat" onClick={() => setView(view === 'hidden' ? 'all' : 'hidden')} active={view === 'hidden'} />
            <Stat value={totals.failed} label="failed" tone="problem" onClick={() => jumpNext((s) => s.outcome === 'failed')} />
            <Stat value={totals.repeats} label={totals.repeats === 1 ? 'repeated request' : 'repeated requests'} tone="problem" onClick={() => jumpNext((s) => (s.repeat ?? 0) > 1)} />
            <Stat value={totals.pauses} label={totals.pauses === 1 ? 'long pause' : 'long pauses'} tone="problem" onClick={() => jumpNext((s) => !!s.pauseBefore)} />
            {totals.waiting > 0 && <Stat value={totals.waiting} label="still waiting" tone="problem" onClick={() => jumpNext((s) => s.kind === 'tool' && !s.outcome)} />}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <SegmentedTabs variant="pill" tabs={VIEWS} value={view} onChange={(id) => setView(id as View)} aria-label="What to show" />
            <Legend />
            <span className="flex-1" />
            <TextInput size="sm" className="w-56" placeholder="Search everything saved" value={query}
              onChange={(e) => setQuery(e.target.value)} aria-label="Search everything saved" />
          </div>
        </div>
      </div>
      <div ref={scrollRef} onScroll={onScroll}
        className="chat-scroll chat-scroll--below-find-row flex-1 min-h-0 overflow-y-auto px-4">
        {hiddenEarlier > 0 && (
          <div className="flex justify-center py-2 select-none">
            <Button size="sm" variant="ghost" onClick={() => setShown((s) => s + XRAY_WINDOW)}>
              Show {Math.min(XRAY_WINDOW, hiddenEarlier).toLocaleString()} earlier steps
            </Button>
          </div>
        )}
        {matchCount === 0 && (
          <p className="text-sm text-fg-muted text-center py-8 select-none">
            {view === 'problems' && !q ? 'No failures, repeats or long pauses in this session.' : 'Nothing saved matches.'}
          </p>
        )}
        <div className="space-y-3 pb-3">
          {drawnTurns.map(({ turn, steps }) => (
            <TurnCard key={turn.id} turn={turn} steps={steps} open={open} flash={flash} toggleRef={toggleRef} />
          ))}
        </div>
      </div>
    </>
  );
}

function Stat({ value, label, tone, onClick, active }: { value: number; label: string; tone?: 'problem'; onClick?: () => void; active?: boolean }) {
  // A problem stat at zero reads as good news, so it is quiet; above zero it is
  // the thing to look at, so it is the strongest text in the strip.
  const loud = tone === 'problem' && value > 0;
  const body = (
    <>
      {loud && <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-destructive self-center" />}
      <span className={`text-sm tabular-nums ${loud ? 'font-semibold text-fg' : 'text-fg-2'}`}>{value.toLocaleString()}</span>
      <span className={`text-xs ${loud ? 'text-fg' : 'text-fg-muted'}`}>{label}</span>
      {loud && onClick && <span className="text-2xs text-fg-muted">· next</span>}
    </>
  );
  const cls = `inline-flex items-baseline gap-1.5 rounded-md px-2.5 py-1 border ${active ? 'border-accent bg-inset' : loud ? 'border-edge bg-inset' : 'border-edge-dim'}`;
  if (!onClick || (tone === 'problem' && value === 0)) return <span className={cls}>{body}</span>;
  return <button type="button" className={`${cls} hover:bg-inset transition-colors`} onClick={onClick}>{body}</button>;
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-fg-muted">
      <span className="inline-flex items-center gap-1"><DirectionMark direction="to-model" /> sent to the model</span>
      <span className="inline-flex items-center gap-1"><DirectionMark direction="from-model" /> written by the model</span>
      <span className="inline-flex items-center gap-1"><DirectionMark direction="app-only" /> kept by the app, never sent</span>
      <span className="inline-flex items-center gap-1"><EyeOffIcon className="w-3 h-3" /> not shown in normal chat</span>
    </div>
  );
}

function DirectionMark({ direction }: { direction: XrayStep['direction'] }) {
  if (direction === 'app-only') return <span aria-hidden="true" className="inline-block w-3 text-center leading-none">·</span>;
  return (
    <svg aria-hidden="true" className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      {direction === 'to-model' ? <path d="M2 6h7M6.5 3.5 9 6 6.5 8.5" /> : <path d="M10 6H3M5.5 3.5 3 6l2.5 2.5" />}
    </svg>
  );
}

const DIRECTION_TEXT = { 'to-model': 'Sent to the model', 'from-model': 'Written by the model', 'app-only': 'Kept by the app, never sent to the model' } as const;

// 24-hour, so a time never wraps an AM/PM onto a second line.
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function TurnCard({ turn, steps, open, flash, toggleRef }: {
  turn: XrayTurn; steps: XrayStep[]; open: ReadonlySet<number>; flash: number | null;
  toggleRef: React.MutableRefObject<(id: number) => void>;
}) {
  const meta = [
    turn.at != null ? timeFmt.format(turn.at) : null,
    turn.durationMs ? formatGap(turn.durationMs) : null,
    `${turn.steps.length} ${turn.steps.length === 1 ? 'step' : 'steps'}`,
    turn.toolCount ? `${turn.toolCount} ${turn.toolCount === 1 ? 'tool use' : 'tool uses'}` : null,
  ].filter(Boolean).join(' · ');
  const problems = [
    turn.failed ? `${turn.failed} failed` : null,
    turn.repeats ? `${turn.repeats} repeated` : null,
    turn.pauses ? `${turn.pauses} long ${turn.pauses === 1 ? 'pause' : 'pauses'}` : null,
  ].filter(Boolean);
  return (
    <section className="rounded-xl border border-edge bg-panel overflow-hidden" aria-label={turn.id ? `Turn: ${turn.ask}` : 'Before your first message'}>
      <header className="px-4 py-3 border-b border-edge-dim select-none">
        <div className="text-sm text-fg truncate">{turn.id ? <>“{turn.ask}”</> : 'Before your first message'}</div>
        <div className="flex flex-wrap items-center gap-2 mt-0.5">
          <span className="text-2xs text-fg-muted">{meta}</span>
          {problems.map((p) => (
            <span key={p} className="inline-flex items-center gap-1 text-2xs font-medium text-fg">
              <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-destructive" />{p}
            </span>
          ))}
        </div>
      </header>
      <ol className="px-2 py-2">
        {steps.map((s) => (
          <StepRow key={s.id} step={s} open={open.has(s.id)} flash={flash === s.id} toggleRef={toggleRef} />
        ))}
      </ol>
    </section>
  );
}

const StepRow = React.memo(function StepRow({ step: s, open, flash, toggleRef }: {
  step: XrayStep; open: boolean; flash: boolean; toggleRef: React.MutableRefObject<(id: number) => void>;
}) {
  const tool = s.kind === 'tool';
  const quiet = s.direction === 'app-only' || s.kind === 'reminder' || s.kind === 'instructions' || s.kind === 'hook';
  return (
    <li data-xray-step={s.id}>
      {s.pauseBefore && (
        <div className="flex items-center gap-2 px-2 py-1.5 text-2xs text-fg-muted select-none">
          <span className="h-px flex-1 bg-edge-dim" />
          Nothing happened for {formatGap(s.pauseBefore)}
          <span className="h-px flex-1 bg-edge-dim" />
        </div>
      )}
      <div className={`rounded-lg ${flash ? 'bg-inset ring-1 ring-accent' : ''}`}>
        <button type="button" onClick={() => toggleRef.current(s.id)} aria-expanded={open}
          className="w-full text-left flex items-start gap-3 px-2 py-2 rounded-lg hover:bg-inset transition-colors">
          <StepIcon step={s} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className={`text-sm ${quiet ? 'text-fg-2' : 'text-fg font-medium'}`}>{s.title}</span>
              {tool && s.outcome === 'failed' && <span className="text-2xs font-medium text-fg">Failed</span>}
              {tool && s.outcome === 'worked' && <span className="text-2xs text-fg-muted">Worked</span>}
              {tool && !s.outcome && <span className="text-2xs font-medium text-fg">No result yet</span>}
              {(s.repeat ?? 0) > 1 && (
                <span className="inline-flex items-center gap-1 text-2xs font-medium text-fg">
                  <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-destructive" />
                  Same request again (×{s.repeat})
                </span>
              )}
            </span>
            <span className={`block text-xs truncate ${tool ? 'font-mono text-fg-2' : 'text-fg-muted'}`}>{s.gist || '(empty)'}</span>
          </span>
          <span className="shrink-0 flex items-center gap-2 text-2xs text-fg-muted pt-0.5 select-none">
            {s.chat !== 'shown' && (
              <Tooltip text={s.chat === 'hidden' ? 'Normal chat doesn’t show this' : 'Normal chat shows this with part of it removed'} placement="top">
                <span className="inline-flex items-center gap-1"><EyeOffIcon className="w-3 h-3" />{s.chat === 'hidden' ? 'Not in chat' : 'Shortened in chat'}</span>
              </Tooltip>
            )}
            <Tooltip text={DIRECTION_TEXT[s.direction]} placement="top">
              <span className="inline-flex"><DirectionMark direction={s.direction} /></span>
            </Tooltip>
            <span className="tabular-nums w-14 text-right">{s.at != null ? timeFmt.format(s.at) : ''}</span>
            <ChevronIcon expanded={open} />
          </span>
        </button>
        {open && <StepDetail step={s} />}
      </div>
    </li>
  );
});

function StepIcon({ step: s }: { step: XrayStep }) {
  const box = 'mt-0.5 w-6 h-6 rounded-md flex items-center justify-center shrink-0';
  if (s.kind === 'tool') {
    if (s.outcome === 'failed') return <span className={`${box} bg-inset text-fg`}><FailIcon className="w-3.5 h-3.5" /></span>;
    if (s.outcome === 'worked') return <span className={`${box} bg-inset text-fg-2`}><CheckIcon className="w-3.5 h-3.5" /></span>;
    return <span className={`${box} bg-inset text-fg-muted`}><Glyph d="M8 4v4l2.5 1.5" circle /></span>;
  }
  const glyph: Record<Exclude<XrayStep['kind'], 'tool'>, React.ReactNode> = {
    you: <Glyph d="M8 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3.5 13a4.5 4.5 0 0 1 9 0" />,
    reply: <Glyph d="M3 4.5h10v6H7l-3 2.5v-2.5H3z" />,
    thinking: <Glyph d="M5 12.5h6M6 10.5c-1.5-.8-2.5-2.2-2.5-3.8a4.5 4.5 0 0 1 9 0c0 1.6-1 3-2.5 3.8z" />,
    reminder: <Glyph d="M8 2.5v1M4.5 11V7.5a3.5 3.5 0 0 1 7 0V11l1 1.5h-9zM6.8 13.5a1.4 1.4 0 0 0 2.4 0" />,
    instructions: <Glyph d="M4.5 2.5h5l2 2v9h-7zM6.5 7h3M6.5 9.5h3" />,
    hook: <Glyph d="M6 3v4.5a2.5 2.5 0 0 0 5 0V6M11 6 9.5 7.5M11 6l1.5 1.5" />,
    summary: <Glyph d="M3.5 4.5h9M3.5 8h9M3.5 11.5h5" />,
    interrupt: <Glyph d="M5 5h6v6H5z" />,
    note: <Glyph d="M8 7.5v3.5M8 5v.01" circle />,
  };
  const tint = s.direction === 'from-model' ? 'bg-accent text-on-accent' : s.kind === 'you' ? 'bg-fg-2 text-canvas' : 'bg-inset text-fg-muted';
  return <span className={`${box} ${tint}`}>{glyph[s.kind as Exclude<XrayStep['kind'], 'tool'>]}</span>;
}

function Glyph({ d, circle }: { d: string; circle?: boolean }) {
  return (
    <svg aria-hidden="true" className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      {circle && <circle cx="8" cy="8" r="5.5" />}
      <path d={d} />
    </svg>
  );
}

function XrayGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round">
      <path d="M4 6h16M4 10h10M4 14h16M4 18h7" /><circle cx="18" cy="17" r="2.5" />
    </svg>
  );
}

const PREVIEW_LINES = 15;

function StepDetail({ step: s }: { step: XrayStep }) {
  const [exact, setExact] = useState(false);
  const call = s.kind === 'tool' && s.direction === 'from-model' ? s.lines[0] : null;
  const result = s.kind === 'tool' ? s.lines.find((l) => l.kind === 'tool-result') : null;
  const fields = call ? inputFields(call) : [];
  return (
    <div className="ml-11 mr-2 mb-2 space-y-3">
      <p className="text-2xs text-fg-muted select-none">{DIRECTION_TEXT[s.direction]}.{s.chat === 'hidden' ? ' Normal chat doesn’t show it.' : s.chat === 'trimmed' ? ' Normal chat shows it with part removed.' : ''}</p>
      {call && fields.length > 0 && (
        <Block title={`What the model asked ${s.tool || 'the tool'} to do`}>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
            {fields.map((f) => (
              <React.Fragment key={f.label}>
                <dt className="text-fg-muted capitalize">{f.label}</dt>
                <dd className="font-mono text-fg-2 whitespace-pre-wrap break-words select-text">{f.value}</dd>
              </React.Fragment>
            ))}
          </dl>
        </Block>
      )}
      {s.kind === 'tool' ? (
        result ? (
          <Block title={s.outcome === 'failed' ? 'What came back — it failed' : 'What came back'}>
            <LongText text={fullText(result).replace(/^Error:\s*/, '')} mono />
          </Block>
        ) : (
          <Block title="What came back">
            <p className="text-xs text-fg-2">Nothing yet. The model is waiting on this tool — if it stays like this, the tool is stuck.</p>
          </Block>
        )
      ) : (
        <Block title={s.kind === 'you' ? 'What you sent' : s.direction === 'from-model' ? 'What the model wrote' : 'The full text'}>
          <LongText text={fullText(s.lines[0])} mono={s.direction === 'app-only'} />
        </Block>
      )}
      <div>
        <button type="button" onClick={() => setExact((v) => !v)} aria-expanded={exact}
          className="inline-flex items-center gap-1 text-2xs text-fg-muted hover:text-fg select-none">
          <ChevronIcon expanded={exact} className="w-3 h-3" />
          Exact saved text ({s.lines.length} {s.lines.length === 1 ? 'line' : 'lines'} of the file)
        </button>
        {exact && (
          <div className="mt-2 space-y-2">
            {s.lines.map((l) => <ExactLine key={l.n} line={l} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-inset px-3 py-2">
      <div className="text-2xs font-medium text-fg-muted mb-1 select-none">{title}</div>
      {children}
    </div>
  );
}

function LongText({ text, mono }: { text: string; mono?: boolean }) {
  const [all, setAll] = useState(false);
  const rows = text.split('\n');
  const long = rows.length > PREVIEW_LINES;
  const body = !long || all ? text : rows.slice(0, PREVIEW_LINES).join('\n');
  return (
    <>
      <div className={`text-xs text-fg-2 whitespace-pre-wrap break-words select-text ${mono ? 'font-mono' : ''}`}>{body || '(empty)'}</div>
      {long && (
        <button type="button" className="mt-1 text-2xs text-fg-muted hover:text-fg select-none" onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : `Show all ${rows.length.toLocaleString()} lines`}
        </button>
      )}
    </>
  );
}

function ExactLine({ line: l }: { line: XrayLine }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="flex items-center gap-2 mb-1 select-none">
        <span className="text-2xs text-fg-muted">Line {l.n} · {formatBytes(l.bytes)}</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => {
          void copyText(l.raw).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } });
        }}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      <pre className="yc-code-block bg-well text-fg-2 text-xs rounded-md p-3 max-h-80 overflow-auto whitespace-pre-wrap break-all select-text">{prettyRaw(l.raw)}</pre>
    </div>
  );
}
