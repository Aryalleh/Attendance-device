package com.accessctl.door

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.util.concurrent.Executors

/** First-run setup and the admin screen (behind the PIN). */
class SettingsActivity : Activity() {

    private lateinit var prefs: Prefs
    private lateinit var server: EditText
    private lateinit var key: EditText
    private lateinit var pin: EditText
    private lateinit var offline: CheckBox
    private lateinit var lock: CheckBox
    private lateinit var boot: CheckBox
    private lateinit var status: TextView
    private val io = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        setTitle(R.string.settings_title)

        val pad = dp(20)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        fun label(res: Int) = TextView(this).apply {
            setText(res)
            textSize = 15f
            setTextColor(Color.parseColor("#333333"))
            setPadding(0, dp(14), 0, dp(2))
        }.also { col.addView(it) }
        fun field(hint: Int, value: String, type: Int) = EditText(this).apply {
            setHint(hint)
            setText(value)
            inputType = type
            isSingleLine = true
            textDirection = View.TEXT_DIRECTION_LTR
        }.also { col.addView(it) }
        fun check(res: Int, value: Boolean) = CheckBox(this).apply {
            setText(res)
            isChecked = value
            setPadding(dp(4), dp(10), 0, dp(10))
        }.also { col.addView(it) }
        fun button(res: Int, onClick: () -> Unit) = Button(this).apply {
            setText(res)
            setOnClickListener { onClick() }
        }.also { col.addView(it, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10) }) }

        label(R.string.server_url)
        server = field(R.string.server_url_hint, prefs.server, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        label(R.string.door_key)
        key = field(R.string.door_key_hint, prefs.key, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)
        label(R.string.admin_pin)
        pin = field(R.string.admin_pin_hint, prefs.pin, InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD)
        col.addView(View(this), LinearLayout.LayoutParams(1, dp(8)))
        offline = check(R.string.offline_fallback, prefs.offlineFallback)
        lock = check(R.string.lock_task, prefs.lockTask)
        boot = check(R.string.auto_start, prefs.autoStart)

        status = TextView(this).apply {
            textSize = 15f
            setPadding(0, dp(12), 0, dp(4))
        }
        col.addView(status)

        button(R.string.save) { save() }
        button(R.string.exit_kiosk) {
            prefs.kioskEnabled = false
            KioskMode.leave(this)
            finishAffinity()       // closes the kiosk screen too; the phone's normal launcher appears
        }
        if (KioskMode.isDeviceOwner(this)) {
            button(R.string.remove_owner) {
                prefs.kioskEnabled = false
                KioskMode.removeDeviceOwner(this)
                Toast.makeText(this, R.string.owner_removed, Toast.LENGTH_LONG).show()
                finishAffinity()
            }
        }
        val owner = TextView(this).apply {
            setText(if (KioskMode.isDeviceOwner(this@SettingsActivity)) R.string.owner_on else R.string.owner_off)
            textSize = 13f
            setTextColor(Color.parseColor("#666666"))
            setPadding(0, dp(16), 0, 0)
        }
        col.addView(owner)
        col.addView(TextView(this).apply {
            text = "v" + BuildConfig.VERSION_NAME
            textSize = 12f
            setTextColor(Color.parseColor("#999999"))
            setPadding(0, dp(8), 0, 0)
        })

        setContentView(ScrollView(this).apply {
            fitsSystemWindows = true
            addView(col)
        })
    }

    override fun onDestroy() {
        io.shutdown()
        super.onDestroy()
    }

    private fun save() {
        val url = Prefs.normalizeServer(server.text.toString())
        val k = key.text.toString().trim()
        if (url.isEmpty() || k.isEmpty()) {
            showStatus(getString(R.string.fill_in), false)
            return
        }
        showStatus(getString(R.string.testing), null)
        io.execute {
            val r = Api(url, k).kiosk()
            runOnUiThread {
                if (isFinishing) return@runOnUiThread
                when {
                    r.ok -> {
                        val changed = url != prefs.server || k != prefs.key
                        prefs.server = url
                        prefs.key = k
                        prefs.pin = pin.text.toString()
                        prefs.offlineFallback = offline.isChecked
                        prefs.lockTask = lock.isChecked
                        prefs.autoStart = boot.isChecked
                        prefs.kioskEnabled = true
                        prefs.doorName = r.json().optString("name", "")
                        if (changed) prefs.cardsVersion = ""     // fetch this server's card list
                        showStatus(getString(R.string.connected, prefs.doorName), true)
                        // back to the kiosk screen; it reloads the live page if the server or key changed
                        startActivity(Intent(this, KioskActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
                        finish()
                    }
                    r.code == 401 -> showStatus(getString(R.string.bad_key), false)
                    r.code == 404 -> showStatus(getString(R.string.conn_failed, "HTTP 404 — server too old? (needs /api/v1/kiosk)"), false)
                    else -> showStatus(getString(R.string.conn_failed, if (r.code > 0) "HTTP ${r.code}" else r.body), false)
                }
            }
        }
    }

    private fun showStatus(text: String, ok: Boolean?) {
        status.text = text
        status.setTextColor(when (ok) {
            true -> Color.parseColor("#15803D")
            false -> Color.parseColor("#B91C1C")
            null -> Color.parseColor("#444444")
        })
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}
