import { describe, it, expect } from 'vitest';
import { backendDeviceNoun, markBackendAsPhone } from '../src/main/device-noun';

describe('backendDeviceNoun', () => {
  it('says computer until the headless (phone) boot marks it, then phone', () => {
    expect(backendDeviceNoun()).toBe('computer');
    markBackendAsPhone();
    expect(backendDeviceNoun()).toBe('phone');
  });
});
