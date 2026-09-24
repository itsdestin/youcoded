// OpenRouterHealth — what the app last learned about THIS profile's OpenRouter
// key by asking OpenRouter (connection-trust design, docs/active/specs/
// 2026-08-31-openrouter-connection-trust-design.md §3.1–3.2).
//
// WHY this exists: "Connected" used to mean "a key is saved". A dead key read
// Connected while every message failed (Destin, 2026-08-31), because nothing
// ever asked OpenRouter and nothing a chat failure learned reached Settings.
//
// Deliberately free of Electron: the caller passes the folder, fetch and the
// clock, so the planned Android Node host can run this file unchanged.
//
// Stored per PROFILE (next to native-secrets.json), never in the shared
// ~/.youcoded/providers.json: the key it describes is per-profile, so a record
// there would let one app copy's check describe another copy's key.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderHealth } from '../../shared/provider-types';

const FILE = 'provider-health.json';
const CHECK_TIMEOUT_MS = 10_000;
/** A check of a key not yet saved is adopted by the save that follows it
 *  (the Connect dialog checks, then saves) if it is this fresh. */
const PENDING_TTL_MS = 60_000;

export type HealthReason = NonNullable<ProviderHealth['reason']>;

/** What a check returns to Test / Connect / first-run. `ok` is true only for
 *  a verified key, so every existing caller keeps its meaning. */
export interface KeyCheckResult {
  ok: boolean;
  message: string;
  verdict: ProviderHealth['verdict'];
  reason?: HealthReason;
  expiresAt?: string;
}

/** The sentence for each outcome. Plain words: these show on the card and in
 *  the Connect dialog exactly as written. */
const MESSAGES: Record<HealthReason | 'verified' | 'unchecked', string> = {
  verified: 'Connected.',
  'openrouter-key-rejected': "OpenRouter didn't accept this key. Check that you copied all of it.",
  'openrouter-key-expired': 'This OpenRouter key has expired. Create a new key on OpenRouter.',
  'openrouter-forbidden': 'OpenRouter refused this key.',
  'openrouter-wrong-key-type': "That's an account-management key, which can't run models. Create a regular API key on OpenRouter.",
  unchecked: "OpenRouter couldn't be reached to check the key.",
};

/** Thrown by the chat-turn fetch wrapper for an OpenRouter refusal. Carries an
 *  errorCode the chat's error card reads to pick its button.
 *  WHY no statusCode / status / code fields: the AI SDK and the harness's
 *  withRetry key on those, and describeProviderError appends "(provider error
 *  N)" when it sees one — the same reason ChatGPT's errors are plain
 *  (chatgpt-oauth.ts plainError). */
export class ProviderAccountError extends Error {
  constructor(message: string, readonly errorCode: string, readonly providerMessage?: string) {
    super(message);
    this.name = 'ProviderAccountError';
  }
}

interface StoredRecord { fingerprint: string; health: ProviderHealth }
interface HealthFile { v: 1; records: Record<string, StoredRecord> }

/** First 16 hex chars of SHA-256 — enough to tell two keys apart, never
 *  enough to recover one. */
