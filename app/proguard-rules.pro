# DestinCode ProGuard Rules

# Termux terminal libraries — native JNI and reflection usage
-keep class com.termux.terminal.** { *; }
-keep class com.termux.view.** { *; }

# Apache Commons Compress — reflection-based codec loading
-keep class org.apache.commons.compress.** { *; }
-dontwarn org.apache.commons.compress.**

# XZ and Zstd — native decompression
-keep class org.tukaani.xz.** { *; }
-keep class com.github.luben.zstd.** { *; }
-dontwarn com.github.luben.zstd.**

# CommonMark — markdown parser
-keep class org.commonmark.** { *; }

# Keep JSON parsing (org.json is part of Android SDK but accessed via reflection in some cases)
-keep class org.json.** { *; }

# Encrypted SharedPreferences + Google Tink (used by security-crypto)
-keep class androidx.security.crypto.** { *; }
-keep class com.google.crypto.tink.** { *; }
-dontwarn javax.annotation.**
-dontwarn javax.annotation.concurrent.**
-dontwarn com.google.errorprone.annotations.**
-dontwarn com.google.api.client.http.**
-dontwarn com.google.api.client.http.javanet.**
-dontwarn org.joda.time.**

# Keep our hook event and session classes (used with JSON parsing)
-keep class com.destin.code.parser.HookEvent { *; }
-keep class com.destin.code.parser.HookEvent$* { *; }
