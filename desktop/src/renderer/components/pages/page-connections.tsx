// Page connections — the words, the approval screen and the per-page list
// (Pages Phase 2; decided on two questions decks, 2026-09-19).
//
// ONE function writes the sentence for a connection, so the approval screen,
// the card's list and Settings can never describe the same access two ways.
// The wording rules come from the decks and are load-bearing:
//   - access is a plain sentence per thing reached, no levels or badges;
//   - "look-up only" is enforced by the app, so "Cannot change anything there"
//     is true — and the second half says what it does NOT stop (deck 3,
//     Q-lookup: a look-up can still carry what the page knows to that address)
//     as written — but never "read-only" or "safe" for an outside service;
//   - the whole internet is its own blunt line, never softened;
//   - Remove "stops future use", never "revokes": the app cannot take back
//     what a service already received.
import React, { useState } from 'react';
import type { PageConnection, PageConnectionStatus, PageSummary, PagesBridge } from '../../../shared/pages-types';
import { PLAID_SERVICE, plaidAddress } from '../../../shared/pages-types';
import { isRemoteMode } from '../../platform';
import { isWorkbenchMode } from '../../workbench-mode';
import { Button, ErrorState, TextInput } from '../ui';
import { Dialog } from '../ui/Dialog';
import { PageGlyph } from './page-icons';
import { cleanDeviceAddress, deviceAddressProblem } from '../../../shared/page-device-address';
import { publishPages } from './use-pages';

function bridge(): PagesBridge | undefined {
  return (window as unknown as { claude?: { pages?: PagesBridge } }).claude?.pages;
}

/** A new key is typed on the computer only (deck Q-phone): over remote access
 *  the approval says "Finish setting this up on your computer" instead of
 *  showing a key box. `?pagesPhone=1` shows that state in the workbench.
 *  WHY not exported: only this file calls it; the export was knip's one unused
 *  export that pushed the combined tree past the remote branch's lowered ratchet. */
function keysEnteredHere(): boolean {
  if (isWorkbenchMode() && new URLSearchParams(location.search).get('pagesPhone') === '1') return false;
  return !isRemoteMode();
}

/** The sentence for one connection. `what` is the main clause; `limit` is the
 *  quieter second sentence. Written to follow "This page can…". */
/** Destin chose "both facts" (deck 3, Q-lookup) over the old "Cannot send
 *  changes.", which read as "nothing about me leaves". */
const LOOKUP_LIMIT = 'Cannot change anything there. The page decides what it sends to this address.';

export function describeConnection(c: PageConnection): { what: string; limit: string } {
  switch (c.kind) {
    case 'youcoded':
      // A page may change things on YouCoded only at places it names (a
      // campaign builder: one place). The card names each one and says the
      // rest of the account is out of reach, which main enforces.
      if (c.writePaths?.length) {
        return {
          what: `Look things up on YouCoded's own service using your YouCoded sign-in, and make changes at ${c.writePaths.join(', ')}.`,
          limit: 'Nothing else on your account can be changed.',
        };
      }
      return { what: "Look things up on YouCoded's own service using your YouCoded sign-in.", limit: LOOKUP_LIMIT };
    case 'key':
      return c.access === 'lookup'
        ? { what: `Look things up on ${c.address} using your ${c.service} key.`, limit: LOOKUP_LIMIT }
        : { what: `Look up and change things on ${c.address} using your ${c.service} key.`, limit: 'It can do whatever that key allows.' };
    case 'public':
      return { what: `Read public information from ${c.address}.`, limit: 'No key or sign-in is used. The page decides what it sends to this address.' };
    case 'github':
      return c.access === 'lookup'
        ? { what: 'Look things up on GitHub using your GitHub sign-in.', limit: LOOKUP_LIMIT }
        : { what: 'Look up and change things on GitHub using your GitHub sign-in.', limit: 'That includes your repositories.' };
    case 'open':
      return { what: 'Reach any website.', limit: 'Anything shown in this page, or typed into it, could be sent anywhere.' };
    // Home-device deck (2026-10-01): one device, never the internet
    // (S-only-home), and the key is the person's own (S-key-and-control).
    case 'device': {
      const using = c.needsKey ? ` using your ${c.service} key` : '';
      // No usable address yet (the box holds something refused): name the
      // device, not an address.
      const at = c.address ? ` at ${c.address}` : '';
      const only = 'Only this one device in your home; nothing on the internet.';
      return c.access === 'lookup'
        ? { what: `Look things up on your ${c.service}${at}${using}.`, limit: `Cannot change anything there. ${only}` }
        : { what: `Look up and change things on your ${c.service}${at}${using}.`, limit: c.needsKey ? `It can do whatever that key allows. ${only}` : only };
    }
    // Finance dashboard (2026-10-05). Practice mode says so plainly, so nobody
    // thinks their real bank is reachable from a sandbox page.
    case 'plaid':
      return c.environment === 'sandbox'
        ? { what: "See Plaid's made-up practice banks, using your Plaid keys.", limit: 'Nothing real is reached.' }
        : { what: 'See balances, credit limits and due dates from banks you connect through Plaid, using your Plaid keys.', limit: 'Cannot move money. Each bank is added only when you sign in to it in your browser, and you can remove it any time.' };
  }
}

