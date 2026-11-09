package app.haru.companion

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.Process

/** Reads "was the phone used?" from Android's usage events. Needs the Usage Access special permission. */
object ActivityReader {

    fun hasUsageAccess(context: Context): Boolean {
        val ops = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= 29) {
            ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        } else {
            @Suppress("DEPRECATION")
            ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    /**
     * Latest moment in [from, to] that a person used the phone: an unlock, or an app coming to the
     * foreground. Screen-on alone is ignored because notifications can light the screen by themselves.
     */
    fun latestActivity(context: Context, from: Long, to: Long): Long? {
        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val events = usm.queryEvents(from, to) ?: return null
        val e = UsageEvents.Event()
        var latest: Long? = null
        while (events.hasNextEvent()) {
            events.getNextEvent(e)
            if (isUse(e.eventType)) latest = maxOf(latest ?: 0L, e.timeStamp)
        }
        return latest
    }

    @Suppress("DEPRECATION")
    private fun isUse(type: Int): Boolean = when {
        type == UsageEvents.Event.MOVE_TO_FOREGROUND -> true // same value as ACTIVITY_RESUMED on API 29+
        Build.VERSION.SDK_INT >= 28 && type == UsageEvents.Event.KEYGUARD_HIDDEN -> true
        else -> false
    }

    fun batteryPercent(context: Context): Int? {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val v = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (v in 0..100) v else null
    }

    fun isIgnoringBatteryOptimizations(context: Context): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }
}
