import React from 'react';
import { RemoteAccessMockPanel } from '../../../components/SettingsPanel';
import { createRemoteAccessPreview } from '../fixtures/remote-access';

/** WHY: the review's operable setup uses the same panel and fake service as Settings,
 * never copied markup or an actual Tailscale operation. */
export function RemoteSetupDemo() {
  const [preview] = React.useState(() => createRemoteAccessPreview('not-installed'));
  const view = React.useSyncExternalStore(preview.subscribe, preview.getView);
  return <div className="p-4"><RemoteAccessMockPanel view={view} onAction={preview.act} /></div>;
}
