package app.haru.companion

/*
 * Room sensor event heuristics. Plain rules on numbers that were already computed on this device
 * (sound level per 100 ms, tone strength per 50 ms, movement per camera frame). No audio or picture
 * reaches this file, and nothing here is a trained model: these rules WILL have false alarms and misses.
 * The family dashboard should present them as "possible", never as certain.
 *
 * TODO: call_for_help and crying are not detected. They need an on-device speech / sound-event
 * classifier (e.g. a small TFLite model), which this pilot deliberately does not include.
 */

/** A short, sharp bang well above the room's normal level. */
class Impact(val at: Long, val excessDb: Double)

/**
 * loud_impact: a peak more than 25 dB above the last 30 s of background, lasting under ~400 ms.
 * Limits: a dropped pan, a slammed door, a clap or a loud TV moment looks exactly like a person falling
 * against furniture. Sustained loud sounds (music, vacuum) are ignored because they last too long.
 */
class ImpactDetector {
    private val history = DoubleArray(BASELINE_BLOCKS) // dBFS of recent normal (non-burst) 100 ms blocks
    private var count = 0
    private var next = 0
    private var burstBlocks = 0
    private var burstStart = 0L
    private var burstPeak = -120.0
    private var burstBaseline = 0.0

    /** Feed one 100 ms block's level in dBFS. Returns an impact when a short burst has just ended. */
    fun feed(db: Double, at: Long): Impact? {
        if (count < MIN_BLOCKS) {
            remember(db)
            return null // still learning what this room normally sounds like
        }
        val baseline = median()
        val loud = db > baseline + EXCESS_DB && db > MIN_LOUD_DB
        if (loud) {
            if (burstBlocks == 0) {
                burstStart = at
                burstBaseline = baseline
                burstPeak = db
            }
            burstBlocks++
            burstPeak = maxOf(burstPeak, db)
            // Short bursts stay out of the baseline so a bang doesn't raise it; a long loud stretch
            // (TV turned up) is let in so the baseline catches up with the new normal.
            if (burstBlocks > MAX_BURST_BLOCKS) remember(db)
            return null
        }
        var result: Impact? = null
        if (burstBlocks in 1..MAX_BURST_BLOCKS) result = Impact(burstStart, burstPeak - burstBaseline)
        burstBlocks = 0
        remember(db)
        return result
    }

    private fun remember(db: Double) {
        history[next] = db
        next = (next + 1) % history.size
        if (count < history.size) count++
    }

    private fun median(): Double {
        val sorted = history.copyOf(count)
        sorted.sort()
        return sorted[count / 2]
    }

    companion object {
        private const val BASELINE_BLOCKS = 300 // 30 s of 100 ms blocks
        private const val MIN_BLOCKS = 50 // 5 s before we judge anything
        private const val EXCESS_DB = 25.0
        private const val MIN_LOUD_DB = -40.0 // ignore "loud for a silent room" clicks
        private const val MAX_BURST_BLOCKS = 4 // up to ~400 ms
    }
}

/**
 * smoke_alarm: the standard T3 pattern (ISO 8201): three ~0.5 s beeps with ~0.5 s gaps, a ~1.5 s pause,
 * repeat. Fed one "is a strong 3.0-3.4 kHz tone present?" flag per 50 ms frame. Reports after two full
 * groups (about 8 s). Limits: CO alarms (T4 pattern) and alarms with unusual pitches are missed; a TV
 * playing an alarm sound, or some microwaves/timers that happen to match the rhythm, can trigger it.
 */
class SmokeAlarmDetector {
    private var stable = false // debounced tone state
    private var flip = 0 // frames in a row disagreeing with `stable`
    private var toneRun = 0
    private var quietRun = 0
    private var beeps = 0 // beeps in the current group of three
    private var groups = 0 // complete groups seen in a row

    /** Returns true when the T3 pattern has repeated at least twice (keeps returning true while it continues). */
    fun feed(tone: Boolean): Boolean {
        // Debounce: change state only after 2 frames agree, so one noisy frame doesn't split a beep.
        if (tone != stable) {
            flip++
            if (flip < 2) return step(stable)
            stable = tone
            flip = 0
        } else {
            flip = 0
        }
        return step(stable)
    }

