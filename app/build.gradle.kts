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

// Diagnostic producer adapter for AGP's generated-sources API. The API carries
// dependency edges to EVERY asset/JNI reader (including lint), rather than a
// brittle list of internal task names. Default builds do not register this task.
abstract class SpeedPayloadTask : org.gradle.api.DefaultTask() {
    @get:org.gradle.api.tasks.InputDirectory abstract val webDirectory: org.gradle.api.file.DirectoryProperty
    @get:org.gradle.api.tasks.InputDirectory abstract val backendDirectory: org.gradle.api.file.DirectoryProperty
    @get:org.gradle.api.tasks.InputDirectory abstract val runtimeDirectory: org.gradle.api.file.DirectoryProperty
    @get:org.gradle.api.tasks.OutputDirectory abstract val assetDirectory: org.gradle.api.file.DirectoryProperty
    @get:org.gradle.api.tasks.OutputDirectory abstract val nativeDirectory: org.gradle.api.file.DirectoryProperty
    @get:javax.inject.Inject abstract val fileOperations: org.gradle.api.file.FileSystemOperations

    @org.gradle.api.tasks.TaskAction
    fun materialize() {
        fileOperations.sync {
            from(webDirectory) { into("web") }
            from(backendDirectory)
            from(runtimeDirectory.dir("assets"))
            into(assetDirectory)
        }
        fileOperations.sync {
            from(runtimeDirectory.dir("jniLibs"))
            into(nativeDirectory)
        }
    }
}

// WHY: benchmark only. Defaults retain the current production task graph; the
// opt-in connects expensive generated payloads to packaging, not JVM tests.
val ciPackagingDependencies = providers.gradleProperty("ciPackagingDependencies")
    .map { it.toBooleanStrict() }.orElse(false).get()

