import { describe, expect, it } from 'vitest'
import { decideCloudRead } from '../src/main/cloud-files/policy'
import type { CloudObservation, CloudPurpose } from '../src/shared/cloud-file-types'

const passive: CloudPurpose[] = ['preview', 'description', 'count', 'search', 'optional-discovery']
const substantive: CloudPurpose[] = ['file', 'instructions', 'context']
describe('cloud read policy', () => {
  for (const purpose of passive) {
    for (const residency of ['local', 'cloud', 'partial', 'unknown'] as const) {
      it(`${purpose}: ${residency} is local-only`, () => {
        expect(decideCloudRead(purpose, { kind: 'present', residency }, true)).toBe(residency === 'local' ? 'no-recall' : 'skip')
      })
    }
    it(`${purpose}: no safe capability means skip`, () => {
      expect(decideCloudRead(purpose, { kind: 'present', residency: 'local' }, false)).toBe('skip')
    })
  }
  for (const purpose of substantive) {
    for (const residency of ['cloud', 'partial', 'unknown'] as const) {
      it(`${purpose}: ${residency} needs consent`, () => {
        expect(decideCloudRead(purpose, { kind: 'present', residency }, true)).toBe('consent')
      })
    }
    it(`${purpose}: local without protection is unavailable, not ordinary read`, () => {
      expect(decideCloudRead(purpose, { kind: 'present', residency: 'local' }, false)).toBe('unsupported')
    })
  }
  it('keeps absence and errors distinct from unknown residency', () => {
    const observations: CloudObservation[] = [{ kind: 'absent' }, { kind: 'error' }]
    expect(observations.map(o => decideCloudRead('file', o, true))).toEqual(['absent', 'error'])
  })
})
