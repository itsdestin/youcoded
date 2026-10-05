import { useState } from 'react';
import { Button } from '../ui';
import { ProviderIcon } from '../ProviderIcon';

/**
 * The sign-in step, explained (first-run deck L-3, Destin 2026-10-04: "walk the users
 * quickly through the differences between a plan, an api key, and local models in terms
 * of cost/privacy … assume many app users have never messed with api or local llms"),
 * polished per deck first-run-1 R-3: "add brand icons for claude/gpt/openrouter … make
 * this feel much more polished/premium".
 *
 * Layout B, "pick a kind first" (deck first-run-2 P2-3): three rows, then one kind's facts
 * and buttons on a second page. The all-open cards (A) and the table (C) were not picked.
 */

export type WayIn = 'claude' | 'chatgpt' | 'openrouter' | 'local' | 'apikey';

type FactKind = 'cost' | 'privacy' | 'good';
interface Group {
  id: 'plan' | 'payg' | 'local';
  title: string;
  badge: string;
  summary: string;
  facts: { kind: FactKind; text: string }[];
  ways: { id: WayIn; label: string }[];
}

// WHY these words: every fact is something the user can check for themselves, and none
// claims what a company does with their messages beyond "it goes to them" — the
// error-message rule's "never invent a cause" applied to promises.
function groups(chatGpt: boolean): Group[] {
  return [
    {
      id: 'plan',
      title: 'A plan you already pay for',
      badge: 'No extra cost',
      summary: 'Use your Claude or ChatGPT subscription.',
      facts: [
        { kind: 'cost', text: 'Included in your plan. Its usage limits apply.' },
        { kind: 'privacy', text: 'Messages go to Anthropic or OpenAI, as in their own apps.' },
        { kind: 'good', text: 'The strongest models.' },
      ],
      ways: [{ id: 'claude', label: 'Log in with Claude' }, ...(chatGpt ? [{ id: 'chatgpt' as const, label: 'Log in with ChatGPT' }] : [])],
    },
    {
      id: 'payg',
      title: 'Pay as you go',
      badge: 'Pay per message',
      summary: 'Add credit, then pay only for what you use.',
      facts: [
        { kind: 'cost', text: 'Charged per message from credit you add first.' },
        { kind: 'privacy', text: 'Messages go to the company running the model you pick.' },
        { kind: 'good', text: 'Trying many models without a subscription.' },
      ],
      ways: [{ id: 'openrouter', label: 'Log in with OpenRouter' }, { id: 'apikey', label: 'Use an API key' }],
    },
    {
      id: 'local',
      title: 'Free, on this computer',
      badge: 'Private',
      summary: 'Download a model and run it yourself.',
      facts: [
        { kind: 'cost', text: 'Free. Needs a few GB of space.' },
        { kind: 'privacy', text: 'Nothing leaves your computer.' },
        { kind: 'good', text: 'Working offline. Slower and simpler than the big models.' },
      ],
      ways: [{ id: 'local', label: 'Use a local model' }],
    },
  ];
}

