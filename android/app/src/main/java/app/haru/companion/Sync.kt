package app.haru.companion

import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

/**
 * One heartbeat to the server.
 *  - Phone mode: phone use since the last sync, battery, permission state, location (if allowed) and
 *    medicine answers. The reply says which medicine doses are due now.
 *  - Room sensor mode: finished 15-minute movement/sound slots, last movement time and events.
 */
object Sync {
    private const val OVERLAP_MS = 60_000L
    private const val MAX_LOOKBACK_MS = 24 * 3600_000L
    private const val FIRST_LOOKBACK_MS = 3600_000L

    /**
     * Returns null on success, or a human-readable error. Blocking (up to [locationWaitMs] waiting for a
     * location fix): call off the main thread. Synchronized so the periodic worker, a "sync soon" after a
     * medicine button and the app screen never send overlapping heartbeats.
     */
    @Synchronized
    fun run(context: Context, manual: Boolean = false, locationWaitMs: Long = 20_000L): String? {
        val prefs = Prefs(context)
        val token = prefs.token ?: return "This phone is not set up yet."
        val now = System.currentTimeMillis()
        if (prefs.isRoom) return runRoom(context, prefs, token, now)
        val access = ActivityReader.hasUsageAccess(context)

        val body = JSONObject()
            .put("manual", manual)
            .put("usageAccess", access)
            .put("locationAccess", LocationReader.hasAccess(context))
            .put("appVersion", BuildConfig.VERSION_NAME)
        ActivityReader.batteryPercent(context)?.let { body.put("battery", it) }
        if (access) {
            val from = if (prefs.lastQueryEnd == 0L) now - FIRST_LOOKBACK_MS
            else maxOf(prefs.lastQueryEnd - OVERLAP_MS, now - MAX_LOOKBACK_MS)
            ActivityReader.latestActivity(context, from, now)?.let { body.put("activityAt", it) }
            val slots = ActivityReader.usageSlots(context, from, now)
            if (slots.isNotEmpty()) body.put("usage", JSONArray(slots))
        }
        LocationReader.read(context, locationWaitMs)?.let { loc ->
            val l = JSONObject().put("lat", loc.latitude).put("lng", loc.longitude).put("at", loc.time)
            if (loc.hasAccuracy()) l.put("accuracy", loc.accuracy.toDouble())
            body.put("location", l)
        }
        val doses = prefs.pendingDoses()
        if (doses.length() > 0) body.put("doses", doses)

        return try {
            val res = Api.post("${prefs.serverUrl}/api/device/heartbeat", token, body)
            prefs.lastQueryEnd = now
            prefs.lastSyncAt = now
            prefs.lastError = ""
            if (doses.length() > 0) prefs.removeDoses(doses) // only now is it safe to forget them
            res.optString("seniorName").takeIf { it.isNotEmpty() }?.let { prefs.seniorName = it }
            // Older servers don't send "meds": leave reminders alone rather than clearing them.
            // A notification problem must not turn a successful heartbeat into an error.
            res.optJSONArray("meds")?.let { meds -> runCatching { MedReminders.update(context, meds) } }
            null
        } catch (e: Exception) {
            failed(context, prefs, e)
        }
    }

    /**
     * Room sensor heartbeat. Only finished slots are sent, so each slot goes up once with its final
     * numbers. Slots and events stay in Prefs until the server says 2xx; the server ignores repeats.
     */
    private fun runRoom(context: Context, prefs: Prefs, token: String, now: Long): String? {
        val slots = prefs.finishedRoomSlots(now)
        val events = prefs.roomEvents()
        val signals = JSONObject().put("slots", slots).put("events", events)
        prefs.lastMotionAt.takeIf { it > 0L }?.let { signals.put("lastMotionAt", it) }
        val body = JSONObject().put("appVersion", BuildConfig.VERSION_NAME).put("signals", signals)
        ActivityReader.batteryPercent(context)?.let { body.put("battery", it) }

        return try {
            val res = Api.post("${prefs.serverUrl}/api/device/heartbeat", token, body)
            prefs.lastSyncAt = now
            prefs.lastError = ""
            prefs.removeRoomSlots(slots)
            prefs.removeRoomEvents(events)
            res.optString("seniorName").takeIf { it.isNotEmpty() }?.let { prefs.seniorName = it }
            null
        } catch (e: Exception) {
            failed(context, prefs, e)
        }
    }

    /** Records and returns a human-readable error. A 401 means an admin disconnected this device. */
    private fun failed(context: Context, prefs: Prefs, e: Exception): String {
        prefs.lastError = if (e is ApiException) {
            if (e.status == 401) {
                // disconnected by an admin: stop everything and show the setup screen again
                if (prefs.isRoom) RoomSensorService.stop(context)
                MedReminders.cancelAll(context)
                prefs.unpair()
                SyncWorker.cancel(context)
            }
            e.message ?: "Server error"
        } else {
            "Can't reach Haru. Check the internet connection."
        }
        return prefs.lastError
    }

    fun deviceModel(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
}
