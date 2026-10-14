import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChunkedReveal } from '../../hooks/use-chunked-reveal';
import { CARD_LEVEL_1, Dialog, ErrorState, InputGroup, LoadingState, SectionLabel } from '../ui';
import { ChipAction } from '../tags/TagChip';
import { plainMessage } from '../../utils/ipc-error';
import type { VoiceVocabularyBridge } from '../../../shared/voice-types';

// WHY: stable remove props let typing in Add leave every existing chip idle.
const VocabularyChip = React.memo(function VocabularyChip({ phrase, disabled, onRemove }: {
  phrase: string; disabled: boolean; onRemove: (phrase: string) => void;
}) {
  // WHY the shared remove disc (final review F52): a "×" letter in a ghost button was a
  // hand-made remove beside the app's one (the tag pills' ChipAction, same aria name).
  // WHY a tag-sized pill (vocab-chips-1#V-4, Destin picked "Tag chip size and ×"): the same
  // height, roundness, 12px words and remove disc as a tag on a session (SessionDetails
  // AppliedPill), in the plain panel colours — a word has no colour of its own.
  return <span className="max-w-full shrink-0 inline-flex items-center gap-1.5 pl-2.5 pr-2 h-6.5 rounded-full border border-edge bg-inset text-xs leading-none text-fg">
    <span className="break-all min-w-0">{phrase}</span>
    <ChipAction kind="remove" label={phrase} size="md" disabled={disabled} onClick={() => onRemove(phrase)} />
  </span>;
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
  const [saved, setSaved] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
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

  // WHY each change saves at once (vocab-chips-1, proposal: like a tag added to a session or a
  // quick chip edited): no Save button and no "unsaved changes" line; closing never loses a word.
  // A failed save keeps the list as shown and offers Try again, which saves it again.
  const commit = async (next: string[]) => {
    setPhrases(next);
    setSaving(true);
    setError(null);
    try {
      await bridge.save(next);
      setSaved(next);
    } catch (err) {
      setError({ action: 'save', detail: plainMessage(err) });
    } finally {
      setSaving(false);
    }
  };
  const phrasesRef = useRef(phrases);
  phrasesRef.current = phrases;
  const remove = useCallback((phrase: string) => { void commit(phrasesRef.current.filter((item) => item !== phrase)); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bridge]);
  const add = () => {
    if (!candidate || duplicate || saving) return;
    setDraft('');
    void commit([...phrases, candidate]);
  };
  const save = () => commit(phrases);

  return <Dialog screen="chat/voice/vocabulary" open onClose={onClose} size="panel" title="Voice vocabulary">
    {/* WHY one labelled card shaped like Tags (vocab-chips-1, Destin: "propose visual redesigns for
        voice/quick chips that better align with tags"): the words as tag-sized pills, then "Add a
        word" over one box that adds on Enter (vocab-chips-2#D-2, Destin picked "Enter only"; the
        box says so), and the explanation as grey words under the box (popup-cards-3#B-1). Saves
        as you go (#D-1). */}
    <div className="space-y-4">
      {saved === null && !error && <LoadingState what="vocabulary" variant="inline" />}
      {saved !== null && <section>
        <SectionLabel className="mb-2">Your words</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3 space-y-3`}>
        <div ref={listRef} role="region" aria-label="Vocabulary phrases" className="max-h-48 overflow-y-auto">
          <div className="flex flex-wrap gap-1.5">
            {visible.map((phrase) => <VocabularyChip key={phrase} phrase={phrase} disabled={saving} onRemove={remove} />)}
            {phrases.length === 0 && <span className="text-xs text-fg-muted">No words yet.</span>}
          </div>
          {hasMore && <div ref={sentinelRef} className="h-1" aria-hidden="true" />}
        </div>
        <div className="space-y-2">
          <label className="block text-xs font-medium text-fg-2" htmlFor="voice-vocabulary">Add a word</label>
          <InputGroup size="sm">
            <InputGroup.Field id="voice-vocabulary" value={draft} disabled={saving}
              placeholder="Type a word or phrase, then press Enter" spellCheck={false} aria-describedby="voice-vocabulary-hint"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); add(); } }} />
          </InputGroup>
          <p id="voice-vocabulary-hint" className="text-xs text-fg-muted leading-relaxed">
            {duplicate ? 'Already in your vocabulary.'
              : 'Names, unusual words or phrases you say often: hints for Parakeet, not text replacements. They stay on this computer and apply to your next recording.'}
          </p>
        </div>
        </div>
      </section>}
      {/* WHY a fixed sentence with the raw words folded under Details (final review, guide
          "Status and notices": machine words only under a Details fold, never the sentence —
          the Contribute failure's and Git review's shape): the bridge's message is for a bug
          report. The sentence says what happened and what still holds, guessing no cause. */}
      {error && <div className="space-y-2">
        <ErrorState busy={saving}
          message={error.action === 'load'
            ? 'Your vocabulary couldn’t be loaded.'
            : 'Your changes couldn’t be saved. They’re still here, so you can try again.'}
          onRetry={() => { if (error.action === 'load') setLoadAttempt((n) => n + 1); else void save(); }}
          details={error.detail} /* popup-cards-8#Q-1: Details sits inside the error box, everywhere */ />
      </div>}
    </div>
  </Dialog>;
}
