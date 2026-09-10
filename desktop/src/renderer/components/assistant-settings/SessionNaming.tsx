import React, { useCallback, useEffect, useRef, useState } from 'react';
import ModelPicker from '../model/ModelPicker';
import { AnchorTip, Button, ErrorState, LoadingState, SegmentedTabs } from '../ui';
import { namingApi, type NamingPreferences } from './naming-api';

export default function SessionNaming() {
  const api = namingApi();
  const [value, setValue] = useState<NamingPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const savedRef = useRef<NamingPreferences | null>(null);
  const pendingRef = useRef<NamingPreferences | undefined>(undefined);
  const writingRef = useRef(false);
  const mountedRef = useRef(true);
  const [retryValue, setRetryValue] = useState<NamingPreferences | undefined>(undefined);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const load = () => {
    setError(null);
    void api?.get()
      .then((v) => { savedRef.current = v; setValue(v); })
      .catch(() => setError('Session naming settings could not be loaded.'));
  };
  useEffect(load, [api]);

  // WHY the choice is painted BEFORE the write, and nothing appears while it
  // runs: this used to set `saving`, which rendered an inline loading row and
  // disabled the fieldset, while the segmented control kept showing the OLD
  // choice until the write came back. Three visible movements for one click on
  // a control that answers in milliseconds — Destin read it as a flicker, and
  // he was right. Same optimistic-with-revert shape as StepGuardRow, whose
  // comments explain the queue: a superseding click must win over a failed
  // request rather than be discarded with it.
  const drainWrites = useCallback(async () => {
    if (writingRef.current) return;
    writingRef.current = true;
    while (pendingRef.current !== undefined) {
      const next = pendingRef.current;
      pendingRef.current = undefined;
      const previous = savedRef.current;
      setValue(next); setError(null); setRetryValue(undefined);
      try {
        await api!.set(next);
        if (!mountedRef.current) return;
        savedRef.current = next;
      } catch (e) {
        if (!mountedRef.current) return;
        if (pendingRef.current !== undefined) { setValue(previous); continue; }
        setValue(previous); setRetryValue(next);
        setError(e instanceof Error ? e.message : 'Settings were not saved. Your previous setting is kept.');
        break;
      }
    }
    writingRef.current = false;
  }, [api]);

  if (!api) return null;
  if (!value) return error ? <ErrorState message={error} onRetry={load} /> : <LoadingState what="session naming" variant="inline" />;
  const update = (patch: Partial<NamingPreferences>) => {
    pendingRef.current = { ...value, ...patch };
    void drainWrites();
  };
  // WHY: naming is a General option, so it uses the same card as FieldRow.
  return <section className="bg-inset/50 rounded-lg px-3 py-2.5 space-y-1.5" aria-label="Session naming">
    <div className="flex items-center gap-1"><h3 className="text-xs font-medium text-fg">Session naming</h3>
      <AnchorTip label="About session naming" title="Session naming"><div className="space-y-2 text-xs">
        <p>Basic is the default: it uses the opening request without AI calls and keeps that name.</p>
        <p>AI names after reply 1, refines after reply 3, then checks every 25 completed assistant replies, not tool steps. Later changes happen only when the subject changes.</p>
        <p>Conversation excerpts go to the naming model’s provider. Reviews use its plan allowance or incur API charges. If unavailable, the existing name stays; no other paid model is substituted.</p>
        <p>Names you choose stay unchanged. Off keeps existing names.</p>
      </div></AnchorTip></div>
    {error && <ErrorState message={error} onRetry={() => {
      if (retryValue) { pendingRef.current = retryValue; void drainWrites(); } else load();
    }} variant="inline" />}
    <div className="space-y-3">
    <SegmentedTabs aria-label="Automatic session naming" variant="contained" value={value.mode}
      tabs={[{ id: 'off', label: 'Off' }, { id: 'basic', label: 'Basic' }, { id: 'ai', label: 'AI' }]}
      onChange={(mode) => update({ mode: mode as NamingPreferences['mode'] })} />
    <p className="text-xs text-fg-2 leading-relaxed">{value.mode === 'off'
      ? 'Keeps existing names; you can still rename sessions.'
      : value.mode === 'basic'
        ? 'Keeps a short name from your first message. No AI needed.'
        : 'Uses AI to name the conversation and follow changes of subject.'}</p>
    {value.mode === 'ai' && <div className="space-y-3">
      <ModelSelection value={value} update={update} />
    </div>}
    </div>
  </section>;
}

// WHY: reuse the specialist picker, not a second provider/model catalog.
function ModelSelection({ value, update }: { value: NamingPreferences; update: (p: Partial<NamingPreferences>) => void }) {
  // WHY the default is the PICKER'S OWN label rather than a line above it: with
  // both, the card said "Conversation model (default)" and then, underneath,
  // "Choose a model…" — a prompt to make a choice that had already been made.
  // The control now reads as the setting it is.
  return <div className="space-y-1.5">
    <p className="text-xs font-medium text-fg">Naming model</p>
    <ModelPicker value={value.model} includeClaude={false}
      emptyLabel="Same as Conversation (default)"
      onSelect={(model) => update({ model })} />
    {value.model && <Button size="sm" variant="ghost" onClick={() => update({ model: null })}>Use conversation model instead</Button>}
  </div>;
}
