import { useState, useEffect, useCallback, useMemo } from 'react';
import React from 'react';
import { Button, Callout, CARD_LEVEL_1, CARD_LEVEL_2, Chip, CloseButton, ErrorState, FieldError, FoldRow, SectionLabel, TextInput, Toggle, TypeableSelect } from './ui';
import type { SelectOption } from './ui/Select';
import { isLocalEndpoint, type PendingProviderCalls, type ProviderStatus, type ProviderConfig, type ServiceEntry } from '../../shared/provider-types';
import { ScreenMark, useScreenOpen } from '../shoot-mode';

/** The provider calls designed ahead of their backend (PendingProviderCalls). */
function pendingProviderCalls(): PendingProviderCalls {
  return (window.claude?.providers ?? {}) as PendingProviderCalls;
}


/** Same address, ignoring case, a trailing "/" and a trailing "/v1" — how the
 *  catalog matches a custom endpoint to a listed service (custom-providers spec). */
function sameAddress(a: string, b: string): boolean {
  const n = (u: string) => u.trim().toLowerCase().replace(/\/+$/, '').replace(/\/v1$/, '');
  return n(a) === n(b);
}
import { invalidateProviderTypeCache } from '../hooks/use-provider-type';

/** Pass-through that forgets the provider-type cache once a write succeeded. */
function afterWrite<T>(value: T): T {
  invalidateProviderTypeCache();
  return value;
}

// WHY: this panel's error lines are where a phone's "desktop only" refusal and
// Electron's "Error invoking remote method …" wrapper both land verbatim.
import { plainMessage } from '../utils/ipc-error';

// Settings → Providers section (Phase 1 Plan A, Task 13). Lets the user add,
// test, enable/disable, and remove the model providers the NATIVE runtime binds
// sessions to (OpenRouter, direct Anthropic/OpenAI/Google keys, custom
// OpenAI-compatible endpoints). Desktop-only surface: the whole section is
// gated on window.claude.native.supported so production builds (native.supported
// false until Phase 2) render nothing.
//
// ERROR TOLERANCE: provider IPC error semantics differ by transport — desktop
// ipcMain.handle lets the registry THROW (renderer promise rejects), while the
// remote WS transport resolves with { ok:false, error }. Every provider call
// runs through the `safe*` helpers below, which tolerate BOTH: a rejected
// promise AND a resolved { ok:false, error/message } object are normalized into
// a single thrown Error the UI can render. testConnection is the ONE exception —
// it legitimately resolves { ok:false, message } for a failed test, which is a
// real result to display, not a transport error, so safeTest never throws on
// ok:false.
//
// LATENT REMOTE PARITY GAP (reconcile before Phase 2 ungates this UI on remote):
// the desktop preload passes provider IPC args POSITIONALLY
// (invoke(PROVIDER_REMOVE, id), invoke(PROVIDER_SET_KEY, id, key)) and the
// ipcMain handlers read them positionally, whereas remote-shim.ts wraps them as
// OBJECTS (invoke('provider:remove', { id }), invoke('provider:set-key', { id,
// key })). A remote WS route would need to UNWRAP those objects before calling
// the registry. In Plan A the section is gated on native.supported (hard-false
// on remote) so this path is never exercised — but when Phase 2 enables it on
// remote, align the payload shapes (and add the WS route) or remove/set-key
// silently break over the WebSocket transport.

// A resolved value shaped like a transport error ({ ok:false, ... }). Used only
// for list/upsert/remove/setKey — NOT test (see module header).
function errorMessageOf(v: unknown): string | null {
  if (v && typeof v === 'object' && (v as any).ok === false) {
    // Only trust a STRING error/message — a resolved { ok:false, error:{...} }
    // (structured error object) would otherwise stringify to "[object Object]".
    const err = (v as any).error;
    const msg = (v as any).message;
    if (typeof err === 'string') return err;
    if (typeof msg === 'string') return msg;
    return 'The provider request failed.';
  }
  return null;
}

// Await a provider IPC promise and normalize a resolved { ok:false } into a
// throw so the caller's single try/catch covers both a rejected promise and a
// resolved-error object. Rejections propagate untouched.
async function normalize<T>(p: Promise<T>): Promise<T> {
  const res = await p;
  const err = errorMessageOf(res);
  if (err) throw new Error(err);
  return res;
}

