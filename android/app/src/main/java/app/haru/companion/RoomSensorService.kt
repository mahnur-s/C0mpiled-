package app.haru.companion

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.text.format.DateFormat
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.util.Date
import kotlin.math.roundToInt

/**
 * Room sensor mode: a spare phone or tablet, plugged in at home, measures movement (camera) and sound
 * level (microphone) all day. Everything is analysed on this device and thrown away at once; only
 * per-15-minute numbers and event labels are kept (in Prefs) for the next heartbeat.
 *
 * Runs as a foreground service of type camera|microphone with a permanent quiet notification.
 * The "pause for 1 hour" privacy switch keeps the service alive but turns the camera and microphone
 * off: Android only lets a camera/mic service start while the app is on screen, so staying alive is
 * what lets the sensor resume by itself after the hour.
 */
class RoomSensorService : Service(), SoundSensor.Listener {

    /** Who is asking the sensor to start; decides whether Android will allow it. */
    enum class Trigger { SCREEN, BOOT, WORKER }

    private lateinit var prefs: Prefs
    private val main = Handler(Looper.getMainLooper())
    private var motion: MotionSensor? = null
    private var sound: SoundSensor? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val fall = FallDetector()
    private val lastEventAt = HashMap<String, Long>()
    private var pausedShown: Boolean? = null

    // The 15-minute slot being filled. Guarded by `this` (camera and audio threads both write).
    private var slot = 0L
    private var mask = 0 // bit per minute with movement
    private var peak = 0
    private var soundSum = 0.0
    private var soundN = 0
    private var soundPeak = 0
    private var lastMotion = 0L

