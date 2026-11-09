package app.haru.companion

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.text.format.DateUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject

/**
 * Two screens, built in code:
 *  - Setup (done once by a family member): pairing code, then Usage Access and battery steps.
 *  - Home (what the senior sees): reassurance, a big "I'm OK" button, and any setup problems.
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
            syncInBackground(manual = false)
        }
    }

    private fun render() {
        root.removeAllViews()
        if (prefs.isPaired) renderHome() else renderSetup()
    }

    // ---------- setup ----------
    private fun renderSetup() {
        root.addView(title("Set up Haru"))
        root.addView(body("Haru notices if this phone goes unused for longer than usual, then calls to check in and lets family know if help is needed."))
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
            Thread {
                val result = try {
                    val res = Api.post(
                        "$url/api/device/pair", null,
                        JSONObject().put("code", c).put("model", Sync.deviceModel()).put("appVersion", BuildConfig.VERSION_NAME),
                    )
                    prefs.serverUrl = url
                    prefs.seniorName = res.optString("seniorName")
                    prefs.token = res.getString("token")
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
        root.addView(TextView(this).apply {
            text = "Disconnect this phone"
            setTextColor(muted)
            textSize = 14f
            setPadding(0, dp(12), 0, dp(12))
            setOnClickListener { confirmDisconnect() }
        })
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
            val error = Sync.run(this, manual)
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
        AlertDialog.Builder(this)
            .setTitle("Disconnect this phone?")
            .setMessage("Haru will stop noticing if this phone goes quiet. Only do this if your family asked you to.")
            .setNegativeButton("Keep connected", null)
            .setPositiveButton("Disconnect") { _, _ ->
                SyncWorker.cancel(this)
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

    private fun card(heading: String, detail: String, action: String, onClick: () -> Unit): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(16))
            background = rounded(warnBg)
        }
        box.addView(TextView(this).apply { text = heading; textSize = 19f; setTextColor(warn); setTypeface(typeface, Typeface.BOLD) })
        box.addView(TextView(this).apply { text = detail; textSize = 17f; setTextColor(warn) })
        box.addView(Button(this).apply {
            text = action
            isAllCaps = false
            textSize = 18f
            setTextColor(Color.WHITE)
            background = rounded(blue)
            gravity = Gravity.CENTER
            setOnClickListener { onClick() }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) })
        return spaced(box, 20)
    }
}
