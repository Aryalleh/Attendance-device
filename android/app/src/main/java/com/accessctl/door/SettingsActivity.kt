package com.accessctl.door

import android.app.Activity
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.util.concurrent.Executors

/**
 * First-run setup and the admin screen (behind the PIN), as a 3-step wizard:
 * connect to the server, set the admin PIN, kiosk mode (UX Pilot: Kiosk - 00 Setup).
 */
class SettingsActivity : Activity() {

    private lateinit var prefs: Prefs
    private lateinit var server: EditText
    private lateinit var key: EditText
    private lateinit var pin: EditText
    private lateinit var pin2: EditText
    private lateinit var lock: CheckBox
    private lateinit var boot: CheckBox
    private lateinit var status: TextView
    private lateinit var stepLabel: TextView
    private lateinit var title: TextView
    private lateinit var lead: TextView
    private lateinit var back: TextView
    private lateinit var next: TextView
    private val pages = arrayOfNulls<View>(3)
    private val stepDots = mutableListOf<Pair<TextView, TextView>>()
    private var step = 0
    private var verified: Pair<String, String>? = null   // server + key that passed the check
    private var doorName = ""
    private val io = Executors.newSingleThreadExecutor()

    private fun dp(v: Int) = Ui.dp(this, v)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        setTitle(R.string.settings_title)
        window.statusBarColor = Ui.SLATE_900
        val wide = resources.configuration.screenWidthDp >= 720

        val root = LinearLayout(this).apply {
            orientation = if (wide) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
            setBackgroundColor(Ui.SLATE_50)
            fitsSystemWindows = true
        }
        root.addView(side(wide), if (wide) LinearLayout.LayoutParams(dp(380), -1) else LinearLayout.LayoutParams(-1, -2))
        root.addView(ScrollView(this).apply { isFillViewport = true; addView(form()) },
            if (wide) LinearLayout.LayoutParams(0, -1, 1f) else LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        show(0)
    }

