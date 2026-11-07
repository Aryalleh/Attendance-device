package com.accessctl.door

import android.app.Activity
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * First-run setup and the admin screen (behind the admin sign-in), as a 3-step wizard
 * (UX Pilot: Kiosk - 00 Setup): sign in with a company admin account, choose or create this
 * phone's door, kiosk mode. No door key to copy: the server hands it to the app after sign-in.
 * Opened again from the kiosk screen it starts at the kiosk step; "Change door or account" re-pairs.
 */
class SettingsActivity : Activity() {

    private data class Door(val id: Int, val name: String, val online: Boolean, val android: Boolean, val enabled: Boolean)

    private lateinit var prefs: Prefs
    private lateinit var serverRow: LinearLayout
    private lateinit var serverLabel: TextView
    private lateinit var server: Ui.Field
    private lateinit var user: Ui.Field
    private lateinit var pass: Ui.Field
    private lateinit var doorList: LinearLayout
    private lateinit var newName: Ui.Field
    private lateinit var doorNote: TextView
    private lateinit var lock: Switch
    private lateinit var boot: Switch
    private lateinit var status: TextView
    private lateinit var stepLabel: TextView
    private lateinit var title: TextView
    private lateinit var lead: TextView
    private lateinit var back: TextView
    private lateinit var next: TextView
    private val pages = arrayOfNulls<View>(3)
    private val stepDots = mutableListOf<Pair<TextView, TextView>>()
    private var step = 0
    private val io = Executors.newSingleThreadExecutor()

    // the sign-in that passed, the doors it returned, the chosen door (null = new) and its key
    private var signedIn: Triple<String, String, String>? = null   // server, user, password
    private var orgName = ""
    private var doors = listOf<Door>()
    private var canAdd = true
    private var chosen: Int? = null
    private var paired: Pair<String, String>? = null                // key, door name
    private var repairing = false

    private fun dp(v: Int) = Ui.dp(this, v)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        window.statusBarColor = Ui.SLATE_900
        val wide = resources.configuration.screenWidthDp >= 720

        val root = LinearLayout(this).apply {
            orientation = if (wide) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
            setBackgroundColor(Ui.SLATE_50)
            fitsSystemWindows = true
        }
        root.addView(side(wide), if (wide) LinearLayout.LayoutParams(dp(380), -1) else LinearLayout.LayoutParams(-1, -2))
        root.addView(ScrollView(this).apply { isFillViewport = true; addView(form(wide)) },
            if (wide) LinearLayout.LayoutParams(0, -1, 1f) else LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        repairing = !prefs.configured
        show(if (prefs.configured) 2 else 0)
    }

