package app.haru.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Room sensor mode only: turn the sensor back on after the device restarts or Haru is updated.
 * Android 15+ no longer lets a camera/microphone service start from here; then the user gets a
 * "tap to turn it back on" notification instead (see RoomSensorService.ensureRunning).
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val prefs = Prefs(context)
        if (!prefs.isPaired || !prefs.isRoom) return
        SyncWorker.schedule(context)
        RoomSensorService.ensureRunning(context, RoomSensorService.Trigger.BOOT)
    }
}
