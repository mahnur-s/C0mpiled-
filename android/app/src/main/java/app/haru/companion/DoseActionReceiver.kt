package app.haru.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Handles the "I took it" / "Skip" buttons on a medicine reminder. Not exported: only our own notifications can call it. */
class DoseActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val medId = intent.getIntExtra(EXTRA_MEDICATION_ID, -1)
        val dueAt = intent.getLongExtra(EXTRA_DUE_AT, 0L)
        val status = intent.getStringExtra(EXTRA_STATUS) ?: return
        if (medId < 0 || dueAt <= 0L) return
        if (status != MedReminders.STATUS_TAKEN && status != MedReminders.STATUS_SKIPPED) return
        if (!Prefs(context).isPaired) return
        MedReminders.record(context, medId, dueAt, status)
    }

    companion object {
        const val ACTION_PREFIX = "app.haru.companion.DOSE_"
        const val EXTRA_MEDICATION_ID = "medicationId"
        const val EXTRA_DUE_AT = "dueAt"
        const val EXTRA_STATUS = "status"
    }
}
