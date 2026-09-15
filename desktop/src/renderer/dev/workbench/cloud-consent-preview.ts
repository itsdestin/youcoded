import type { CloudConsentPreview, CloudConsentState } from '../../components/project-view/CloudFileConsent';

// WHY: simulated provider/availability facts belong only to the workbench, not a
// path-name heuristic in production. Approval is never persisted.
export function cloudConsentPreview(params: URLSearchParams): CloudConsentPreview | null {
  const mode = params.get('cloudConsent');
  if (!mode || !['ask', 'denied', 'waiting', 'instructions'].includes(mode)) return null;
  const instructions = mode === 'instructions';
  const initial: CloudConsentState = {
    phase: instructions ? 'ask' : mode as CloudConsentState['phase'],
    purpose: instructions ? 'instructions' : 'file',
    file: instructions ? 'CLAUDE.md' : mode === 'waiting' ? 'latency-chart.png' : null,
    ...(instructions && params.get('cloudMultiple') === '1' ? { additionalFiles: ['project-guidelines.md'] } : {}),
  };
  return {
    initial,
    folder: params.get('cloudFolder') || '/home/destin/youcoded-dev/youcoded',
    // WHY: navigate only the workbench to its empty real conversation fixture;
    // this is not a real session launch or any external-program restriction.
    openConversation: (folder) => {
      const url = new URL(location.href);
      url.searchParams.set('scenario', 'site');
      url.searchParams.set('seed', 'none');
      url.searchParams.set('cloudConsent', 'instructions');
      url.searchParams.set('cloudFolder', folder);
      url.searchParams.set('title', 'New conversation');
      location.assign(url.toString());
    },
    provider: params.get('cloudProvider') === 'unknown' ? undefined : 'OneDrive',
    availability: (path) => path === 'README.md' ? 'local' : path === 'scratch.md' ? 'unknown' : 'cloud',
  };
}
