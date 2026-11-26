// The address the Android app serves its bundled page from (Android's WebViewAssetLoader). WHY its own file: the phone's
// page (renderer/android-page.ts) and the computer's origin check (main/remote-origin.ts) must agree on it, and neither
// side may import the other. Must also match AppWebView.kt (PAGE_ORIGIN).
export const ANDROID_PAGE_ORIGIN = 'https://appassets.androidplatform.net';

// The address the iPhone app serves its bundled page from (2026-11-25, card #89): a private scheme answered by the
// app itself (WKURLSchemeHandler in ios/YouCoded/AppWebView.swift — iOS has no WebViewAssetLoader, and a private
// scheme is the only way a WKWebView loads bundled files without file access). Must match AppWebView.swift (pageOrigin).
export const IOS_PAGE_ORIGIN = 'youcoded-app://app';
