package app.haru.companion

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Range
import kotlin.math.abs

/**
 * Watches the room with the back camera (Camera2, no preview) and reports how much of the picture
 * changed since the last frame, about twice a second, as 0-100.
 *
 * PRIVACY: each frame is shrunk to a 64x48 grid of brightness numbers and closed straight away. Only
 * the previous grid is kept, to compare with the next one. Frames are never stored, uploaded or logged.
 */
class MotionSensor(private val context: Context, private val listener: (at: Long, motion: Int) -> Unit) {

    @Volatile
    var isRunning = false
        private set
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var camera: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var reader: ImageReader? = null
    private var previous: IntArray? = null
    private var lastFrameAt = 0L

    @Synchronized
    @SuppressLint("MissingPermission") // checked just below
    fun start(): Boolean {
        if (isRunning) return true
        if (context.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return false
        try {
            val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val id = pickCamera(cm) ?: return false
            val chars = cm.getCameraCharacteristics(id)
            val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return false
            // Smallest picture the camera offers: we only need a rough brightness grid.
            val size = map.getOutputSizes(ImageFormat.YUV_420_888)?.minByOrNull { it.width * it.height } ?: return false
            // Slowest frame rate offered, to save power (we only look at ~2 frames a second anyway).
            val fps = chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
                ?.minByOrNull { it.upper * 1000 + it.lower }

            val t = HandlerThread("haru-camera").apply { start() }
            val h = Handler(t.looper)
            thread = t
            handler = h
            val r = ImageReader.newInstance(size.width, size.height, ImageFormat.YUV_420_888, 2)
            r.setOnImageAvailableListener({ onImage(it) }, h)
            reader = r
            isRunning = true
            cm.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(device: CameraDevice) {
                    if (!isRunning) {
                        device.close() // stopped while the camera was opening
                        return
                    }
                    camera = device
                    startSession(device, r, fps)
                }

                override fun onDisconnected(device: CameraDevice) = stop() // another app took the camera
                override fun onError(device: CameraDevice, error: Int) = stop()
            }, h)
            return true
        } catch (e: Exception) {
            stop()
            return false
        }
    }

    @Synchronized
    fun stop() {
        isRunning = false
        try {
            session?.close()
        } catch (e: Exception) {
        }
        session = null
        try {
            camera?.close()
        } catch (e: Exception) {
        }
        camera = null
        try {
            reader?.close()
        } catch (e: Exception) {
        }
        reader = null
        thread?.quitSafely()
        thread = null
        handler = null
        previous = null
    }

    private fun pickCamera(cm: CameraManager): String? {
        val ids = cm.cameraIdList
        return ids.firstOrNull {
            cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
        } ?: ids.firstOrNull()
    }

    // createCaptureSession(List<Surface>, ...) is deprecated on Android 11+ but works on every version we support.
    @Suppress("DEPRECATION")
    private fun startSession(device: CameraDevice, r: ImageReader, fps: Range<Int>?) {
        try {
            device.createCaptureSession(listOf(r.surface), object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(s: CameraCaptureSession) {
                    if (!isRunning) {
                        s.close()
                        return
                    }
                    session = s
                    try {
                        val request = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
                        request.addTarget(r.surface)
                        if (fps != null) request.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fps)
                        s.setRepeatingRequest(request.build(), null, handler)
                    } catch (e: Exception) {
                        stop()
                    }
                }

                override fun onConfigureFailed(s: CameraCaptureSession) = stop()
            }, handler)
        } catch (e: Exception) {
            stop()
        }
    }

    private fun onImage(r: ImageReader) {
        val img = try {
            r.acquireLatestImage()
        } catch (e: Exception) {
            null
        } ?: return
        try {
            val now = System.currentTimeMillis()
            if (now - lastFrameAt < FRAME_INTERVAL_MS) return
            lastFrameAt = now
            val grid = lumaGrid(img)
            val prev = previous
            previous = grid
            if (prev != null) listener(now, motionScore(prev, grid))
        } catch (e: Exception) {
            // reader closed mid-frame while stopping
        } finally {
            img.close()
        }
    }

    /** Average brightness (Y plane) of each cell of a GRID_W x GRID_H grid. */
    private fun lumaGrid(img: Image): IntArray {
        val plane = img.planes[0]
        val buf = plane.buffer
        val rowStride = plane.rowStride
        val pixelStride = plane.pixelStride
        val w = img.width
        val h = img.height
        val out = IntArray(GRID_W * GRID_H)
        for (gy in 0 until GRID_H) {
            val y0 = gy * h / GRID_H
            val y1 = maxOf(y0 + 1, (gy + 1) * h / GRID_H)
            val yStep = maxOf(1, (y1 - y0) / 4)
            for (gx in 0 until GRID_W) {
                val x0 = gx * w / GRID_W
                val x1 = maxOf(x0 + 1, (gx + 1) * w / GRID_W)
                val xStep = maxOf(1, (x1 - x0) / 4)
                var sum = 0
                var n = 0
                var y = y0
                while (y < y1) {
                    var x = x0
                    while (x < x1) {
                        val i = y * rowStride + x * pixelStride
                        if (i < buf.limit()) {
                            sum += buf.get(i).toInt() and 0xFF
                            n++
                        }
                        x += xStep
                    }
                    y += yStep
                }
                out[gy * GRID_W + gx] = if (n > 0) sum / n else 0
            }
        }
        return out
    }

    /**
     * Thresholded frame difference: the share (0-100) of grid cells whose brightness changed by more
     * than NOISE. The average change of the whole picture is removed first, so auto-exposure or a lamp
     * being switched on doesn't count as movement. Limits: in a dark room camera noise rises and small
     * movements are lost; a TV screen or a curtain in the wind counts as movement.
     */
    private fun motionScore(a: IntArray, b: IntArray): Int {
        var shift = 0L
        for (i in a.indices) shift += (b[i] - a[i]).toLong()
        val mean = shift.toDouble() / a.size
        var changed = 0
        for (i in a.indices) if (abs(b[i] - a[i] - mean) > NOISE) changed++
        return (changed * 100 / a.size).coerceIn(0, 100)
    }

    companion object {
        private const val GRID_W = 64
        private const val GRID_H = 48
        private const val NOISE = 15.0 // brightness steps (of 255) treated as sensor noise
        private const val FRAME_INTERVAL_MS = 500L // ~2 fps
    }
}
