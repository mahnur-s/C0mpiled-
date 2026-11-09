package app.haru.companion

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/** Runs every 15 minutes (Android's minimum), survives reboots via WorkManager. Used in both modes. */
class SyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val prefs = Prefs(applicationContext)
        if (!prefs.isPaired) return Result.success()
        // Room sensor mode: restart the sensor if it died (or ask the user to, where Android requires it).
        if (prefs.isRoom) RoomSensorService.ensureRunning(applicationContext, RoomSensorService.Trigger.WORKER)
        return if (Sync.run(applicationContext) == null) Result.success() else Result.retry()
    }

    companion object {
        private const val NAME = "haru-sync"
        private const val NOW_NAME = "haru-sync-now"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        /**
         * One extra sync as soon as there's internet, e.g. right after a medicine button is tapped.
         * Not "expedited": on Android 11 and older that needs a foreground-service notification.
         * APPEND_OR_REPLACE runs it after any sync already under way, so the new dose isn't missed.
         */
        fun syncSoon(context: Context) {
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(NOW_NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(NAME)
            WorkManager.getInstance(context).cancelUniqueWork(NOW_NAME)
        }
    }
}
