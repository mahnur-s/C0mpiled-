package app.haru.companion

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.text.format.DateFormat
import android.text.format.DateUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.util.Date

/**
 * Screens, built in code:
 *  - Setup (done once by a family member): what this device is (the senior's phone or a room sensor),
 *    then the pairing code.
 *  - Phone home (what the senior sees): reassurance, medicines due now, a big "I'm OK" button, and any
 *    setup steps left (usage access, battery, notifications, and optional location).
 *  - Room sensor home: what it's doing, a plain privacy promise, live movement/sound bars, pause.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var root: LinearLayout

    private val blue = Color.parseColor("#185FA5")
    private val green = Color.parseColor("#27500A")
    private val greenBg = Color.parseColor("#EAF3DE")
    private val warn = Color.parseColor("#633806")
    private val warnBg = Color.parseColor("#FAEEDA")
    private val muted = Color.parseColor("#6B6A64")
    private val ink = Color.parseColor("#1F1E1B")

    /** Setup choice: Prefs.KIND_PHONE or Prefs.KIND_ROOM. */
    private var setupKind = Prefs.KIND_PHONE

    // Room sensor screen: live bars, refreshed twice a second while the screen is open.
    private val ui = Handler(Looper.getMainLooper())
    private var motionBar: ProgressBar? = null
    private var soundBar: ProgressBar? = null
    private var renderedRunning = false
    private var renderedPaused = false
    private val liveUpdate = object : Runnable {
        override fun run() {
            if (!prefs.isPaired || !prefs.isRoom) return
            if (RoomSensorService.running != renderedRunning || prefs.isPaused != renderedPaused) render()
            // Movement is "% of the picture that changed"; everyday movement is a few %, so scale it up to show.
            motionBar?.progress = minOf(100, RoomSensorService.liveMotion * 4)
            soundBar?.progress = RoomSensorService.liveSound
            ui.postDelayed(this, 500L)
        }
    }

    /** System permission prompts; whatever the answer, redraw so finished steps disappear. */
    private val askPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (prefs.isPaired) {
            if (prefs.isRoom) RoomSensorService.ensureRunning(this, RoomSensorService.Trigger.SCREEN)
            render()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        if (prefs.serverUrl.isEmpty() && BuildConfig.SERVER_URL.isNotEmpty()) prefs.serverUrl = BuildConfig.SERVER_URL
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(32), dp(24), dp(32))
        }
        setContentView(ScrollView(this).apply { addView(root) })
    }

    override fun onResume() {
        super.onResume()
        render()
        if (prefs.isPaired) {
            SyncWorker.schedule(this)
            if (prefs.isRoom) {
                // The app is on screen: the one moment Android always lets the camera/mic service start.
                RoomSensorService.ensureRunning(this, RoomSensorService.Trigger.SCREEN)
                ui.removeCallbacks(liveUpdate)
                ui.post(liveUpdate)
            }
            // Redraw afterwards: the reply may bring new medicine reminders.
            syncInBackground(manual = false) { if (!isFinishing) render() }
        }
    }

    override fun onPause() {
        super.onPause()
        ui.removeCallbacks(liveUpdate)
    }

    private fun render() {
        root.removeAllViews()
        motionBar = null
        soundBar = null
        when {
            !prefs.isPaired -> renderSetup()
            prefs.isRoom -> renderRoomHome()
            else -> renderHome()
        }
    }

    // ---------- setup ----------
    private fun renderSetup() {
        root.addView(title("Set up Haru"))
        root.addView(body("Haru notices if this phone goes unused for longer than usual, then calls to check in and lets family know if help is needed."))

        // What is this device? The senior's own phone, or a spare device that stays at home as a room sensor.
        root.addView(body("What is this device?"))
        val phoneChoice = choiceButton("This is the phone of the person Haru looks after")
        val roomChoice = choiceButton("This is a room sensor (a spare phone or tablet that stays at home)")
        val roomNote = body("A room sensor stays plugged in, facing the living room. It uses the camera and microphone only to measure movement and sound on this device. Nothing is recorded, saved or sent: only numbers and alerts like \"possible fall\".")
        fun showChoice() {
            styleChoice(phoneChoice, setupKind == Prefs.KIND_PHONE)
            styleChoice(roomChoice, setupKind == Prefs.KIND_ROOM)
            roomNote.visibility = if (setupKind == Prefs.KIND_ROOM) View.VISIBLE else View.GONE
        }
        phoneChoice.setOnClickListener {
            setupKind = Prefs.KIND_PHONE
            showChoice()
        }
        roomChoice.setOnClickListener {
            setupKind = Prefs.KIND_ROOM
            showChoice()
        }
        showChoice()
        root.addView(phoneChoice)
        root.addView(roomChoice)
        root.addView(roomNote)

        root.addView(body("Ask your Haru admin for a 6-digit pairing code."))

        val server = input("Server address", InputType.TYPE_TEXT_VARIATION_URI).apply { setText(prefs.serverUrl) }
        if (BuildConfig.SERVER_URL.isEmpty()) root.addView(server)
        val code = input("Pairing code", InputType.TYPE_CLASS_NUMBER)
        root.addView(code)
        val status = body("")
        val pair = bigButton("Connect", blue, Color.WHITE)
        pair.setOnClickListener {
            val url = server.text.toString().trim().trimEnd('/')
            val c = code.text.toString().filter { it.isDigit() }
            if (!url.startsWith("https://") && !url.startsWith("http://")) {
                status.text = "Enter the server address, starting with https://"
                return@setOnClickListener
            }
            if (c.length != 6) {
                status.text = "The code has 6 digits."
                return@setOnClickListener
            }
            pair.isEnabled = false
            status.text = "Connecting…"
            val kind = setupKind
            Thread {
                val result = try {
                    val req = JSONObject().put("code", c).put("model", Sync.deviceModel()).put("appVersion", BuildConfig.VERSION_NAME)
                    if (kind == Prefs.KIND_ROOM) req.put("kind", Prefs.KIND_ROOM)
                    val res = Api.post("$url/api/device/pair", null, req)
                    prefs.serverUrl = url
                    prefs.seniorName = res.optString("seniorName")
                    // The server echoes the kind it registered; trust it over our own choice.
                    val echoed = res.optString("kind")
                    prefs.kind = if (echoed == Prefs.KIND_ROOM || echoed == Prefs.KIND_PHONE) echoed else kind
                    prefs.token = res.getString("token") // set last: this is what makes the device "paired"
                    null
                } catch (e: ApiException) {
                    e.message
                } catch (e: Exception) {
                    "Can't reach the server. Check the address and internet connection."
                }
                runOnUiThread {
                    pair.isEnabled = true
                    if (result == null) {
                        SyncWorker.schedule(this)
                        if (prefs.isRoom) {
                            RoomSensorService.ensureRunning(this, RoomSensorService.Trigger.SCREEN)
                            ui.removeCallbacks(liveUpdate)
                            ui.post(liveUpdate)
                        }
                        syncInBackground(manual = false)
                        render()
                    } else {
                        status.text = result
                    }
                }
            }.start()
        }
        root.addView(pair)
        root.addView(status)
    }

    // ---------- home ----------
    private fun renderHome() {
        val name = prefs.seniorName.ifEmpty { "there" }
        root.addView(title("Hello, $name"))
        root.addView(body("Haru is looking out for you. If your phone is quiet for a long time, Haru will call to make sure you're okay."))

        // Medicines due now (same as the notifications, for when the app is open).
        val meds = prefs.dueMeds
        for (i in 0 until meds.length()) {
            val m = meds.optJSONObject(i) ?: continue
            root.addView(card(
                MedReminders.titleFor(m),
                MedReminders.describe(this, m),
                "I took it",
                secondary = "Skip",
                onSecondary = { answerDose(m, MedReminders.STATUS_SKIPPED) },
                fill = greenBg,
                color = green,
            ) { answerDose(m, MedReminders.STATUS_TAKEN) })
        }

        val access = ActivityReader.hasUsageAccess(this)
        if (!access) {
            root.addView(card(
                "Step needed: allow Haru to see when the phone is used.",
                "Find Haru in the list and turn it on.",
                "Open settings",
            ) { startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)) })
        }
        if (!ActivityReader.isIgnoringBatteryOptimizations(this)) {
            root.addView(card(
                "Step needed: let Haru run in the background.",
                "Without this, Android may delay Haru for hours.",
                "Allow",
            ) { requestBatteryExemption() })
        }
        if (!MedReminders.canNotify(this)) {
            root.addView(card(
                "Step needed: allow medicine reminders.",
                "Haru can remind you when it's time to take your medicine.",
                "Allow",
            ) { requestNotifications() })
        }
        renderLocationStep()

        val status = body(statusLine())
        val ok = bigButton("I'm OK", greenBg, green)
        ok.setOnClickListener {
            ok.isEnabled = false
            status.text = "Sending…"
            syncInBackground(manual = true) { error ->
                ok.isEnabled = true
                status.text = error ?: "Thank you! Your family can see you're okay."
            }
        }
        root.addView(ok)
        root.addView(status)

        root.addView(View(this), LinearLayout.LayoutParams(1, dp(48)))
        if (prefs.locationDeclined && !LocationReader.hasAccess(this)) {
            root.addView(TextView(this).apply {
                text = "Share my location with family"
                setTextColor(muted)
                textSize = 14f
                setPadding(0, dp(12), 0, dp(12))
                setOnClickListener {
                    prefs.locationDeclined = false
                    render()
                }
            })
        }
        root.addView(TextView(this).apply {
            text = "Disconnect this phone"
            setTextColor(muted)
            textSize = 14f
            setPadding(0, dp(12), 0, dp(12))
            setOnClickListener { confirmDisconnect() }
        })
    }

    /**
     * Location is optional. First the normal "while using the app" permission, then (Android 10+)
     * "Allow all the time", because Haru checks in every 15 minutes while the app is closed.
     */
    private fun renderLocationStep() {
        if (prefs.locationDeclined || LocationReader.hasAccess(this)) return
        val why = "Your family can see whether you're at home, and it helps them find you in an emergency."
        if (!LocationReader.hasForegroundAccess(this)) {
            root.addView(card(
                "Optional: share where you are.",
                "$why Haru works fine without it.",
                "Share location",
                secondary = "No thanks",
                onSecondary = { declineLocation() },
            ) { requestLocation() })
        } else {
            val label = if (Build.VERSION.SDK_INT >= 30) packageManager.backgroundPermissionOptionLabel.toString()
            else "Allow all the time"
            root.addView(card(
                "One more step to share where you are.",
                "Haru checks in every 15 minutes, even when this app is closed. On the next screen, choose \"$label\" so your family can still see whether you're at home.",
                "Continue",
                secondary = "No thanks",
                onSecondary = { declineLocation() },
            ) { requestBackgroundLocation() })
        }
    }

    private fun granted(permission: String) = checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    /**
     * Android only shows a permission prompt a couple of times; after that it silently does nothing,
     * so we send them to Settings instead.
     */
    private fun canPrompt(key: String, vararg permissions: String) =
        !prefs.wasAsked(key) || permissions.any { shouldShowRequestPermissionRationale(it) }

    private fun requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS) &&
            canPrompt("notifications", Manifest.permission.POST_NOTIFICATIONS)
        ) {
            prefs.markAsked("notifications")
            askPermissions.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
        } else {
            // Turned off in Settings, or the prompt is no longer allowed: open Haru's notification settings.
            try {
                startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
            } catch (e: Exception) {
                openAppSettings()
            }
        }
    }

    private fun requestLocation() {
        val perms = arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (canPrompt("location", *perms)) {
            prefs.markAsked("location")
            askPermissions.launch(perms)
        } else {
            openAppSettings()
        }
    }

    private fun requestBackgroundLocation() {
        if (Build.VERSION.SDK_INT < 29) return // older Android has no separate background permission
        val perm = Manifest.permission.ACCESS_BACKGROUND_LOCATION
        if (canPrompt("background_location", perm)) {
            // Must be asked on its own. On Android 11+ this opens Haru's location settings page directly.
            prefs.markAsked("background_location")
            askPermissions.launch(arrayOf(perm))
        } else {
            openAppSettings()
        }
    }

    private fun declineLocation() {
        prefs.locationDeclined = true
        render()
    }

    private fun openAppSettings() {
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
    }

    private fun answerDose(m: JSONObject, status: String) {
        MedReminders.record(this, m.optInt("medicationId"), m.optLong("dueAt"), status)
        val msg = if (status == MedReminders.STATUS_TAKEN) "Thank you! Your family will see you took it." else "Okay, skipped."
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
        render()
    }

    // ---------- room sensor home ----------
    private fun renderRoomHome() {
        val paused = prefs.isPaused
        val running = RoomSensorService.running
        renderedPaused = paused
        renderedRunning = running

        root.addView(title(if (paused) "Paused" else "Watching the living room"))
        val who = prefs.seniorName
        root.addView(body(
            (if (who.isNotEmpty()) "This device is Haru's room sensor for $who. " else "This device is Haru's room sensor. ") +
                "Keep it plugged in, with the camera facing the room.",
        ))
        root.addView(note(
            "Private by design: the camera and microphone are only used to measure movement and sound, " +
                "right here on this device. Pictures and sound are never recorded, saved or sent. " +
                "Only numbers and alerts like \"possible fall\" or \"smoke alarm\" go to Haru.",
        ))

        if (!RoomSensorService.hasPermissions(this)) {
            root.addView(card(
                "Step needed: allow the camera and microphone.",
                "Haru uses them only to notice movement, a possible fall or a smoke alarm. Nothing is recorded.",
                "Allow",
            ) { requestRoomPermissions() })
        }
        if (!ActivityReader.isIgnoringBatteryOptimizations(this)) {
            root.addView(card(
                "Step needed: let Haru run in the background.",
                "Without this, Android may stop the room sensor.",
                "Allow",
            ) { requestBatteryExemption() })
        }
        if (!ActivityReader.isPluggedIn(this)) {
            root.addView(card(
                "Please keep this device plugged in.",
                "The room sensor uses the camera and microphone all day, so it needs to stay on its charger.",
                "Check again",
            ) { render() })
        }

        if (running && !paused) {
            motionBar = meter("Movement")
            soundBar = meter("Sound")
        }
        root.addView(body(roomStatus(paused, running)))
        root.addView(body(statusLine()))

        val toggle = if (paused) bigButton("Turn back on now", greenBg, green) else bigButton("Pause for 1 hour", warnBg, warn)
        toggle.setOnClickListener {
            if (prefs.isPaused) RoomSensorService.resume(this) else RoomSensorService.pause(this)
            render()
        }
        root.addView(toggle)

        root.addView(View(this), LinearLayout.LayoutParams(1, dp(48)))
        root.addView(TextView(this).apply {
            text = "Disconnect this device"
            setTextColor(muted)
            textSize = 14f
            setPadding(0, dp(12), 0, dp(12))
            setOnClickListener { confirmDisconnect() }
        })
    }

    private fun roomStatus(paused: Boolean, running: Boolean): String = when {
        paused -> "The camera and microphone are off until ${DateFormat.getTimeFormat(this).format(Date(prefs.pausedUntil))}. They turn back on by themselves."
        !RoomSensorService.hasPermissions(this) -> "The sensor is off until the camera and microphone are allowed."
        !running -> "Starting the sensor…"
        RoomSensorService.cameraOn && RoomSensorService.micOn -> "Measuring movement and sound."
        RoomSensorService.micOn -> "Measuring sound only: the camera isn't available right now."
        RoomSensorService.cameraOn -> "Measuring movement only: the microphone isn't available right now."
        else -> "Waiting for the camera and microphone…"
    }

    private fun requestRoomPermissions() {
        val perms = arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
        if (canPrompt("room_sensor", *perms)) {
            prefs.markAsked("room_sensor")
            askPermissions.launch(perms)
        } else {
            openAppSettings()
        }
    }

    private fun statusLine(): String {
        val err = prefs.lastError
        if (err.isNotEmpty()) return "Problem: $err"
        val at = prefs.lastSyncAt
        return if (at == 0L) "Connecting to Haru…"
        else "Last checked in with Haru ${DateUtils.getRelativeTimeSpanString(at, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)}."
    }

    private fun syncInBackground(manual: Boolean, done: ((String?) -> Unit)? = null) {
        Thread {
            // Someone looking at the screen shouldn't wait long for a fresh location fix.
            val error = Sync.run(this, manual, locationWaitMs = 5_000L)
            runOnUiThread {
                if (!prefs.isPaired) render() else done?.invoke(error)
            }
        }.start()
    }

    @SuppressLint("BatteryLife") // sideloaded pilot app whose whole job is timely background syncs
    private fun requestBatteryExemption() {
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (e: Exception) {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    private fun confirmDisconnect() {
        val room = prefs.isRoom
        AlertDialog.Builder(this)
            .setTitle(if (room) "Disconnect this device?" else "Disconnect this phone?")
            .setMessage(
                if (room) "Haru will stop watching the room. Only do this if your family asked you to."
                else "Haru will stop noticing if this phone goes quiet. Only do this if your family asked you to.",
            )
            .setNegativeButton("Keep connected", null)
            .setPositiveButton("Disconnect") { _, _ ->
                SyncWorker.cancel(this)
                RoomSensorService.stop(this)
                MedReminders.cancelAll(this)
                prefs.unpair()
                render()
            }
            .show()
    }

    // ---------- small view helpers ----------
    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun rounded(fill: Int, stroke: Int? = null) = GradientDrawable().apply {
        cornerRadius = dp(18).toFloat()
        setColor(fill)
        if (stroke != null) setStroke(dp(2), stroke)
    }

    private fun spaced(v: View, top: Int = 12): View {
        v.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            .apply { topMargin = dp(top) }
        return v
    }

    private fun title(s: String) = spaced(TextView(this).apply {
        text = s
        textSize = 32f
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(ink)
    }, 0)

    private fun body(s: String) = spaced(TextView(this).apply {
        text = s
        textSize = 20f
        setTextColor(muted)
        setLineSpacing(0f, 1.15f)
    }) as TextView

    private fun input(hint: String, type: Int) = spaced(EditText(this).apply {
        this.hint = hint
        inputType = type
        textSize = 22f
        setSingleLine()
    }, 20) as EditText

    private fun bigButton(label: String, fill: Int, color: Int) = spaced(Button(this).apply {
        text = label
        isAllCaps = false
        textSize = 26f
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(color)
        background = rounded(fill)
        minHeight = dp(88)
    }, 28) as Button

    /** A large selectable option for the setup screen. */
    private fun choiceButton(label: String) = spaced(Button(this).apply {
        text = label
        isAllCaps = false
        textSize = 19f
        gravity = Gravity.START or Gravity.CENTER_VERTICAL
        minHeight = dp(72)
    }, 12) as Button

    private fun styleChoice(b: Button, selected: Boolean) {
        b.background = rounded(if (selected) greenBg else Color.WHITE, if (selected) green else muted)
        b.setTextColor(if (selected) green else ink)
        b.setTypeface(null, if (selected) Typeface.BOLD else Typeface.NORMAL)
        b.setPadding(dp(18), dp(14), dp(18), dp(14))
    }

    /** A calm green information box (no button). */
    private fun note(s: String) = spaced(TextView(this).apply {
        text = s
        textSize = 17f
        setTextColor(green)
        setLineSpacing(0f, 1.15f)
        setPadding(dp(18), dp(16), dp(18), dp(16))
        background = rounded(greenBg)
    }, 20)

    /** A labelled 0-100 bar on the room sensor screen. */
    private fun meter(label: String): ProgressBar {
        root.addView(spaced(TextView(this).apply {
            text = label
            textSize = 17f
            setTextColor(muted)
        }, 16))
        val bar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            isIndeterminate = false
            progressTintList = ColorStateList.valueOf(blue)
        }
        root.addView(bar, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(16)).apply { topMargin = dp(4) })
        return bar
    }

    private fun card(
        heading: String,
        detail: String,
        action: String,
        secondary: String? = null,
        onSecondary: () -> Unit = {},
        fill: Int = warnBg,
        color: Int = warn,
        onClick: () -> Unit,
    ): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(16))
            background = rounded(fill)
        }
        box.addView(TextView(this).apply { text = heading; textSize = 19f; setTextColor(color); setTypeface(typeface, Typeface.BOLD) })
        box.addView(TextView(this).apply { text = detail; textSize = 17f; setTextColor(color) })
        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        buttons.addView(Button(this).apply {
            text = action
            isAllCaps = false
            textSize = 18f
            setTextColor(Color.WHITE)
            background = rounded(blue)
            setPadding(dp(18), 0, dp(18), 0)
            gravity = Gravity.CENTER
            setOnClickListener { onClick() }
        })
        if (secondary != null) {
            buttons.addView(Button(this).apply {
                text = secondary
                isAllCaps = false
                textSize = 18f
                setTextColor(color)
                background = rounded(Color.TRANSPARENT, color)
                setPadding(dp(18), 0, dp(18), 0)
                gravity = Gravity.CENTER
                setOnClickListener { onSecondary() }
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(12) })
        }
        box.addView(buttons, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) })
        return spaced(box, 20)
    }
}
