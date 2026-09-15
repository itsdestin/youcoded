/** Metadata is an observation, NEVER a guarantee that a later content open is safe. */
export type CloudObservation =
  | { readonly kind: 'present'; readonly residency: 'local' | 'cloud' | 'partial' | 'unknown' }
  | { readonly kind: 'absent' | 'error' }

export type CloudPurpose = 'preview' | 'description' | 'count' | 'search' | 'optional-discovery'
  | 'file' | 'instructions' | 'context'

export interface CloudFile {
  /** Adapter-issued stable object/version identity, not merely a pathname. */
  readonly identity: string
  readonly name: string
  readonly observation: CloudObservation
}

export type CloudReadResult =
  | { readonly kind: 'ready'; readonly identity: string; readonly bytes: Uint8Array }
  | { readonly kind: 'unsupported' | 'identity-changed' | 'absent' | 'error' | 'too-large' }

/** Descriptor is immutable; bytes are owned by this subscriber, never shared with another. */
export interface CloudContent {
  readonly identity: string
  readonly bytes: Uint8Array
}
export interface CloudCompletion extends CloudSnapshot {
  /** Only successful, still-interested consumers receive bytes; status notifications never do. */
  readonly content?: readonly CloudContent[]
}
export type CloudAuthorization =
  | { readonly mode: 'no-recall' }
  | { readonly mode: 'authorized'; readonly operationId: string; readonly identity: string }

/**
 * Trusted capability boundary; T0 has NO platform implementation.
 * observe must be metadata-only. consume must bind the exact identity before any
 * data access, then consume through that SAME protected handle/capability. A stale
 * observation + ordinary pathname read is not an implementation of this interface.
 * no-recall must prevent hydration for the whole consumption, not just the open.
 * Unsupported enforcement / changed identity MUST fail closed, with no fallback.
 * acknowledge means the provider accepted a download request, not that consent was clicked.
 * A ready result transfers protected content, not a reusable permission or path.
 * Enforce maxBytes DURING consumption, returning too-large rather than buffering
 * an arbitrarily large file. Returned bytes must not be mutated after transfer.
 */
export interface CloudAdapter {
  noRecall: boolean
  observe(identity: string): Promise<CloudObservation>
  consume(file: CloudFile, authorization: CloudAuthorization, acknowledge: () => void, maxBytes: number): Promise<CloudReadResult>
}

export type CloudOperationState = 'awaiting-consent' | 'requesting' | 'downloading' | 'ready'
  | 'skipped' | 'denied' | 'abandoned' | 'unsupported' | 'reapproval-required' | 'absent' | 'error' | 'too-large'

/** Owner tokens are trusted main-process identities, never taken from an IPC payload. */
export type CloudOwner = symbol
export interface CloudSnapshot {
  readonly id: string
  readonly purpose: CloudPurpose
  readonly files: readonly CloudFile[]
  readonly state: CloudOperationState
  readonly subscriber?: string
  readonly generation?: number
  readonly openEligible: boolean
  readonly continueEligible: boolean
}
export interface CloudSubscription {
  readonly id: string
  readonly generation: number
  readonly done: Promise<CloudCompletion>
}
