import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mutateFileUnderLock } from '../artifacts/cas-write';

const MAX_BYTES = 524_288;
const MAX_PHRASES = 2000;
const MAX_PHRASE_LENGTH = 256;

function normalizePhrases(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_PHRASES) throw new TypeError(`Vocabulary must contain at most ${MAX_PHRASES} phrases.`);
  const result: string[] = [];
  const keys = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') throw new TypeError('Every vocabulary phrase must be text.');
    // WHY: sherpa's hotword format treats newlines, slash and colon as syntax.
    // Refuse those characters rather than interpreting a user's phrase as a score.
    if (/[\u0000-\u001f\u007f/:]/.test(item)) throw new TypeError('Vocabulary phrases cannot contain control characters, / or :.');
    const phrase = item.trim();
    if (!phrase) continue;
    if (phrase.length > MAX_PHRASE_LENGTH) throw new TypeError(`A vocabulary phrase can have at most ${MAX_PHRASE_LENGTH} characters.`);
    const key = phrase.toLowerCase();
    if (keys.has(key)) continue;
    keys.add(key);
    result.push(phrase);
  }
  return result;
}

function parseSaved(raw: string): string[] {
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw new Error('The saved vocabulary file is too large.');
  const data: unknown = JSON.parse(raw);
  if (!data || typeof data !== 'object' || (data as { version?: unknown }).version !== 1) throw new Error('The saved vocabulary format is not supported.');
  return normalizePhrases((data as { phrases?: unknown }).phrases);
}

/** Per-profile, local-only vocabulary. No startup I/O or sync side effects. */
export class VoiceVocabularyStore {
  private readonly file: string;
  constructor(userDataPath: string) { this.file = path.join(userDataPath, 'voice-vocabulary.json'); }

  async read(): Promise<string[]> {
    const raw = await this.readCurrent(this.file);
    return raw === null ? [] : parseSaved(raw);
  }

  private async readCurrent(file: string): Promise<string | null> {
    let handle;
    try { handle = await fs.open(file, 'r'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try {
      // WHY: bound bytes before reading/parsing even a hand-edited or growing file.
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const buffer = Buffer.alloc(Math.min(65536, MAX_BYTES + 1 - total));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > MAX_BYTES) throw new Error('The saved vocabulary file is too large.');
        chunks.push(buffer.subarray(0, bytesRead));
      }
      // WHY: replacement decoding would turn corrupt bytes into a different
      // phrase and permit a later Save to overwrite the damaged original.
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } finally { await handle.close(); }
  }

  async save(value: unknown): Promise<void> {
    const phrases = normalizePhrases(value);
    const next = JSON.stringify({ version: 1, phrases });
    if (Buffer.byteLength(next, 'utf8') > MAX_BYTES) throw new TypeError('Vocabulary is too large to save.');
    // WHY: all windows share this file. Validate the current document inside the
    // same lock as the atomic write, so corrupt data is never silently replaced.
    const ok = await mutateFileUnderLock(this.file, (current) => {
      if (current !== null) parseSaved(current);
      return next;
    }, (target) => this.readCurrent(target));
    if (!ok) throw new Error('The vocabulary file is busy. Try saving again.');
  }
}
