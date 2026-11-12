package com.matisseduffield.muster.updates

import android.app.AlertDialog
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.matisseduffield.muster.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.File

/**
 * The self-updater's side of MainActivity: when to check, and the dialog that
 * offers a new version. The play flavor has a class of the same name whose
 * methods do nothing, so main code compiles for both.
 */
class AppUpdates(private val activity: ComponentActivity) {
    private companion object {
        const val CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000L
    }

    private var lastUpdateCheck = 0L
    private var updatePromptOpen = false

    // "Later" holds for as long as the app stays running.
    private var declined = 0

    /** Call from onCreate. [firstCreate] is false when the activity is being rebuilt. */
    fun start(firstCreate: Boolean) {
        // A downloaded update has done its job once the new version is running.
        if (firstCreate) {
            activity.lifecycleScope.launch(Dispatchers.IO) { File(activity.cacheDir, "updates").deleteRecursively() }
        }

        activity.lifecycleScope.launch {
            UpdateManager.installError.collect { message ->
                if (message != null) {
                    Toast.makeText(activity, message, Toast.LENGTH_LONG).show()
                    UpdateManager.installError.value = null
                }
            }
        }
    }

    fun onResume() {
        val now = System.currentTimeMillis()
        if (updatePromptOpen || now - lastUpdateCheck < CHECK_INTERVAL_MS) return
        lastUpdateCheck = now
        activity.lifecycleScope.launch {
            val result = UpdateManager.check()
            if (result is UpdateManager.CheckResult.Available && !activity.isFinishing &&
                !updatePromptOpen && result.info.versionCode != declined
            ) offerUpdate(result.info)
        }
    }

    private fun offerUpdate(info: UpdateManager.UpdateInfo) {
        updatePromptOpen = true
        val notes = info.notes.joinToString("\n") { "• $it" }
        AlertDialog.Builder(activity)
            .setTitle("Muster ${info.versionName} is ready")
            .setMessage(notes.ifEmpty { "You have ${BuildConfig.VERSION_NAME}." })
            .setPositiveButton("Update") { _, _ -> runUpdate(info) }
            .setNegativeButton("Later") { _, _ -> declined = info.versionCode }
            .setOnDismissListener { updatePromptOpen = false }
            .show()
    }

    private fun runUpdate(info: UpdateManager.UpdateInfo) {
        val pad = (24 * activity.resources.displayMetrics.density).toInt()
        val bar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            isIndeterminate = info.sizeBytes <= 0
        }
        val box = FrameLayout(activity).apply {
            setPadding(pad, pad / 2, pad, 0)
            addView(bar)
        }
        val progress = AlertDialog.Builder(activity)
            .setTitle("Downloading ${info.versionName}")
            .setView(box)
            .setCancelable(false)
            .show()

        activity.lifecycleScope.launch {
            try {
                val apk = UpdateManager.download(activity, info) { fraction ->
                    activity.runOnUiThread { bar.progress = (fraction * 100).toInt() }
                }
                progress.dismiss()
                UpdateManager.install(activity, apk)
            } catch (e: Exception) {
                progress.dismiss()
                Toast.makeText(
                    activity,
                    "Update failed: ${e.message ?: "unknown error"}",
                    Toast.LENGTH_LONG,
                ).show()
            }
        }
    }
}
