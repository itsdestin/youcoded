import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) load(FileInputStream(keystorePropertiesFile))
}

android {
    namespace = "com.youcoded.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.youcoded.app"
        minSdk = 28
        targetSdk = 35
        versionCode = 17
        versionName = "1.2.1"
    }

    signingConfigs {
        create("release") {
            storeFile = file(keystoreProperties.getProperty("storeFile", "release-keystore.jks"))
            storePassword = keystoreProperties.getProperty("storePassword", "")
            keyAlias = keystoreProperties.getProperty("keyAlias", "youcoded")
            keyPassword = keystoreProperties.getProperty("keyPassword", "")
        }

        // Stable debug signing: if app/debug.keystore is committed, use it so
        // dev APKs share one signature across CI runs (dev→dev upgrades preserve
        // data). If absent, AGP falls back to the per-machine ~/.android/debug.keystore
        // and each CI run produces a fresh key — dev builds would then require
        // uninstall-before-install, but release builds are unaffected.
        getByName("debug") {
            val stableDebugKeystore = file("debug.keystore")
            if (stableDebugKeystore.exists()) {
                storeFile = stableDebugKeystore
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
        }
    }

    buildTypes {
        // Dev build: installs as a SEPARATE app ("YouCoded Dev") alongside the
        // released app on the same device. applicationIdSuffix changes the final
        // package ID; namespace (Kotlin/Java package) stays the same so class
        // references like `.MainActivity` still resolve.
        debug {
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            resValue("string", "app_name", "YouCoded Dev")
            // Dev APK uses a different LocalBridgeServer port so it can run
            // side-by-side with the released app (which binds 9901). Both apps
            // would otherwise collide on 127.0.0.1:9901 and the dev app's
            // WebView would hang forever on "Connecting...".
            buildConfigField("int", "BRIDGE_PORT", "9951")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = signingConfigs.getByName("release")
            resValue("string", "app_name", "YouCoded")
            buildConfigField("int", "BRIDGE_PORT", "9901")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Compose BOM
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")


    // Termux terminal emulator (PTY session management) + terminal view (native rendering).
    // LICENSE NOTE: Both are GPLv3. Linking them into the Android APK is why the Android
    // application is distributed under GPLv3 (see app/LICENSE). The desktop Electron app
    // has no such dependency and remains MIT-licensed. Swapping in a permissively-licensed
    // terminal library is the only way to relicense the Android app.
    implementation("com.github.termux.termux-app:terminal-emulator:v0.118.1")
    implementation("com.github.termux.termux-app:terminal-view:v0.118.1")

    // Apache Commons Compress for extracting .deb packages (ar + tar + xz + zstd)
    implementation("org.apache.commons:commons-compress:1.27.1")
    implementation("org.tukaani:xz:1.10")
    implementation("com.github.luben:zstd-jni:1.5.6-3")

    // Markdown parsing for chat view
    implementation("org.commonmark:commonmark:0.24.0")

    // WebSocket server for React UI bridge
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.java-websocket:Java-WebSocket:1.5.6")

    // Security: encrypted credential storage for paired device passwords
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // QR code scanning for remote desktop pairing
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    implementation("androidx.camera:camera-core:1.4.1")
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")

    debugImplementation("androidx.compose.ui:ui-tooling")

    // Unit tests
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20231013")
    // Coroutines test support for runTest in SubagentWatcherTest
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    // kotlin.test assertions (assertTrue/assertEquals/etc.) for JVM unit tests
    testImplementation(kotlin("test"))
    // MockWebServer for AnalyticsServiceTest — version matches the OkHttp
    // already on the main classpath (4.12.0).
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
