// Vendored copy of Termux's terminal-emulator module (v0.118.1).
// Patched to add a RawByteListener hook on TerminalEmulator.append().
// See VENDORED.md for origin, patch details, and re-vendor procedure.
plugins {
    id("com.android.library")
}

android {
    namespace = "com.termux.terminal.vendored"
    compileSdk = 35

    defaultConfig {
        minSdk = 28
        consumerProguardFiles("consumer-rules.pro")

        // Deviation from plan: upstream uses ndkBuild (Android.mk), not cmake.
        // cFlags match the upstream terminal-emulator/build.gradle exactly so
        // the resulting .so has identical compile options to the JitPack artifact.
        externalNativeBuild {
            ndkBuild {
                cFlags("-std=c11", "-Wall", "-Wextra", "-Werror", "-Os", "-fno-stack-protector", "-Wl,--gc-sections")
            }
        }

        ndk {
            abiFilters += listOf("x86", "x86_64", "armeabi-v7a", "arm64-v8a")
        }
    }

    // Deviation from plan: upstream uses Android.mk (ndkBuild), not CMakeLists.txt (cmake).
    // Path matches the vendored file at src/main/jni/Android.mk.
    externalNativeBuild {
        ndkBuild {
            path = file("src/main/jni/Android.mk")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
