package app.haru.companion

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Listens to the room through the microphone and turns each 100 ms of sound into numbers: a 0-100
 * loudness level, plus "loud impact" and "smoke alarm" flags. PRIVACY: samples live only in one reused
 * buffer that is overwritten every 100 ms. Audio is never stored, uploaded or logged.
 */
class SoundSensor(private val context: Context, private val listener: Listener) {

    interface Listener {
        fun onSoundLevel(at: Long, level: Int)
        fun onImpact(at: Long, excessDb: Double)
        fun onSmokeAlarm(at: Long)
    }

    @Volatile
    var isRunning = false
        private set
    private var thread: Thread? = null

    @Synchronized
    @SuppressLint("MissingPermission") // checked just below
    fun start(): Boolean {
        if (isRunning) return true
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false
        val minBuf = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minBuf <= 0) return false
        val rec = try {
            AudioRecord(
                MediaRecorder.AudioSource.MIC, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                maxOf(minBuf, BLOCK * 2 * 4),
            )
        } catch (e: Exception) {
            return false
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            return false
        }
        try {
            rec.startRecording()
        } catch (e: Exception) {
            rec.release()
            return false
        }
        isRunning = true
        thread = Thread({ loop(rec) }, "haru-sound").apply { start() }
        return true
    }

    @Synchronized
    fun stop() {
        isRunning = false
        thread?.join(1_000)
        thread = null
    }

    private fun loop(rec: AudioRecord) {
        val buf = ShortArray(BLOCK)
        val impact = ImpactDetector()
        val smoke = SmokeAlarmDetector()
        try {
            while (isRunning) {
                var got = 0
                while (got < BLOCK && isRunning) {
                    val n = rec.read(buf, got, BLOCK - got)
                    if (n <= 0) {
                        isRunning = false // mic error or taken away; the service retries every minute
                        break
                    }
                    got += n
                }
                if (got < BLOCK) break
                val now = System.currentTimeMillis()

                var sum = 0.0
                for (s in buf) sum += s.toDouble() * s
                val db = dbfs(sqrt(sum / BLOCK))
                // dBFS -90 (near silence) .. 0 (as loud as the mic goes) -> 0..100
                listener.onSoundLevel(now, ((db + 90.0) / 90.0 * 100.0).roundToInt().coerceIn(0, 100))
                impact.feed(db, now)?.let { listener.onImpact(it.at, it.excessDb) }
                for (half in 0 until BLOCK / FRAME) {
                    if (smoke.feed(isAlarmTone(buf, half * FRAME, FRAME))) listener.onSmokeAlarm(now)
                }
            }
        } catch (e: Exception) {
            isRunning = false
        } finally {
            try {
                rec.stop()
            } catch (e: Exception) {
            }
            rec.release()
            buf.fill(0) // nothing of the sound outlives the loop
        }
    }

    private fun dbfs(rms: Double): Double = if (rms < 1.0) -96.0 else 20.0 * log10(rms / 32768.0)

    /**
     * Is a strong pure tone between 3.0 and 3.4 kHz (where smoke alarms beep) present in this frame?
     * Goertzel filter every 20 Hz; the tone's share of the frame's energy must be high, and the frame loud.
     * For a pure sine exactly on a probed frequency, power / (energy * n / 2) is about 1.
     */
    private fun isAlarmTone(x: ShortArray, off: Int, n: Int): Boolean {
        var energy = 0.0
        for (i in off until off + n) energy += x[i].toDouble() * x[i]
        if (dbfs(sqrt(energy / n)) < TONE_MIN_DB) return false
        var best = 0.0
        var f = TONE_LOW_HZ
        while (f <= TONE_HIGH_HZ) {
            val coeff = 2.0 * cos(2.0 * Math.PI * f / RATE)
            var s1 = 0.0
            var s2 = 0.0
            for (i in off until off + n) {
                val s0 = x[i] + coeff * s1 - s2
                s2 = s1
                s1 = s0
            }
            val power = s1 * s1 + s2 * s2 - coeff * s1 * s2
            best = maxOf(best, power / (energy * n / 2.0))
            f += TONE_STEP_HZ
        }
        return best > TONE_RATIO
    }

    companion object {
        private const val RATE = 16_000
        private const val BLOCK = 1_600 // 100 ms
        private const val FRAME = 800 // 50 ms, for tone timing
        private const val TONE_LOW_HZ = 3_000.0
        private const val TONE_HIGH_HZ = 3_400.0
        private const val TONE_STEP_HZ = 20.0
        private const val TONE_RATIO = 0.3
        private const val TONE_MIN_DB = -50.0
    }
}
