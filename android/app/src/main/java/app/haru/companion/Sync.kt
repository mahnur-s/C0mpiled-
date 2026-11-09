package app.haru.companion

import android.content.Context
import android.os.Build
import org.json.JSONObject

/** One heartbeat to the server: latest phone use since the last sync, battery, and permission state. */
object Sync {
    private const val OVERLAP_MS = 60_000L
    private const val MAX_LOOKBACK_MS = 24 * 3600_000L
    private const val FIRST_LOOKBACK_MS = 3600_000L

    /** Returns null on success, or a human-readable error. Blocking: call off the main thread. */
    fun run(context: Context, manual: Boolean = false): String? {
        val prefs = Prefs(context)
        val token = prefs.token ?: return "This phone is not set up yet."
        val now = System.currentTimeMillis()
        val access = ActivityReader.hasUsageAccess(context)

        val body = JSONObject()
            .put("manual", manual)
            .put("usageAccess", access)
            .put("appVersion", BuildConfig.VERSION_NAME)
        ActivityReader.batteryPercent(context)?.let { body.put("battery", it) }
        if (access) {
            val from = if (prefs.lastQueryEnd == 0L) now - FIRST_LOOKBACK_MS
            else maxOf(prefs.lastQueryEnd - OVERLAP_MS, now - MAX_LOOKBACK_MS)
            ActivityReader.latestActivity(context, from, now)?.let { body.put("activityAt", it) }
        }

        return try {
            val res = Api.post("${prefs.serverUrl}/api/device/heartbeat", token, body)
            prefs.lastQueryEnd = now
            prefs.lastSyncAt = now
            prefs.lastError = ""
            res.optString("seniorName").takeIf { it.isNotEmpty() }?.let { prefs.seniorName = it }
            null
        } catch (e: ApiException) {
            if (e.status == 401) {
                prefs.unpair() // disconnected by an admin: show the setup screen again
                SyncWorker.cancel(context)
            }
            prefs.lastError = e.message ?: "Server error"
            prefs.lastError
        } catch (e: Exception) {
            prefs.lastError = "Can't reach Haru. Check the internet connection."
            prefs.lastError
        }
    }

    fun deviceModel(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
}
