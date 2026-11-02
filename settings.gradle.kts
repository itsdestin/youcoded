pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
// WHY no jitpack.io (security audit): nothing the app depends on comes from there (every dependency
// is on Google or Maven Central; the old Termux terminal library is vendored). An unused extra
// repository only gives someone else a place to plant a look-alike package.
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "youcoded"
include(":app")
