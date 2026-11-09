package app.haru.companion

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.text.format.DateFormat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.Date

/**
 * Medicine reminders. Each heartbeat reply lists the doses that are due now ("meds"); we keep one
 * notification per dose with "I took it" / "Skip" buttons, and the answer goes back on the next heartbeat.
 */
object MedReminders {
    private const val CHANNEL_ID = "med-reminders"
    private const val KEEP_NOTIFIED_MS = 3 * 24 * 3600_000L

    const val STATUS_TAKEN = "taken"
    const val STATUS_SKIPPED = "skipped"

    /** Same dose -> same notification id, so re-posting updates it in place. */
    fun notificationId(medicationId: Int, dueAt: Long): Int = Prefs.doseKey(medicationId, dueAt).hashCode()

    fun canNotify(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return false
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /**
     * Bring notifications in line with the server's list of due doses: alert for new ones, quietly
     * refresh ones already shown, and remove ones that are no longer due (taken elsewhere, or expired).
     */
    @SuppressLint("MissingPermission") // canNotify() checks POST_NOTIFICATIONS first
    fun update(context: Context, meds: JSONArray) {
        val prefs = Prefs(context)
        val pending = prefs.pendingDoseKeys()
        val nm = NotificationManagerCompat.from(context)
        val notified = prefs.notifiedDoses
        val now = System.currentTimeMillis()

        // Doses the senior already answered but the server hasn't heard about yet aren't "due" here.
        val due = JSONArray()
        val dueKeys = HashSet<String>()
        for (i in 0 until meds.length()) {
            val m = meds.optJSONObject(i) ?: continue
            val key = Prefs.doseKey(m.optInt("medicationId"), m.optLong("dueAt"))
            if (key in pending) continue
            due.put(m)
            dueKeys.add(key)
        }
        prefs.dueMeds = due

        // Remove notifications for doses that dropped off the list.
        for (key in notified.keys().asSequence().toList()) {
            if (key in dueKeys) continue
            val parts = key.split(":")
            val id = parts.getOrNull(0)?.toIntOrNull()
            val dueAt = parts.getOrNull(1)?.toLongOrNull()
            if (id != null && dueAt != null) nm.cancel(notificationId(id, dueAt))
            // Keep the "already alerted" mark for a while so a flickering list can't alert twice.
            if (dueAt == null || now - dueAt > KEEP_NOTIFIED_MS) notified.remove(key)
        }

        if (canNotify(context)) {
            ensureChannel(context)
            for (i in 0 until due.length()) {
                val m = due.getJSONObject(i)
                val medId = m.optInt("medicationId")
                val dueAt = m.optLong("dueAt")
                val key = Prefs.doseKey(medId, dueAt)
                nm.notify(notificationId(medId, dueAt), build(context, m, silent = notified.has(key)))
                notified.put(key, dueAt)
            }
        }
        prefs.notifiedDoses = notified
    }

    /**
     * The senior answered a dose (from a notification button or the main screen): remember it,
     * clear the reminder, and sync soon so family sees it.
     */
    fun record(context: Context, medicationId: Int, dueAt: Long, status: String) {
        val prefs = Prefs(context)
        prefs.queueDose(medicationId, dueAt, status, System.currentTimeMillis())
        prefs.removeDueMed(medicationId, dueAt)
        NotificationManagerCompat.from(context).cancel(notificationId(medicationId, dueAt))
        SyncWorker.syncSoon(context)
    }

    /** Clear every reminder (used when the phone is disconnected). */
    fun cancelAll(context: Context) {
        NotificationManagerCompat.from(context).cancelAll()
    }

    /** "500 mg · due 8:00 AM" */
    fun describe(context: Context, m: JSONObject): String {
        val time = DateFormat.getTimeFormat(context).format(Date(m.optLong("dueAt")))
        val whenText = if (m.optString("status") == "late") "was due $time" else "due $time"
        val dose = m.optString("dose").trim()
        return if (dose.isEmpty()) whenText.replaceFirstChar { it.uppercase() } else "$dose · $whenText"
    }

    fun titleFor(m: JSONObject): String {
        val name = m.optString("name").trim()
        return if (name.isEmpty()) "Time for your medicine" else "Time for your $name"
    }

    private fun build(context: Context, m: JSONObject, silent: Boolean): android.app.Notification {
        val medId = m.optInt("medicationId")
        val dueAt = m.optLong("dueAt")
        val id = notificationId(medId, dueAt)
        val open = PendingIntent.getActivity(
            context, id,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notify)
            .setColor(0xFF185FA5.toInt())
            .setContentTitle(titleFor(m))
            .setContentText(describe(context, m))
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(open)
            .setAutoCancel(false)
            .setOnlyAlertOnce(true)
            .setSilent(silent) // already alerted for this dose: just refresh it quietly
            .addAction(0, "I took it", actionIntent(context, id, medId, dueAt, STATUS_TAKEN))
            .addAction(0, "Skip", actionIntent(context, id, medId, dueAt, STATUS_SKIPPED))
            .build()
    }

    private fun actionIntent(context: Context, id: Int, medId: Int, dueAt: Long, status: String): PendingIntent {
        val intent = Intent(context, DoseActionReceiver::class.java)
            .setAction(DoseActionReceiver.ACTION_PREFIX + status) // different action per button = separate PendingIntents
            .putExtra(DoseActionReceiver.EXTRA_MEDICATION_ID, medId)
            .putExtra(DoseActionReceiver.EXTRA_DUE_AT, dueAt)
            .putExtra(DoseActionReceiver.EXTRA_STATUS, status)
        return PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun ensureChannel(context: Context) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(CHANNEL_ID, "Medication reminders", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Reminds you when it's time to take your medicine."
        }
        nm.createNotificationChannel(channel)
    }
}
