package com.veto.installedpackage

import android.content.pm.PackageManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class InstalledPackageModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("InstalledPackage")

    AsyncFunction("isInstalled") { packageName: String ->
      val context = appContext.reactContext
      if (context == null) {
        false
      } else {
        try {
          @Suppress("DEPRECATION")
          context.packageManager.getPackageInfo(packageName, 0)
          true
        } catch (_: PackageManager.NameNotFoundException) {
          false
        }
      }
    }
  }
}
