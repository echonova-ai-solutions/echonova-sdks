allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
// flutter_pcm_sound (3.3.3, its latest release) compiles against Android API 33, but the
// AndroidX libraries Flutter brings in need 34 or later. Plugins below 34 are compiled
// against API 36 instead. compileSdk only sets which Android APIs the plugin's code is
// checked against; how and where the app runs (minSdk, targetSdk) is unchanged.
subprojects {
    val raiseCompileSdk: () -> Unit = {
        extensions.findByType(com.android.build.api.dsl.LibraryExtension::class.java)?.let { android ->
            if ((android.compileSdk ?: 0) < 34) {
                android.compileSdk = 36
            }
        }
    }
    if (state.executed) raiseCompileSdk() else afterEvaluate { raiseCompileSdk() }
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