const safeProviders = {
  list: (): Promise<ProviderStatus[]> =>
    normalize(window.claude.providers.list() as Promise<ProviderStatus[]>),
  // Each write below changes which provider rows (and models) exist, and the
  // status bar / usage card resolve a session's provider through a cached
  // copy of those rows (hooks/use-provider-type.ts). Dropping the cache here,
  // on success, is what makes a just-added provider's sessions resolve
  // without an app reload (design §4.9 / review R3-4). A throw leaves the
  // cache alone: nothing changed.
  upsert: (config: Partial<ProviderConfig>): Promise<string> =>
    normalize(window.claude.providers.upsert(config)).then(afterWrite),
  remove: (id: string): Promise<unknown> =>
    normalize(window.claude.providers.remove(id)).then(afterWrite),
  setKey: (id: string, key: string): Promise<unknown> =>
    normalize(window.claude.providers.setKey(id, key)).then(afterWrite),
  // Never throws on ok:false — a failed test is a real result, not an error.
  // A genuinely rejected promise (or a transport { ok:false, error } with no
  // message) still degrades to a displayable { ok:false, message }.
  async test(id: string): Promise<{ ok: boolean; message: string }> {
    try {
      const res: any = await window.claude.providers.test(id);
      if (res && typeof res === 'object' && typeof res.message === 'string') {
        return { ok: !!res.ok, message: res.message };
      }
      // Resolved error shape without a message, or an unexpected shape.
      const err = errorMessageOf(res);
      return { ok: false, message: err ?? 'Could not test this provider.' };
    } catch (e) {
      return { ok: false, message: plainMessage(e, 'Could not test this provider.') };
    }
  },
};

// Plain-language state word for a provider row. No status glyphs (●◐○) anywhere —
// the app's standing UX rule. The local-engine row's readiness now derives from
// `ready` (true once Plan B's llama.cpp engine is installed) — the EngineCard
// below the row carries the detailed install/status controls.
function stateWord(p: ProviderStatus): string {
  if (p.type === 'local-engine') return p.ready ? 'Installed' : 'Not installed';
  // Keyless like the local engine: `ready` is "signed in" (shared/chatgpt-types.ts).
  if (p.type === 'chatgpt') return p.ready ? 'Signed in' : 'Not signed in';
  if (!p.enabled) return 'Disabled';
  if (p.ready) return 'Connected';
  // enabled && !ready && not local → the key is missing (ready already accounts
  // for keyless provider types, so a non-ready enabled provider needs a key).
  return 'Needs API key';
}

