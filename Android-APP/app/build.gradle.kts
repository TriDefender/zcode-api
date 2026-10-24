plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Version/signing properties accept BOTH spellings: dotted for local
// -PandroidApp.versionName (see README), underscored for CI's
// ORG_GRADLE_PROJECT_androidApp_versionName — Gradle maps that env prefix to
// the property name VERBATIM (env vars can't carry dots). The two forms must
// both be accepted or CI APKs silently fall back to versionCode=1 /
// versionName="3.0.0-android" and UpdateChecker flags every fresh install as
// outdated.
fun prop(name: String) =
    providers.gradleProperty(name)
        .orElse(providers.gradleProperty(name.replace('.', '_')))

// Fail loud when CI forgets the version props — a silent fallback ships an
// APK that permanently prompts for updates (UpdateChecker.isNewer).
if (System.getenv("CI") == "true") {
    val missing = listOf("androidApp.versionCode", "androidApp.versionName")
        .filter { prop(it).orNull == null }
    if (missing.isNotEmpty()) {
        throw GradleException(
            "CI build is missing gradle properties: $missing — set " +
                "ORG_GRADLE_PROJECT_androidApp_versionCode / ORG_GRADLE_PROJECT_androidApp_versionName " +
                "(see release.yml build-android job)"
        )
    }
}

android {
    namespace = "com.zcode.proxy"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.zcode.proxy"
        minSdk = 24
        targetSdk = 35
        versionCode = prop("androidApp.versionCode").orNull?.toIntOrNull() ?: 1
        // CI injects the release tag via androidApp.versionName; local/dev
        // builds derive "<repo package.json version>-android" so they only
        // prompt for an update when a genuinely newer release exists.
        val repoVersion = runCatching {
            Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
                .find(rootProject.file("../package.json").readText())?.groupValues?.get(1)
        }.getOrNull()
        versionName = prop("androidApp.versionName").orNull ?: "${repoVersion ?: "0.0.0"}-android"
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    signingConfigs {
        create("release") {
            val storeFilePath = prop("androidSigning.keystoreFile").orNull
            if (storeFilePath != null) {
                storeFile = file(storeFilePath)
                storePassword = prop("androidSigning.storePassword").get()
                keyAlias = prop("androidSigning.keyAlias").get()
                keyPassword = prop("androidSigning.keyPassword").get()
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
// captcha-worker-entry.cjs is the same script's second output: Android runs
// captcha solving STRICTLY in worker threads (ZCODE_CAPTCHA_REQUIRE_WORKER=1),
// so a missing entry means every start-plan request 503s — guard it too.
val serverBundleFile = file("src/main/assets/server_bundle/server.cjs")
val captchaWorkerEntryFile = file("src/main/assets/server_bundle/captcha-worker-entry.cjs")
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
        val workerSize = if (captchaWorkerEntryFile.exists()) captchaWorkerEntryFile.length() else 0L
        if (workerSize < 100_000L) {
            throw GradleException(
                "server_bundle/captcha-worker-entry.cjs is missing or implausible ($workerSize bytes). " +
                    "Generate it first:\n" +
                    "  bun run build:android-bundle\n" +
                    "  cp dist/android/captcha-worker-entry.cjs Android-APP/app/src/main/assets/server_bundle/captcha-worker-entry.cjs"
            )
        }
    }
}
tasks.named("preBuild") { dependsOn(checkServerBundle) }
