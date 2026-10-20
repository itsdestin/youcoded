import { readRecoveryDraft, writeRecoveryDraft } from '../state/draft-recovery';
import { expandDraftTokens, makeDraftToken, splitComposeRefs } from './context-menu/compose-ref';

export function readComposerDraft(key: string) {
  const saved = readRecoveryDraft(key);
  if (!saved) return null;
  // WHY: display tokens refer to the vanished renderer's registry. Rebuild their
  // chips from self-contained markers, preserving the exact reference sent later.
  const text = splitComposeRefs(saved.text).map((part) =>
    part.type === 'ref' ? makeDraftToken(part.ref) : part.value).join('');
  return { ...saved, text };
}

export function writeComposerDraft(key: string, draft: { text: string; attachments: string[] }): void {
  writeRecoveryDraft(key, { ...draft, text: expandDraftTokens(draft.text) });
}
