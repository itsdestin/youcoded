// WHY: detached windows receive only bounded, plain-text local composer state;
// never pass an arbitrary renderer object through an ownership notification.
export type DetachedHandoffDraft = { text: string; attachments: string[] };

export function validateHandoffDraft(value: unknown): DetachedHandoffDraft | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<DetachedHandoffDraft>;
  if (typeof candidate.text !== 'string' || candidate.text.length > 1_000_000 ||
      !Array.isArray(candidate.attachments) || candidate.attachments.length > 100 ||
      !candidate.attachments.every((path) => typeof path === 'string' && path.length > 0 &&
        path.length <= 4096 && !path.includes('\0'))) return null;
  return { text: candidate.text, attachments: [...candidate.attachments] };
}