/** Extra plain lines for a device whose manifest asks for more than ordinary look-ups: a live connection
 *  (a login greeting or a "logged in" reply means the page keeps a socket open) and camera video. Only the
 *  fields that are present produce a line, so a device that asks for neither shows nothing new.
 *  WHY: both ride the approval fingerprint, so the person was approving them without being told. */
const LIVE_CONNECTION_LINE = 'Keeps a live connection open for instant updates.';
const CAMERA_VIDEO_LINE = 'Can play camera video through the app.';
function deviceExtraLines(c: PageConnection): string[] {
  if (c.kind !== 'device') return [];
  const lines: string[] = [];
  if (c.socketHello || c.socketReady) lines.push(LIVE_CONNECTION_LINE);
  if (c.videoProfile) lines.push(CAMERA_VIDEO_LINE);
  return lines;
}

/** Home-device deck, S-plain-connection: most home devices only speak the
 *  unencrypted form of web traffic, so the card says what that means rather
 *  than hiding it. Tailscale encrypts on its own, which is why the line says
 *  "your home wifi" and not "anyone". */
const DEVICE_NOT_ENCRYPTED = 'The connection to a home device is usually not encrypted. Someone already on your home wifi could see what passes between them, including the key. Over Tailscale it is encrypted.';

/** Two-label endings that are registries rather than somebody's website, so
 *  the real site is the THIRD label from the right. A short hand-kept list, not
 *  the public suffix list: bundling and updating that list is a dependency this
 *  screen does not need, and being one label too generous ("bbc.co.uk" shown as
 *  "co.uk" would be) is the failure worth avoiding. An unlisted ending simply
 *  emphasises the last two labels, which is right for nearly every address. */
const REGISTRY_ENDINGS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'net.nz', 'org.nz',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'com.br', 'com.cn', 'com.hk', 'com.mx', 'com.pl', 'com.sg', 'com.tr', 'com.tw', 'com.ar',
  'co.in', 'co.il', 'co.id', 'co.kr', 'co.th', 'co.za',
  'ac.in', 'net.in', 'org.in',
]);

/** The website an address really belongs to, and the rest of it.
 *  `api.openweathermap.org.evil.example` is a perfectly legal address that
 *  reads as OpenWeather at a glance (design review 1, finding 6), so the part
 *  that decides who receives the request is the part that is emphasised. */
export function splitAddress(address: string): { prefix: string; site: string } {
  const labels = address.split('.').filter(Boolean);
  if (labels.length <= 2) return { prefix: '', site: address };
  const take = REGISTRY_ENDINGS.has(labels.slice(-2).join('.')) ? 3 : 2;
  if (labels.length <= take) return { prefix: '', site: address };
  const site = labels.slice(-take).join('.');
  return { prefix: address.slice(0, address.length - site.length), site };
}

/** The address as it is read: the real website solid, everything in front of
 *  it dim. Same everywhere an address appears, so one screen never teaches a
 *  way of reading that another screen breaks. */
function Address({ address, device }: { address: string; device?: boolean }) {
  // A home device has no "real website" hiding inside it — 100.99.234.114:8123
  // split at its dots would emphasise "234.114:8123" — so it is shown whole.
  if (device) return <span data-page-address={address} className="text-fg font-medium">{address}</span>;
  const { prefix, site } = splitAddress(address);
  return (
    <span data-page-address={site}>
      {prefix && <span className="text-fg-dim">{prefix}</span>}
      <span className="text-fg font-medium">{site}</span>
    </span>
  );
}

