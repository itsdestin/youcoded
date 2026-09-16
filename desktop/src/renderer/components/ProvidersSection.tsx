import { useState, useEffect, useCallback } from 'react';
import { Button, FieldError, InputGroup, Select, TextInput, Toggle } from './ui';
import { isLocalEndpoint, type ProviderStatus, type ProviderConfig, type ProviderType } from '../../shared/provider-types';
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

// The provider-type options surfaced in the "Add provider" form. Custom endpoints
// map to the openai-compatible runtime type; the rest are direct-key providers.
const ADD_TYPE_OPTIONS: { value: ProviderType; label: string; needsBaseUrl?: boolean }[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'openai-compatible', label: 'Custom endpoint (OpenAI-compatible)', needsBaseUrl: true },
];

// The same list in the shape <Select> wants. Built once at module scope (not per
// render) so the dropdown's open-effect isn't handed a brand-new options array
// on every keystroke in the form beside it.
const ADD_TYPE_SELECT_OPTIONS = ADD_TYPE_OPTIONS.map((o) => ({ value: o.value as string, label: o.label }));

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
      {!embedded && (
        <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-3">Providers</h3>
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
          {listError && (
            <div className="flex items-center gap-2 px-1">
              <FieldError as="p" size="2xs" className="flex-1">
                {visibleRows.length === 0
                  ? `Couldn't load providers — ${listError}`
                  : `Couldn't refresh — ${listError}`}
              </FieldError>
              <Button variant="secondary" size="sm" onClick={() => void refresh()} className="shrink-0">
                Retry
              </Button>
            </div>
          )}

          {visibleRows.map((p) => (
            <ProviderRow key={p.id} provider={p} onChanged={refresh} />
          ))}

          {!canAdd ? null : adding ? (
            <AddProviderForm onDone={async () => { setAdding(false); await refresh(); }} onCancel={() => setAdding(false)} />
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

function ProviderRow({ provider, onChanged }: { provider: ProviderStatus; onChanged: () => Promise<void> }) {
  // Key entry: hidden until "Add key" / "Replace key". Draft + busy + inline
  // result message (with a tone) all live per-row.
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const isLocal = provider.type === 'local-engine';

  const saveKey = async () => {
    const value = keyDraft.trim();
    if (!value) return;
    setBusy(true);
    setNote(null);
    try {
      await safeProviders.setKey(provider.id, value);
      // Immediately verify the key so the user gets a real Connected/failed
      // signal instead of a silent save.
      const res = await safeProviders.test(provider.id);
      setNote({ tone: res.ok ? 'ok' : 'bad', text: res.message });
      setKeyDraft('');
      setKeyOpen(false);
      await onChanged(); // refresh hasKey/ready
    } catch (e) {
      setNote({ tone: 'bad', text: plainMessage(e, 'Could not save the key.') });
    } finally {
      setBusy(false);
    }
  };

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
      // fields (builtIn/hasKey/ready), which would get persisted. Destructure
      // them off so a clean config reaches upsert.
      const { builtIn, hasKey, ready, ...config } = provider;
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
      // Reset in finally (mirrors saveKey/toggleEnabled): a success that somehow
      // leaves this row mounted must not strand it permanently disabled.
      setBusy(false);
    }
  };

  return (
    <div className="bg-inset/50 hover:bg-inset rounded-lg px-3 py-2.5 transition-colors">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-fg font-medium truncate">{provider.label}</p>
          <p className="text-3xs text-fg-muted">{stateWord(provider)}</p>
        </div>

        {/* Enable/disable toggle — hidden for the dormant local engine (nothing
            to enable in Plan A). */}
        {/* Change 19: the hand-rolled 32x18 switch becomes the shared Toggle (one
            36x20 geometry app-wide). It also gains a real accessible name — the
            old button announced only aria-pressed with no label at all. */}
        {!isLocal && (
          <Toggle
            checked={provider.enabled}
            onChange={() => void toggleEnabled()}
            disabled={busy}
            aria-label={`Enable ${provider.label}`}
            title={provider.enabled ? 'Enabled' : 'Disabled'}
          />
        )}
      </div>

      {/* Row actions — key + test live under the header. Local engine has no
          key/test affordances (Plan B territory). */}
      {!isLocal && (
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          {!keyOpen && (
            <Button variant="secondary" size="sm" onClick={() => { setKeyOpen(true); setNote(null); }}>
              {provider.hasKey ? 'Replace key' : 'Add key'}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => void runTest()} disabled={busy}>
            {busy ? 'Testing…' : 'Test'}
          </Button>
          {/* Remove — non-builtIn rows only (local/openrouter are builtIn and
              cannot be removed). Consequence-gated inline confirm.
              danger-outline per spec change 68: "Remove" reads the same everywhere,
              because removing a provider deletes a key the user pasted in. Was a
              hand-rolled border-red-500/40 + text-red-500. */}
          {!provider.builtIn && !confirmingRemove && (
            <Button variant="danger-outline" size="sm" onClick={() => { setConfirmingRemove(true); setNote(null); }}>
              Remove
            </Button>
          )}
        </div>
      )}

      {/* Key input — revealed on Add/Replace key. */}
      {keyOpen && (
        <div className="mt-2 flex items-center gap-2">
          {/* Change 77: Save moves INSIDE the field. Cancel deliberately stays
              OUTSIDE — a field carries one action; two buttons inside it stop the
              thing reading as a field at all. */}
          <InputGroup className="flex-1">
            <InputGroup.Field
              type="password"
              autoFocus
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveKey(); }}
              placeholder="Paste API key"
              aria-label={`${provider.label} API key`}
            />
            <Button size="sm" onClick={() => void saveKey()} disabled={busy || keyDraft.trim().length === 0}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </InputGroup>
          <Button variant="secondary" onClick={() => { setKeyOpen(false); setKeyDraft(''); }} className="py-2">
            Cancel
          </Button>
        </div>
      )}

      {/* Remove confirm — plain-language consequence (the key is deleted). */}
      {confirmingRemove && (
        <div className="mt-2 space-y-2 rounded-lg bg-inset border border-edge-dim p-3">
          <p className="text-2xs text-fg-dim leading-relaxed">
            Remove {provider.label}? Its API key is deleted from this computer.
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setConfirmingRemove(false)} className="flex-1 py-2">
              Cancel
            </Button>
            {/* Filled danger for the committing action (the confirm), outline for the
                one that opens it — spec change 59. Was bg-red-500 + text-white; the
                token pair carries an engine-derived label color instead. */}
            <Button variant="danger" onClick={() => void confirmRemove()} disabled={busy} className="flex-1 py-2">
              {busy ? 'Removing…' : 'Remove'}
            </Button>
          </div>
        </div>
      )}

      {/* Inline result — green-ish tone for ok, destructive for a failure.
          Plain words only. */}
      {note && (
        <p className={`text-3xs mt-2 ${note.tone === 'ok' ? 'text-green-600' : 'text-red-500'}`}>
          {note.text}
        </p>
      )}

      {/* Local engine install/status/restart controls moved to the Local Models
          section (Plan C) — the local row just points there now. */}
      {isLocal && (
        <p className="text-3xs text-fg-muted mt-2">Managed in Local Models below.</p>
      )}
    </div>
  );
}

