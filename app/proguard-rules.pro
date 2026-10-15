# R8 rules for the release build. Since the Android clean rebuild (2026-10-14) the app is a thin shell; the
# old rules for the Termux terminal, xz/zstd, commonmark, HookEvent and Bootstrap went with the code they kept.

# Unpacks the backend and data files (RuntimeInstaller.kt).
-keep class org.apache.commons.compress.** { *; }
-dontwarn org.apache.commons.compress.**
-keep class org.json.** { *; }

# The page calls YouCodedHost.invoke by name (WebView JavaScript interface): keep the name.
-keepclassmembers class com.youcoded.app.bridge.HostJsBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# Tink / security-crypto and ML Kit reference annotations that are not on the classpath.
-dontwarn javax.annotation.**
-dontwarn javax.annotation.concurrent.**
-dontwarn com.google.errorprone.annotations.**
-dontwarn com.google.api.client.http.**
-dontwarn com.google.api.client.http.javanet.**
-dontwarn org.joda.time.**
