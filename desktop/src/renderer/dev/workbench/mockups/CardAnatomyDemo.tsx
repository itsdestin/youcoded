import React from 'react';
import { ThemeBg } from '../../../components/ThemeBg';

/** WHY (design-guide review, 2026-09-24): ~16 card families show "a name, who
 *  made it, and some numbers", and no two agree on the order. These candidates
 *  put three different kinds of thing — a Marketplace plugin, a Library skill
 *  and a Page — through ONE card anatomy each, on the decided raised card
 *  (panel, thin edge-dim border, medium shadow, theme radius, 12px gap), with
 *  the decided tinted status pill and no capitals. Tokens only; dev-only. */

export type CardAnatomy = 'today' | 'quiet-footer' | 'meta-under-title' | 'chips';
export type ConvAnatomy = 'date-top' | 'date-end' | 'icons-bottom' | 'icons-hover' | 'icons-top-date-end';

const CARD = 'rounded-xl bg-panel border border-edge-dim p-3 flex flex-col gap-2';
const SHADOW = { boxShadow: '0 4px 20px rgb(0 0 0 / .16), 0 1px 3px rgb(0 0 0 / .08)' };

type Item = { title: string; kind: string; by: string; desc: string; status?: string; stats: string; star?: boolean };
const ITEMS: Item[] = [
  { title: 'Civic Report', kind: 'Plugin', by: '@destin', desc: 'Know your federal reps, tailored to what you care about.', status: 'Installed', stats: '93% liked · 412 installs', star: true },
  { title: 'Encyclopedia', kind: 'Skill', by: '@destin', desc: 'Your life, written down and searchable.', status: 'Installed', stats: '5 skills · updated 3 days ago' },
  { title: 'Week planner', kind: 'Page', by: 'You', desc: 'Your week in seven columns: events by kind, done or still to do.', stats: '1 connection · updated 11 days ago' },
];