    /** Dark panel: brand, headline, the three steps. */
    private fun side(wide: Boolean): View {
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Ui.SLATE_900)
            val p = if (wide) dp(40) else dp(20)
            setPadding(p, p, p, p)
        }
        val brand = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        brand.addView(ImageView(this).apply {
            setImageResource(R.drawable.ic_shield)
            setColorFilter(Color.WHITE)
            background = Ui.rounded(this@SettingsActivity, Ui.INDIGO_600, 8)
            setPadding(dp(10), dp(10), dp(10), dp(10))
        }, LinearLayout.LayoutParams(dp(40), dp(40)))
        brand.addView(Ui.text(this, getString(R.string.setup_brand), 20f, Color.WHITE, true).apply { setPadding(dp(12), 0, dp(12), 0) })
        col.addView(brand)
        col.addView(Ui.text(this, getString(R.string.setup_title), if (wide) 28f else 22f, Color.WHITE, true).apply { setPadding(0, dp(if (wide) 32 else 16), 0, dp(8)) })
        if (wide) col.addView(Ui.text(this, getString(R.string.setup_lead), 15f, Ui.SLATE_400))
        val steps = LinearLayout(this).apply {
            orientation = if (wide) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
            setPadding(0, dp(if (wide) 32 else 12), 0, 0)
        }
        listOf(R.string.step_connect, R.string.step_pin, R.string.step_kiosk).forEachIndexed { i, res ->
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            val num = Ui.text(this, Persian.digits(this, (i + 1).toString()), 13f, Color.WHITE, true).apply { gravity = Gravity.CENTER }
            row.addView(num, LinearLayout.LayoutParams(dp(28), dp(28)))
            val label = Ui.text(this, getString(res), 14f, Ui.SLATE_400).apply { setPadding(dp(10), 0, dp(14), 0) }
            row.addView(label)
            if (!wide && i > 0) label.visibility = View.GONE
            stepDots += num to label
            steps.addView(row, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = if (wide) dp(16) else 0 })
        }
        col.addView(steps)
        if (wide) {
            col.addView(View(this), LinearLayout.LayoutParams(1, 0, 1f))
            col.addView(Ui.text(this, "v" + BuildConfig.VERSION_NAME, 12f, Ui.SLATE_500))
        }
        return col
    }

    private fun form(): View {
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(28), dp(24), dp(24))
        }
        stepLabel = Ui.text(this, "", 14f, Ui.INDIGO_600, true)
        title = Ui.text(this, "", 22f, Ui.SLATE_900, true).apply { setPadding(0, dp(4), 0, dp(4)) }
        lead = Ui.text(this, "", 15f, Ui.SLATE_600)
        col.addView(stepLabel); col.addView(title); col.addView(lead)

        // step 1: server and door key
        pages[0] = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            server = field(this, R.string.server_url, R.string.server_url_hint, prefs.server, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI, false)
            key = field(this, R.string.door_key, R.string.door_key_hint, prefs.key, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD, true)
            addView(Ui.button(this@SettingsActivity, getString(R.string.test_conn), Ui.INDIGO_600, Color.WHITE) { check(false) },
                LinearLayout.LayoutParams(-1, dp(56)).apply { topMargin = dp(20) })
        }
        // step 2: PIN
        pages[1] = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            pin = field(this, R.string.admin_pin, R.string.admin_pin_hint, prefs.pin, InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD, true)
            pin2 = field(this, R.string.pin_repeat, R.string.admin_pin_hint, prefs.pin, InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD, true)
        }
        // step 3: kiosk mode and admin actions
        pages[2] = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(12), 0, 0)
            lock = check(this, R.string.lock_task, prefs.lockTask)
            boot = check(this, R.string.auto_start, prefs.autoStart)
            addView(Ui.text(this@SettingsActivity, getString(if (KioskMode.isDeviceOwner(this@SettingsActivity)) R.string.owner_on else R.string.owner_off), 13f, Ui.SLATE_500)
                .apply { setPadding(0, dp(12), 0, dp(8)) })
            if (prefs.configured) {
                addView(Ui.button(this@SettingsActivity, getString(R.string.exit_kiosk), Color.WHITE, Ui.SLATE_900, Ui.SLATE_300) {
                    prefs.kioskEnabled = false
                    KioskMode.leave(this@SettingsActivity)
                    finishAffinity()       // closes the kiosk screen too; the phone's normal launcher appears
                }, LinearLayout.LayoutParams(-1, dp(48)).apply { topMargin = dp(8) })
            }
            if (KioskMode.isDeviceOwner(this@SettingsActivity)) {
                addView(Ui.button(this@SettingsActivity, getString(R.string.remove_owner), Color.WHITE, Ui.RED_700, Ui.RED_200) {
                    prefs.kioskEnabled = false
                    KioskMode.removeDeviceOwner(this@SettingsActivity)
                    Toast.makeText(this@SettingsActivity, R.string.owner_removed, Toast.LENGTH_LONG).show()
                    finishAffinity()
                }, LinearLayout.LayoutParams(-1, dp(48)).apply { topMargin = dp(8) })
            }
        }
        pages.forEach { col.addView(it, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) }) }

        status = TextView(this).apply {
            textSize = 14f
            setPadding(dp(16), dp(12), dp(16), dp(12))
            compoundDrawablePadding = dp(10)
            visibility = View.GONE
        }
        col.addView(status, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(16) })

        col.addView(View(this), LinearLayout.LayoutParams(1, 0, 1f))
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END; setPadding(0, dp(24), 0, 0) }
        back = Ui.button(this, getString(R.string.back), Color.WHITE, Ui.SLATE_700, Ui.SLATE_300) { show(step - 1) }
        next = Ui.button(this, getString(R.string.next), Ui.INDIGO_600, Color.WHITE) { onNext() }
        bar.addView(back, LinearLayout.LayoutParams(-2, dp(48)).apply { marginEnd = dp(12) })
        bar.addView(next, LinearLayout.LayoutParams(-2, dp(48)))
        col.addView(bar)
        return col
    }

    private fun field(parent: LinearLayout, label: Int, hint: Int, value: String, type: Int, mono: Boolean): EditText {
        parent.addView(Ui.text(this, getString(label), 14f, Ui.SLATE_700, true).apply { setPadding(0, dp(18), 0, dp(8)) })
        val e = EditText(this).apply {
            setHint(hint)
            setText(value)
            inputType = type
            isSingleLine = true
            textDirection = View.TEXT_DIRECTION_LTR
            textSize = 15f
            setTextColor(Ui.SLATE_900)
            setHintTextColor(Ui.SLATE_400)
            if (mono) typeface = android.graphics.Typeface.MONOSPACE
            background = Ui.rounded(this@SettingsActivity, Color.WHITE, 8, Ui.SLATE_300)
            setPadding(dp(16), 0, dp(16), 0)
        }
        parent.addView(e, LinearLayout.LayoutParams(-1, dp(48)))
        return e
    }

    private fun check(parent: LinearLayout, res: Int, value: Boolean) = CheckBox(this).apply {
        setText(res)
        isChecked = value
        textSize = 15f
        setTextColor(Ui.SLATE_900)
        if (Build.VERSION.SDK_INT >= 21) buttonTintList = ColorStateList.valueOf(Ui.INDIGO_600)
        setPadding(dp(8), dp(12), 0, dp(12))
    }.also { parent.addView(it) }

    private fun show(s: Int) {
        step = s.coerceIn(0, 2)
        pages.forEachIndexed { i, v -> v?.visibility = if (i == step) View.VISIBLE else View.GONE }
        stepLabel.text = Persian.digits(this, getString(R.string.step_of, step + 1))
        title.setText(listOf(R.string.connect_title, R.string.pin_set_title, R.string.kiosk_title)[step])
        lead.setText(listOf(R.string.connect_lead, R.string.pin_set_lead, R.string.kiosk_lead)[step])
        stepDots.forEachIndexed { i, (num, label) ->
            num.background = if (i <= step) Ui.circle(Ui.INDIGO_600) else Ui.circle(Color.TRANSPARENT, Ui.SLATE_600, dp(1))
            num.setTextColor(if (i <= step) Color.WHITE else Ui.SLATE_400)
            label.setTextColor(if (i == step) Color.WHITE else Ui.SLATE_400)
            if (resources.configuration.screenWidthDp < 720) label.visibility = if (i == step) View.VISIBLE else View.GONE
        }
        back.visibility = if (step == 0) View.INVISIBLE else View.VISIBLE
        next.setText(if (step == 2) R.string.save else R.string.next)
        status.visibility = if (step == 0 && isVerified()) View.VISIBLE else View.GONE
    }

    private fun onNext() {
        when (step) {
            0 -> if (isVerified()) show(1) else check(true)
            1 -> {
                if (pin.text.toString() != pin2.text.toString()) { showStatus(getString(R.string.pin_mismatch), false); return }
                status.visibility = View.GONE
                show(2)
            }
            2 -> save()
        }
    }

    private fun current() = Prefs.normalizeServer(server.text.toString()) to key.text.toString().trim()
    private fun isVerified() = verified != null && verified == current()

    /** Ask the server who this key belongs to; [thenNext] moves to step 2 on success. */
    private fun check(thenNext: Boolean) {
        val (url, k) = current()
        if (url.isEmpty() || k.isEmpty()) {
            showStatus(getString(R.string.fill_in), false)
            return
        }
        showStatus(getString(R.string.testing), null)
        Ui.setEnabledLook(next, false)
        io.execute {
            val r = Api(url, k).kiosk()
            runOnUiThread {
                if (isFinishing) return@runOnUiThread
                Ui.setEnabledLook(next, true)
                when {
                    r.ok -> {
                        val j = r.json()
                        val org = j.optJSONObject("org")
                        doorName = j.optString("name", "")
                        verified = url to k
                        val parts = listOf(doorName, org?.optString("name", "") ?: "", org?.optString("plan", "") ?: "").filter { it.isNotEmpty() }
                        showStatus(getString(R.string.connected_full, parts.joinToString(" · ")), true)
                        if (thenNext) show(1)
                    }
                    r.code == 401 -> showStatus(getString(R.string.bad_key), false)
                    r.code == 404 -> showStatus(getString(R.string.conn_failed, "HTTP 404 — server too old? (needs /api/v1/kiosk)"), false)
                    else -> showStatus(getString(R.string.conn_failed, if (r.code > 0) "HTTP ${r.code}" else r.body), false)
                }
            }
        }
    }

    private fun save() {
        val (url, k) = current()
        if (!isVerified()) { show(0); check(false); return }
        prefs.server = url
        prefs.key = k
        prefs.pin = pin.text.toString()
        prefs.lockTask = lock.isChecked
        prefs.autoStart = boot.isChecked
        prefs.kioskEnabled = true
        prefs.doorName = doorName
        // back to the kiosk screen; it reloads the live page if the server or key changed
        startActivity(Intent(this, KioskActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
        finish()
    }

    override fun onDestroy() {
        io.shutdown()
        super.onDestroy()
    }

    private fun showStatus(text: String, ok: Boolean?) {
        status.visibility = View.VISIBLE
        status.text = text
        val (fg, bg, line) = when (ok) {
            true -> Triple(Ui.GREEN_700, Ui.GREEN_50, Ui.GREEN_200)
            false -> Triple(Ui.RED_700, Ui.RED_50, Ui.RED_200)
            null -> Triple(Ui.SLATE_600, Color.WHITE, Ui.SLATE_200)
        }
        status.setTextColor(fg)
        status.background = Ui.rounded(this, bg, 8, line)
        val icon = when (ok) { true -> R.drawable.ic_result_ok; false -> R.drawable.ic_result_bad; null -> 0 }
        val d = if (icon != 0) getDrawable(icon)?.mutate()?.apply { setTint(fg); setBounds(0, 0, dp(18), dp(18)) } else null
        status.setCompoundDrawablesRelative(d, null, null, null)
    }
}

/** Persian digits when the UI language is Persian. */
object Persian {
    fun digits(a: Activity, s: String): String =
        if (java.util.Locale.getDefault().language == "fa") s.map { if (it in '0'..'9') '۰' + (it - '0') else it }.joinToString("") else s
}