function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export interface OpenRouterHealthDeps {
  /** The profile's userData folder. */
  dir: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class OpenRouterHealth {
  private readonly file: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private records: Record<string, StoredRecord> | null = null;
  /** Checks of keys not yet saved, by fingerprint (see PENDING_TTL_MS). */
  private pending = new Map<string, { health: ProviderHealth; at: number }>();

  constructor(deps: OpenRouterHealthDeps) {
    this.file = join(deps.dir, FILE);
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  private load(): Record<string, StoredRecord> {
    if (this.records) return this.records;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as HealthFile;
      this.records = parsed?.v === 1 && parsed.records && typeof parsed.records === 'object' ? parsed.records : {};
    } catch {
      // Missing or unreadable: no verdicts yet. The next check rewrites it.
      this.records = {};
    }
    return this.records;
  }

  private save(): void {
    const records = this.load();
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      // Write-then-rename so a crash mid-write never leaves half a file.
      // Per-process name (ast-grep atomic-tmp-name-per-process).
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, records } satisfies HealthFile));
      renameSync(tmp, this.file);
    } catch {
      // A verdict that could not be saved is still correct in memory for this
      // run; losing it only means the next launch checks again.
    }
  }

  /** The stored verdict for a key pointer. Never decrypts anything — reads
   *  must stay cheap and safe (the provider list and launch check call it). */
  get(ref: string | undefined): ProviderHealth | undefined {
    if (!ref) return undefined;
    return this.load()[ref]?.health;
  }

  /** Write a verdict for the key saved under `ref`. */
  record(ref: string, key: string, health: ProviderHealth): void {
    this.load()[ref] = { fingerprint: keyFingerprint(key), health };
    this.save();
  }

  /** Called by setKey: forget the old key's verdict, and adopt a check of the
   *  NEW key made moments earlier (the Connect dialog checks before saving),
   *  so the card does not fall back to "Checking…" right after a good save. */
  adoptOrClear(ref: string, key: string): void {
    const fp = keyFingerprint(key);
    const hit = this.pending.get(fp);
    this.pending.delete(fp);
    if (hit && this.now() - hit.at <= PENDING_TTL_MS) {
      this.load()[ref] = { fingerprint: fp, health: hit.health };
    } else {
      delete this.load()[ref];
    }
    this.save();
  }

  /** Forget a pointer's verdict entirely (the key was removed). */
  clear(ref: string): void {
    if (!(ref in this.load())) return;
    delete this.load()[ref];
    this.save();
  }

  /** A chat turn was refused with 401: the key is dead. "Expired" only when a
   *  previous check recorded an expiry date that has now passed — a 401 alone
   *  cannot tell expired from deleted (§6). */
  recordTurnRejection(ref: string, key: string): HealthReason {
    const prior = this.get(ref);
    const reason: HealthReason = prior?.expiresAt && Date.parse(prior.expiresAt) <= this.now()
      ? 'openrouter-key-expired' : 'openrouter-key-rejected';
    this.record(ref, key, { verdict: 'rejected', reason, expiresAt: prior?.expiresAt, checkedAt: this.now() });
    return reason;
  }

  /** Ask OpenRouter about `key` (GET /key). Never throws.
   *  `ref` given: the key is the saved one — store the verdict under it.
   *  `ref` absent: a candidate not yet saved — hold it for adoptOrClear. */
  async check(baseUrl: string, key: string, ref?: string): Promise<KeyCheckResult> {
    const prior = ref ? this.get(ref) : undefined;
    const result = await this.ask(baseUrl, key, prior);
    const health: ProviderHealth = {
      verdict: result.verdict,
      ...(result.reason ? { reason: result.reason } : {}),
      // Keep a known expiry through an unreachable check, so a later 401 can
      // still be worded "expired".
      ...((result.expiresAt ?? prior?.expiresAt) ? { expiresAt: result.expiresAt ?? prior?.expiresAt } : {}),
      checkedAt: this.now(),
    };
    if (ref) {
      // An unreachable check never overwrites a real answer: a key that was
      // verified an hour ago is still the best knowledge we have offline.
      if (!(result.verdict === 'unchecked' && prior && prior.verdict !== 'unchecked')) this.record(ref, key, health);
    } else {
      this.pending.set(keyFingerprint(key), { health, at: this.now() });
    }
    return result;
  }

  private async ask(baseUrl: string, key: string, prior: ProviderHealth | undefined): Promise<KeyCheckResult> {
    const out = (verdict: KeyCheckResult['verdict'], reason?: HealthReason, expiresAt?: string): KeyCheckResult => ({
      ok: verdict === 'verified',
      verdict,
      message: MESSAGES[reason ?? verdict as 'verified' | 'unchecked'],
      ...(reason ? { reason } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    });
    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl.replace(/\/+$/, '')}/key`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
    } catch {
      return out('unchecked');
    }
    if (res.status === 401) {
      const expired = prior?.expiresAt && Date.parse(prior.expiresAt) <= this.now();
      return out('rejected', expired ? 'openrouter-key-expired' : 'openrouter-key-rejected');
    }
    if (res.status === 403) return out('rejected', 'openrouter-forbidden');
    if (!res.ok) return out('unchecked'); // 5xx, 404 from a proxy without /key, …
    let data: any;
    try { data = (await res.json())?.data; } catch { return out('unchecked'); }
    // A proxy answering 200 with something else entirely is not proof.
    if (!data || typeof data !== 'object') return out('unchecked');
    if (data.is_management_key === true || data.is_provisioning_key === true) {
      return out('rejected', 'openrouter-wrong-key-type');
    }
    const expiresAt = typeof data.expires_at === 'string' ? data.expires_at : undefined;
    return out('verified', undefined, expiresAt);
  }
}

/** The chat-turn fetch for the OpenRouter branch (§3.1 write point 4). A 401
 *  marks the saved key rejected — the missing link that let Settings read
 *  Connected while every message failed. 402 and 403 are about THIS request
 *  (credit held for a long reply; a moderation flag), so they change nothing
 *  stored. All three end the turn with a typed, plain-words error. */
export function openRouterTurnFetch(
  base: typeof fetch,
  onRejected: () => HealthReason,
): typeof fetch {
  return (async (input: any, init?: any) => {
    const res = await base(input, init);
    if (res.status !== 401 && res.status !== 402 && res.status !== 403) return res;
    let providerMessage: string | undefined;
    try {
      const body = await res.clone().json();
      const m = body?.error?.message ?? body?.message;
      if (typeof m === 'string' && m.trim()) providerMessage = m.trim();
    } catch { /* non-JSON body: no provider sentence to quote */ }
    if (res.status === 401) {
      const reason = onRejected();
      throw new ProviderAccountError(
        reason === 'openrouter-key-expired' ? 'Your OpenRouter key has expired.' : "OpenRouter didn't accept your API key.",
        reason, providerMessage,
      );
    }
    if (res.status === 402) {
      // "for this reply", never "you're out of credit": OpenRouter also answers
      // 402 when money is left but less than the reply it reserves for.
      throw new ProviderAccountError("There isn't enough OpenRouter credit left for this reply.", 'openrouter-credit-short', providerMessage);
    }
    throw new ProviderAccountError(
      providerMessage ? `OpenRouter refused this request. OpenRouter said: “${providerMessage}”` : 'OpenRouter refused this request.',
      'openrouter-request-refused', providerMessage,
    );
  }) as typeof fetch;
}
