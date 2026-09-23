// src/renderer/dev/workbench/LiveCandidate.tsx
//
// ONE candidate from the compare registry, alone on the page, with no chrome —
// the thing a review deck embeds as a live pane so Destin can hover, click and
// drag a design instead of watching a recording of it.
//
//   ?mode=workbench&child=1&view=live&surface=<id>&round=<n>&candidate=<id>&theme=<slug>
//
// WHY it exists at all: a 200 ms animation on a small pill is judged by doing it.
// The 2026-08-31 session-strip review was four before/after recordings and
// Destin's verdict was "the videos are just rough to compare." CompareView
// already renders these candidates live; what it has no idea about is the review
// vocabulary (headline, What changed / You'll notice / Risk, Submit). The deck
// has all of that and no way to show anything live. This route is the join.
// Spec: youcoded-dev docs/active/specs/2026-08-31-live-review-panes-design.md.
//
// Dev-only, like the rest of dev/. `child=1` is not optional — without it the
// workbench renders its toolbar frame instead of this page.
import React from 'react';
import { COMPARE_SURFACES } from './compare/registry';
import { CandidateBoundary } from './compare/CandidateBoundary';
import { Frame, paneWidthRange } from './compare/Frame';
import { findCandidate } from './compare/lookup';
import { useTheme } from '../../state/theme-context';

/** Origins allowed to drive this pane. The deck is served on a loopback port
 *  that is not knowable when this code is built, so the check is on the shape of
 *  the origin rather than an exact address. */
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

function Problem({ what, asked, available }: { what: string; asked: string; available: string[] }) {
  // The deck CANNOT check this: the name it asked for is in a JSON file in
  // another repository, and the thing being named is TypeScript in this one. So
  // the route is the only place that can say what went wrong, and it says it
  // with the list of names that would have worked.
  return (
    <div className="h-screen w-screen bg-canvas text-fg flex items-center justify-center p-8">
      <div className="max-w-lg text-sm">
        <p className="font-medium mb-2">No {what} called “{asked || '(none given)'}”.</p>
        <p className="text-fg-2 mb-3">The review deck names candidates by hand; this one does not exist in the registry on this branch.</p>
        <p className="text-2xs uppercase tracking-wider text-fg-muted mb-1">{available.length === 1 ? 'The one that exists' : 'The ones that exist'}</p>
        <ul className="text-2xs text-fg-2 leading-relaxed">
          {available.map((a) => <li key={a}><code>{a}</code></li>)}
        </ul>
      </div>
    </div>
  );
}

function Index() {
  // No ?surface → browse. This is also the boot-check's route, deliberately:
  // pointing the guard at a named candidate would make it rot the day that
  // candidate is renamed, which is exactly the kind of failure it exists to catch.
  const base = '?mode=workbench&child=1&view=live';
  return (
    <div className="h-screen w-screen bg-canvas text-fg overflow-auto p-8">
      <h1 className="text-sm font-medium mb-1">Live candidates</h1>
      <p className="text-2xs text-fg-muted mb-6">
        One authored candidate per page, no chrome — what a review deck embeds as a live pane.
      </p>
      {COMPARE_SURFACES.map((s) => (
        <section key={s.id} className="mb-6">
          <h2 className="text-xs text-fg mb-0.5"><code>{s.id}</code> <span className="text-fg-muted">· {s.label}</span></h2>
          <p className="text-3xs text-fg-muted mb-2">{s.question}</p>
          {s.rounds.map((r) => (
            <p key={r.n} className="text-2xs text-fg-2 mb-1">
              <span className="text-fg-muted">R{r.n}</span>{' '}
              {r.candidates.map((c, i) => (
                <React.Fragment key={c.id}>
                  {i > 0 && <span className="text-fg-faint"> · </span>}
                  <a className="text-link hover:underline" href={`${base}&surface=${encodeURIComponent(s.id)}&round=${r.n}&candidate=${encodeURIComponent(c.id)}`}>
                    {c.id}
                  </a>
                </React.Fragment>
              ))}
            </p>
          ))}
        </section>
      ))}
    </div>
  );
}

