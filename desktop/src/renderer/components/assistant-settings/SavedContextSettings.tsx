import React, { useEffect, useRef, useState } from 'react';
import type { ContextPreferences } from '../../../shared/context-preferences';
import ContextSettings from './ContextSettings';
import { ErrorState, LoadingState } from '../ui';
import { plainMessage } from '../../utils/ipc-error';

type Patch = Partial<ContextPreferences>;
const providers = ['openrouter', 'chatgpt'] as const;
// WHY module-scoped: a closed panel can still be saving accepted clicks. A new
// mount must wait for that whole queue before reading, otherwise it paints a
// stale choice forever with no way to select that already-highlighted value.
let outstandingSaves: Promise<void> = Promise.resolve();

export default function SavedContextSettings() {
  const [value, setValue] = useState<ContextPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const lifetime = useRef({ active: false });
  const pending = useRef<Patch>({});
  const failed = useRef<Patch>({});
  const writing = useRef(false);

  useEffect(() => {
    const current = { active: true };
    lifetime.current = current;
    setError(null);
    void (async () => {
      await outstandingSaves;
      if (!current.active) return;
      const result = await window.claude.native.getContextPreferences();
      if (current.active) setValue(result);
    })().catch((err: unknown) => {
      if (current.active) setError(`Could not load context preferences: ${plainMessage(err)}`);
    });
    return () => { current.active = false; };
  }, [loadAttempt]);

  async function drain() {
    if (writing.current || !lifetime.current.active) return;
    const current = lifetime.current;
    writing.current = true;
    try {
      // WHY a single serialized writer plus per-provider patches: a late reply
      // cannot erase a newer click, nor overwrite another window's sibling setting.
      // Already accepted clicks still save when the panel closes. The lifetime
      // fences React updates, not this queue; closing must not lose a second toggle.
      while (Object.keys(pending.current).length) {
        const patch = pending.current;
        pending.current = {};
        try {
          const committed = await window.claude.native.setContextPreferences(patch);
          for (const provider of providers) {
            if (provider in patch) delete failed.current[provider];
          }
          if (current.active) {
            setValue({ ...committed, ...failed.current, ...pending.current });
            if (!Object.keys(failed.current).length) setError(null);
          }
        } catch (err: unknown) {
          // WHY keep unsaved intent separately: later input for the other provider
          // may succeed, but that must not hide this failure or lose its Retry.
          for (const provider of providers) {
            if (provider in patch && !(provider in pending.current)) failed.current[provider] = patch[provider];
          }
          if (current.active && Object.keys(failed.current).length) setError(`Could not save context preferences: ${plainMessage(err)}`);
        }
      }
    } finally {
      writing.current = false;
    }
  }

  function savePending() {
    // drain handles save failures and retains Retry intent. Include any previous
    // mount's queue; a no-op drain during an in-flight write must not erase it.
    outstandingSaves = Promise.all([outstandingSaves, drain()]).then(() => undefined);
  }

  function change(next: ContextPreferences) {
    if (!value || !lifetime.current.active) return;
    const patch: Patch = {};
    for (const provider of providers) {
      if (next[provider] !== value[provider]) {
        patch[provider] = next[provider];
        delete failed.current[provider];
      }
    }
    pending.current = { ...pending.current, ...patch };
    setValue(previous => previous && ({ ...previous, ...patch }));
    if (!Object.keys(failed.current).length) setError(null);
    savePending();
  }

  function retry() {
    if (!value) { setLoadAttempt(attempt => attempt + 1); return; }
    pending.current = { ...failed.current, ...pending.current };
    savePending();
  }

  return <>
    {value ? <ContextSettings value={value} onChange={change} /> : !error && <LoadingState what="context preferences" variant="inline" />}
    {error && <ErrorState message={error} onRetry={retry} variant="inline" />}
  </>;
}
