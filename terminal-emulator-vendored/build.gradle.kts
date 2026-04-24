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

        // TODO(Task 2): uncomment once src/main/jni/CMakeLists.txt is vendored in.
        // externalNativeBuild {
        //     cmake {
        //         cppFlags("")
        //     }
        // }
    }

    // TODO(Task 2): uncomment once src/main/jni/CMakeLists.txt is vendored in.
    // externalNativeBuild {
    //     cmake {
    //         path = file("src/main/jni/CMakeLists.txt")
    //         version = "3.22.1"
    //     }
    // }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
