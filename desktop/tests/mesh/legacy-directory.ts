// TEST-ONLY: a version directory that skips the root-id and token binding, so older tests can keep naming versions with arbitrary ids (`wireId('x')`). The product's directory has no such mode (review 3, finding 10);
// tests of the binding itself use `repWorld(..., { bound: true })` and `deriveRootId`.
import { InterimDirectory, type AcceptResult } from '../../src/main/mesh/replicator/directory';
import type { IntroBody } from '../../src/main/mesh/replicator/wire';

export class LegacyDirectory extends InterimDirectory {
  protected override bindingOk(_b: IntroBody): 'ok' | AcceptResult { return 'ok'; }
}
