import type { CloudObservation, CloudPurpose } from '../../shared/cloud-file-types'

export type CloudReadDecision = 'no-recall' | 'consent' | 'skip' | 'unsupported' | 'absent' | 'error'

export function decideCloudRead(purpose: CloudPurpose, observation: CloudObservation, noRecall: boolean): CloudReadDecision {
  if (observation.kind !== 'present') return observation.kind
  const passive = purpose === 'preview' || purpose === 'description' || purpose === 'count'
    || purpose === 'search' || purpose === 'optional-discovery'
  // WHY: even an approved file operation must not turn browsing into background downloads.
  if (passive) return observation.residency === 'local' && noRecall ? 'no-recall' : 'skip'
  if (observation.residency !== 'local') return 'consent'
  return noRecall ? 'no-recall' : 'unsupported'
}
