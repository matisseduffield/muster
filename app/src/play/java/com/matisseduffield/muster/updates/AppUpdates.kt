package com.matisseduffield.muster.updates

import androidx.activity.ComponentActivity

/**
 * Play builds update through the store, so MainActivity's calls land here and
 * do nothing. The real updater is in the github flavor, under the same name.
 */
@Suppress("UNUSED_PARAMETER")
class AppUpdates(activity: ComponentActivity) {
    fun start(firstCreate: Boolean) = Unit
    fun onResume() = Unit
}
