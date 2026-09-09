import React, { useEffect, useState } from 'react';
import ModelPicker from '../model/ModelPicker';
import { AnchorTip, Button, ErrorState, LoadingState, SegmentedTabs } from '../ui';
import { namingApi, type NamingPreferences } from './naming-api';

export default function SessionNaming() {
  const api = namingApi();
  const [value, setValue] = useState<NamingPreferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<NamingPreferences | null>(null);
  const load = () => { setError(null); void api?.get().then(setValue).catch(() => setError('Session naming settings could not be loaded.')); };
  useEffect(load, [api]);
  if (!api) return null;
  if (!value) return error ? <ErrorState message={error} onRetry={load} /> : <LoadingState what="session naming" variant="inline" />;
  // WHY: serialize preview writes and keep the saved selection on refusal.
  const commit = async (next: NamingPreferences) => {
    if (saving) return;
    setSaving(true); setError(null); setPending(next);
    try { await api.set(next); setValue(next); setPending(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Settings were not saved.'); }
    finally { setSaving(false); }
  };
  const update = (patch: Partial<NamingPreferences>) => { void commit({ ...value, ...patch }); };
  // WHY: naming is a General option, so it uses the same card as FieldRow.
  return <section className="bg-inset/50 rounded-lg px-3 py-2.5 space-y-1.5" aria-label="Session naming">
    <div className="flex items-center gap-1"><h3 className="text-xs font-medium text-fg">Session naming</h3>
      <AnchorTip label="About session naming" title="Session naming"><div className="space-y-2 text-xs">
        <p>Basic is the default: it uses the opening request without AI calls and keeps that name.</p>
        <p>AI names after reply 1, refines after reply 3, then checks every 25 completed assistant replies, not tool steps. Later changes happen only when the subject changes.</p>
        <p>Conversation excerpts go to the naming model’s provider. Reviews use its plan allowance or incur API charges. If unavailable, the existing name stays; no other paid model is substituted.</p>
        <p>Names you choose stay unchanged. Off keeps existing names.</p>
      </div></AnchorTip></div>
    {error && <ErrorState message={error} onRetry={() => { if (pending) void commit(pending); }} variant="inline" />}
    {saving && <LoadingState what="your naming settings" variant="inline" />}
    <fieldset disabled={saving} className="space-y-3">
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
    </fieldset>
  </section>;
}

// WHY: reuse the specialist picker, not a second provider/model catalog.
function ModelSelection({ value, update }: { value: NamingPreferences; update: (p: Partial<NamingPreferences>) => void }) {
  return <div className="space-y-1.5">
    <p className="text-xs font-medium text-fg">Naming model</p>
    {!value.model && <p className="text-xs text-fg-2">Conversation model (default)</p>}
    <ModelPicker value={value.model} includeClaude={false} onSelect={(model) => update({ model })} />
    {value.model && <Button size="sm" variant="ghost" onClick={() => update({ model: null })}>Use conversation model instead</Button>}
  </div>;
}
