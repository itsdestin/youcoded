import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChunkedReveal } from '../../hooks/use-chunked-reveal';
import { Badge, Button, Dialog, ErrorState, LoadingState, TextInput } from '../ui';
import { plainMessage } from '../../utils/ipc-error';
import type { VoiceVocabularyBridge } from '../../../shared/voice-types';

// WHY: stable remove props let typing in Add leave every existing chip idle.
const VocabularyChip = React.memo(function VocabularyChip({ phrase, disabled, onRemove }: {
  phrase: string; disabled: boolean; onRemove: (phrase: string) => void;
}) {
  return <Badge className="max-w-full">
    <span className="text-xs break-all min-w-0">{phrase}</span>
    <Button variant="ghost" size="sm" disabled={disabled} aria-label={`Remove ${phrase}`} onClick={() => onRemove(phrase)}>×</Button>
  </Badge>;
});

export default function VocabularyPanel({ bridge, onClose }: { bridge: VoiceVocabularyBridge; onClose: () => void }) {
  // WHY: keystrokes stay local; only the bounded chip region grows on scroll.
  const [draft, setDraft] = useState('');
  const [phrases, setPhrases] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const { visible, hasMore, sentinelRef } = useChunkedReveal(phrases, { resetKey: 'vocabulary', rootRef: listRef });
  const phraseKeys = useMemo(() => new Set(phrases.map((phrase) => phrase.toLowerCase())), [phrases]);
  const candidate = draft.trim();
  const duplicate = phraseKeys.has(candidate.toLowerCase());
  const remove = useCallback((phrase: string) => setPhrases((current) => current.filter((item) => item !== phrase)), []);
  const add = () => {
    if (!candidate || duplicate || saving) return;
    setPhrases((current) => [...current, candidate]);
    setDraft('');
  };
  const [saved, setSaved] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<{ action: 'load' | 'save'; detail: string } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    bridge.get().then((phrases) => {
      if (!alive) return;
      setSaved(phrases);
      setPhrases(phrases);
    }).catch((err: unknown) => {
      if (alive) setError({ action: 'load', detail: plainMessage(err) });
    });
    return () => { alive = false; };
  }, [bridge, loadAttempt]);

  const dirty = useMemo(() => saved !== null && JSON.stringify(phrases) !== JSON.stringify(saved), [phrases, saved]);
  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      await bridge.save(phrases);
      setSaved(phrases);
      setPhrases(phrases);
      setConfirmed(true);
    } catch (err) {
      setError({ action: 'save', detail: plainMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  return <Dialog screen="chat/voice/vocabulary" open onClose={onClose} size="panel" title="Voice vocabulary">
    <div className="space-y-3">
      <p className="text-sm text-fg-2">Add names, unusual words or phrases you say often. These are hints for Parakeet, not text replacements.</p>
      {saved === null && !error && <LoadingState what="vocabulary" variant="inline" />}
      {saved !== null && <>
        <div ref={listRef} role="region" aria-label="Vocabulary phrases" className="max-h-48 overflow-y-auto">
          <div className="flex flex-wrap gap-2">
            {visible.map((phrase) => <VocabularyChip key={phrase} phrase={phrase} disabled={saving} onRemove={remove} />)}
          </div>
          {hasMore && <div ref={sentinelRef} className="h-1" aria-hidden="true" />}
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-fg" htmlFor="voice-vocabulary">Add word or phrase</label>
          <div className="flex gap-2">
            <TextInput id="voice-vocabulary" className="min-w-0 flex-1 w-full" value={draft} disabled={saving}
              placeholder="e.g. YouCoded" spellCheck={false} aria-describedby="voice-vocabulary-hint"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); add(); } }} />
            <Button variant="secondary" disabled={!candidate || duplicate || saving} onClick={add}>Add</Button>
          </div>
          <p id="voice-vocabulary-hint" className="text-2xs text-fg-muted">{duplicate ? 'Already in your vocabulary.' : 'Press Enter to add. Use × to remove a phrase.'}</p>
        </div>
        <p role="status" aria-live="polite" className="text-2xs text-fg-muted">
          {phrases.length} {phrases.length === 1 ? 'phrase' : 'phrases'} · {saving ? 'Saving…' : dirty ? 'Unsaved changes' : confirmed ? 'Saved' : 'No unsaved changes'}
        </p>
      </>}
      {error && <ErrorState message={error.detail} busy={saving}
        onRetry={() => { if (error.action === 'load') setLoadAttempt((n) => n + 1); else void save(); }} />}
      <p className="text-2xs text-fg-muted">Vocabulary stays on this computer. Changes apply to your next recording.</p>
      {saved !== null && !error && <div className="flex justify-end">
        <Button variant="primary" disabled={!dirty || saving} onClick={() => { void save(); }}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>}
    </div>
  </Dialog>;
}
