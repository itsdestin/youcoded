// Errors thrown by the mesh chat store and adapters. A store call that cannot do what it was asked
// (bad input, unknown version, refused eviction) throws StoreError with a short machine code; the
// expected outcomes of S2 (`parked`, `not-a-prefix`, `evicted`) are return values, never throws.
export type StoreErrorCode =
  | 'bad-line'          // a line did not end in exactly one 0x0a at its end
  | 'bad-argument'
  | 'unknown-version'
  | 'version-conflict'  // the same version id registered again with different facts
  | 'bad-proof'         // eviction proof failed its shape or consistency check
  | 'evicted'
  | 'parked-full'
  | 'corrupt'           // on-disk data that cannot be explained by an interrupted write
  | 'closed';

export class StoreError extends Error {
  constructor(public readonly code: StoreErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'StoreError';
  }
}
