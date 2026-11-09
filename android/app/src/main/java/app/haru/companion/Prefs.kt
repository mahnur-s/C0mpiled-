package app.haru.companion

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

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

    // ---------- medication doses ----------
    // The notification buttons, the main screen and the sync worker can all touch these at once,
    // so every read-modify-write holds LOCK, and writes use commit() so they survive the process ending
    // right after a notification button is tapped.

    /** Dose actions ("taken"/"skipped") not yet confirmed by the server, as a JSON array of objects. */
    fun pendingDoses(): JSONArray = synchronized(LOCK) { array("pending_doses") }

    /** Queue one dose action. A newer action for the same dose replaces an older one. */
    fun queueDose(medicationId: Int, dueAt: Long, status: String, at: Long) = synchronized(LOCK) {
        val key = doseKey(medicationId, dueAt)
        val out = JSONArray()
        val old = array("pending_doses")
        for (i in 0 until old.length()) {
            val d = old.optJSONObject(i) ?: continue
            if (doseKey(d.optInt("medicationId"), d.optLong("dueAt")) != key) out.put(d)
        }
        out.put(JSONObject().put("medicationId", medicationId).put("dueAt", dueAt).put("status", status).put("at", at))
        p.edit().putString("pending_doses", out.toString()).commit()
    }

    /** Forget queued actions the server has now accepted (matched on dose and action time). */
    fun removeDoses(sent: JSONArray) = synchronized(LOCK) {
        val sentKeys = HashSet<String>()
        for (i in 0 until sent.length()) {
            val d = sent.optJSONObject(i) ?: continue
            sentKeys.add(doseKey(d.optInt("medicationId"), d.optLong("dueAt")) + "@" + d.optLong("at"))
        }
        val out = JSONArray()
        val old = array("pending_doses")
        for (i in 0 until old.length()) {
            val d = old.optJSONObject(i) ?: continue
            if (doseKey(d.optInt("medicationId"), d.optLong("dueAt")) + "@" + d.optLong("at") !in sentKeys) out.put(d)
        }
        p.edit().putString("pending_doses", out.toString()).commit()
    }

    /** Keys of doses with an action waiting in the queue, so they aren't shown as due again meanwhile. */
    fun pendingDoseKeys(): Set<String> = synchronized(LOCK) {
        val keys = HashSet<String>()
        val a = array("pending_doses")
        for (i in 0 until a.length()) {
            val d = a.optJSONObject(i) ?: continue
            keys.add(doseKey(d.optInt("medicationId"), d.optLong("dueAt")))
        }
        keys
    }

    /** Doses the server last said are due ("meds" from the heartbeat), for the main screen. */
    var dueMeds: JSONArray
        get() = synchronized(LOCK) { array("due_meds") }
        set(v) {
            synchronized(LOCK) { p.edit().putString("due_meds", v.toString()).commit() }
        }

    /** Remove one dose from [dueMeds] right away after the senior acts on it. */
    fun removeDueMed(medicationId: Int, dueAt: Long) = synchronized(LOCK) {
        val key = doseKey(medicationId, dueAt)
        val out = JSONArray()
        val old = array("due_meds")
        for (i in 0 until old.length()) {
            val m = old.optJSONObject(i) ?: continue
            if (doseKey(m.optInt("medicationId"), m.optLong("dueAt")) != key) out.put(m)
        }
        p.edit().putString("due_meds", out.toString()).commit()
    }

    /** Doses we have already alerted for: dose key -> dueAt. Used to alert once and to cancel stale ones. */
    var notifiedDoses: JSONObject
        get() = synchronized(LOCK) {
            try {
                JSONObject(p.getString("notified_doses", "{}") ?: "{}")
            } catch (e: Exception) {
                JSONObject()
            }
        }
        set(v) {
            synchronized(LOCK) { p.edit().putString("notified_doses", v.toString()).commit() }
        }

    // ---------- permission prompts ----------

    /** Whether we've already shown a system permission prompt (Android gives no way to ask). */
    fun wasAsked(what: String): Boolean = p.getBoolean("asked_$what", false)

    fun markAsked(what: String) = p.edit().putBoolean("asked_$what", true).apply()

    /** The senior said "No thanks" to sharing location; stop showing that step. */
    var locationDeclined: Boolean
        get() = p.getBoolean("location_declined", false)
        set(v) = p.edit().putBoolean("location_declined", v).apply()

    // ---------- room sensor mode ----------

    /** "phone" (the senior's own phone, the default) or "room" (a spare device left at home as a sensor). */
    var kind: String
        get() = p.getString("kind", KIND_PHONE) ?: KIND_PHONE
        set(v) = p.edit().putString("kind", v).apply()

    val isRoom: Boolean get() = kind == KIND_ROOM

    /** Room sensor privacy pause: camera and microphone stay off until this time (epoch ms). */
    var pausedUntil: Long
        get() = p.getLong("paused_until", 0L)
        set(v) {
            p.edit().putLong("paused_until", v).commit()
        }

    val isPaused: Boolean get() = pausedUntil > System.currentTimeMillis()

    /** Last time the room sensor saw movement (epoch ms), 0 if never. */
    var lastMotionAt: Long
        get() = p.getLong("last_motion_at", 0L)
        set(v) = p.edit().putLong("last_motion_at", v).apply()

    /**
     * Raw per-15-minute room numbers, keyed by slot start: {mask, peak, sSum, sN, sPeak}.
     * mask has one bit per minute with movement, so a restarted sensor can carry on the same slot.
     */
    fun roomSlot(slot: Long): JSONObject? = synchronized(LOCK) { roomSlots().optJSONObject(slot.toString()) }

    fun putRoomSlot(slot: Long, data: JSONObject) = synchronized(LOCK) {
        val all = roomSlots()
        all.put(slot.toString(), data)
        val cutoff = System.currentTimeMillis() - ROOM_KEEP_MS
        for (k in all.keys().asSequence().toList()) {
            if ((k.toLongOrNull() ?: 0L) < cutoff) all.remove(k)
        }
        p.edit().putString("room_slots", all.toString()).commit()
    }

    /** Finished slots (the whole 15 minutes is over) in the heartbeat's `signals.slots` format, oldest first. */
    fun finishedRoomSlots(now: Long): JSONArray = synchronized(LOCK) {
        val all = roomSlots()
        val out = JSONArray()
        for (k in all.keys().asSequence().mapNotNull { it.toLongOrNull() }.sorted().toList()) {
            if (k + SLOT_MS > now) continue
            val d = all.optJSONObject(k.toString()) ?: continue
            val n = d.optInt("sN")
            out.put(
                JSONObject()
                    .put("slot", k)
                    .put("motionMinutes", Integer.bitCount(d.optInt("mask")).coerceAtMost(15))
                    .put("motionPeak", d.optInt("peak").coerceIn(0, 100))
                    .put("soundAvg", if (n > 0) (d.optDouble("sSum") / n).toInt().coerceIn(0, 100) else 0)
                    .put("soundPeak", d.optInt("sPeak").coerceIn(0, 100)),
            )
        }
        out
    }

    fun removeRoomSlots(sent: JSONArray) = synchronized(LOCK) {
        val all = roomSlots()
        for (i in 0 until sent.length()) {
            val s = sent.optJSONObject(i) ?: continue
            all.remove(s.optLong("slot").toString())
        }
        p.edit().putString("room_slots", all.toString()).commit()
    }

    /** Room events ({at, kind, confidence}) not yet accepted by the server. */
    fun roomEvents(): JSONArray = synchronized(LOCK) { array("room_events") }

    fun queueRoomEvent(at: Long, kind: String, confidence: Double) = synchronized(LOCK) {
        val cutoff = System.currentTimeMillis() - ROOM_KEEP_MS
        val out = JSONArray()
        val old = array("room_events")
        for (i in 0 until old.length()) {
            val e = old.optJSONObject(i) ?: continue
            if (e.optLong("at") >= cutoff) out.put(e)
        }
        out.put(JSONObject().put("at", at).put("kind", kind).put("confidence", confidence))
        p.edit().putString("room_events", out.toString()).commit()
    }

    fun removeRoomEvents(sent: JSONArray) = synchronized(LOCK) {
        val sentKeys = HashSet<String>()
        for (i in 0 until sent.length()) {
            val e = sent.optJSONObject(i) ?: continue
            sentKeys.add(e.optString("kind") + "@" + e.optLong("at"))
        }
        val out = JSONArray()
        val old = array("room_events")
        for (i in 0 until old.length()) {
            val e = old.optJSONObject(i) ?: continue
            if (e.optString("kind") + "@" + e.optLong("at") !in sentKeys) out.put(e)
        }
        p.edit().putString("room_events", out.toString()).commit()
    }

    private fun roomSlots(): JSONObject = try {
        JSONObject(p.getString("room_slots", "{}") ?: "{}")
    } catch (e: Exception) {
        JSONObject()
    }

    fun unpair() {
        p.edit().remove("token").remove("last_query_end").remove("last_sync_at").remove("last_error")
            .remove("pending_doses").remove("due_meds").remove("notified_doses")
            .remove("kind").remove("paused_until").remove("last_motion_at").remove("room_slots").remove("room_events")
            .apply()
    }

    private fun array(key: String): JSONArray = try {
        JSONArray(p.getString(key, "[]") ?: "[]")
    } catch (e: Exception) {
        JSONArray()
    }

    companion object {
        private val LOCK = Any()

        const val KIND_PHONE = "phone"
        const val KIND_ROOM = "room"
        const val SLOT_MS = 15 * 60_000L
        private const val ROOM_KEEP_MS = 3 * 24 * 3600_000L

        fun doseKey(medicationId: Int, dueAt: Long) = "$medicationId:$dueAt"
    }
}