export function LiveCandidate() {
  const q = new URLSearchParams(location.search);
  const surfaceId = q.get('surface');
  const found = React.useMemo(
    () => findCandidate(surfaceId, q.get('round'), q.get('candidate')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [surfaceId, q.get('round'), q.get('candidate')],
  );
  const wrap = React.useRef<HTMLDivElement>(null);
  const { theme: activeTheme, themeApplied } = useTheme();
  React.useEffect(() => {
    // WHY: the deck cannot certify a themed preview from the mount/size report:
    // its first render may still wear the theme baked into the pane URL. This
    // counter advances AFTER ThemeProvider writes the new theme to the DOM.
    if (!found.ok || themeApplied === 0 || window.parent === window
        || document.documentElement.getAttribute('data-theme') !== activeTheme) return;
    window.parent.postMessage({ type: 'youcoded:pane-theme', theme: activeTheme, candidate: found.candidate.id }, '*');
  }, [found, activeTheme, themeApplied]);

  // ── how wide the design is drawn ───────────────────────────────────────────
  // A fixed surface is its number. A FLUID surface starts at its `min` and is
  // then told its width by the deck (`youcoded:pane-width`), which knows the
  // page: it gives each pane the widest width its row allows inside [min, max]
  // and stacks panes rather than shrinking them. The pane never decides this
  // itself — it cannot see the page it sits in.
  const range = React.useMemo(
    () => paneWidthRange(found.ok ? found.surface.paneWidth : undefined),
    [found],
  );
  const [askedWidth, setAskedWidth] = React.useState<number | null>(null);
  // The deck sizes the WHOLE pane — the wrapper below, padding included — and
  // reports/asks in those terms. The design inside is that minus the padding.
  // (The first cut applied the asked width to the design itself, so the pane
  // overflowed its frame by the padding and the right edge was cut off.)
  const PANE_PAD = 2 * 12;   // p-3, both sides
  const width = askedWidth === null
    ? range.min
    : Math.max(range.min, Math.min(range.max, askedWidth - PANE_PAD));

  // ── the pane reports its own SIZE ──────────────────────────────────────────
  // WHY measured rather than declared: both numbers live in the registry, in the
  // OTHER repository, so a deck spec naming them is guessing — and a guess that is
  // too small clips the design silently. (Measured 2026-08-31: close-prompt-body
  // is 380 and permissions-mode-control is 420, so a single deck-level width
  // cannot be right for a review that shows both.) The pane knows exactly, so it
  // says. `candidate` rides along so a deck showing four panes can tell them apart.
  React.useEffect(() => {
    const el = wrap.current;
    if (!el || window.parent === window) return;
    const report = () => window.parent.postMessage(
      { type: 'youcoded:pane-height',
        height: Math.ceil(el.getBoundingClientRect().height),
        width: Math.ceil(el.getBoundingClientRect().width),
        // The range, so the deck can fit a fluid pane to its row. Equal for a
        // fixed surface — the deck then has nothing to decide.
        minWidth: range.min + PANE_PAD,
        maxWidth: range.max + PANE_PAD,
        candidate: q.get('candidate') },
      // '*' is correct here and carries no secret: the height of a design mock-up
      // is not information, and the deck's port is not knowable at build time.
      '*',
    );
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [found, range]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ── the deck sets a fluid pane's width by message ──────────────────────────
  React.useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!LOOPBACK.test(e.origin)) return;
      const d = e.data as { type?: string; width?: number } | null;
      if (!d || d.type !== 'youcoded:pane-width' || typeof d.width !== 'number' || !(d.width > 0)) return;
      setAskedWidth(d.width);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // ── the deck changes theme by message, never by reloading us ───────────────
  React.useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!LOOPBACK.test(e.origin)) return;
      const d = e.data as { type?: string; theme?: string } | null;
      if (!d || d.type !== 'youcoded:theme' || typeof d.theme !== 'string') return;
      // WHY not re-point our address: a reload restarts the animation and throws
      // away whatever the reviewer had set up mid-drag. __workbenchAppearanceSync
      // is the app's own cross-window theme sync — the same live-swap path the
      // landing page's embed uses (mock-shim.ts).
      (window as any).__workbenchAppearanceSync?.({ theme: d.theme });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Paint the page itself, not just the wrapper. The wrapper has to HUG its content — its
  // height is what gets reported — so it cannot also cover the viewport, which leaves the
  // body transparent. Inside a deck that is invisible (the deck paints the iframe in the same
  // theme), but "open on its own" is a bare tab: a dark candidate would sit on browser-default
  // white. Set on <html> so it covers the whole page in both places.
  React.useEffect(() => {
    const el = document.documentElement;
    const before = el.style.background;
    el.style.background = 'var(--canvas)';
    return () => { el.style.background = before; };
  }, []);

  if (!surfaceId) return <Index />;
  if (!found.ok) return <Problem what={found.level} asked={found.asked} available={found.available} />;

  const { surface, candidate } = found;
  // Nothing else on the page: no header, no label, no border. The deck draws the
  // caption beside the pane; the pane is only the thing being judged.
  //
  // p-3: the design sits on a field of canvas rather than flush against the pane's edge.
  // Flush, a rounded panel's corners are sliced by the pane's square boundary and every
  // corner shows a notch (Destin, 2026-09-01) — and its own border doubles up with the
  // pane's. CompareView has always padded for the same reason. The padding is inside the
  // measured wrapper, so the pane sizes itself to include it.
  const pane = (
    <div ref={wrap} className="inline-block bg-canvas text-fg p-3">
      <CandidateBoundary label={`${surface.id} · ${candidate.id}`}>
        <Frame frame={surface.frame} width={width}>{candidate.render()}</Frame>
      </CandidateBoundary>
    </div>
  );
  // Embedded, the wrapper must shrink-wrap its content — its size IS what the deck sizes the
  // pane to. Opened on its own it is a whole browser window, and a 380px design pinned to the
  // top-left corner of a 2560px tab looks abandoned rather than presented (Destin, 2026-09-01),
  // so centre it there. Centring only when NOT embedded keeps the measurement honest.
  if (window.parent !== window) return pane;
  return <div className="min-h-screen w-full bg-canvas flex items-center justify-center p-6">{pane}</div>;
}
