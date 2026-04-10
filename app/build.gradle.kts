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
    namespace = "com.destin.code"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.destin.code"
        minSdk = 28
        targetSdk = 35
        versionCode = 7
        versionName = "2.3.2"
    }

    signingConfigs {
        create("release") {
            storeFile = file(keystoreProperties.getProperty("storeFile", "release-keystore.jks"))
            storePassword = keystoreProperties.getProperty("storePassword", "")
            keyAlias = keystoreProperties.getProperty("keyAlias", "destincode")
            keyPassword = keystoreProperties.getProperty("keyPassword", "")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = signingConfigs.getByName("release")
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


    // Termux terminal emulator (PTY session management) + terminal view (native rendering)
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
}
