plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.zcode.proxy"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.zcode.proxy"
        minSdk = 24
        targetSdk = 35
        versionCode = providers.gradleProperty("androidApp.versionCode").orNull?.toIntOrNull() ?: 1
        versionName = providers.gradleProperty("androidApp.versionName").orNull ?: "3.0.0-android"
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    signingConfigs {
        create("release") {
            val storeFilePath = providers.gradleProperty("androidSigning.keystoreFile").orNull
            if (storeFilePath != null) {
                storeFile = file(storeFilePath)
                storePassword = providers.gradleProperty("androidSigning.storePassword").get()
                keyAlias = providers.gradleProperty("androidSigning.keyAlias").get()
                keyPassword = providers.gradleProperty("androidSigning.keyPassword").get()
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            val releaseSigning = signingConfigs.getByName("release")
            if (releaseSigning.storeFile != null) {
                signingConfig = releaseSigning
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.browser:browser:1.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}

// server.cjs is build output (gitignored), generated from ../../src by
// "bun run build:android-bundle" + copy — release CI regenerates it before
// packaging; local builds must too. Fail at build time rather than shipping
// an APK whose NodeRunner dies on first launch over a missing bundle.
val serverBundleFile = file("src/main/assets/server_bundle/server.cjs")
val checkServerBundle = tasks.register("checkServerBundle") {
    doLast {
        val size = if (serverBundleFile.exists()) serverBundleFile.length() else 0L
        if (size < 1_000_000L) {
            throw GradleException(
                "server_bundle/server.cjs is missing or implausible ($size bytes). " +
                    "Generate it first:\n" +
                    "  bun run build:android-bundle\n" +
                    "  cp dist/android/server.cjs Android-APP/app/src/main/assets/server_bundle/server.cjs"
            )
        }
    }
}
tasks.named("preBuild") { dependsOn(checkServerBundle) }