/* Small line icons for the facts and the two ways in that have no company logo. */
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
function FactIcon({ kind }: { kind: FactKind }) {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden {...stroke} className="shrink-0 mt-0.5 text-accent">
      {kind === 'cost' && <><circle cx="12" cy="12" r="9" /><path d="M14.8 9.2a3 2.4 0 0 0-2.8-1.4c-1.7 0-3 .9-3 2.1 0 2.8 6 1.4 6 4.2 0 1.2-1.3 2.1-3 2.1a3 2.4 0 0 1-2.8-1.4M12 6.2v1.6m0 8.4v1.6" /></>}
      {kind === 'privacy' && <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>}
      {kind === 'good' && <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8L3.5 9.7l5.9-.9z" />}
    </svg>
  );
}
function WayIcon({ id }: { id: WayIn }) {
  // Company marks in their own colours where the mark is coloured (Claude's terracotta);
  // the single-colour marks (OpenAI, OpenRouter) in the page's ink.
  if (id === 'claude') return <span style={{ color: '#D97757' }}><ProviderIcon icon="claude" size={18} /></span>;
  if (id === 'chatgpt') return <ProviderIcon icon="openai" size={18} />;
  if (id === 'openrouter') return <ProviderIcon icon="openrouter" size={18} />;
  if (id === 'apikey') {
    return (
      <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden {...stroke}>
        <circle cx="8" cy="15" r="4" /><path d="M11 12l8-8m-3 3l2 2m-4 0l1.5 1.5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden {...stroke}>
      <rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2.5 19h19" />
    </svg>
  );
}

function Facts({ facts }: { facts: Group['facts'] }) {
  return (
    <ul className="flex flex-col gap-1.5 text-sm text-fg-2">
      {facts.map((f) => (
        <li key={f.kind} className="flex gap-2.5 leading-snug"><FactIcon kind={f.kind} />{f.text}</li>
      ))}
    </ul>
  );
}

// WHY the Button primitive with brand classes: every control goes through its primitive;
// `brand-way` (brand.css) gives the white, logo-led sign-in button its look.
function Ways({ ways, onPick }: { ways: Group['ways']; onPick: (w: WayIn) => void }) {
  return (
    <div className="flex flex-col gap-2">
      {ways.map((w) => (
        <Button key={w.id} variant="secondary" size="lg" className="brand-way w-full" onClick={() => onPick(w.id)}>
          <WayIcon id={w.id} />
          <span className="flex-1 text-left">{w.label}</span>
        </Button>
      ))}
    </div>
  );
}

function Head({ g, big = false }: { g: Group; big?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <h3 className={`brand-heading text-fg ${big ? 'text-xl' : 'text-lg'}`}>{g.title}</h3>
        <p className="text-sm text-fg-dim">{g.summary}</p>
      </div>
      <span className="brand-badge shrink-0">{g.badge}</span>
    </div>
  );
}

/** Pick a kind first, then its facts and buttons on a second page. */
function Guided({ list, onPick, initial }: { list: Group[]; onPick: (w: WayIn) => void; initial: Group['id'] | null }) {
  const [open, setOpen] = useState<Group['id'] | null>(initial);
  const g = list.find((x) => x.id === open);
  if (g) {
    return (
      <section className="brand-card w-full p-6 flex flex-col gap-5">
        <button type="button" onClick={() => setOpen(null)} className="self-start text-sm text-fg-dim hover:text-fg transition-colors">‹ All options</button>
        <Head g={g} big />
        <Facts facts={g.facts} />
        <Ways ways={g.ways} onPick={onPick} />
      </section>
    );
  }
  return (
    <div className="w-full flex flex-col gap-3">
      {list.map((x) => (
        <button key={x.id} type="button" onClick={() => setOpen(x.id)} className="brand-card brand-card--press w-full p-5 text-left flex items-center gap-4">
          <span className="flex -space-x-1 shrink-0 w-12 justify-center text-fg">
            {x.ways.map((w) => <span key={w.id} className="brand-way-chip"><WayIcon id={w.id} /></span>)}
          </span>
          <span className="flex-1 min-w-0">
            <span className="block brand-heading text-lg text-fg">{x.title}</span>
            <span className="block text-sm text-fg-dim">{x.summary}</span>
          </span>
          <span className="brand-badge shrink-0">{x.badge}</span>
          <span aria-hidden className="text-fg-muted text-lg">›</span>
        </button>
      ))}
    </div>
  );
}

export function SignInChoices({ chatGpt, onPick }: { chatGpt: boolean; onPick: (w: WayIn) => void }) {
  // `?signInPick=<kind>` is the workbench's photo switch for the second page; the real
  // app's address never carries it, so it always opens on the three rows.
  const pick = new URLSearchParams(location.search).get('signInPick') as Group['id'] | null;
  return <Guided list={groups(chatGpt)} onPick={onPick} initial={pick} />;
}