function Pill({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 rounded-full border border-green-500/30 bg-green-500/15 px-2 text-2xs text-fg-2">{children}</span>;
}
function Star({ on }: { on?: boolean }) {
  return <span aria-hidden className={on ? 'text-fg' : 'text-fg-faint'}>★</span>;
}

function Card({ item, anatomy }: { item: Item; anatomy: CardAnatomy }) {
  if (anatomy === 'today') {
    // Today's Marketplace card: capitals badge, two pills for who/trust, stats split left/right.
    return (
      <div className={CARD} style={{ boxShadow: '0 8px 32px rgb(0 0 0 / .18)' }}>
        <div className="flex items-center gap-2">
          <span className="text-base font-medium text-fg flex-1 truncate">{item.title}</span>
          {/* WHY the exact class order (capture repair, 2026-09-24): ast-grep's
              section-label-canonical-classes invariant spells this recipe one
              way project-wide; found pre-existing-broken by `verify.sh` while
              checking this session's unrelated mock-shim.ts change. */}
          {item.status && <span className="text-3xs font-medium text-fg-muted tracking-wider uppercase">{item.status}</span>}
          <Star on={item.star} />
        </div>
        <div className="flex gap-1">
          <span className="rounded border border-edge-dim bg-inset px-1.5 text-3xs text-fg-2">Likely safe</span>
          <span className="rounded border border-edge-dim bg-inset px-1.5 text-3xs text-fg-2">{item.by}</span>
        </div>
        <p className="text-xs text-fg-2 line-clamp-2">{item.desc}</p>
        <div className="flex justify-between text-3xs text-fg-muted font-semibold"><span>{item.stats.split(' · ')[0]}</span><span>{item.kind}</span></div>
      </div>
    );
  }
  if (anatomy === 'chips') {
    // Destin's CA-1 answer: today's chip-ish trust/author badges kept, and the
    // footer details turned into chips of the same style.
    const chip = 'rounded border border-edge-dim bg-inset px-1.5 text-3xs text-fg-2';
    return (
      <div className={CARD} style={SHADOW}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-fg flex-1 truncate">{item.title}</span>
          {item.status && <Pill>{item.status}</Pill>}
          <Star on={item.star} />
        </div>
        <div className="flex gap-1">
          <span className={chip}>Likely safe</span>
          <span className={chip}>{item.by}</span>
        </div>
        <p className="text-xs text-fg-2 line-clamp-2">{item.desc}</p>
        <div className="mt-auto flex flex-wrap gap-1">
          <span className={chip}>{item.kind}</span>
          {item.stats.split(' · ').map((x) => <span key={x} className={chip}>{x}</span>)}
        </div>
      </div>
    );
  }
  if (anatomy === 'quiet-footer') {
    return (
      <div className={CARD} style={SHADOW}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-fg flex-1 truncate">{item.title}</span>
          {item.status && <Pill>{item.status}</Pill>}
          <Star on={item.star} />
        </div>
        <p className="text-xs text-fg-2 line-clamp-2">{item.desc}</p>
        <p className="mt-auto text-2xs text-fg-muted truncate">{item.kind} · {item.by} · {item.stats}</p>
      </div>
    );
  }
  return (
    <div className={CARD} style={SHADOW}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-fg truncate">{item.title}</p>
          <p className="text-2xs text-fg-muted truncate">{item.kind} · {item.by}</p>
        </div>
        {item.status && <Pill>{item.status}</Pill>}
        <Star on={item.star} />
      </div>
      <p className="text-xs text-fg-2 line-clamp-2">{item.desc}</p>
      <p className="mt-auto text-2xs text-fg-muted text-right truncate">{item.stats}</p>
    </div>
  );
}

export function CardAnatomyDemo({ anatomy }: { anatomy: CardAnatomy }) {
  return (
    <div className="relative p-5" style={{ height: 300 }}>
      <ThemeBg />
      <div className="relative grid grid-cols-3 gap-3">
        {ITEMS.map((i) => <Card key={i.title} item={i} anatomy={anatomy} />)}
      </div>
    </div>
  );
}

const CONVS = [
  { title: 'fix chat scroll stick', project: 'youcoded', model: 'Claude Code · Sonnet', size: '4 KB', date: '7/29/2025', tags: ['Priority', 'bug'] },
  { title: 'theme contrast pass', project: 'wecoded-themes', model: 'GPT 5.6', size: '4 KB', date: '7/28/2025', tags: [] },
];

/** A conversation you can open, as in Resume / Projects / chat references: where
 *  the date sits, and — for Resume's cards — where the tag and "done" icon
 *  buttons go once the date takes the top-right corner. */
function Icons() {
  return (
    <span className="flex items-center gap-1 text-fg-muted shrink-0" aria-hidden>
      <span className="inline-flex w-6 h-6 items-center justify-center rounded-md hover:bg-inset">⌂</span>
      <span className="inline-flex w-6 h-6 items-center justify-center rounded-md hover:bg-inset">✓</span>
    </span>
  );
}

export function ConversationCardDemo({ anatomy }: { anatomy: ConvAnatomy }) {
  const withIcons = anatomy.startsWith('icons');
  return (
    <div className="relative p-5" style={{ height: 260 }}>
      <ThemeBg />
      <div className="relative max-w-md space-y-3">
        {CONVS.map((c) => (
          <div key={c.title} className={`${CARD} group`} style={SHADOW}>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-fg flex-1 truncate">{c.title}</span>
              {anatomy === 'icons-top-date-end' && <Icons />}
              {(anatomy === 'date-top' || anatomy === 'icons-bottom' || anatomy === 'icons-hover') && <span className="text-2xs text-fg-muted shrink-0">{c.date}</span>}
              {anatomy === 'icons-hover' && <span className="opacity-0 group-hover:opacity-100 transition-opacity"><Icons /></span>}
            </div>
            {c.tags.length > 0 && (
              <div className="flex gap-1">{c.tags.map((t) => <span key={t} className="rounded-full border border-edge-dim bg-inset px-2 text-2xs text-fg-2">{t}</span>)}</div>
            )}
            <div className="flex items-center gap-2">
              <p className="text-2xs text-fg-muted truncate flex-1">
                {c.project} · {c.model} · {c.size}{anatomy === 'date-end' || anatomy === 'icons-top-date-end' ? ` · ${c.date}` : ''}
              </p>
              {anatomy === 'icons-bottom' && <Icons />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
