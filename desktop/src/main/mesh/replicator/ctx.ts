// Shared types and small helpers of the replicator parts (receive, serve, repair, forks), so each file takes ONE context object and none imports another's internals.
import { createHash } from 'node:crypto';
import type { CborValue } from '../crypto/cbor';
import type { ChatStore, Head } from '../store';
import type { SignedHeads } from './signed-heads';
import type { IdMap } from './idmap';
import type { ReplicatorCrypto, VersionDirectory, VersionDescriptor } from './directory';
import type { ByteBudget, RateLimiter } from './budget';
import type { AdvertisedState } from './wire';

/** The part of Link the replicator uses (a real Link satisfies it; so does a fake in a test). */
export interface ReplicatorLink {
  sendLive(a: { group: string; kind: string; body: CborValue; to?: Buffer }): boolean;
  sendDurable(a: { group: string; kind: string; body: CborValue; to?: Buffer; line?: boolean }): Promise<{ counter: number }>;
  follow(group: string): void;
  unfollow(group: string): Promise<void>;
  sync(group: string): Promise<void>;
  retryPending(): void;
}

export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): { cancel(): void } }
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return { cancel: () => clearTimeout(t) }; },
};

type VState = 'unknown' | 'comparing' | 'in-sync' | 'pulling' | 'serving' | 'refilling' | 'diverged' | 'retired-recopy' | 'stuck';
export interface VersionStatus { state: VState; reason: string | null; lines: number; incarnation: number }

/** A signed statement a holder made about a version, in the shape of an eviction proof's ack (the store's `EvictionProof.acks`). */
export interface PeerAck { holder: string; version: string; lines: number; hash: string; signature: string }

interface PeerHead { lines: number; hash: string; state: AdvertisedState; at: number }
export interface PeerInfo { hex: string; id: Buffer; lastSeen: number; heads: Map<string, PeerHead>; acks: Map<string, { lines: number; hash: string; sig: Buffer }> }

/** The source of lines no peer holds (the writer's own chat file, via an adapter): `resupply(wire, from, to)` gives raw lines [from, to) or null. */
export type SourceRefill = (wire: Buffer, from: number, to: number) => Promise<Buffer[] | null>;

/** Per-version bookkeeping that is NOT durable (everything durable is the store's, or a file in this folder). */
export interface VRun {
  stuck: string | null;
  diverged: string | null;
  retiredRecopy: boolean;
  /** The range being refilled after a rollback or damage report, or null. Cleared only on store evidence (repair.ts). */
  refill: { from: number; end: number } | null;
  pull: { peer: string; haveLines: number; at: number } | null;
  seenRejected: number;
  lastHead: { lines: number; incarnation: number };
  recopies: number;
  /** Peers asked to restart from line 0 after a chain mismatch whose base was my own store (once each until the next hello). */
  rewanted: Set<string>;
  /** The last signed head of a verified batch, per peer, so the next batch of a session can be verified from the WRITER's chain value rather than my own. */
  lastSigned: Map<string, { lines: number; hash: Buffer }>;
  stall: { cancel(): void } | null;
  /** The writer's lines below this have been pushed to the other devices (durable lane); the rest is pushed by the next flush. */
  pushedThrough: number | null;
  pushing: boolean;
  /** Peers that just failed to serve this version (a nak, or no progress): not asked again until one serves or all are tried. */
  skip: Set<string>;
}

/** A line larger than one frame, arriving in parts from one peer (receive.ts). Held in memory under `reassemblyBytes`, one per (peer, version). */
interface Reasm { from: number; of: number; total: number; chunks: Buffer[]; bytes: number; at: number }
/** One peer's catch-up of one version that this device is serving (serve.ts). */
export interface ServeSession { peer: string; wire: Buffer; next: number; acked: number; through: number; inFlight: Array<{ end: number; bytes: number }>; lastProgress: number; timer: { cancel(): void } | null; pumping: boolean }

export interface RepCtx {
  store: ChatStore;
  link: ReplicatorLink;
  crypto: ReplicatorCrypto;
  directory: VersionDirectory;
  heads: SignedHeads;
  ids: IdMap;
  clock: Clock;
  setId: Buffer;
  holds: RateLimiter;
  /** The writer's live push has its own, wider limit: a reply of 50 lines must reach the other devices within seconds, while bulk catch-up is held to a few frames a second. */
  pushRate: RateLimiter;
  readBytes: ByteBudget;
  reassemblyBytes: ByteBudget;
  sourceRefill?: SourceRefill;
  peers: Map<string, PeerInfo>;
  runs: Map<string, VRun>;
  counters: Map<string, number>;
  reasm: Map<string, Reasm>;
  sessions: Map<string, ServeSession>;
  /** All work on one version runs one at a time (replicator.ts invariant 9's companion). */
  run<T>(wire: Buffer, fn: () => Promise<T>): Promise<T>;
  runOf(wire: Buffer): VRun;
  /** Local id of the current incarnation, registered in the store (a fork is made here when its parent allows). `null` when the version cannot be set up yet. */
  localOf(wire: Buffer): Promise<{ local: Buffer; incarnation: number; desc: VersionDescriptor } | null>;
  bump(counter: string): void;
  sendLive(kind: string, body: CborValue, to?: Buffer): boolean;
  /** Ask `peer` for lines after what I hold (receiver-driven). */
  want(wire: Buffer, peer: PeerInfo, opts?: { haveLines?: number; through?: number | null }): Promise<void>;
  /** Re-judge a version against what every peer last said, and ask for what is missing. */
  reconsider(wire: Buffer): Promise<void>;
  advertise(): void;
}

export const hex8 = (b: Buffer): string => b.toString('hex').slice(0, 8);

/** Name of a chat's group at the relay: opaque, one per chat, the same on every device of the set. WHY a hash of the set id and chat id: the relay sees group names in clear and must not learn chat ids. */
export function chatGroup(setId: Buffer, chatId: string): string {
  return 'chat.' + createHash('sha256').update('youcoded-mesh/v1/chat-group\0').update(setId).update('\0').update(chatId).digest('hex').slice(0, 32);
}

/** What a head says about the version's health, for peers: only the point this device can vouch for while it is repairing. */
export function repairFrom(h: Head): number | null {
  let from: number | null = null;
  for (const c of [h.partial?.from, h.rolledBack?.from, h.damagedFromLine]) if (c !== undefined && c !== null) from = from === null ? c : Math.min(from, c);
  return from;
}

