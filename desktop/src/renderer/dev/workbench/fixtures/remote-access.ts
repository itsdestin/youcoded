import type { RemoteAccessPreview, RemoteAccessView } from '../../../components/remote/preview-types';

/** Fake checks never open Tailscale or contact a host; every transition is local to this preview. */
export function createRemoteAccessPreview(raw: string): RemoteAccessPreview {
  const stages: RemoteAccessView['stage'][] = ['setup', 'consent', 'checking', 'ready', 'conflict', 'error', 'disabled'];
  let view: RemoteAccessView = {
    stage: raw === 'not-installed' || raw === 'sign-in-required' ? 'setup' : stages.includes(raw as RemoteAccessView['stage']) ? raw as RemoteAccessView['stage'] : 'ready',
    prerequisite: raw === 'not-installed' || raw === 'sign-in-required' ? raw : 'ready',
    address: 'https://home-laptop.example-tailnet.ts.net',
    // WHY empty before approval: a computer that is "not set up yet" cannot already
    // remember paired devices, and showing both at once told two different stories.
    devices: ['ready', 'disabled', 'checking', 'encrypted', 'consent'].includes(raw)
      ? [{ id: 'phone', name: 'My phone', online: true }, { id: 'tablet', name: 'My tablet', online: false }]
      : [],
    browserEncryption: raw === 'encrypted' ? 'on' : 'off',
  };
  const listeners = new Set<() => void>();
  let generation = 0;
  let approved = ['ready', 'disabled', 'checking', 'encrypted', 'consent'].includes(raw);
  const update = (changes: Partial<RemoteAccessView>) => { view = { ...view, ...changes }; listeners.forEach(fn => fn()); };
  return {
    getView: () => view,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    act: action => {
      if (action.type === 'revoke') { update({ devices: view.devices.filter(item => item.id !== action.deviceId) }); return; }
      if (action.type === 'report' || action.type === 'diagnose') {
        update({ notice: 'Preview only — no report sent and no assistant started.' }); return;
      }
      // The optional level: this is where the public-record consent appears, and nowhere
      // else. Turning it off again is a plain toggle — the record it created is not
      // recallable, which the copy says.
      if (action.type === 'advanced') {
        if (view.browserEncryption === 'on') { update({ browserEncryption: 'off' }); return; }
        update({ stage: 'consent' });
        return;
      }
      if (action.type === 'prerequisite') {
        update({ prerequisite: view.prerequisite === 'not-installed' ? 'sign-in-required' : 'ready' }); return;
      }
      const current = ++generation;
      if (action.type === 'consent') update({ stage: 'consent' });
      else if (action.type === 'disable') update({ stage: 'disabled' });
      else {
        if (view.stage === 'consent') { approved = true; update({ browserEncryption: 'on' }); }
        if (!approved) { update({ stage: 'consent' }); return; }
        update({ stage: 'checking' });
        // WHY a generation guard: a disabled preview must not become ready when an older fake check finishes.
        setTimeout(() => { if (current === generation) update({ stage: 'ready' }); }, 1200);
      }
    },
  };
}