function addressOf(c: PageConnection): string | undefined {
  return c.kind === 'key' || c.kind === 'public' || c.kind === 'device' ? c.address : undefined;
}

/** The connection's sentence, with its address rendered rather than written —
 *  the same words, only read correctly. */
function withAddress(text: string, address: string | undefined, device?: boolean): React.ReactNode {
  if (!address) return text;
  const at = text.indexOf(address);
  if (at < 0) return text;
  return <>{text.slice(0, at)}<Address address={address} device={device} />{text.slice(at + address.length)}</>;
}

/** True while any line is waiting for a yes — the page stays closed until then. */
export function needsApproval(page: PageSummary | null): boolean {
  return !!page?.connections?.some((c) => !c.approved);
}

/** What the whole internet means in practice, spelled out under its sentence
 *  (review round 1, C-4: "clearer about what the permission actually means in
 *  practice, and associated risks"). The last line is true because an
 *  open-internet page never also holds a key or sign-in (deck Q-open-mix). */
const OPEN_INTERNET_MEANS = [
  'It can load from, and send to, any site. There is no fixed list.',
  'Anything you type or paste into this page could be sent somewhere you did not choose.',
  'It still cannot see your files, your other pages, or your saved keys and sign-ins.',
  // Deck 3, Q-home-network: the protection is real but can lose a timing race
  // (net-guard.ts HONESTY LIMIT), so the line says what the app does, not a
  // guarantee.
  'YouCoded blocks it from reaching your router, your Pi and anything else on your home network.',
];

/** No glyph beside the sentence (review round 1: "remove the key symbol",
 *  "drop icon") — the words carry it. */
function ConnectionLine({ c, children, small }: { c: PageConnectionStatus; children?: React.ReactNode; small?: boolean }) {
  const words = describeConnection(c);
  return (
    <div className="flex flex-col gap-1.5" data-page-connection={c.kind}>
      <div className={`${small ? 'text-xs' : 'text-sm'} text-fg-2 leading-relaxed`}>
        {withAddress(words.what, addressOf(c), c.kind === 'device')} <span className="text-fg-dim">{words.limit}</span>
      </div>
      {deviceExtraLines(c).map((line) => <div key={line} className={`${small ? 'text-xs' : 'text-sm'} text-fg-2 leading-relaxed`} data-device-extra>{line}</div>)}
      {children}
    </div>
  );
}

/** How to find a key: the page's author may supply the steps (they travel with
 *  the page); otherwise a general pointer. Shown as the author's words, not the
 *  app's, because the app cannot vouch for them. */
type KeyedLine = (PageConnectionStatus & { kind: 'key' | 'device' })
  // A Plaid line is keyed like the rest, under the service and address its
  // saved key lives at (pages-types plaidAddress), so the saved-key offer and
  // the storage note read the same way for it.
  | (PageConnectionStatus & { kind: 'plaid'; service: string; address: string });

function plaidKeyed(c: PageConnectionStatus & { kind: 'plaid' }): KeyedLine {
  return { ...c, service: PLAID_SERVICE, address: plaidAddress(c.environment) };
}

/** Plaid's own dashboard page where both keys are shown. */
const PLAID_KEYS_PAGE = 'https://dashboard.plaid.com/developers/keys';
const PLAID_KEY_STEPS = (env: string) => [
  'Sign in at dashboard.plaid.com (making an account is free).',
  'Open Developers, then Keys.',
  `Copy your client ID and your ${env === 'sandbox' ? 'Sandbox' : 'Production'} secret into the two boxes below.`,
];

