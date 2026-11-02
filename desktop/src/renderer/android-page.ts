// Is this page the Android app's own bundled page?
//
// WHY this file exists (2026-10-30 security audit A2): the phone app used to open its page as file:///android_asset/web, and ten
// places in the page asked "is the protocol file:?" to mean "I am inside the Android app". The app now serves its page from
// https://appassets.androidplatform.net (Android's WebViewAssetLoader) so the WebView no longer needs file access at all. This
// is the ONE place that knows both addresses, so those checks keep meaning "inside the Android app".
//
// `file:` stays in the answer on purpose: the packaged desktop window is also a file:// page, and every caller already checks
// `window.claude` (desktop's own bridge) before trusting this, exactly as before.

/** The address the Android app serves its bundled page from. Must match AppWebView.kt (PAGE_HOST). */
const ANDROID_PAGE_ORIGIN = 'https://appassets.androidplatform.net';

export function isAndroidAppPage(): boolean {
  if (typeof location === 'undefined') return false;
  return location.protocol === 'file:' || location.origin === ANDROID_PAGE_ORIGIN;
}
