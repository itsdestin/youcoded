import React, { useEffect, useRef, useState } from 'react';
import { Button, Dialog, TextInput, LoadingState, ErrorState } from './ui';
import { namingApi } from './assistant-settings/naming-api';

type Props = { id: string; name: string; onClose: () => void };
export default function SessionRenameDialog(props: Props) {
  // WHY the key is the id ALONE: a new identity owns a fresh draft, errors and
  // retry actions — and a conversation's identity is the conversation, not
  // whatever it is currently called.
  //
  // Keying on the name too made Save fail to close the dialog. Main sends
  // session:renamed BEFORE it returns from the rename call, so the parent has
  // already re-rendered with the new name by the time `await api.rename(...)`
  // resumes. A name in the key turns that into a remount: the in-flight save's
  // `alive` ref is cleared by the unmount, its onClose() is skipped, and a
  // fresh form mounts showing its loading state — a flicker, and the dialog
  // stays open. It also threw away whatever the user was typing whenever the
  // name changed underneath them.
  return <RenameForm key={props.id} {...props} />;
}
function RenameForm({ id, name, onClose }: Props) {
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const api = namingApi();
  const [draft, setDraft] = useState(name);
  const [manual, setManual] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<() => void>(() => () => {});
  const request = useRef(0);
  const load = () => {
    const token = ++request.current;
    setError(null);
    void api?.title(id, name).then((v) => {
      if (!alive.current || token !== request.current) return;
      setDraft(v.title); setManual(v.manual); setLoaded(true);
    }).catch(() => {
      if (!alive.current || token !== request.current) return;
      setError('The session name could not be loaded.'); setRetry(() => load);
    });
  };
  // Deliberately NOT keyed on `name`: a rename arriving from another window or
  // from automatic naming must not reload over a draft mid-edit. `name` is the
  // starting value and the read's fallback, not a reason to start again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [api, id]);
  const save = async () => {
    if (!api || saving) return;
    setSaving(true); setError(null);
    try {
      const saved = draft.trim();
      await api.rename(id, saved);
      // Tell this window's already-fetched lists. Renaming a SAVED conversation
      // touches no live session, so there is no SESSION_RENAMED broadcast to
      // ride and the Resume Browser only refetches when it opens — without
      // this the row keeps the old name until it is closed and reopened.
      // Live sessions get repainted by the broadcast as well; the projection
      // hook drops a name once the parent's own snapshot catches up.
      window.dispatchEvent(new CustomEvent('youcoded:session-renamed', { detail: { id, title: saved } }));
      if (alive.current) onClose();
    }
    catch (e) { if (alive.current) { setError(e instanceof Error ? e.message : 'The name was not saved.'); setRetry(() => () => { void save(); }); } }
    finally { if (alive.current) setSaving(false); }
  };
  // WHY: this dialog only saves protected manual names; it never clears ownership.
  return <Dialog open title="Rename session" size="panel" layer={3} onClose={() => { if (!saving) onClose(); }}>
    {error && <ErrorState message={error} onRetry={retry} variant="inline" />}
    {!loaded ? <LoadingState what="the session name" /> : <form className="space-y-3" onSubmit={(e) => {
      e.preventDefault(); if (draft.trim()) void save();
    }}>
      <label className="block text-xs text-fg font-medium" htmlFor="session-name">Session name</label>
      <TextInput id="session-name" value={draft} disabled={saving} onChange={(e) => setDraft(e.target.value)} autoFocus maxLength={160} className="w-full" />
      <p className="text-xs text-fg-muted">{manual ? 'You named this session. Automatic naming won’t replace it.' : 'Automatic naming won’t change this name.'}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" type="button" disabled={saving} onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={saving || !draft.trim()}>{saving ? 'Saving…' : 'Save name'}</Button>
      </div>
    </form>}
  </Dialog>;
}
