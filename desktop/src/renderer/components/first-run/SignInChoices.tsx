import { useState } from 'react';
import { Button, CARD_LEVEL_1, SectionLabel } from '../ui';

/**
 * The sign-in step, explained (first-run deck L-3, Destin 2026-10-04: "walk the users
 * quickly through the differences between a plan, an api key, and local models in terms
 * of cost/privacy … assume many app users have never messed with api or local llms").
 *
 * TRIAL: three layouts of the same three groups, picked by `?signIn=A|B|C` in the
 * workbench until Destin chooses one; the losers are deleted then.
 */

export type WayIn = 'claude' | 'chatgpt' | 'openrouter' | 'local' | 'apikey';

interface Group {
  id: 'plan' | 'payg' | 'local';
  title: string;
  summary: string;
  facts: { label: string; text: string }[];
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
      summary: 'Use your Claude or ChatGPT subscription.',
      facts: [
        { label: 'Cost', text: 'Nothing extra. Your plan’s usage limits apply.' },
        { label: 'Privacy', text: 'Messages go to Anthropic or OpenAI, as in their own apps.' },
        { label: 'Good for', text: 'The strongest models, if you already subscribe.' },
      ],
      ways: [{ id: 'claude', label: 'Log in with Claude' }, ...(chatGpt ? [{ id: 'chatgpt' as const, label: 'Log in with ChatGPT' }] : [])],
    },
    {
      id: 'payg',
      title: 'Pay as you go',
      summary: 'Add credit and pay for each message.',
      facts: [
        { label: 'Cost', text: 'Charged per message. You add credit first, so you never owe more.' },
        { label: 'Privacy', text: 'Messages go to the company that runs the model you pick.' },
        { label: 'Good for', text: 'Trying many models without a subscription.' },
      ],
      ways: [{ id: 'openrouter', label: 'Log in with OpenRouter' }, { id: 'apikey', label: 'Use an API key' }],
    },
    {
      id: 'local',
      title: 'Free, on this computer',
      summary: 'Download a model and run it yourself.',
      facts: [
        { label: 'Cost', text: 'Free. Needs a few GB of space.' },
        { label: 'Privacy', text: 'Nothing leaves your computer.' },
        { label: 'Good for', text: 'Privacy and working offline. Slower and simpler than the big models.' },
      ],
      ways: [{ id: 'local', label: 'Use a local model' }],
    },
  ];
}

function Facts({ facts }: { facts: Group['facts'] }) {
  return (
    <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 text-xs">
      {facts.map((f) => (
        <div key={f.label} className="contents">
          <dt className="text-fg-muted">{f.label}</dt>
          <dd className="text-fg-2 leading-snug">{f.text}</dd>
        </div>
      ))}
    </dl>
  );
}

function Ways({ ways, onPick, row = true }: { ways: Group['ways']; onPick: (w: WayIn) => void; row?: boolean }) {
  return (
    <div className={row ? 'flex gap-2' : 'flex flex-col gap-2'}>
      {ways.map((w) => (
        <Button key={w.id} variant="secondary" size="md" className="flex-1" onClick={() => onPick(w.id)}>
          {w.label}
        </Button>
      ))}
    </div>
  );
}

/** A — three cards, each with its facts and its own buttons. */
function Cards({ list, onPick }: { list: Group[]; onPick: (w: WayIn) => void }) {
  return (
    <div className="w-full flex flex-col gap-2">
      {list.map((g) => (
        <section key={g.id} className={`${CARD_LEVEL_1} p-3 flex flex-col gap-2.5`}>
          <h3 className="brand-heading text-base text-fg">{g.title}</h3>
          <Facts facts={g.facts} />
          <Ways ways={g.ways} onPick={onPick} />
        </section>
      ))}
    </div>
  );
}

/** B — pick a kind first, then see its facts and buttons on a second page. */
function Guided({ list, onPick, initial }: { list: Group[]; onPick: (w: WayIn) => void; initial: Group['id'] | null }) {
  const [open, setOpen] = useState<Group['id'] | null>(initial);
  const g = list.find((x) => x.id === open);
  if (g) {
    return (
      <div className={`${CARD_LEVEL_1} w-full p-4 flex flex-col gap-3`}>
        <div>
          <h3 className="brand-heading text-lg text-fg">{g.title}</h3>
          <p className="text-sm text-fg-dim">{g.summary}</p>
        </div>
        <Facts facts={g.facts} />
        <Ways ways={g.ways} onPick={onPick} row={false} />
        <Button variant="ghost" size="sm" className="self-center" onClick={() => setOpen(null)}>Back</Button>
      </div>
    );
  }
  return (
    <div className="w-full flex flex-col gap-2">
      {list.map((x) => (
        <button
          key={x.id}
          type="button"
          onClick={() => setOpen(x.id)}
          className={`${CARD_LEVEL_1} w-full p-3 text-left flex items-center gap-3 hover:border-accent transition-colors`}
        >
          <span className="flex-1 min-w-0">
            <span className="block brand-heading text-base text-fg">{x.title}</span>
            <span className="block text-xs text-fg-dim">{x.summary}</span>
          </span>
          <span aria-hidden className="text-fg-muted">›</span>
        </button>
      ))}
    </div>
  );
}

/** C — one comparison table, a column per kind, buttons at the foot of each column. */
function Compare({ list, onPick }: { list: Group[]; onPick: (w: WayIn) => void }) {
  return (
    <div className={`${CARD_LEVEL_1} w-full p-3`}>
      <div className="grid grid-cols-[4.5rem_1fr_1fr_1fr] items-start gap-x-3 gap-y-2 text-xs">
        <span />
        {list.map((g) => <h3 key={g.id} className="brand-heading text-sm text-fg leading-tight">{g.title}</h3>)}
        {list[0].facts.map((_, i) => (
          <div key={i} className="contents">
            <SectionLabel className="pt-px">{list[0].facts[i].label}</SectionLabel>
            {list.map((g) => <p key={g.id} className="text-fg-2 leading-snug">{g.facts[i].text}</p>)}
          </div>
        ))}
        <span />
        {list.map((g) => <Ways key={g.id} ways={g.ways} onPick={onPick} row={false} />)}
      </div>
    </div>
  );
}

export function SignInChoices({ chatGpt, onPick }: { chatGpt: boolean; onPick: (w: WayIn) => void }) {
  const params = new URLSearchParams(location.search);
  const layout = params.get('signIn') ?? 'A';
  const list = groups(chatGpt);
  if (layout === 'B') return <Guided list={list} onPick={onPick} initial={(params.get('signInPick') as Group['id'] | null) ?? null} />;
  if (layout === 'C') return <Compare list={list} onPick={onPick} />;
  return <Cards list={list} onPick={onPick} />;
}
