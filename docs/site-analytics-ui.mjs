import { createAnalytics, eligible, installerTarget } from './site-analytics.mjs';

// WHY: owner authorized collection after deploying analytics-path rate protection.
// The Worker has a separate kill switch and refuses unsigned admissions.
const COLLECTION_ENABLED = true;
export function mountAnalyticsUI(win = window, doc = document) {
  let client;
  if (COLLECTION_ENABLED && eligible(win)) client = createAnalytics({ fetch: win.fetch.bind(win), crypto: win.crypto, href: win.location.href, referrer: doc.referrer });
  // No readback API: event details carry only an outcome, never the page nonce or capability.
  win.addEventListener('youcoded:site-analytics', event => {
    try {
      const detail = event.detail;
      if (!detail || typeof detail !== 'object') return;
      if (detail.type === 'instructions' && Object.keys(detail).length === 1) client?.instructions();
      if (detail.type === 'download' && Object.keys(detail).length === 3 && typeof detail.key === 'string' && typeof detail.href === 'string') {
        const target = installerTarget(detail.key, detail.href);
        if (target) { client?.download(target); client?.flush(); }
      }
    } catch { /* Analytics must never block a modal or navigation. */ }
  });
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') client?.flush(); });
  // No pagehide/pageshow teardown: BFCache restores this same in-memory visit, not a new one.
}
if (typeof window !== 'undefined') {
  try { mountAnalyticsUI(); } catch { /* Optional analytics cannot break the website. */ }
}
