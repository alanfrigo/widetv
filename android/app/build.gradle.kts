import java.util.Properties

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.serialization)
}

/**
 * Assinatura de release fica fora do repositorio.
 *
 * Com `keystore.properties` presente o release sai assinado com a chave de
 * verdade; sem ele o build ainda funciona (assinado em debug), para nao travar
 * quem so quer compilar.
 */
val keystoreProperties = Properties().apply {
  val file = rootProject.file("keystore.properties")
  if (file.exists()) file.inputStream().use { load(it) }
}

/**
 * Endereco padrao do servidor.
 *
 * Fica em `local.properties`, que nao vai para o repositorio: o dominio de casa
 * nao e assunto de codigo aberto. Sem a chave o app abre com o campo vazio e
 * pergunta o endereco na primeira vez, que e o comportamento correto para quem
 * clonar isto sem ser o dono do servidor.
 *
 *   # android/local.properties
 *   widetv.defaultServer=https://tv.exemplo.tld
 */
val localProperties = Properties().apply {
  val file = rootProject.file("local.properties")
  if (file.exists()) file.inputStream().use { load(it) }
}
val defaultServerUrl: String = localProperties.getProperty("widetv.defaultServer", "")

android {
  namespace = "com.widetv.app"
  compileSdk = 35

  defaultConfig {
    applicationId = "com.widetv.app"
    minSdk = 23
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"

    // Padrao; a tela de acesso deixa trocar sem recompilar.
    buildConfigField("String", "DEFAULT_SERVER_URL", "\"$defaultServerUrl\"")
  }

  signingConfigs {
    if (keystoreProperties.isNotEmpty()) {
      create("release") {
        storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
        storePassword = keystoreProperties.getProperty("storePassword")
        keyAlias = keystoreProperties.getProperty("keyAlias")
        keyPassword = keystoreProperties.getProperty("keyPassword")
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      signingConfig =
        if (keystoreProperties.isNotEmpty()) signingConfigs.getByName("release")
        else signingConfigs.getByName("debug")
    }
  }

  buildFeatures {
    buildConfig = true
    viewBinding = true
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
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.appcompat)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.recyclerview)
  implementation(libs.kotlinx.coroutines.android)
  implementation(libs.kotlinx.serialization.json)
  implementation(libs.okhttp)
  implementation(libs.media3.exoplayer)
  implementation(libs.media3.ui)
  implementation(libs.media3.datasource.okhttp)

  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
}