    /** Dark panel: brand, headline, the three steps. */
    private fun side(wide: Boolean): View {
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Ui.SLATE_900)
            val p = if (wide) dp(40) else dp(20)
            setPadding(p, if (wide) p else dp(16), p, if (wide) p else dp(16))
        }
        val brand = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        brand.addView(ImageView(this).apply {
            setImageResource(R.drawable.ic_shield)
            setColorFilter(Color.WHITE)
            background = Ui.rounded(this@SettingsActivity, Ui.INDIGO_600, 8)
            setPadding(dp(9), dp(9), dp(9), dp(9))
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, LinearLayout.LayoutParams(dp(36), dp(36)))
        brand.addView(Ui.text(this, getString(R.string.setup_brand), 18f, Color.WHITE, true).apply { setPadding(dp(12), 0, dp(12), 0) })
        col.addView(brand)
        if (wide) {
            col.addView(Ui.text(this, getString(R.string.setup_title), 28f, Color.WHITE, true).apply { setPadding(0, dp(32), 0, dp(8)) })
            col.addView(Ui.text(this, getString(R.string.setup_lead), 15f, Ui.SLATE_400).apply { setLineSpacing(0f, 1.3f) })
        }
        val steps = LinearLayout(this).apply {
            orientation = if (wide) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(if (wide) 32 else 14), 0, 0)
        }
        listOf(R.string.step_login, R.string.step_door, R.string.step_kiosk).forEachIndexed { i, res ->
            if (!wide && i > 0) steps.addView(View(this).apply { setBackgroundColor(Ui.SLATE_700) },
                LinearLayout.LayoutParams(dp(16), dp(1)).apply { marginStart = dp(4); marginEnd = dp(4) })
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            val num = Ui.text(this, Persian.digits(this, (i + 1).toString()), 13f, Color.WHITE, true).apply { gravity = Gravity.CENTER }
            row.addView(num, LinearLayout.LayoutParams(dp(28), dp(28)))
            val label = Ui.text(this, getString(res), 14f, Ui.SLATE_400).apply { setPadding(dp(8), 0, dp(4), 0) }
            row.addView(label)
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

    private fun form(wide: Boolean): View {
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val side = if (wide) dp(48) else dp(20)
            setPadding(side, dp(24), side, dp(20))
        }
        stepLabel = Ui.text(this, "", 13f, Ui.INDIGO_600, true)
        title = Ui.text(this, "", 22f, Ui.SLATE_900, true).apply { setPadding(0, dp(4), 0, dp(6)) }
        lead = Ui.text(this, "", 15f, Ui.SLATE_600).apply { setLineSpacing(0f, 1.3f) }
        col.addView(stepLabel); col.addView(title); col.addView(lead)

        // step 1: admin sign-in (the server is preset; "Change" shows the field)
        pages[0] = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val current = prefs.server.ifEmpty { Prefs.DEFAULT_SERVER }
            serverRow = LinearLayout(this@SettingsActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(14), 0, dp(4), 0)
                background = Ui.rounded(this@SettingsActivity, Ui.INDIGO_50, 10)
                serverLabel = Ui.text(this@SettingsActivity, host(current), 14f, Ui.SLATE_700).apply {
                    textDirection = View.TEXT_DIRECTION_LTR; isSingleLine = true; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
                }
                addView(Ui.text(this@SettingsActivity, getString(R.string.server_short), 14f, Ui.SLATE_500), LinearLayout.LayoutParams(-2, -2).apply { marginEnd = dp(8) })
                addView(serverLabel, LinearLayout.LayoutParams(0, -2, 1f))
                addView(Ui.button(this@SettingsActivity, getString(R.string.change), Ui.INDIGO_50, Ui.INDIGO_600) {
                    serverRow.visibility = View.GONE
                    server.view.visibility = View.VISIBLE
                    server.edit.requestFocus()
                }.apply { textSize = 14f; setPadding(dp(12), 0, dp(12), 0) }, LinearLayout.LayoutParams(-2, dp(48)))
            }
            addView(serverRow, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(16) })
            server = Ui.field(this@SettingsActivity, getString(R.string.server_url), getString(R.string.server_url_hint), current, Ui.Kind.URL, false)
            server.view.visibility = View.GONE
            addView(server.view)
            user = Ui.field(this@SettingsActivity, getString(R.string.username), getString(R.string.username_hint), prefs.adminUser, Ui.Kind.TEXT, false)
            pass = Ui.field(this@SettingsActivity, getString(R.string.password), "", "", Ui.Kind.PASSWORD, false, EditorInfo.IME_ACTION_GO) { onNext() }
            addView(user.view); addView(pass.view)
            addView(Ui.text(this@SettingsActivity, getString(R.string.login_note), 13f, Ui.SLATE_500).apply { setPadding(0, dp(12), 0, 0); setLineSpacing(0f, 1.25f) })
        }

        // step 2: this phone's door
        pages[1] = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            doorList = LinearLayout(this@SettingsActivity).apply { orientation = LinearLayout.VERTICAL }
            addView(doorList, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(16) })
            newName = Ui.field(this@SettingsActivity, getString(R.string.new_door_name), getString(R.string.new_door_hint), "", Ui.Kind.TEXT, false,
                EditorInfo.IME_ACTION_DONE) { onNext() }
            newName.edit.textDirection = View.TEXT_DIRECTION_FIRST_STRONG
            addView(newName.view)
            doorNote = Ui.text(this@SettingsActivity, "", 13f, Ui.SLATE_500).apply { setPadding(0, dp(12), 0, 0); setLineSpacing(0f, 1.25f) }
            addView(doorNote)
        }

        // step 3: kiosk mode and admin actions
        pages[2] = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(16), 0, 0)
            val box = LinearLayout(this@SettingsActivity).apply {
                orientation = LinearLayout.VERTICAL
                background = Ui.rounded(this@SettingsActivity, Color.WHITE, 12, Ui.SLATE_200)
            }
            lock = switchRow(box, R.string.lock_task, R.string.lock_task_sub, prefs.lockTask)
            box.addView(View(this@SettingsActivity).apply { setBackgroundColor(Ui.SLATE_200) }, LinearLayout.LayoutParams(-1, 1))
            boot = switchRow(box, R.string.auto_start, R.string.auto_start_sub, prefs.autoStart)
            addView(box)
            addView(Ui.text(this@SettingsActivity, getString(if (KioskMode.isDeviceOwner(this@SettingsActivity)) R.string.owner_on else R.string.owner_off), 13f, Ui.SLATE_500)
                .apply { setPadding(dp(4), dp(12), dp(4), dp(8)); setLineSpacing(0f, 1.25f) })
            if (prefs.configured) {
                addView(Ui.text(this@SettingsActivity, getString(R.string.paired_as, prefs.doorName.ifEmpty { "—" }, prefs.orgName.ifEmpty { "—" },
                    prefs.adminUser.ifEmpty { "—" }), 14f, Ui.SLATE_700).apply { setPadding(dp(4), dp(8), dp(4), 0); setLineSpacing(0f, 1.25f) })
                addView(Ui.button(this@SettingsActivity, getString(R.string.change_pairing), Color.WHITE, Ui.INDIGO_600, Ui.SLATE_300) {
                    repairing = true; show(0)
                }, LinearLayout.LayoutParams(-1, dp(48)).apply { topMargin = dp(12) })
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
        pages.forEach { col.addView(it, LinearLayout.LayoutParams(-1, -2)) }

        status = TextView(this).apply {
            textSize = 14f
            setPadding(dp(14), dp(12), dp(14), dp(12))
            compoundDrawablePadding = dp(10)
            visibility = View.GONE
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        col.addView(status, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(16) })

        col.addView(View(this), LinearLayout.LayoutParams(1, 0, 1f))
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(24), 0, 0) }
        back = Ui.button(this, getString(R.string.back), Color.WHITE, Ui.SLATE_700, Ui.SLATE_300) { show(step - 1) }
        next = Ui.button(this, getString(R.string.next), Ui.INDIGO_600, Color.WHITE) { onNext() }
        bar.addView(back, LinearLayout.LayoutParams(0, dp(52), 1f).apply { marginEnd = dp(12) })
        bar.addView(next, LinearLayout.LayoutParams(0, dp(52), 1.6f))
        col.addView(bar)
        return col
    }

    private fun switchRow(parent: LinearLayout, title: Int, sub: Int, value: Boolean): Switch {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(14), dp(12), dp(14))
            minimumHeight = dp(64)
        }
        val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        texts.addView(Ui.text(this, getString(title), 15f, Ui.SLATE_900, true))
        texts.addView(Ui.text(this, getString(sub), 13f, Ui.SLATE_500).apply { setPadding(0, dp(2), 0, 0) })
        row.addView(texts, LinearLayout.LayoutParams(0, -2, 1f))
        val sw = Switch(this).apply {
            isChecked = value
            contentDescription = getString(title)
            thumbTintList = ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()), intArrayOf(Ui.INDIGO_600, Color.WHITE))
            trackTintList = ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()), intArrayOf(Ui.INDIGO_300, Ui.SLATE_300))
            minimumHeight = dp(48)
        }
        row.addView(sw)
        row.setOnClickListener { sw.toggle() }
        parent.addView(row)
        return sw
    }

    private fun show(s: Int) {
        step = s.coerceIn(0, 2)
        pages.forEachIndexed { i, v -> v?.visibility = if (i == step) View.VISIBLE else View.GONE }
        stepLabel.text = Persian.digits(this, getString(R.string.step_of, step + 1))
        title.setText(listOf(R.string.login_title, R.string.door_title, R.string.kiosk_title)[step])
        lead.text = when (step) {
            0 -> getString(R.string.login_lead)
            1 -> getString(R.string.door_lead, orgName)
            else -> getString(R.string.kiosk_lead)
        }
        val wide = resources.configuration.screenWidthDp >= 720
        stepDots.forEachIndexed { i, (num, label) ->
            num.background = if (i <= step) Ui.circle(Ui.INDIGO_600) else Ui.circle(Color.TRANSPARENT, Ui.SLATE_600, dp(1))
            num.setTextColor(if (i <= step) Color.WHITE else Ui.SLATE_400)
            label.setTextColor(if (i == step) Color.WHITE else Ui.SLATE_400)
            label.visibility = if (wide || i == step) View.VISIBLE else View.GONE
        }
        // configured and only changing kiosk options: the pairing steps open only through "Change door or account"
        back.visibility = if (step == 0 || (step == 2 && !repairing)) View.GONE else View.VISIBLE
        next.setText(when (step) { 0 -> R.string.sign_in; 1 -> R.string.next; else -> R.string.save })
        status.visibility = View.GONE
        if (step == 1) renderDoors()
        if (step == 0) (if (user.text.isEmpty()) user.edit else pass.edit).requestFocus()
    }

    private fun onNext() {
        when (step) {
            0 -> signIn()
            1 -> pair()
            2 -> save()
        }
    }

    private fun host(url: String) = url.removePrefix("https://").removePrefix("http://")

    private fun hideKeyboard() {
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(window.decorView.windowToken, 0)
    }

    /** Step 1: check the admin account and fetch the company's doors. */
    private fun signIn() {
        val url = Prefs.normalizeServer(server.text.ifEmpty { Prefs.DEFAULT_SERVER })
        val u = user.text.trim()
        val p = pass.text
        server.setError(null)
        user.setError(if (u.isEmpty()) getString(R.string.need_username) else null)
        pass.setError(if (p.isEmpty()) getString(R.string.need_password) else null)
        if (u.isEmpty() || p.isEmpty()) return
        hideKeyboard()
        Ui.busy(next, true, getString(R.string.signing_in))
        io.execute {
            val r = Api(url).appDoors(u, p)
            runOnUiThread {
                if (isFinishing) return@runOnUiThread
                Ui.busy(next, false, getString(R.string.sign_in))
                val j = r.json()
                when {
                    r.ok -> {
                        signedIn = Triple(url, u, p)
                        orgName = j.optJSONObject("org")?.optString("name", "") ?: ""
                        canAdd = j.optBoolean("can_add", true)
                        val arr = j.optJSONArray("doors")
                        doors = (0 until (arr?.length() ?: 0)).map { i ->
                            val o = arr!!.getJSONObject(i)
                            Door(o.getInt("id"), o.optString("name"), o.optBoolean("online"), o.optBoolean("android"), o.optBoolean("enabled", true))
                        }
                        // preselect this phone's current door, else a new door (or the first door when the plan is full)
                        chosen = doors.firstOrNull { it.name == prefs.doorName && prefs.server == url }?.id
                            ?: if (canAdd) null else doors.firstOrNull()?.id
                        paired = null
                        serverLabel.text = host(url)
                        show(1)
                    }
                    r.code == 401 -> {
                        pass.setError(j.optString("message").ifEmpty { getString(R.string.gate_wrong) })
                        pass.edit.setText("")
                        pass.edit.requestFocus()
                    }
                    r.code == 403 -> showStatus(j.optString("message").ifEmpty { "HTTP 403" }, false)
                    r.code == 404 || r.code < 0 -> {
                        serverRow.visibility = View.GONE
                        server.view.visibility = View.VISIBLE
                        server.setError(if (r.code == 404) getString(R.string.server_old) else getString(R.string.conn_failed, r.body))
                    }
                    else -> showStatus(getString(R.string.conn_failed, "HTTP ${r.code}"), false)
                }
            }
        }
    }

    /** Step 2: the door list, plus "new door" when the plan allows another. */
    private fun renderDoors() {
        doorList.removeAllViews()
        fun row(id: Int?, name: String, sub: String, icon: Int, enabled: Boolean) {
            val sel = chosen == id
            val r = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(14), dp(12), dp(14), dp(12))
                minimumHeight = dp(64)
                background = Ui.rounded(this@SettingsActivity, if (sel) Ui.INDIGO_50 else Color.WHITE, 12,
                    if (sel) Ui.INDIGO_600 else Ui.SLATE_200, if (sel) 2 else 1)
                isClickable = enabled
                isFocusable = enabled
                alpha = if (enabled) 1f else 0.55f
                contentDescription = "$name. $sub"
                if (enabled) setOnClickListener { chosen = id; renderDoors() }
            }
            r.addView(ImageView(this).apply {
                setImageResource(icon)
                setColorFilter(if (sel) Color.WHITE else Ui.SLATE_500)
                background = Ui.rounded(this@SettingsActivity, if (sel) Ui.INDIGO_600 else Ui.SLATE_50, 10)
                setPadding(dp(10), dp(10), dp(10), dp(10))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }, LinearLayout.LayoutParams(dp(40), dp(40)))
            val t = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), 0, dp(12), 0) }
            t.addView(Ui.text(this, name, 15f, Ui.SLATE_900, true))
            if (sub.isNotEmpty()) t.addView(Ui.text(this, sub, 13f, Ui.SLATE_500).apply { setPadding(0, dp(2), 0, 0) })
            r.addView(t, LinearLayout.LayoutParams(0, -2, 1f))
            if (sel) r.addView(ImageView(this).apply {
                setImageResource(R.drawable.ic_result_ok)
                setColorFilter(Ui.INDIGO_600)
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }, LinearLayout.LayoutParams(dp(22), dp(22)))
            doorList.addView(r, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10) })
        }
        for (d in doors) {
            val parts = mutableListOf(getString(if (d.online) R.string.door_online else R.string.door_offline))
            if (d.android) parts += getString(R.string.door_android)
            if (!d.enabled) parts += getString(R.string.door_disabled_short)
            row(d.id, d.name, parts.joinToString(" · "), R.drawable.ic_result_door, true)
        }
        row(null, getString(R.string.new_door), getString(if (canAdd) R.string.new_door_sub else R.string.new_door_limit), R.drawable.ic_plus, canAdd)
        newName.view.visibility = if (chosen == null && canAdd) View.VISIBLE else View.GONE
        if (newName.text.isEmpty()) newName.edit.setText(getString(R.string.new_door_default))
        val picked = doors.firstOrNull { it.id == chosen }
        doorNote.text = getString(if (picked != null && picked.online && !picked.android) R.string.door_in_use else R.string.door_note)
    }

    /** Step 2 → 3: get the chosen door's key from the server (or create the door). */
    private fun pair() {
        val s = signedIn ?: run { show(0); return }
        if (chosen == null && !canAdd) { showStatus(getString(R.string.new_door_limit), false); return }
        val name = newName.text.trim()
        if (chosen == null && name.isEmpty()) { newName.setError(getString(R.string.need_door_name)); return }
        newName.setError(null)
        hideKeyboard()
        Ui.busy(next, true, getString(R.string.checking))
        io.execute {
            val r = Api(s.first).appPair(s.second, s.third, chosen, name)
            runOnUiThread {
                if (isFinishing) return@runOnUiThread
                Ui.busy(next, false, getString(R.string.next))
                val j: JSONObject = r.json()
                val key = j.optString("key", "")
                when {
                    r.ok && key.isNotEmpty() -> {
                        paired = key to j.optString("name", name)
                        orgName = j.optString("org", orgName)
                        show(2)
                        showStatus(getString(R.string.connected_full, listOf(paired!!.second, orgName).filter { it.isNotEmpty() }.joinToString(" · ")), true)
                    }
                    r.code == 409 -> newName.setError(j.optString("message"))
                    else -> showStatus(j.optString("message").ifEmpty { getString(R.string.conn_failed, if (r.code > 0) "HTTP ${r.code}" else r.body) }, false)
                }
            }
        }
    }

    private fun save() {
        if (repairing) {
            val s = signedIn
            val p = paired
            if (s == null || p == null) { show(0); return }
            prefs.server = s.first
            prefs.key = p.first
            prefs.doorName = p.second
            prefs.orgName = orgName
            prefs.setAdmin(s.second, s.third)
        }
        prefs.lockTask = lock.isChecked
        prefs.autoStart = boot.isChecked
        prefs.kioskEnabled = true
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
        status.background = Ui.rounded(this, bg, 10, line)
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
