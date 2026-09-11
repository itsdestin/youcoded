import java.util.Properties
import java.io.FileInputStream
import org.gradle.internal.os.OperatingSystem
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

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
        versionCode = 20
        versionName = "1.2.4"
        // WHY: the bootstrap only ships an aarch64 runtime (bootstrap-aarch64.zip,
        // Termux's binary-aarch64 index), but ML Kit / zstd / the terminal JNI
        // bring native libs for all four ABIs, so the APK advertised
        // armeabi-v7a, x86 and x86_64 too — it installed on those phones and
        // then died at first-run setup with a download error (audit 2026-09-10).
        // Filtering makes the incompatibility honest at install time.
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
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
        // ReleaseTest: same R8 / shrinker / proguard config as `release`, but
        // signed with the debug keystore and installed as a SEPARATE app
        // ("YouCoded ReleaseTest") via applicationIdSuffix.
        //
        // Why this exists: debug builds skip R8 minification entirely, which
        // hides any bug whose trigger involves R8 obfuscation, shrinking, or
        // inlining. The PluginInstaller reflection bug shipped silently from
        // 2026-03-25 through v1.2.2 because every dev/CI build was debug — no
        // pre-release verification ever ran the same code path the user would.
        // assembleReleaseTest reproduces release behavior (R8 effects intact)
        // without needing the production release keystore, so anyone can run
        // it locally or in CI before tagging. Side-by-side install also means
        // the user's real app data is never touched during verification.
        //
        // Bridge port shifted to avoid colliding with both the production app
        // (9901) and the regular debug app (9951). Uninstall + reinstall of
        // releaseTest is safe at any time.
        create("releaseTest") {
            initWith(getByName("release"))
            applicationIdSuffix = ".releasetest"
            versionNameSuffix = "-releasetest"
            resValue("string", "app_name", "YouCoded ReleaseTest")
            signingConfig = signingConfigs.getByName("debug")
            buildConfigField("int", "BRIDGE_PORT", "9961")
            matchingFallbacks += listOf("release")
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

    testOptions {
        // JVM unit tests run against a stubbed android.jar whose methods throw
        // "Method ... not mocked" by default. MarketplaceFetcher.fetchIndex() calls
        // android.util.Log.w on every fallback, so MarketplaceFetcherCatalogTest could
        // not run without this. NOTE: this changes what EVERY JVM test in this module
        // sees from an Android framework call — they now return a default (null / 0 /
        // false) instead of throwing. It does not affect org.json, which comes from the
        // real `org.json:json` test dependency below, not from android.jar.
        unitTests.isReturnDefaultValues = true
    }
}

// Kotlin JVM target. This used to be `android { kotlinOptions { jvmTarget = "17" } }`,
// which Kotlin 2.4 removed from the Gradle plugin (deprecated since 2.0), so the
// build script stopped compiling on the dependabot bump. `compilerOptions` is the
// replacement DSL; it lives at the top level, not inside `android {}`. Keep this
// in step with compileOptions.sourceCompatibility/targetCompatibility above.
kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// Auto-bundle the React UI into Android assets before APK packaging.
//
// Why: app/src/main/assets/web/ is entirely gitignored (since 2026-09-10 — a
// tracked index.html from April used to sit there, referencing chunk hashes no
// build produced and carrying the keyboard-overlay bug the live source had
// fixed). scripts/build-web-ui.sh regenerates the whole folder before each APK
// build. Skipping that step ships an APK with no index.html → file:// load
// fails → blank WebView → black screen. Wiring the script as a preBuild
// dependency makes it impossible to forget.
//
// Cost: Gradle's input/output tracking skips this task entirely when nothing
// in desktop/src/ has changed since the last successful run. Kotlin-only
// iteration loops (./gradlew installDebug repeatedly) pay zero overhead.
val bundleWebUi = tasks.register<Exec>("bundleWebUi") {
    description = "Build React UI from desktop/ and copy it into app/src/main/assets/web/"
    group = "build"

    val repoRoot = rootProject.projectDir  // youcoded/
    val desktopDir = File(repoRoot, "desktop")
    val script = File(repoRoot, "scripts/build-web-ui.sh")
    val outputDir = file("src/main/assets/web")

    workingDir = repoRoot

    // Inputs: anything that affects the built bundle. If none of these changed
    // since the last run, Gradle marks the task UP-TO-DATE and skips it.
    inputs.dir(File(desktopDir, "src")).withPropertyName("desktopSrc")
    inputs.file(File(desktopDir, "package.json")).withPropertyName("packageJson")
    inputs.file(File(desktopDir, "package-lock.json")).withPropertyName("packageLockJson")
    inputs.files(
        File(desktopDir, "vite.config.ts"),
        File(desktopDir, "tsconfig.json"),
        File(desktopDir, "tsconfig.node.json"),
        File(desktopDir, "index.html"),
    ).withPropertyName("buildConfig").optional()
    inputs.file(script).withPropertyName("script")
    outputs.dir(outputDir).withPropertyName("webBundle")

    if (OperatingSystem.current().isWindows) {
        // Windows: bash isn't on the system PATH unless invoked from Git Bash
        // or WSL. Try PATH first (covers Git Bash sessions and most CI runners),
        // then fall back to the standard Git for Windows install location.
        // PITFALLS.md "MCP Plugin Authoring" entry documents the same lookup pattern.
        val pathBash = (System.getenv("PATH") ?: "")
            .split(File.pathSeparator)
            .asSequence()
            .filter { it.isNotBlank() }
            .map { File(it, "bash.exe") }
            .firstOrNull { it.isFile }
        val bashExe = pathBash
            ?: File("C:\\Program Files\\Git\\usr\\bin\\bash.exe").takeIf { it.isFile }
            ?: throw GradleException(
                "bash.exe not found on PATH or at the standard Git for Windows location. " +
                "Install Git for Windows, or run `bash scripts/build-web-ui.sh` manually before assembling."
            )
        commandLine = listOf(bashExe.absolutePath, script.absolutePath)
    } else {
        commandLine = listOf("bash", script.absolutePath)
    }
}