function KeyHelp({ c }: { c: KeyedLine }) {
  const steps = c.keyHelp?.steps ?? (c.kind === 'plaid' ? PLAID_KEY_STEPS(c.environment) : []);
  // Home-device deck, S-key-and-control: a device that names where its keys
  // are made gets a button straight there, on the address the person allowed,
  // so nobody has to find a settings screen inside Home Assistant by hand.
  // Full width (screens review, S-key: "make the open home assistant button
  // full width"), matching the stacked buttons below it.
  const openOnDevice = c.kind === 'device' && c.keyPage ? (
    <div>
      <Button
        variant="secondary"
        className="w-full"
        data-open-key-page
        onClick={() => { void window.claude.shell.openExternal(`http://${c.address}${c.keyPage}`); }}
      >
        Open {c.service}
      </Button>
    </div>
  ) : c.kind === 'plaid' ? (
    <div>
      <Button variant="secondary" className="w-full" data-open-key-page onClick={() => { void window.claude.shell.openExternal(PLAID_KEYS_PAGE); }}>
        Open Plaid's dashboard
      </Button>
    </div>
  ) : null;
  if (steps.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-sm text-fg-2 leading-relaxed">
          {c.kind === 'device'
            ? <>Open {c.service} and look for a section called Security, API or Access tokens. Make a new key and copy it.</>
            : <>Sign in on {c.service}'s website and look for a section called API, Developer or Integrations. Copy the key shown there.</>}
        </div>
        {openOnDevice}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs text-fg-dim">Where to find it, from this page's author:</div>
      <ol className="list-decimal pl-5 text-sm text-fg-2 leading-relaxed flex flex-col gap-0.5">
        {steps.map((t, i) => <li key={i}>{t}</li>)}
      </ol>
      {openOnDevice}
    </div>
  );
}

/** The address box on a device line (home-device deck, Q-address): the page
 *  suggests, the person may change it before allowing. Checked as they type
 *  with the same rule main applies, so a refusal is explained here instead of
 *  arriving later as a failed Allow. */
function DeviceAddressField({ c, value, onChange }: { c: PageConnectionStatus & { kind: 'device' }; value: string; onChange: (v: string) => void }) {
  const ok = cleanDeviceAddress(value) !== null;
  return (
    <div className="flex flex-col gap-1.5" data-device-address-field>
      <label className="text-xs text-fg-dim" htmlFor={`device-address-${c.id}`}>
        Where your {c.service} is. Change this if yours is at a different address.
      </label>
      <TextInput
        id={`device-address-${c.id}`}
        size="sm"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!ok}
        className="select-text"
      />
      {!ok && <div className="text-xs text-fg-2" role="alert" data-device-address-problem>{deviceAddressProblem(value)}</div>}
      <div className="text-xs text-fg-muted leading-relaxed" data-device-not-encrypted>{DEVICE_NOT_ENCRYPTED}</div>
    </div>
  );
}

/** Shown IN PLACE OF the page until every line is approved (decks Q-own-pages,
 *  S-change, S-key-entry). Same card species as the library's welcome card;
 *  actions stack full width, primary over secondary, like the app's dialogs.
 *
 *  TWO STEPS when a key must be typed (review round 1, C-1: "the explanation of
 *  the permission and the key entry are kinda separate things… just have a
 *  continue button, then a second page that has instructions for how to find
 *  the relevant key"): step 1 is what the page may do, step 2 is the key. */