// `embedded`: rendered inside the Model Providers popup's "OpenRouter/API"
// section, which supplies its own heading + a dedicated OpenRouter connect flow
// and already gates on native support — so we drop the standalone <h3> AND hide
// BOTH the local-engine row (managed in Local Models) and the openrouter row
// (managed by the section's own Connect-to-OpenRouter control). What's left is
// the "add your own API provider" list.
// `embedded`: which GROUP of the Model Providers popup this list is inside.
// 'cloud' = the API-key providers and custom endpoints on other machines, under
// the OpenRouter card; 'local' = custom endpoints on this computer (Ollama, LM
// Studio), under Local Models. Only the cloud list offers "Add provider" — a
// local endpoint added there files itself under Local Models once saved.
export default function ProvidersSection({ embedded = false }: { embedded?: false | 'cloud' | 'local' } = {}) {
  // Gate the ENTIRE section on native support — hidden in production until
  // Phase 2 ungates. Read once (it's a static boolean, no IPC round-trip).
  const supported = window.claude?.native?.supported === true;

  const [rows, setRows] = useState<ProviderStatus[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // What the last Add produced (custom-providers U4, U7): the new row's check
  // result, and — when its address is on this computer — the note saying it now
  // lives under Local models, since this list will not show it.
  const [justAdded, setJustAdded] = useState<{ id: string; label: string; result: { tone: 'ok' | 'bad'; text: string } | null; local: boolean } | null>(null);
  // photo-only build: the Add provider form, open and empty.
  // A literal name: tests/shoot-screens.test.ts reads registrations from the source.
  // Only the cloud list offers Add provider, so only it registers.
  useScreenOpen('settings/assistant/cloud/add-provider', () => setAdding(true), undefined, embedded !== 'local');

  const refresh = useCallback(async () => {
    try {
      const list = await safeProviders.list();
      setRows(list);
      setListError(null);
    } catch (e) {
      setListError(plainMessage(e, 'Could not load your providers.'));
      setRows((prev) => prev ?? []); // stop the skeleton; show the error line
    }
  }, []);

  useEffect(() => {
    if (!supported) return;
    void refresh();
  }, [supported, refresh]);

  if (!supported) return null;

  // Embedded, the rows the popup draws as its own cards (local engine,
  // OpenRouter, ChatGPT) are hidden, and custom endpoints split by address:
  // this computer → the 'local' list, anywhere else → the 'cloud' list.
  const visibleRows = rows === null
    ? null
    : !embedded ? rows
    : rows.filter((p) => {
        if (p.type === 'local-engine' || p.type === 'openrouter' || p.type === 'chatgpt') return false;
        const local = p.type === 'openai-compatible' && isLocalEndpoint(p.baseUrl);
        return embedded === 'local' ? local : !local;
      });
  const canAdd = embedded !== 'local';

  return (
    <section>
      {/* WHY SectionLabel, not the old spaced-caps eyebrow (labels batch,
          guide: no spaced capitals — decisions H-3/L-1…L-4). */}
      {!embedded && (
        <SectionLabel className="mb-3">Providers</SectionLabel>
      )}

      {visibleRows === null ? (
        // Loading — quiet skeleton (a single muted line) rather than a spinner.
        <p className="text-2xs text-fg-muted px-1">Loading…</p>
      ) : (
        <div className="space-y-2">
          {/* Load/refresh error — shown inline with a Retry so a transient
              failure (including a HARD initial-load failure that leaves rows
              empty) doesn't strand the user: the Add-provider affordance below
              still renders, and Retry re-runs list(). */}
          {/* WHY ErrorState, not a field-error line beside a loose button (error-notices-2,
              2026-10-12): an error with something to press is the notice box with its
              button inside at the right. Same words; the button now reads "Try again". */}
          {listError && (
            <ErrorState
              variant="inline"
              message={visibleRows.length === 0
                ? `Couldn't load providers — ${listError}`
                : `Couldn't refresh — ${listError}`}
              onRetry={() => void refresh()}
            />
          )}

          {visibleRows.map((p) => (
            <ProviderRow key={p.id} provider={p} onChanged={refresh}
              // Only a failed check is carried onto the new row: a passing one would
              // repeat the "Connected" its status line already says.
              initialNote={justAdded?.id === p.id && justAdded.result?.tone === 'bad' ? justAdded.result : null} />
          ))}

          {/* WHY a note (custom-providers U7, questions#Q-4: move it, say so): an
              address on this computer files itself under Local models, so without
              this the provider seemed to vanish the moment it was added. */}
          {justAdded?.local && !adding && (
            <Callout tone="info" compact>{justAdded.label} is saved under Local models, because it runs on this computer.</Callout>
          )}

          {!canAdd ? null : adding ? (
            <ProviderForm
              onCancel={() => setAdding(false)}
              onDone={async (result, saved) => {
                setAdding(false);
                setJustAdded(saved ? { id: saved.id, label: saved.label, result, local: !!saved.baseUrl && isLocalEndpoint(saved.baseUrl) } : null);
                await refresh();
              }}
            />
          ) : (
            <Button variant="secondary" onClick={() => setAdding(true)} className="w-full py-2.5">
              Add provider
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

// ── One provider row ─────────────────────────────────────────────────────────

/** What the row's status line adds about the model list (custom-providers U5).
 *  Nothing when nothing is known — never a guessed or zero count. */
function modelsWord(p: ProviderStatus): string | null {
  if (!p.models || p.models.count <= 0) return null;
  const n = `${p.models.count} model${p.models.count === 1 ? '' : 's'}`;
  return p.models.source === 'endpoint' ? `${n}, listed by this service` : n;
}

/** Host of an address ("api.inceptionlabs.ai"), shown in brackets after a name. */
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** The one card every provider on Cloud providers is drawn as — the shape of the
 *  OpenRouter / ChatGPT / Claude Code cards: name on the top line, its buttons at the
 *  top right, a grey status line under the name, then anything that belongs to it.
 *  WHY (custom-providers-review-1#R-3, #R-5, Destin: "why is it not styled like the
 *  openrouter/provider cards?", "this card doesn't match first-level card styling"):
 *  this list used to draw its own lighter row and a plain box for the form. */
function ProviderCard({ title, status, actions, children, screen }: {
  title: React.ReactNode;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  screen?: string;
}) {
  return (
    <div className={`${CARD_LEVEL_1} px-3 py-2.5`}>
      {screen && <ScreenMark name={screen} />}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-fg font-medium truncate">{title}</p>
          {status && <p className="text-2xs mt-0.5 text-fg-muted">{status}</p>}
        </div>
        {actions && <div className="shrink-0 flex items-center gap-1.5">{actions}</div>}
      </div>
      {children && <div className="mt-2.5 space-y-2">{children}</div>}
    </div>
  );
}

function ProviderRow({ provider, onChanged, initialNote }: {
  provider: ProviderStatus;
  onChanged: () => Promise<void>;
  /** The check that ran when this provider was just added (custom-providers U4),
   *  so its result shows on the row the form closed onto. */
  initialNote?: { tone: 'ok' | 'bad'; text: string } | null;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(initialNote ?? null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  useEffect(() => { if (initialNote) setNote(initialNote); }, [initialNote]);

  const isLocal = provider.type === 'local-engine';

  const runTest = async () => {
    setBusy(true);
    setNote(null);
    const res = await safeProviders.test(provider.id);
    setNote({ tone: res.ok ? 'ok' : 'bad', text: res.message });
    setBusy(false);
  };

  const toggleEnabled = async () => {
    setBusy(true);
    setNote(null);
    try {
      // Pass ProviderConfig fields ONLY — never the derived ProviderStatus
      // fields (builtIn/hasKey/ready/health/models), which would get persisted.
      const { builtIn, hasKey, ready, health, models, ...config } = provider;
      await safeProviders.upsert({ ...config, enabled: !provider.enabled });
      await onChanged();
    } catch (e) {
      setNote({ tone: 'bad', text: plainMessage(e, 'Could not update the provider.') });
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = async () => {
    setBusy(true);
    setNote(null);
    try {
      await safeProviders.remove(provider.id);
      setConfirmingRemove(false);
      await onChanged();
    } catch (e) {
      setNote({ tone: 'bad', text: plainMessage(e, 'Could not remove the provider.') });
    } finally {
      // Reset in finally (mirrors toggleEnabled): a success that somehow
      // leaves this row mounted must not strand it permanently disabled.
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <ProviderForm
        initial={provider}
        onCancel={() => setEditing(false)}
        onDone={async (result) => { setEditing(false); setNote(result?.tone === 'bad' ? result : null); await onChanged(); }}
      />
    );
  }

  // A refused key is also read from the SAVED check (provider.health), not only this
  // row's memory: the tester closed and reopened Settings and a refused key read
  // "Connected" again (ux-review-1#U1). A fresh result on screen still wins.
  const savedRefusal = !note && provider.health?.verdict === 'rejected'
    ? { tone: 'bad' as const, text: 'The API key was rejected — check it and try again.' } : null;
  const shown = note ?? savedRefusal;
  // WHY one notice holding its fixes (guide "Status and notices": a problem is one
  // slim notice box across the card's foot, its sentence and fix buttons on one line).
  const failed = shown?.tone === 'bad';
  // A check that failed outranks the saved state: "Connected · 4 models" above
  // "The API key was rejected" contradicted itself (first mockup pass, 2026-10-20).
  const models = provider.ready && !failed ? modelsWord(provider) : null;
  const status = failed && provider.enabled ? 'Not connected' : stateWord(provider);
  // The address, in brackets after the name (review-1#R-3: "should just be shown in
  // parenthesis next to the service name, not below it").
  const title = provider.baseUrl && provider.type === 'openai-compatible'
    ? <>{provider.label} <span className="text-fg-muted font-normal">({hostOf(provider.baseUrl)})</span></>
    : provider.label;

  return (
    <ProviderCard
      title={title}
      status={<>{status}{models ? ` · ${models}` : ''}</>}
      actions={isLocal ? null : (
        // WHY Edit replaces Add key / Replace key (custom-providers U6): a wrong address
        // or name meant Remove and add again; Edit opens the same form, key included.
        // The switch sits last, at the far right, like a setting's.
        <>
          {!confirmingRemove && !failed && (
            <>
              <Button variant="secondary" size="sm" onClick={() => { setEditing(true); setNote(null); }}>
                {provider.hasKey || provider.type === 'openai-compatible' ? 'Edit' : 'Add key'}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void runTest()} disabled={busy}>
                {busy ? 'Testing…' : 'Test'}
              </Button>
              {/* danger-outline per spec change 68: removing deletes a key the user pasted in. */}
              {!provider.builtIn && (
                <Button variant="danger-outline" size="sm" onClick={() => { setConfirmingRemove(true); setNote(null); }}>
                  Remove
                </Button>
              )}
            </>
          )}
          <Toggle
            checked={provider.enabled}
            onChange={() => void toggleEnabled()}
            disabled={busy}
            aria-label={`Enable ${provider.label}`}
            title={provider.enabled ? 'Enabled' : 'Disabled'}
          />
        </>
      )}
    >
      {failed && shown && (
        <Callout tone="danger" compact actions={<>
          <Button variant="secondary" size="sm" onClick={() => { setEditing(true); setNote(null); }}>Edit</Button>
          <Button size="sm" onClick={() => void runTest()} disabled={busy}>{busy ? 'Testing…' : 'Try again'}</Button>
        </>}>{shown.text}</Callout>
      )}

      {/* Remove confirm — plain-language consequence (the key is deleted). */}
      {confirmingRemove && (
        <div className={`${CARD_LEVEL_2} space-y-2 rounded-lg p-3`}>
          <p className="text-2xs text-fg-dim leading-relaxed">
            Remove {provider.label}? Its API key is deleted from this computer.
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setConfirmingRemove(false)} className="flex-1 py-2">
              Cancel
            </Button>
            {/* Filled danger for the committing action (spec change 59). */}
            <Button variant="danger" onClick={() => void confirmRemove()} disabled={busy} className="flex-1 py-2">
              {busy ? 'Removing…' : 'Remove'}
            </Button>
          </div>
        </div>
      )}

      {/* A passing manual Test is plain words (guide: no coloured body text). */}
      {note && !failed && <p className="text-2xs text-fg-muted">{note.text}</p>}

      {isLocal && <p className="text-2xs text-fg-muted">Managed in Local models below.</p>}
    </ProviderCard>
  );
}

// ── Add / edit a provider ────────────────────────────────────────────────────

// The service a form row stands for. Direct-key providers keep their own type;
// every listed service and "Other address…" is an OpenAI-compatible endpoint.
type Choice =
  | { kind: 'direct'; type: 'anthropic' | 'openai' | 'google'; label: string }
  | { kind: 'service'; service: ServiceEntry }
  | { kind: 'other' };

const DIRECT: { type: 'anthropic' | 'openai' | 'google'; label: string; host: string }[] = [
  { type: 'anthropic', label: 'Anthropic', host: 'api.anthropic.com' },
  { type: 'openai', label: 'OpenAI', host: 'api.openai.com' },
  { type: 'google', label: 'Google', host: 'generativelanguage.googleapis.com' },
];
const OTHER_VALUE = 'other';
const OTHER_LABEL = 'Other address…';

/** The services Add provider searches. Absent on a build whose backend has not
 *  shipped the list yet — the form then offers the direct providers and "Other
 *  address…", exactly what it could do before. */
function useServices(): ServiceEntry[] {
  const [list, setList] = useState<ServiceEntry[]>([]);
  useEffect(() => {
    let live = true;
    const load = pendingProviderCalls().services;
    if (!load) return;
    load().then((rows) => { if (live && Array.isArray(rows)) setList(rows); }).catch(() => { /* the direct choices still work */ });
    return () => { live = false; };
  }, []);
  return list;
}

/** "1M", "260K", "32K" — a context size the way people say it. */
function contextWord(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1000)}K`;
}
/** "$0.10" — per-million prices with the cents people expect. */
const usd = (n: number) => `$${n < 1 ? n.toFixed(2) : +n.toFixed(2)}`;

/** The picked service's models, as a fold of cards (review-1#R-3: "the list of models
 *  should be its own section/dropdown with cards that appears after service is
 *  selected"). Closed by default so the form stays short; every fact is a fact chip,
 *  and a fact the catalog doesn't publish is simply not shown. */
function ServiceModels({ service }: { service: ServiceEntry }) {
  const models = service.models ?? [];
  if (models.length === 0) return null;
  return (
    // review-2#R2-1: "Models 4" → a phrase that says what the number counts.
    <FoldRow title={`${service.modelCount} supported model${service.modelCount === 1 ? '' : 's'}`}
      description="What this service offers. You pick one in the chat's model menu.">
      <div className="space-y-1.5">
        {models.map((m) => (
          <div key={m.id} className={`${CARD_LEVEL_2} rounded-lg px-2.5 py-2`}>
            <p className="text-xs text-fg">{m.label}</p>
            <div className="mt-1 flex gap-1 overflow-x-auto scroll-mask-x">
              {m.contextLength ? <Chip>{contextWord(m.contextLength)} context</Chip> : null}
              {m.priceIn != null && m.priceOut != null ? <Chip>{usd(m.priceIn)} in · {usd(m.priceOut)} out per 1M</Chip> : null}
              {m.tools === false ? <Chip>No tools</Chip> : null}
            </div>
          </div>
        ))}
      </div>
    </FoldRow>
  );
}

/** The one form for adding a provider AND editing one (custom-providers U1–U4, U6).
 *  WHY one form: Edit is the same fields with the provider's values in them, so
 *  the two can never drift into different wording or validation. */
function ProviderForm({ initial, onDone, onCancel }: {
  initial?: ProviderStatus;
  /** Called after a save. `result` is the connection check (U4), shown on the row. */
  onDone: (result: { tone: 'ok' | 'bad'; text: string } | null, saved?: { id: string; label: string; baseUrl?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const services = useServices();
  const editing = initial !== undefined;

  // Options in the order people look for them: the three big direct providers,
  // then every listed service A–Z, then the way to type an address yourself.
  const options = useMemo<SelectOption[]>(() => [
    // review-2#R2-1 ("the switcher itself should have the parenthetical next to each
    // name"): every listed provider carries its address in its own row.
    ...DIRECT.map((d) => ({ value: `direct:${d.type}`, label: `${d.label} (${d.host})` })),
    ...services.map((s) => ({ value: `service:${s.id}`, label: `${s.label} (${hostOf(s.baseUrl)})` })),
    { value: OTHER_VALUE, label: OTHER_LABEL },
  ], [services]);

  const choiceFor = useCallback((value: string): Choice | null => {
    if (value === OTHER_VALUE) return { kind: 'other' };
    if (value.startsWith('direct:')) {
      const d = DIRECT.find((x) => `direct:${x.type}` === value);
      return d ? { kind: 'direct', type: d.type, label: d.label } : null;
    }
    const s = services.find((x) => `service:${x.id}` === value);
    return s ? { kind: 'service', service: s } : null;
  }, [services]);

  // Editing opens on what the provider is: its direct type, or the listed service
  // its address matches, or "Other address…".
  const initialValue = (): string => {
    if (!initial) return '';
    if (initial.type === 'anthropic' || initial.type === 'openai' || initial.type === 'google') return `direct:${initial.type}`;
    return OTHER_VALUE;
  };
  const [value, setValue] = useState(initialValue);
  useEffect(() => {
    // Once the list arrives, an edited provider whose address is a listed service
    // shows as that service rather than "Other address…".
    if (!initial?.baseUrl || value !== OTHER_VALUE) return;
    const s = services.find((x) => sameAddress(x.baseUrl, initial.baseUrl!));
    if (s) setValue(`service:${s.id}`);
  }, [services]); // eslint-disable-line react-hooks/exhaustive-deps

  const choice = value ? choiceFor(value) : null;
  const [label, setLabel] = useState(initial?.label ?? '');
  const [labelTouched, setLabelTouched] = useState(editing);
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // WHY the key is required for every service except a typed address (U3): a
  // direct provider or a listed service cannot answer without one, while a server
  // on your own network (Ollama, LM Studio, a company proxy) often has none. When
  // editing, an empty box keeps the saved key.
  const keyRequired = choice !== null && choice.kind !== 'other' && !(editing && initial?.hasKey);

  const pick = (next: string) => {
    const c = choiceFor(next);
    if (!c) return false;
    setValue(next);
    setError(null);
    // U1 + review-1#R-3 ("name should default to service + API Key"): the name fills
    // itself from what was picked, until the user types one.
    if (!labelTouched) setLabel(c.kind === 'direct' ? `${c.label} API Key` : c.kind === 'service' ? `${c.service.label} API Key` : '');
    return true;
  };

  const submit = async () => {
    if (!choice) { setError('Choose a provider.'); return; }
    const address = choice.kind === 'service' ? choice.service.baseUrl : choice.kind === 'other' ? baseUrl.trim() : undefined;
    if (choice.kind === 'other' && !address) { setError('Type the service’s address.'); return; }
    const name = label.trim() || (choice.kind === 'other' && address ? hostOf(address) : '');
    if (!name) { setError('Give the provider a name.'); return; }
    const key = apiKey.trim();
    if (keyRequired && !key) { setError('Paste your API key.'); return; }
    setBusy(true);
    setError(null);
    try {
      // Pass ProviderConfig fields ONLY (no derived status fields). Editing keeps
      // the provider's id; adding lets the registry mint one.
      const id = await safeProviders.upsert({
        ...(initial ? { id: initial.id } : {}),
        type: choice.kind === 'direct' ? choice.type : 'openai-compatible',
        label: name,
        ...(address ? { baseUrl: address } : {}),
        enabled: initial?.enabled ?? true,
      });
      if (key) await safeProviders.setKey(id, key);
      // U4 (custom-providers-questions#Q-5: save, then show the problem): the
      // check runs once the provider is saved, and its answer goes to the row the
      // form closes onto. A failure never unsaves what the user typed.
      const res = await safeProviders.test(id);
      await onDone({ tone: res.ok ? 'ok' : 'bad', text: res.message }, { id, label: name, baseUrl: address });
    } catch (e) {
      setError(plainMessage(e, editing ? 'Could not save the provider.' : 'Could not add the provider.'));
      setBusy(false);
    }
  };

  return (
    <ProviderCard
      screen={editing ? undefined : 'settings/assistant/cloud/add-provider'}
      title={editing ? `Edit ${initial!.label}` : 'Add provider'}
      // WHY a ✕ instead of an always-present Cancel (review-1#R-1: "is the cancel
      // button always present? that would be odd"): closing is the card's own action,
      // top right like every popup; Cancel / Add appear only once there is something
      // to add.
      actions={<CloseButton size="icon-sm" label={editing ? 'Stop editing' : 'Close Add provider'} onClick={onCancel} />}
    >
      {/* Service — WHY a search, not a four-item type list (custom-providers U2,
          questions#Q-1): picking a service by name fills in its address. */}
      {/* review-2#R2-1: the line above the box is just its name, "Provider"; what was
          picked (and its address) reads in the box itself. WHY grouped like Name and
          API key below (review-3#R3-1, "the spacing of the provider header is all messed
          up"): a loose label pulled onto the box with a negative margin sat closer to the
          box than its siblings' labels and crowded the card title above it. */}
      <div className="space-y-1">
        <p className="text-2xs text-fg-muted">Provider</p>
        <TypeableSelect
          options={options}
          value={value}
          onCommit={pick}
          filter={(o, q) => o.value === OTHER_VALUE || o.label.toLowerCase().includes(q)}
          placeholder="Search, for example DeepSeek or Inception"
          aria-label="Provider"
          disabled={busy}
        />
      </div>

      {choice?.kind === 'service' && <ServiceModels service={choice.service} />}

      {choice?.kind === 'other' && (
        <div className="space-y-1">
          <label htmlFor="add-provider-baseurl" className="text-2xs text-fg-muted">Address</label>
          <TextInput
            id="add-provider-baseurl"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            className="w-full"
          />
        </div>
      )}

      {choice && (
        <>
          <div className="space-y-1">
            <label htmlFor="add-provider-label" className="text-2xs text-fg-muted">Name</label>
            <TextInput
              id="add-provider-label"
              value={label}
              onChange={(e) => { setLabel(e.target.value); setLabelTouched(true); }}
              placeholder={choice.kind === 'other' ? 'e.g. Work server' : undefined}
              className="w-full"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="add-provider-key" className="text-2xs text-fg-muted">
              {keyRequired ? 'API key' : 'API key (optional)'}
            </label>
            <TextInput
              id="add-provider-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
              placeholder={editing && initial?.hasKey ? 'Leave empty to keep the saved key' : 'Paste API key'}
              className="w-full"
            />
          </div>

          {error && <FieldError as="p">{error}</FieldError>}

          {/* Guide "Buttons": a step's row ends with one filled button, outlined way
              back beside it, both at the right. */}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
            <Button size="sm" onClick={() => void submit()} disabled={busy}>
              {busy ? 'Checking…' : editing ? 'Save' : 'Add provider'}
            </Button>
          </div>
        </>
      )}
    </ProviderCard>
  );
}