// Hook the bundle task into the Android build pipeline. preBuild is the
// standard AGP entry point that runs before any source generation or
// packaging, so registering here covers assembleDebug, assembleRelease,
// installDebug, bundleRelease — every flavor that produces an APK/AAB.
tasks.matching { it.name == "preBuild" }.configureEach {
    dependsOn(bundleWebUi)
}

dependencies {
    // Compose BOM
    val composeBom = platform("androidx.compose:compose-bom:2026.08.00")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")


    // Termux terminal emulator (vendored) — runs the PTY session and emits
    // raw bytes via the patched RawByteListener. Tier 2 (xterm-in-WebView)
    // moved rendering to xterm.js in the React WebView; the native Termux
    // terminal-view library is no longer referenced. Vendored module stays
    // because it owns the PTY fork + JNI waitpid loop + RawByteListener.
    //
    // LICENSE NOTE: terminal-emulator-vendored is Apache License 2.0 (the
    // vendor drop preserves Termux's LICENSE and NOTICE for that library).
    // The Android app itself is MIT, like the rest of the repo (see
    // app/LICENSE). Apache 2.0 only asks that the NOTICE file travel with
    // redistributions.
    //
    // WHY this changed (2026-09): the earlier "GPLv3" label here rested on a
    // wrong reading of Termux's license. Termux's LICENSE.md says the
    // termux-app repo is GPLv3 *except* the terminal-emulator and
    // terminal-view libraries, which it carves out as Apache 2.0. Nothing
    // else in this APK is copyleft, so the Android app was never obliged to
    // be GPLv3 and has been relicensed to MIT.
    implementation(project(":terminal-emulator-vendored"))

    // Apache Commons Compress for extracting .deb packages (ar + tar + xz + zstd)
    implementation("org.apache.commons:commons-compress:1.28.0")
    implementation("org.tukaani:xz:1.12")
    implementation("com.github.luben:zstd-jni:1.5.7-11")

    // Markdown parsing for chat view
    implementation("org.commonmark:commonmark:0.30.0")

    // WebSocket server for React UI bridge
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.java-websocket:Java-WebSocket:1.6.0")

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
    testImplementation("org.json:json:20260719")
    // Coroutines test support for runTest in SubagentWatcherTest
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    // kotlin.test assertions (assertTrue/assertEquals/etc.) for JVM unit tests
    testImplementation(kotlin("test"))
    // MockWebServer for AnalyticsServiceTest — version matches the OkHttp
    // already on the main classpath (4.12.0).
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    // Mockito for stubbing Android Context in SkillScannerTest. Needed because
    // SkillScanner takes a Context to read web/data/skill-registry.json from
    // app assets — there's no in-memory fake equivalent (unlike SharedPreferences).
    testImplementation("org.mockito:mockito-core:5.23.0")
}
