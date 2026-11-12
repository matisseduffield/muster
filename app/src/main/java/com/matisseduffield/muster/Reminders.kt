package com.matisseduffield.muster

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.edit
import org.json.JSONArray
import org.json.JSONObject

/**
 * The Thursday reminder. The page works out which weekends still want an
 * answer and hands over one notice for each ("notify"); the phone shows each
 * at its time. No server is involved. One alarm is kept, for the earliest
 * notice; when it rings, what's due is shown and the next is set.
 */
object Reminders {
    private const val PREFS = "reminders"
    private const val CHANNEL = "weekend"
    const val EXTRA_OPEN = "open"
    val GROUP_PATH = Regex("^/g/[A-Za-z0-9_-]{22}$")

    // A notice this late is about a weekend that's over.
    private const val STALE_MS = 3 * 24 * 60 * 60 * 1000L

    fun allowed(context: Context) = NotificationManagerCompat.from(context).areNotificationsEnabled()

    /** The page's list replaces the stored one. */
    fun set(context: Context, items: JSONArray) {
        val kept = JSONArray()
        for (i in 0 until minOf(items.length(), 16)) {
            val o = items.optJSONObject(i) ?: continue
            val open = o.optString("open")
            if (o.optLong("at") <= 0 || !GROUP_PATH.matches(open)) continue
            kept.put(
                JSONObject()
                    .put("id", o.optString("id").take(40))
                    .put("at", o.optLong("at"))
                    .put("title", o.optString("title").take(80))
                    .put("body", o.optString("body").take(160))
                    .put("open", open),
            )
        }
        save(context, kept)
        schedule(context)
    }

    /** Shows what's due, drops it, and sets the alarm for the next. */
    fun ring(context: Context) {
        val now = System.currentTimeMillis()
        val later = JSONArray()
        val all = load(context)
        for (i in 0 until all.length()) {
            val o = all.getJSONObject(i)
            val at = o.optLong("at")
            if (at > now) later.put(o) else if (now - at < STALE_MS) show(context, o)
        }
        save(context, later)
        schedule(context)
    }

    private fun load(context: Context): JSONArray =
        runCatching { JSONArray(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("items", "[]")) }
            .getOrDefault(JSONArray())

    private fun save(context: Context, items: JSONArray) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit { putString("items", items.toString()) }

    private fun schedule(context: Context) {
        val alarms = context.getSystemService(AlarmManager::class.java) ?: return
        val ring = PendingIntent.getBroadcast(
            context, 0, Intent(context, ReminderReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val all = load(context)
        val next = (0 until all.length()).minOfOrNull { all.getJSONObject(it).optLong("at") }
        if (next == null) alarms.cancel(ring)
        // Not an exact alarm: Android may show it a little after the time.
        else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, ring)
    }

    private fun show(context: Context, item: JSONObject) {
        if (!allowed(context)) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, context.getString(R.string.reminder_channel), NotificationManager.IMPORTANCE_DEFAULT),
        )
        val id = item.optString("id").hashCode()
        val open = PendingIntent.getActivity(
            context, id,
            Intent(context, MainActivity::class.java)
                .putExtra(EXTRA_OPEN, item.optString("open"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notice = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_muster)
            .setContentTitle(item.optString("title").ifEmpty { "Muster" })
            .setContentText(item.optString("body"))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        runCatching { manager.notify(id, notice) }
    }
}

/** The alarm ringing, the phone restarting, or the app being updated. */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = Reminders.ring(context)
}