export function PageApproval({ page, onNotNow }: { page: PageSummary; onNotNow: () => void }) {
  const all = page.connections ?? [];
  const asking = all.filter((c) => !c.approved);
  const already = all.filter((c) => c.approved);
  // A re-ask after an edit shows what was already allowed too, so the new line
  // is read in context; the first ask has nothing approved yet.
  const isChange = already.length > 0;
  // `?pagesStep=keys` opens the key step directly in the workbench, so it is
  // a screen of its own (shoot) rather than only reachable by clicking.
  const [step, setStep] = useState<'what' | 'keys'>(() =>
    isWorkbenchMode() && new URLSearchParams(location.search).get('pagesStep') === 'keys' ? 'keys' : 'what');
  const [keys, setKeys] = useState<Record<string, string>>({});
  // Plaid takes two values; they are joined into the one saved key here.
  const [plaidParts, setPlaidParts] = useState<Record<string, { clientId: string; secret: string }>>({});
  const setPlaidPart = (id: string, part: 'clientId' | 'secret', v: string) => setPlaidParts((m) => {
    const next = { ...(m[id] ?? { clientId: '', secret: '' }), [part]: v };
    setKeys((k) => ({ ...k, [id]: next.clientId.trim() && next.secret.trim() ? JSON.stringify({ clientId: next.clientId.trim(), secret: next.secret.trim() }) : '' }));
    return { ...m, [id]: next };
  });
  const [differentKey, setDifferentKey] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  // Allowing can fail where nothing is wrong with the page: a computer with no
  // keychain, where the secrets store refuses by design and NO approval is
  // recorded (design review 1, finding 11). Before this, the button simply
  // un-greyed and the screen stayed — which reads as "nothing happened".
  const [failure, setFailure] = useState<string | null>(null);
  const here = keysEnteredHere();
  // Home-device deck, Q-address: each device line's address as the person has
  // it right now, starting from the page's suggestion.
  const [addresses, setAddresses] = useState<Record<string, string>>(() =>
    Object.fromEntries(asking.filter((c) => c.kind === 'device').map((c) => [c.id, (c as { address: string }).address])));

  // A device line with its address replaced by the one being typed, so the
  // sentence, the key step and the Open button all name the device that will
  // actually be allowed — never the suggestion the person already changed.
  // An address that is not allowed becomes '' rather than the typed text, so
  // the sentence never reads "…at evil.example.com… only this one device in
  // your home" while the box is showing why that address is refused.
  const asTyped = (c: PageConnectionStatus): PageConnectionStatus =>
    c.kind === 'device' && addresses[c.id] !== undefined ? { ...c, address: cleanDeviceAddress(addresses[c.id]) ?? '' } : c;
  const shown = asking.map(asTyped);
  const addressesOk = shown.every((c) => c.kind !== 'device' || cleanDeviceAddress(addresses[c.id]) !== null);

  const keyLines: KeyedLine[] = shown.flatMap((c): KeyedLine[] =>
    c.kind === 'key' || (c.kind === 'device' && c.needsKey) ? [c as KeyedLine] : c.kind === 'plaid' ? [plaidKeyed(c)] : []);
  // A saved key is kept per service AND address, so it is only offered while
  // the device is still at the address it was saved for.
  const suggested = (id: string) => {
    const a = asking.find((x) => x.id === id);
    return a?.kind === 'device' ? a.address : undefined;
  };
  const savedHere = (c: KeyedLine) => !!c.savedKey && (c.kind !== 'device' || c.address === suggested(c.id));
  const toType = keyLines.filter((c) => !savedHere(c) || differentKey[c.id]);
  const missingKey = toType.some((c) => !(keys[c.id] ?? '').trim());

  const allow = async () => {
    const b = bridge();
    if (!b?.approve) return;
    setBusy(true);
    setFailure(null);
    const sent: Record<string, string> = {};
    for (const c of keyLines) sent[c.id] = toType.some((t) => t.id === c.id) ? keys[c.id].trim() : 'saved';
    const sentAddresses: Record<string, string> = {};
    for (const c of shown) if (c.kind === 'device') sentAddresses[c.id] = c.address;
    try {
      const r = await b.approve(page.id, sent, sentAddresses);
      // On a yes the host replaces this screen with the page itself, so the
      // button stays "Allowing…" rather than flicking back to Allow for the
      // frame or two in between — which would invite a second press.
      if (r.ok) { publishPages(r.pages); return; }
      setFailure(r.message);
    } catch {
      // The reason is not known here, so none is claimed — Retry is the offer.
      setFailure("Allowing this page didn't finish.");
    }
    setBusy(false);
  };

  const failureState = failure === null ? null : (
    <ErrorState variant="inline" message={failure} onRetry={() => { void allow(); }} />
  );

  const shell = (children: React.ReactNode) => (
    <div className="absolute inset-0 overflow-y-auto flex items-center justify-center max-sm:items-start p-4 select-none" data-page-approval={step}>
      <div className="w-full max-w-xl bg-panel border border-edge rounded-lg p-5 sm:p-6 flex flex-col gap-4">{children}</div>
    </div>
  );
  const heading = (eyebrow: string, title: string) => (
    <div className="flex items-center gap-3">
      <span aria-hidden="true" className="shrink-0 inline-flex w-10 h-10 rounded-md bg-inset border border-edge-dim items-center justify-center text-fg-2">
        <PageGlyph icon={page.icon} className="w-5 h-5" />
      </span>
      <div className="min-w-0">
        <div className="text-2xs font-medium text-fg-muted tracking-wider uppercase">{eyebrow}</div>
        <h3 className="text-base font-semibold text-fg leading-snug">{title}</h3>
      </div>
    </div>
  );

  if (step === 'keys') {
    const names = toType.map((c) => c.service);
    return shell(<>
      {heading('One more step', names.length === 1 ? `Add your ${names[0]} key` : 'Add your keys')}
      {toType.map((c) => (
        <div key={c.id} className="flex flex-col gap-3" data-page-key-step={c.service}>
          {toType.length > 1 && <div className="text-sm font-medium text-fg">{c.service}</div>}
          <KeyHelp c={c} />
          {c.kind === 'plaid' ? (<>
            <TextInput
              autoComplete="off"
              spellCheck={false}
              aria-label="Your Plaid client ID"
              placeholder="Client ID"
              value={plaidParts[c.id]?.clientId ?? ''}
              onChange={(e) => setPlaidPart(c.id, 'clientId', e.target.value)}
              className="select-text"
            />
            <TextInput
              type="password"
              autoComplete="off"
              aria-label={`Your Plaid ${c.environment === 'sandbox' ? 'Sandbox' : 'Production'} secret`}
              placeholder={`${c.environment === 'sandbox' ? 'Sandbox' : 'Production'} secret`}
              value={plaidParts[c.id]?.secret ?? ''}
              onChange={(e) => setPlaidPart(c.id, 'secret', e.target.value)}
              className="select-text"
            />
          </>) : (
          <TextInput
            type="password"
            autoComplete="off"
            aria-label={`Your ${c.service} key`}
            placeholder={`Paste your ${c.service} key`}
            value={keys[c.id] ?? ''}
            onChange={(e) => setKeys((m) => ({ ...m, [c.id]: e.target.value }))}
            className="select-text"
          />
          )}
        </div>
      ))}
      {/* Review round 2, D-2: "page never sees it" read as nonsense to someone
          pasting a key precisely so the page can use it. This says what is true
          of the storage instead: SecretsStore encrypts with the OS keychain,
          refuses a plaintext fallback, and lives in per-install app data that
          sync never touches. The key does leave the machine — to its own
          service — so that is said too, never "not accessible to anyone". */}
      <div className="text-xs text-fg-muted leading-relaxed" data-key-storage-note>
        Your key is stored encrypted on this computer only. It isn't backed up or synced, and YouCoded sends it only to {toType.length === 1 ? <Address address={toType[0].address} device={toType[0].kind === 'device'} /> : 'the service it belongs to'}.
      </div>
      {failureState}
      <div className="flex flex-col gap-2">
        <Button variant="primary" onClick={() => { void allow(); }} disabled={busy || missingKey} className="w-full">
          {busy ? 'Allowing…' : 'Allow and open'}
        </Button>
        <Button variant="secondary" onClick={() => setStep('what')} className="w-full">Back</Button>
      </div>
    </>);
  }

  return shell(<>
    {heading(isChange ? 'This page changed' : 'Before this page opens', isChange ? `${page.name} wants additional permissions` : `${page.name} wants to connect`)}

    <div className="flex flex-col gap-2">
      <div className="text-xs text-fg-dim">This page would be able to:</div>
      {/* Two boxes on a re-ask, one under each label (review round 3, E-2):
          the new permissions, then what was already allowed. A first ask has
          only the one box and no labels. */}
      {isChange && <div className="text-2xs font-medium text-fg tracking-wider uppercase" data-new-label>New</div>}
      <div className="rounded-lg border border-edge bg-inset/40 p-3 flex flex-col gap-3">
        {shown.map((c) => (
          <ConnectionLine key={c.id} c={c}>
            {c.kind === 'open' && (
              <ul className="list-disc pl-5 text-xs text-fg-muted leading-relaxed flex flex-col gap-0.5" data-open-internet-means>
                {OPEN_INTERNET_MEANS.map((t) => <li key={t}>{t}</li>)}
              </ul>
            )}
            {c.kind === 'device' && (
              <DeviceAddressField c={c} value={addresses[c.id] ?? ''} onChange={(v) => setAddresses((m) => ({ ...m, [c.id]: v }))} />
            )}
            {(() => {
              const k = keyLines.find((x) => x.id === c.id);
              return k && savedHere(k) ? (
                <div className="flex items-center gap-2 text-xs text-fg-muted" data-saved-key-offer>
                  <span>{differentKey[c.id] ? `You'll paste a different ${k.service} key next.` : `Uses your saved ${k.service} key.`}</span>
                  {here && (
                    <Button variant="secondary" size="sm" onClick={() => setDifferentKey((m) => ({ ...m, [c.id]: !m[c.id] }))}>
                      {differentKey[c.id] ? 'Use the saved key' : 'Use a different key'}
                    </Button>
                  )}
                </div>
              ) : null;
            })()}
          </ConnectionLine>
        ))}
      </div>
      {isChange && (
        <div className="flex flex-col gap-2 pt-1" data-already-allowed>
          <div className="text-2xs font-medium text-fg-muted tracking-wider uppercase">Already allowed</div>
          <div className="rounded-lg border border-edge bg-inset/40 p-3 flex flex-col gap-3">
            {already.map((c) => <ConnectionLine key={c.id} c={c} small />)}
          </div>
        </div>
      )}
    </div>

    {failureState}

    <div className="flex flex-col gap-2">
      {/* On the phone a key cannot be typed (deck Q-phone). The button sits where
          Allow would, greyed, with the reason under it (review round 1, C-5). */}
      {toType.length > 0 && !here ? (
        // The reason sits INSIDE the greyed button (review round 2, D-6), so
        // the one control where Allow would be carries its own explanation.
        <Button variant="primary" disabled className="w-full h-auto" data-finish-on-computer>
          <span className="flex flex-col items-center gap-0.5 py-1 whitespace-normal text-center">
            <span>Finish on your computer</span>
            <span className="text-2xs opacity-80">Adding a key isn't supported on the phone yet. Open this page on your computer to set it up.</span>
          </span>
        </Button>
      ) : toType.length > 0 ? (
        <Button variant="primary" onClick={() => setStep('keys')} disabled={!addressesOk} className="w-full">Continue</Button>
      ) : (
        <Button variant="primary" onClick={() => { void allow(); }} disabled={busy || !addressesOk} className="w-full">
          {busy ? 'Allowing…' : 'Allow and open'}
        </Button>
      )}
      <Button variant="secondary" onClick={onNotNow} className="w-full">Not now</Button>
    </div>
  </>);
}

