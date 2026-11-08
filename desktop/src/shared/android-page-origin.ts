// The address the Android app serves its bundled page from (Android's WebViewAssetLoader). WHY its own file: the phone's
// page (renderer/android-page.ts) and the computer's origin check (main/remote-origin.ts) must agree on it, and neither
// side may import the other. Must also match AppWebView.kt (PAGE_ORIGIN).
export const ANDROID_PAGE_ORIGIN = 'https://appassets.androidplatform.net';
