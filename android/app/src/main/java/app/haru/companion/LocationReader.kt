package app.haru.companion

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Optional: where the phone is, so family can see whether the senior is at home and help find them
 * in an emergency. Uses Android's own LocationManager (no Google Play Services). Haru works without it.
 */
object LocationReader {
    private const val MAX_AGE_MS = 3600_000L

    private fun granted(context: Context, permission: String) =
        context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    /** Fine or coarse location granted (enough while the app is open). */
    fun hasForegroundAccess(context: Context): Boolean =
        granted(context, Manifest.permission.ACCESS_FINE_LOCATION) ||
            granted(context, Manifest.permission.ACCESS_COARSE_LOCATION)

    /** On Android 10+ the 15-minute worker also needs "Allow all the time". */
    fun hasBackgroundAccess(context: Context): Boolean =
        Build.VERSION.SDK_INT < 29 || granted(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION)

    /** What the heartbeat reports as `locationAccess`. */
    fun hasAccess(context: Context): Boolean = hasForegroundAccess(context) && hasBackgroundAccess(context)

    /**
     * A recent position, or null. Blocking for up to [waitMs]: call off the main thread.
     * Asks for a fresh fix on Android 11+, otherwise (or if that fails) uses the freshest cached one.
     */
    fun read(context: Context, waitMs: Long): Location? {
        if (!hasForegroundAccess(context)) return null
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
        val loc = try {
            (if (Build.VERSION.SDK_INT >= 30) currentFix(lm, waitMs) else null) ?: lastKnown(lm)
        } catch (e: SecurityException) {
            null // permission withdrawn, or no background access while the app is closed
        } catch (e: Exception) {
            null
        }
        return loc?.takeIf { System.currentTimeMillis() - it.time <= MAX_AGE_MS }
    }

    @SuppressLint("MissingPermission") // checked in read(); SecurityException is caught there
    private fun currentFix(lm: LocationManager, waitMs: Long): Location? {
        if (Build.VERSION.SDK_INT < 30) return null
        val provider = pickProvider(lm) ?: return null
        val result = AtomicReference<Location?>(null)
        val latch = CountDownLatch(1)
        val cancel = CancellationSignal()
        val executor = Executors.newSingleThreadExecutor()
        try {
            lm.getCurrentLocation(provider, cancel, executor) { loc ->
                result.set(loc) // null if Android couldn't get a fix
                latch.countDown()
            }
            latch.await(waitMs, TimeUnit.MILLISECONDS)
        } finally {
            cancel.cancel()
            executor.shutdown()
        }
        return result.get()
    }

    /** Fused (Android 12+) if the phone has it, else network (quick, works indoors), else GPS. */
    private fun pickProvider(lm: LocationManager): String? {
        if (Build.VERSION.SDK_INT >= 31 && lm.hasProvider(LocationManager.FUSED_PROVIDER) &&
            lm.isProviderEnabled(LocationManager.FUSED_PROVIDER)
        ) return LocationManager.FUSED_PROVIDER
        if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) return LocationManager.NETWORK_PROVIDER
        if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) return LocationManager.GPS_PROVIDER
        return null
    }

    @SuppressLint("MissingPermission") // checked in read(); SecurityException is caught there
    private fun lastKnown(lm: LocationManager): Location? {
        var best: Location? = null
        for (p in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)) {
            val loc = try {
                lm.getLastKnownLocation(p)
            } catch (e: Exception) {
                null // provider missing on this phone, or not allowed with coarse-only permission
            } ?: continue
            if (best == null || loc.time > best.time) best = loc
        }
        return best
    }
}
