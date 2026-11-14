// Public types of the chat store (split out of store.ts to keep it inside its line budget). Types only; no code runs from here.
import type { Fs } from './fsio';
import type { ChainSeedFn, RuntimeKind } from './chain';
import type { ReplyEndOptions } from './classify';

/** Opaque version id: 1 to 64 bytes (documented limit: the id becomes folder names in hex, and the longest name the store makes is `<hex>-q<n>`; `registerVersion` and every call refuse a longer id with `bad-argument`). Real ids are 32 bytes. */
export type VersionId = Uint8Array;

/**
 * Whether a proof is genuine. Supplied by the caller at construction (the replicator, which can check
 * holder signatures); the store cannot. Must resolve to exactly `true`: anything else, or a throw, refuses.
 */
export type ProofVerifier = (proof: EvictionProof, ctx: { version: string; chatId: string; lines: number; hash: string }) => boolean | Promise<boolean>;

export interface StoreOptions {
  fs?: Fs;
  /** The single replaceable rule that seeds both chains (chain.ts). */
  seeds?: ChainSeedFn;
  /** Arrival-time clock for "last used" (never a line timestamp: T2 finding 10). */
  now?: () => number;
  /** A new body chunk file starts once the active one reaches this size. */
  chunkBytes?: number;
  /** Cap on bytes of parked (gapped) appends held per version. */
  maxParkedBytes?: number;
  /** Cap on the NUMBER of parked append files per version (M4). */
  maxParkedFiles?: number;
  /** An append may start at most this many lines past the head (M4); further is refused as bad-argument. */
  maxParkGap?: number;
  /** One append call may carry at most this many bytes (L8). */
  maxAppendBytes?: number;
  /** One extra may be at most this many bytes (L9). */
  maxExtraBytes?: number;
  /** Cap on parked control entries per chat (M3). */
  maxParkedControl?: number;
  /** Bytes of the rolling integrity scrub run when a version is first loaded; 0 turns it off (H3). */
  scrubOnOpenBytes?: number;
  /** Total bytes of extras kept; a put past it is refused with `limit` (N11). Default 4 GiB. */
  maxExtrasBytes?: number;
  /** Bytes kept under a version's rejected/ folder; past it a rejected park stays in parked/ and counts toward its cap (N11). Default 256 MiB. */
  maxRejectedBytes?: number;
  /** From a `store-locked-stale?` error's `evidence.breakLockToken`: take over exactly that lock (N9). */
  breakLockToken?: string | null;
  replyEnd?: ReplyEndOptions;
  /** Decides whether an eviction proof is genuine. Default refuses everything (H4). */
  proofVerifier?: ProofVerifier;
}

export interface VersionMeta {
  chatId: string;
  runtime: RuntimeKind;
  /** Opaque parent version id (rewrite becomes a new version whose parent is the old one); not interpreted here. */
  parent?: VersionId | null;
}

export interface Head {
  lines: number;
  /** Raw chain value after `lines` lines, 64 hex. */
  hash: string;
  conversationLines: number;
  conversationHash: string;
  /** Lines whose bodies were evicted (chain values are always kept). */
  evictedLines: number;
  /**
   * Which classifier (and reply-end option) produced the conversation chain and reply ends (M5). Two heads
   * are comparable on `conversationHash` only when their stamps are equal.
   */
  classifierStamp: number;
  /** First line whose body bytes were found not to match the chain, or null (H3). A correct resend heals it. */
  damagedFromLine: number | null;
  /**
   * True while the conversation chain of the evicted lines was written by another classifier and cannot be
   * recomputed without their bodies (N4). `conversationHash` and `conversationLines` are not comparable with
   * another device's until `restoreBody` brings the bodies back; `hash` (the raw chain) is unaffected.
   */
  conversationChainStale: boolean;
}

export type AppendResult = 'ok' | 'parked' | 'not-a-prefix';

export interface Summary {
  lines: number;
  conversationLines: number;
  replyEnds: number;
  title: string | null;
  model: string | null;
  cwd: string | null;
  /** Arrival time (ms since epoch) of the last append: "used" comes from arrival, never from line timestamps. */
  lastAppendMs: number | null;
}

/** One holder's statement "I hold `lines` lines of `version` and my chain value there is `hash`". */
interface ProofAck {
  holder: string;
  version: string;
  lines: number;
  hash: string;
  /** Opaque to the store; checked by the ProofVerifier. */
  signature: string;
}

/**
 * Proof that other devices hold these lines. The store checks the BINDING (this version, this line count,
 * this chain value, distinct holders) and then asks the caller-supplied ProofVerifier; shape and a matching
 * hash alone never suffice (H4: the store's own hashAt would otherwise forge one).
 */
export interface EvictionProof {
  kind: 'holders-confirmed';
  version: string;
  through: number;
  hash: string;
  acks: ProofAck[];
}

export interface TailRecord {
  version: VersionId;
  fromLine: number;
  fromHash: string;
  fromConversationHash: string;
  headHash: string;
  headConversationHash: string;
  lines: Buffer[];
  /** Reply ends confirmed inside the tail (absolute line numbers) and the unconfirmed candidate, if any. */
  replyEnds: number[];
  pendingReplyEnd: number | null;
}

export interface VerifyReport { ok: boolean; lines: number; firstBadLine: number | null; reason?: string }
export interface ScrubReport { verifiedLines: number; total: number; damagedFromLine: number | null }
