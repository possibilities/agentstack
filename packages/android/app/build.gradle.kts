plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.agentstack.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.agentstack.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")
    // Keeps the share token out of plain SharedPreferences.
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    // Redelivery of held shares: a persisted queue that survives process death
    // and reboot, and waits for a network rather than waking without one.
    implementation("androidx.work:work-runtime:2.9.1")

    // org.json ships with Android but is stubbed on the JVM, so unit tests need
    // a real implementation to exercise payload serialization.
    testImplementation("org.json:json:20240303")
    testImplementation("junit:junit:4.13.2")
    testImplementation(kotlin("test"))
}