// ── Add-provider form ────────────────────────────────────────────────────────

function AddProviderForm({ onDone, onCancel }: { onDone: () => Promise<void>; onCancel: () => void }) {
  const [type, setType] = useState<ProviderType>('anthropic');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  // Named apiKey (not `key`) so it doesn't read as React's list `key` prop,
  // which appears just below on the <option key=…> elements.
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsBaseUrl = ADD_TYPE_OPTIONS.find((o) => o.value === type)?.needsBaseUrl === true;

  const submit = async () => {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) { setError('Give the provider a name.'); return; }
    if (needsBaseUrl && !baseUrl.trim()) { setError('A custom endpoint needs a base URL.'); return; }
    setBusy(true);
    setError(null);
    try {
      // Pass ProviderConfig fields ONLY (no id — the registry mints one and
      // returns it). baseUrl is only meaningful for custom endpoints.
      const id = await safeProviders.upsert({
        type,
        label: trimmedLabel,
        ...(needsBaseUrl ? { baseUrl: baseUrl.trim() } : {}),
        enabled: true,
      });
      // If a key was entered, save it against the freshly-minted id.
      const trimmedKey = apiKey.trim();
      if (trimmedKey) {
        await safeProviders.setKey(id, trimmedKey);
      }
      await onDone();
    } catch (e) {
      setError(plainMessage(e, 'Could not add the provider.'));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg bg-inset border border-edge-dim p-3">
      <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Add provider</h3>

      {/* Type — change 21: the native <select> is gone. A native option list is
          drawn by the OS, so a themed app dropped an OS-blue menu out of it;
          <Select> renders the list itself. The old <label htmlFor> can't point at
          a <button> trigger, so the name moves onto the control as aria-label. */}
      <div className="space-y-1">
        <p className="text-3xs text-fg-muted">Type</p>
        <Select
          options={ADD_TYPE_SELECT_OPTIONS}
          value={type}
          onChange={(v) => setType(v as ProviderType)}
          aria-label="Provider type"
        />
      </div>

      {/* Label */}
      <div className="space-y-1">
        <label htmlFor="add-provider-label" className="text-3xs text-fg-muted">Name</label>
        <TextInput
          id="add-provider-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. My OpenAI"
          className="w-full"
        />
      </div>

      {/* Base URL — custom endpoints only. */}
      {needsBaseUrl && (
        <div className="space-y-1">
          <label htmlFor="add-provider-baseurl" className="text-3xs text-fg-muted">Base URL</label>
          <TextInput
            id="add-provider-baseurl"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:11434/v1"
            className="w-full"
          />
        </div>
      )}

      {/* Optional key */}
      <div className="space-y-1">
        <label htmlFor="add-provider-key" className="text-3xs text-fg-muted">API key (optional)</label>
        <TextInput
          id="add-provider-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Paste API key"
          className="w-full"
        />
      </div>

      {error && <FieldError as="p">{error}</FieldError>}

      <div className="flex gap-2 pt-1">
        <Button variant="secondary" onClick={onCancel} className="flex-1 py-2">
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={busy} className="flex-1 py-2">
          {busy ? 'Adding…' : 'Add provider'}
        </Button>
      </div>
    </div>
  );
}