/** One page's connections, opened from its library card (deck Q-manage). */
export function PageConnectionsDialog({ page, onClose, onConnect }: { page: PageSummary | null; onClose: () => void; onConnect: (pageId: string) => void }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const remove = async (connectionId: string) => {
    const b = bridge();
    if (!page || !b?.removeConnection) return;
    publishPages(await b.removeConnection(page.id, connectionId));
    setConfirming(null);
  };
  const list = page?.connections ?? [];
  return (
    <Dialog screen="pages/library/connections" open={page !== null} onClose={onClose} layer={3} size="panel" title={page ? `${page.name} · connections` : ''}>
      <div className="flex flex-col gap-3">
        {list.length === 0 && <div className="text-sm text-fg-muted">This page reaches nothing outside itself.</div>}
        {list.map((c) => (
          <div key={c.id} className="rounded-lg border border-edge bg-inset/40 p-3 flex flex-col gap-2">
            <ConnectionLine c={c} small />
            {confirming === c.id ? (
              <div className="flex flex-col gap-2">
                <div className="text-2xs text-fg-2 leading-relaxed" data-remove-confirm>
                  This stops future use. It cannot undo anything the page already sent or received. The page will ask again next time it opens.
                </div>
                {/* Right-aligned, Remove rightmost (review round 1, C-10). */}
                <div className="flex items-center justify-end gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setConfirming(null)}>Never mind</Button>
                  <Button variant="danger" size="sm" onClick={() => { void remove(c.id); }}>Remove</Button>
                </div>
              </div>
            ) : (
              // Not connected yet: offer to connect, bottom right, instead of a
              // "waiting" label (review round 1, C-9). It opens the page, whose
              // approval card is the one place a connection is agreed to.
              <div className="flex justify-end">
                {c.approved
                  ? <Button variant="secondary" size="sm" onClick={() => setConfirming(c.id)}>Remove</Button>
                  : <Button variant="primary" size="sm" data-connect onClick={() => { if (page) onConnect(page.id); }}>Connect</Button>}
              </div>
            )}
          </div>
        ))}
        {list.length > 0 && <div className="text-2xs text-fg-muted leading-relaxed">Saved keys are kept under Settings › Account › Connected services.</div>}
      </div>
    </Dialog>
  );
}
