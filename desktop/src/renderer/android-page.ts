// Is this page the Android app's own bundled page?
//
// WHY this file exists (2026-10-30 security audit A2): the phone app used to open its page as file:///android_asset/web, and ten
// places in the page asked "is the protocol file:?" to mean "I am inside the Android app". The app now serves its page from
// https://appassets.androidplatform.net (Android's WebViewAssetLoader) so the WebView no longer needs file access at all. This
// is the ONE place that knows both addresses, so those checks keep meaning "inside the Android app".
//
// `file:` stays in the answer on purpose: the packaged desktop window is also a file:// page, and every caller already checks
// `window.claude` (desktop's own bridge) before trusting this, exactly as before.

//
// WHY the iPhone app answers true here too (2026-11-25, card #89): the iPhone app is the same thing on another phone
// system — the app's own bundled page, talking to a backend the app runs on the phone. Every caller of this function
// asks exactly that ("am I the phone app's own page?"), so the iPhone page gets the Android app's proven behaviour
// everywhere and the name stays (renaming ~40 call sites would collide with every branch in flight). The few places
// the two phones truly differ ask `phoneOs()` below.

import { ANDROID_PAGE_ORIGIN, IOS_PAGE_ORIGIN } from '../shared/android-page-origin';

/** True on the iPhone app's own page. WHY protocol as well as origin: WebKit reports `location.origin` of a private
 *  scheme as the string "null" in some versions, and the protocol is always right. */
function isIosAppPage(): boolean {
  if (typeof location === 'undefined') return false;
  return location.origin === IOS_PAGE_ORIGIN || location.protocol === 'youcoded-app:';
}

export function isAndroidAppPage(): boolean {
  if (typeof location === 'undefined') return false;
  return location.protocol === 'file:' || location.origin === ANDROID_PAGE_ORIGIN || isIosAppPage();
}

/** Which phone system the phone app's own page is on, or null anywhere else (a computer, a browser). For the few
 *  real differences only: wording that names the phone, the notch/home-bar insets, features one phone lacks. */
export function phoneOs(): 'android' | 'ios' | null {
  if (isIosAppPage()) return 'ios';
  if (typeof location !== 'undefined' && location.origin === ANDROID_PAGE_ORIGIN) return 'android';
  return null;
}