    private fun step(on: Boolean): Boolean {
        var fired = false
        if (on) {
            if (quietRun > 0) gapEnded(quietRun)
            quietRun = 0
            toneRun++
        } else {
            if (toneRun > 0) beepEnded(toneRun)
            toneRun = 0
            quietRun++
            if (quietRun == LONG_GAP_MIN && beeps == 3) {
                groups++
                beeps = 0
                fired = groups >= 2
            }
            if (quietRun > LONG_GAP_MAX) reset()
        }
        return fired
    }

    private fun beepEnded(frames: Int) {
        if (frames in BEEP_MIN..BEEP_MAX) beeps++ else reset()
    }

    private fun gapEnded(frames: Int) {
        when {
            frames < SHORT_GAP_MIN -> reset()
            frames <= SHORT_GAP_MAX -> if (beeps >= 3) reset() // a 4th beep in a group isn't T3
            frames <= LONG_GAP_MAX -> if (beeps != 0) reset() // long pause before the group was complete
            else -> reset()
        }
    }

    private fun reset() {
        beeps = 0
        groups = 0
    }

    companion object {
        // In 50 ms frames.
        private const val BEEP_MIN = 6 // 0.3 s
        private const val BEEP_MAX = 18 // 0.9 s
        private const val SHORT_GAP_MIN = 4 // 0.2 s
        private const val SHORT_GAP_MAX = 18 // 0.9 s
        private const val LONG_GAP_MIN = 19 // 0.95 s
        private const val LONG_GAP_MAX = 60 // 3 s
    }
}

/**
 * possible_fall: a burst of movement, a loud impact within ~2 s of it, then near-stillness for 30 s.
 * Confidence grows with a bigger movement burst, a louder impact and a cleaner stillness.
 * Limits: falls out of the camera's view, soft falls on carpet, or a person who falls and then moves
 * (crawls, tries to get up) are missed. Dropping something heavy and then sitting still, or leaving
 * the room right after a bang, can look like a fall. Needs both camera and microphone running.
 */
class FallDetector {
    private class Candidate(val at: Long, val excessDb: Double, var burstPeak: Int) {
        var samples = 0
        var moving = 0
    }

    private var lastBurstAt = 0L
    private var lastBurstPeak = 0
    private var candidate: Candidate? = null

    @Synchronized
    fun onImpact(at: Long, excessDb: Double) {
        // A new bang during the stillness watch replaces the old candidate (someone is clearly active).
        val peak = if (lastBurstAt > 0 && at - lastBurstAt in 0..BURST_BEFORE_MS) lastBurstPeak else 0
        candidate = Candidate(at, excessDb, peak)
    }

    /** Feed each movement sample (0-100). Returns a confidence when a fall pattern has just completed. */
    @Synchronized
    fun onMotion(at: Long, motion: Int): Double? {
        if (motion >= BURST) {
            if (at - lastBurstAt > BURST_BEFORE_MS) lastBurstPeak = 0
            lastBurstAt = at
            lastBurstPeak = maxOf(lastBurstPeak, motion)
        }
        val c = candidate ?: return null
        val since = at - c.at
        if (c.burstPeak == 0) {
            // The camera samples only twice a second, so the burst may show up just after the bang.
            if (since <= BURST_AFTER_MS) {
                if (motion >= BURST) c.burstPeak = motion
            } else {
                candidate = null // a bang with no movement around it: not this pattern
            }
            return null
        }
        if (since < SETTLE_MS) {
            c.burstPeak = maxOf(c.burstPeak, motion)
            return null
        }
        c.samples++
        if (motion > STILL) c.moving++
        if (c.moving > MAX_MOVING_SAMPLES) {
            candidate = null // they're moving about: fine
            return null
        }
        if (since < SETTLE_MS + STILL_MS) return null
        candidate = null
        if (c.samples < MIN_SAMPLES) return null // camera wasn't delivering frames reliably
        var confidence = 0.5
        if (c.burstPeak >= 30) confidence += 0.15
        if (c.excessDb >= 30.0) confidence += 0.15
        if (c.moving == 0) confidence += 0.1
        return confidence.coerceAtMost(0.9)
    }

    companion object {
        private const val BURST = 15 // % of the picture changing in one frame
        private const val STILL = 3
        private const val BURST_BEFORE_MS = 2_500L
        private const val BURST_AFTER_MS = 1_500L
        private const val SETTLE_MS = 2_000L
        private const val STILL_MS = 30_000L
        private const val MAX_MOVING_SAMPLES = 2
        private const val MIN_SAMPLES = 20 // ~2 fps over 30 s should give ~60
    }
}
