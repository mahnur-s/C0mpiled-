package app.haru.companion

import android.content.Context

/** Small typed wrapper over SharedPreferences. Backups are disabled, so the device token stays on this phone. */
class Prefs(context: Context) {
    private val p = context.getSharedPreferences("haru", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = p.getString("server_url", "") ?: ""
        set(v) = p.edit().putString("server_url", v).apply()

    var token: String?
        get() = p.getString("token", null)
        set(v) = p.edit().putString("token", v).apply()

    var seniorName: String
        get() = p.getString("senior_name", "") ?: ""
        set(v) = p.edit().putString("senior_name", v).apply()

    /** End of the last usage window successfully reported, so the next sync only looks at newer events. */
    var lastQueryEnd: Long
        get() = p.getLong("last_query_end", 0L)
        set(v) = p.edit().putLong("last_query_end", v).apply()

    var lastSyncAt: Long
        get() = p.getLong("last_sync_at", 0L)
        set(v) = p.edit().putLong("last_sync_at", v).apply()

    var lastError: String
        get() = p.getString("last_error", "") ?: ""
        set(v) = p.edit().putString("last_error", v).apply()

    val isPaired: Boolean get() = !token.isNullOrEmpty()

    fun unpair() {
        p.edit().remove("token").remove("last_query_end").remove("last_sync_at").remove("last_error").apply()
    }
}