    private val tick = object : Runnable {
        override fun run() {
            flush()
            applyState()
            main.postDelayed(this, TICK_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Must go foreground promptly after startForegroundService(), whatever happens next.
        if (!goForeground()) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (!prefs.isPaired || !prefs.isRoom) {
            stopSelf()
            return START_NOT_STICKY
        }
        running = true
        main.removeCallbacks(tick)
        main.post(tick) // applies pause/resume right away, then every minute
        return START_STICKY
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        stopSensors()
        flush()
        running = false
        super.onDestroy()
    }

    // ---------- sensors on / off ----------

    private fun applyState() {
        val paused = prefs.isPaused
        if (paused) stopSensors() else startSensors()
        if (paused != pausedShown) {
            pausedShown = paused
            goForeground() // refresh the notification text
        }
    }

    private fun startSensors() {
        val m = motion ?: MotionSensor(this) { at, v -> onMotion(at, v) }.also { motion = it }
        if (!m.isRunning) m.start()
        val s = sound ?: SoundSensor(this, this).also { sound = it }
        if (!s.isRunning) s.start()
        cameraOn = m.isRunning
        micOn = s.isRunning
        // Plugged-in device: keep the CPU awake so analysis doesn't stall with the screen off.
        // Re-acquired every minute with a timeout, so a crash can't leave it held forever.
        val wl = wakeLock ?: (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "haru:room-sensor")
            .apply { setReferenceCounted(false) }
            .also { wakeLock = it }
        wl.acquire(10 * 60_000L)
    }

    private fun stopSensors() {
        motion?.stop()
        sound?.stop()
        cameraOn = false
        micOn = false
        liveMotion = 0
        liveSound = 0
        wakeLock?.let { if (it.isHeld) it.release() }
    }

    // ---------- numbers in ----------

    private fun onMotion(at: Long, value: Int) {
        liveMotion = value
        synchronized(this) {
            roll(at)
            if (value >= MOTION_THRESHOLD) {
                mask = mask or (1 shl minuteOf(at))
                lastMotion = at
            }
            peak = maxOf(peak, value)
        }
        fall.onMotion(at, value)?.let { emit(at, "possible_fall", it) }
    }

    override fun onSoundLevel(at: Long, level: Int) {
        liveSound = level
        synchronized(this) {
            roll(at)
            soundSum += level
            soundN++
            soundPeak = maxOf(soundPeak, level)
        }
    }

    override fun onImpact(at: Long, excessDb: Double) {
        emit(at, "loud_impact", (0.5 + (excessDb - 25.0) / 50.0).coerceIn(0.5, 0.9))
        fall.onImpact(at, excessDb)
    }

    override fun onSmokeAlarm(at: Long) = emit(at, "smoke_alarm", 0.8)

    /** Queue an event (at most once per kind every 2 minutes); urgent ones are sent straight away. */
    private fun emit(at: Long, kind: String, confidence: Double) {
        synchronized(lastEventAt) {
            if (at - (lastEventAt[kind] ?: 0L) < EVENT_GAP_MS) return
            lastEventAt[kind] = at
        }
        prefs.queueRoomEvent(at, kind, (confidence * 100).roundToInt() / 100.0)
        if (kind == "possible_fall" || kind == "smoke_alarm") SyncWorker.syncSoon(applicationContext)
    }

    // ---------- 15-minute slots ----------

    /** Caller holds `this`. Moves to the slot containing [at], saving the old one. */
    private fun roll(at: Long) {
        val s = at - at % Prefs.SLOT_MS
        if (s == slot) return
        if (slot != 0L) save()
        slot = s
        // Carry on from what's stored, in case the sensor restarted part-way through this slot.
        val d = prefs.roomSlot(s)
        mask = d?.optInt("mask") ?: 0
        peak = d?.optInt("peak") ?: 0
        soundSum = d?.optDouble("sSum", 0.0) ?: 0.0
        soundN = d?.optInt("sN") ?: 0
        soundPeak = d?.optInt("sPeak") ?: 0
    }

    private fun minuteOf(at: Long): Int = ((at - slot) / 60_000L).toInt().coerceIn(0, 14)

    /** Caller holds `this`. */
    private fun save() {
        if (slot == 0L || (soundN == 0 && peak == 0 && mask == 0)) return
        prefs.putRoomSlot(
            slot,
            JSONObject().put("mask", mask).put("peak", peak).put("sSum", soundSum).put("sN", soundN).put("sPeak", soundPeak),
        )
        if (lastMotion > prefs.lastMotionAt) prefs.lastMotionAt = lastMotion
    }

    /** Write the current slot to Prefs (every minute), so a crash loses at most a minute. */
    private fun flush() = synchronized(this) { save() }

    // ---------- notification ----------

    private fun goForeground(): Boolean {
        ensureChannels(this)
        val text = if (prefs.isPaused) {
            "Paused until ${DateFormat.getTimeFormat(this).format(Date(prefs.pausedUntil))}. Camera and microphone are off."
        } else {
            "Haru room sensor is on. Nothing is recorded."
        }
        val n = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notify)
            .setColor(0xFF185FA5.toInt())
            .setContentTitle("Haru")
            .setContentText(text)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(openAppIntent(this))
            .build()
        return try {
            if (Build.VERSION.SDK_INT >= 30) {
                startForeground(
                    NOTIFICATION_ID, n,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
                )
            } else {
                startForeground(NOTIFICATION_ID, n) // types come from the manifest
            }
            true
        } catch (e: Exception) {
            false // e.g. camera/mic permission withdrawn (Android 14+ checks this here)
        }
    }

    companion object {
        private const val CHANNEL_ID = "room-sensor"
        private const val ALERT_CHANNEL_ID = "room-sensor-alerts"
        private const val NOTIFICATION_ID = 1001
        private const val RESTART_NOTIFICATION_ID = 1002
        private const val TICK_MS = 60_000L
        private const val EVENT_GAP_MS = 2 * 60_000L
        private const val MOTION_THRESHOLD = 2 // % of the picture changing = "someone moved this minute"
        const val PAUSE_MS = 3600_000L

        /** Live state for the main screen (same process). */
        @Volatile
        var running = false
            private set
        @Volatile
        var cameraOn = false
            private set
        @Volatile
        var micOn = false
            private set
        @Volatile
        var liveMotion = 0
            private set
        @Volatile
        var liveSound = 0
            private set

        fun hasPermissions(context: Context): Boolean =
            context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED &&
                context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

        /**
         * Start the sensor if it should be running and isn't. Android only allows a camera/microphone
         * service to start while the app is on screen (and, before Android 15, right after a reboot).
         * Otherwise we post a notification asking for a tap, which opens the app and starts it.
         */
        fun ensureRunning(context: Context, trigger: Trigger) {
            val prefs = Prefs(context)
            if (!prefs.isPaired || !prefs.isRoom || running) return
            if (!hasPermissions(context)) return // the main screen shows this step
            val allowed = when (trigger) {
                Trigger.SCREEN -> true
                Trigger.BOOT -> Build.VERSION.SDK_INT < 35
                Trigger.WORKER -> Build.VERSION.SDK_INT < 30
            }
            if (allowed && start(context)) {
                (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(RESTART_NOTIFICATION_ID)
                return
            }
            if (trigger != Trigger.SCREEN) showRestartNotice(context)
        }

        /** Privacy pause: camera and microphone off for an hour, then back on by themselves. */
        fun pause(context: Context) {
            Prefs(context).pausedUntil = System.currentTimeMillis() + PAUSE_MS
            if (running) start(context) // the service re-reads the pause right away
        }

        fun resume(context: Context) {
            Prefs(context).pausedUntil = 0L
            if (running) start(context) else ensureRunning(context, Trigger.SCREEN)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RoomSensorService::class.java))
        }

        private fun start(context: Context): Boolean = try {
            context.startForegroundService(Intent(context, RoomSensorService::class.java))
            true
        } catch (e: Exception) {
            false // not allowed from the background on this Android version
        }

        private fun showRestartNotice(context: Context) {
            if (!MedReminders.canNotify(context)) return
            ensureChannels(context)
            val n = NotificationCompat.Builder(context, ALERT_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notify)
                .setColor(0xFF185FA5.toInt())
                .setContentTitle("Haru room sensor stopped")
                .setContentText("Tap to turn it back on.")
                .setOnlyAlertOnce(true)
                .setAutoCancel(true)
                .setContentIntent(openAppIntent(context))
                .build()
            try {
                (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(RESTART_NOTIFICATION_ID, n)
            } catch (e: Exception) {
            }
        }

        private fun openAppIntent(context: Context): PendingIntent = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        private fun ensureChannels(context: Context) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Room sensor", NotificationManager.IMPORTANCE_LOW).apply {
                        description = "Shows that the room sensor is on. Nothing is recorded."
                    },
                )
            }
            if (nm.getNotificationChannel(ALERT_CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(ALERT_CHANNEL_ID, "Room sensor problems", NotificationManager.IMPORTANCE_DEFAULT),
                )
            }
        }
    }
}
