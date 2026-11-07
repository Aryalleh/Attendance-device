package com.accessctl.door

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import java.util.concurrent.Executors

/**
 * The way into the settings from the kiosk screen: a company admin's username and password.
 * The server checks them (any admin of the door's company may unlock); if it can't be reached,
 * they are checked against the hash of the password that paired this phone.
 * Closes after 30 s without input; 5 wrong tries lock it for 60 s.
 */
object AdminGate {
    private const val IDLE_MS = 30_000L
    private const val MAX_TRIES = 5
    private const val LOCK_MS = 60_000L
    private var wrong = 0
    private var lockedUntil = 0L
    private val io = Executors.newSingleThreadExecutor()

    fun ask(a: Activity, prefs: Prefs, onOk: () -> Unit) {
        when {
            prefs.hasAdminLogin -> dialog(a, prefs, onOk)
            prefs.pin.isNotEmpty() -> PinDialog.ask(a, prefs.pin, onOk)   // set up before admin sign-in existed
            else -> onOk()
        }
    }

    private fun dialog(a: Activity, prefs: Prefs, onOk: () -> Unit) {
        val dp = { v: Int -> Ui.dp(a, v) }
        val handler = Handler(Looper.getMainLooper())
        val d = Dialog(a, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
        d.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val closeIdle = Runnable { d.dismiss() }
        fun touch() { handler.removeCallbacks(closeIdle); handler.postDelayed(closeIdle, IDLE_MS) }

        val card = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(28), dp(28), dp(28), dp(24))
            background = Ui.rounded(a, Ui.SLATE_800, 16, Ui.SLATE_700)
        }
        card.addView(ImageView(a).apply {
            setImageResource(R.drawable.ic_lock)
            setColorFilter(Ui.INDIGO_300)
            background = Ui.circle(0x334F46E5)
            setPadding(dp(15), dp(15), dp(15), dp(15))
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, LinearLayout.LayoutParams(dp(56), dp(56)).apply { gravity = Gravity.CENTER_HORIZONTAL })
        card.addView(Ui.text(a, a.getString(R.string.gate_title), 20f, Color.WHITE, true).apply {
            gravity = Gravity.CENTER; setPadding(0, dp(16), 0, dp(4))
        })
        val sub = Ui.text(a, a.getString(R.string.gate_sub, prefs.orgName.ifEmpty { prefs.doorName }), 14f, Ui.SLATE_400).apply {
            gravity = Gravity.CENTER; setPadding(0, 0, 0, dp(4))
        }
        card.addView(sub)

        lateinit var submit: () -> Unit
        val user = Ui.field(a, a.getString(R.string.username), a.getString(R.string.username_hint), prefs.adminUser, Ui.Kind.TEXT, true)
        val pass = Ui.field(a, a.getString(R.string.password), "", "", Ui.Kind.PASSWORD, true, EditorInfo.IME_ACTION_DONE) { submit() }
        card.addView(user.view)
        card.addView(pass.view)
        listOf(user.edit, pass.edit).forEach { e ->
            e.addTextChangedListener(object : android.text.TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, st: Int, c: Int, af: Int) {}
                override fun onTextChanged(s: CharSequence?, st: Int, b: Int, c: Int) { touch() }
                override fun afterTextChanged(s: android.text.Editable?) {}
            })
        }

        val row = LinearLayout(a).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(24), 0, 0) }
        val cancel = Ui.button(a, a.getString(R.string.cancel), Ui.SLATE_800, Ui.SLATE_300, Ui.SLATE_600) { d.dismiss() }
        val unlock = Ui.button(a, a.getString(R.string.pin_unlock), Ui.INDIGO_600, Color.WHITE) { submit() }
        row.addView(cancel, LinearLayout.LayoutParams(0, dp(52), 1f).apply { marginEnd = dp(12) })
        row.addView(unlock, LinearLayout.LayoutParams(0, dp(52), 1.4f))
        card.addView(row)
        card.addView(Ui.text(a, a.getString(R.string.pin_timeout), 12f, Ui.SLATE_500).apply { gravity = Gravity.CENTER; setPadding(0, dp(16), 0, 0) })

        fun lockedLeft() = ((lockedUntil - SystemClock.elapsedRealtime()) / 1000).toInt()
        fun showLocked(): Boolean {
            val left = lockedLeft()
            if (left <= 0) return false
            pass.setError(a.getString(R.string.pin_locked, left + 1))
            return true
        }
        fun failed() {
            wrong++
            pass.edit.setText("")
            if (wrong >= MAX_TRIES) {
                wrong = 0
                lockedUntil = SystemClock.elapsedRealtime() + LOCK_MS
                showLocked()
            } else {
                pass.setError(a.getString(R.string.gate_wrong))
            }
            pass.edit.requestFocus()
        }
        submit = submit@{
            touch()
            if (showLocked()) return@submit
            val u = user.text.trim()
            val p = pass.text
            user.setError(if (u.isEmpty()) a.getString(R.string.need_username) else null)
            pass.setError(if (p.isEmpty()) a.getString(R.string.need_password) else null)
            if (u.isEmpty() || p.isEmpty()) return@submit
            Ui.busy(unlock, true, a.getString(R.string.checking))
            io.execute {
                val r = Api(prefs.server, prefs.key).appUnlock(u, p)
                // the server said "wrong" only when it recognised this door; otherwise use the offline check
                val serverSaysNo = r.code == 401 && r.json().optString("error") == "bad_login"
                val ok = r.ok || (!serverSaysNo && prefs.checkAdminLocal(u, p))
                handler.post {
                    if (!d.isShowing) return@post
                    Ui.busy(unlock, false, a.getString(R.string.pin_unlock))
                    if (ok) {
                        wrong = 0
                        handler.removeCallbacks(closeIdle)
                        d.dismiss()
                        onOk()
                    } else failed()
                }
            }
        }

        val scroll = ScrollView(a).apply {
            isFillViewport = true
            addView(FrameLayout(a).apply {
                setPadding(dp(16), dp(24), dp(16), dp(24))
                addView(card, FrameLayout.LayoutParams(dp(400).coerceAtMost(a.resources.displayMetrics.widthPixels - dp(32)),
                    ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
            })
        }
        val scrim = FrameLayout(a).apply { setBackgroundColor(0xE6020617.toInt()); addView(scroll) }
        d.setContentView(scrim)
        d.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        d.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
        d.setOnDismissListener { handler.removeCallbacks(closeIdle) }
        d.show()
        if (!showLocked()) (if (user.text.isEmpty()) user.edit else pass.edit).requestFocus()
        touch()
    }
}
