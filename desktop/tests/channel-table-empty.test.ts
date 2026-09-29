// R2 ships the channel table EMPTY: with zero entries neither door does anything new.
// This pin is meant to be deleted by R3, the run that moves the first real channel in.
import { describe, it, expect } from 'vitest';
import { CHANNEL_TABLE, findChannel } from '../src/main/ipc/channel-table';

describe('the channel table ships empty (one-core R2)', () => {
  it('has no entries, so neither door changes behaviour', () => {
    expect(CHANNEL_TABLE).toHaveLength(0);
    expect(findChannel('session:create')).toBeUndefined();
  });
});
