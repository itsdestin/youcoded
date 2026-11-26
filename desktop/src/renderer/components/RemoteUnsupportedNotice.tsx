// Announces features that aren't bridged to remote access yet.
//
// Most of window.claude's channels have no handler in remote-server.ts. They
// now answer immediately with {ok:false, unsupported:true} rather than hanging
// for 30 seconds, but the answer lands in call sites that largely don't check
// it — ProjectView's listProjectsIndex().then() has no .catch(), account-context
// calls reloadFromStore() as `void` — so without this the user just gets an
// empty panel and no reason for it.
//
// Mount-only; renders nothing itself. The shim dedupes by feature, so this raises at most one
// notice per feature per page load even for channels polled on a loop.
//
// WHY a short floating notice now (Destin, waiting-notice deck R-remote): there is nothing to do about it, and it can come back each
// time such a screen opens, so it times out by itself like "Copied" does instead of asking for a Close press each time. It goes
// through announce(), so it shares the one floating spot and never pushes out a notice that needs you.

import { useEffect } from 'react';
import { REMOTE_UNSUPPORTED_EVENT, remoteFeatureIsPlural, type RemoteUnsupportedDetail } from '../remote-unsupported';
import { announce } from '../utils/announce';

/** How long to wait for the other features one screen touches at the same moment, so they become ONE sentence. */
const GATHER_MS = 250;
const VISIBLE_MS = 6000;

/** "Theme browsing only works on the computer running YouCoded for now." (several, or a plural name like "Skills": "only work …"). */
function remoteOnlyOnComputerMessage(features: string[]): string {
  const list = features.length <= 1 ? features[0] ?? '' : `${features.slice(0, -1).join(', ')} and ${features[features.length - 1]}`;
  return `${list} only ${features.length > 1 || remoteFeatureIsPlural(features[0] ?? '') ? 'work' : 'works'} on the computer running YouCoded for now.`;
}

export default function RemoteUnsupportedNotice() {
  useEffect(() => {
    // WHY gathered (kept from the old notice): opening one screen can touch three unbridged channels at once, and each
    // replacing the last produced a flicker of half-read sentences.
    let batch: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onUnsupported = (e: Event) => {
      const detail = (e as CustomEvent).detail as RemoteUnsupportedDetail | undefined;
      if (!detail) return;
      if (!batch.includes(detail.feature)) batch.push(detail.feature);
      if (timer) return;
      timer = setTimeout(() => {
        const features = batch; batch = []; timer = undefined;
        announce(remoteOnlyOnComputerMessage(features), VISIBLE_MS);
      }, GATHER_MS);
    };
    window.addEventListener(REMOTE_UNSUPPORTED_EVENT, onUnsupported);
    return () => { window.removeEventListener(REMOTE_UNSUPPORTED_EVENT, onUnsupported); if (timer) clearTimeout(timer); };
  }, []);
  return null;
}