android {
    namespace = "com.youcoded.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.youcoded.app"
        minSdk = 28
        targetSdk = 35
        versionCode = 21
        versionName = "1.3.0"
        // WHY: the bundled programs (app/runtime/build-runtime.sh) are arm64 only, but ML Kit brings
        // native libs for all four ABIs, so the APK would advertise armeabi-v7a, x86 and x86_64 too and
        // install on phones it cannot run on. Filtering makes that honest at install time.
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

    // WHY (2026-10-14, Android clean rebuild): the bundled programs ship as jniLibs so Android unpacks them
    // into the one folder an app may execute from. They must stay files on disk, not inside the APK.
    packaging {
        jniLibs {
            useLegacyPackaging = true
            keepDebugSymbols += "**/*.so"
        }
    }

    // The runtime's programs name their package's files folder (/data/data/<applicationId>/files/usr/lib),
    // so each variant gets its own build of them (runtimeTasks below); the backend is the same for all.
    sourceSets {
        if (!ciPackagingDependencies) getByName("main").assets.srcDir(layout.buildDirectory.dir("backend-assets"))
        for (variant in listOf("debug", "release", "releaseTest").filter { !ciPackagingDependencies }) {
            getByName(variant).jniLibs.srcDir(layout.buildDirectory.dir("runtime/$variant/jniLibs"))
            getByName(variant).assets.srcDir(layout.buildDirectory.dir("runtime/$variant/assets"))
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
if (!ciPackagingDependencies) {
    tasks.matching { it.name == "preBuild" }.configureEach {
        dependsOn(bundleWebUi)
    }
}

// The phone's programs and the desktop backend (Android clean rebuild, 2026-10-14). Both are cached by
// Gradle: they rebuild only when their scripts, pins or the desktop source change.
fun bashCommand(script: File, vararg args: String): List<String> = listOf("bash", script.absolutePath) + args

val buildBackend = tasks.register<Exec>("buildBackend") {
    description = "Pack the desktop backend for the phone (app/runtime/build-backend.sh)"
    group = "build"
    // The backend compiles with the desktop's own dependencies, which bundleWebUi installs (npm ci). WHY (CI,
    // 2026-10-15): on a fresh checkout this task ran first and found no node_modules.
    dependsOn(bundleWebUi)
    val repoRoot = rootProject.projectDir
    val script = file("runtime/build-backend.sh")
    val out = layout.buildDirectory.dir("backend").get().asFile
    val assetsOut = layout.buildDirectory.dir("backend-assets").get().asFile
    inputs.file(script)
    inputs.file(file("runtime/preserve-npm-legal.py"))
    inputs.dir(File(repoRoot, "desktop/src/main"))
    inputs.dir(File(repoRoot, "desktop/src/shared"))
    inputs.dir(File(repoRoot, "desktop/hook-scripts"))
    // The backend compiles a few renderer modules and ships the skill registry from there, plus these files
    // (independent review, 2026-10-15: without them a change there shipped the previous backend).
    inputs.dir(File(repoRoot, "desktop/src/renderer"))
    inputs.file(File(repoRoot, "desktop/package.json"))
    inputs.file(File(repoRoot, "desktop/scripts/install-hooks.js"))
    inputs.file(File(repoRoot, "desktop/tsconfig.json"))
    inputs.file(File(repoRoot, "desktop/package-lock.json"))
    outputs.dir(assetsOut)
    commandLine(bashCommand(script, out.absolutePath))
    doLast {
        assetsOut.mkdirs()
        File(out, "backend.tgz").copyTo(File(assetsOut, "backend.tgz"), overwrite = true)
    }
}

val runtimeTasks = mutableMapOf<String, org.gradle.api.tasks.TaskProvider<Exec>>()
val variantAppIds = mapOf("Debug" to "com.youcoded.app.dev", "Release" to "com.youcoded.app", "ReleaseTest" to "com.youcoded.app.releasetest")
for ((variant, appId) in variantAppIds) {
    val runtimeTask = tasks.register<Exec>("buildRuntime$variant") {
        description = "Build the phone's programs for $appId (app/runtime/build-runtime.sh)"
        group = "build"
        val out = layout.buildDirectory.dir("runtime/${variant.replaceFirstChar { it.lowercase() }}").get().asFile
        dependsOn(bundleWebUi) // node-pty source is an exact runtime build input too.
        // WHY: Python tests generate bytecode inside this source directory.
        // It is neither authored runtime input nor included in source evidence;
        // treating it as input can rebuild every native variant spuriously.
        inputs.files(fileTree("runtime") { exclude("**/__pycache__/**", "**/*.pyc") })
        // WHY: native headers/sources and lock/config changes must invalidate runtime evidence too.
        inputs.files(rootProject.file("desktop/package.json"), rootProject.file("desktop/package-lock.json"),
            rootProject.file("gradle.properties"), rootProject.file("build.gradle.kts"), rootProject.file("settings.gradle.kts"))
        inputs.dir(rootProject.file("desktop/node_modules/node-pty/src"))
        inputs.dir(rootProject.file("desktop/node_modules/node-pty/third_party"))
        inputs.dir(rootProject.file("desktop/node_modules/node-pty/node_modules/node-addon-api"))
        inputs.property("collectSources", providers.environmentVariable("YOUCODED_COLLECT_SOURCES").orElse("0"))
        inputs.property("experimentalCommonNative", providers.environmentVariable("YOUCODED_COMMON_NATIVE_CACHE")
            .map { it.isNotBlank() }.orElse(false))
        inputs.dir(file("src/main/kotlin/com/youcoded/app/runtime"))
        inputs.files(rootProject.file("LICENSE"), rootProject.file("TERMS.md"), file("build.gradle.kts"))
        outputs.dir(out)
        commandLine(bashCommand(file("runtime/build-runtime.sh"), appId, out.absolutePath))
    }
    runtimeTasks[variant] = runtimeTask
    if (!ciPackagingDependencies) {
        tasks.matching { it.name == "pre${variant}Build" }.configureEach {
            dependsOn(runtimeTask, buildBackend)
        }
    }
}

if (ciPackagingDependencies) {
    androidComponents.onVariants { variant ->
        val capital = variant.name.replaceFirstChar { it.uppercaseChar() }
        val payload = tasks.register<SpeedPayloadTask>("materialize${capital}SpeedPayload") {
            dependsOn(bundleWebUi, buildBackend, runtimeTasks.getValue(capital))
            webDirectory.set(layout.projectDirectory.dir("src/main/assets/web"))
            backendDirectory.set(layout.buildDirectory.dir("backend-assets"))
            runtimeDirectory.set(layout.buildDirectory.dir("runtime/${variant.name}"))
            assetDirectory.set(layout.buildDirectory.dir("speed-payload/${variant.name}/assets"))
            nativeDirectory.set(layout.buildDirectory.dir("speed-payload/${variant.name}/jniLibs"))
        }
        // WHY: public AGP source registration propagates producer dependencies
        // to merge, lint and future consumers without guessing task names.
        variant.sources.assets?.addGeneratedSourceDirectory(payload, SpeedPayloadTask::assetDirectory)
        variant.sources.jniLibs?.addGeneratedSourceDirectory(payload, SpeedPayloadTask::nativeDirectory)
        // AGP 8.7 lint also reads the static source-provider asset roots. Order
        // its ENTIRE variant lint family after the one modeled source producer,
        // not a growing list of individual internal model/analyzer task names.
        tasks.matching { it.name.contains("lint", ignoreCase = true) &&
            (it.name.endsWith(capital) || it.name.startsWith("generate${capital}Lint")) }.configureEach {
            dependsOn(payload)
        }
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



    // Unpacking the backend and data files the app ships (RuntimeInstaller.kt).
    implementation("org.apache.commons:commons-compress:1.28.0")

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
    testImplementation(kotlin("test"))
}
