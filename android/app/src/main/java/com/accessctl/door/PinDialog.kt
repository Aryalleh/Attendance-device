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
import android.view.animation.TranslateAnimation
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Admin PIN keypad over the kiosk screen (UX Pilot: Kiosk - 11 PIN exit).
 * Closes after 30 s without input; 5 wrong PINs lock it for 60 s.
 */
object PinDialog {
    private const val IDLE_MS = 30_000L
    private const val MAX_TRIES = 5
    private const val LOCK_MS = 60_000L
    private var wrong = 0
    private var lockedUntil = 0L

    /** Runs [onOk] if [pin] is empty or the user types it correctly. */
    fun ask(a: Activity, pin: String, onOk: () -> Unit) {
        if (pin.isEmpty()) { onOk(); return }
        val dp = { v: Int -> Ui.dp(a, v) }
        val handler = Handler(Looper.getMainLooper())
        val dialog = Dialog(a, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val closeIdle = Runnable { dialog.dismiss() }
        fun touch() { handler.removeCallbacks(closeIdle); handler.postDelayed(closeIdle, IDLE_MS) }

        val entered = StringBuilder()
        val card = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(32), dp(32), dp(32), dp(28))
            background = Ui.rounded(a, Ui.SLATE_800, 16, Ui.SLATE_700)
        }
        card.addView(ImageView(a).apply {
            setImageResource(R.drawable.ic_lock)
            setColorFilter(Ui.INDIGO_300)
            background = Ui.circle(0x334F46E5)
            setPadding(dp(15), dp(15), dp(15), dp(15))
        }, LinearLayout.LayoutParams(dp(56), dp(56)))
        card.addView(Ui.text(a, a.getString(R.string.pin_title), 20f, Color.WHITE, true).apply { gravity = Gravity.CENTER; setPadding(0, dp(20), 0, 0) })
        val sub = Ui.text(a, a.getString(R.string.pin_sub), 14f, Ui.SLATE_400).apply { gravity = Gravity.CENTER; setPadding(0, dp(4), 0, dp(20)) }
        card.addView(sub)

        // one box per digit of the stored PIN (capped at 8)
        val boxes = LinearLayout(a).apply { orientation = LinearLayout.HORIZONTAL; layoutDirection = View.LAYOUT_DIRECTION_LTR }
        val n = pin.length.coerceIn(1, 8)
        val boxViews = (0 until n).map {
            TextView(a).apply {
                gravity = Gravity.CENTER
                textSize = 24f
                setTextColor(Color.WHITE)
            }.also { boxes.addView(it, LinearLayout.LayoutParams(dp(if (n > 6) 34 else 46), dp(56)).apply { setMargins(dp(4), 0, dp(4), 0) }) }
        }
        card.addView(boxes)
        fun paint() {
            boxViews.forEachIndexed { i, v ->
                val filled = i < entered.length
                v.text = if (filled) "•" else ""
                v.background = Ui.rounded(a, Ui.SLATE_900, 8, if (filled || i == entered.length) Ui.INDIGO_500 else Ui.SLATE_600)
            }
        }
        paint()

        fun lockedLeft() = ((lockedUntil - SystemClock.elapsedRealtime()) / 1000).toInt()
        fun showLocked(): Boolean {
            val left = lockedLeft()
            if (left <= 0) return false
            sub.setTextColor(0xFFF87171.toInt())
            sub.text = a.getString(R.string.pin_locked, left + 1)
            return true
        }
        fun shake() {
            boxes.startAnimation(TranslateAnimation(0f, dp(10).toFloat(), 0f, 0f).apply { duration = 60; repeatCount = 5; repeatMode = TranslateAnimation.REVERSE })
        }
        fun submit() {
            if (showLocked()) return
            if (entered.toString() == pin) {
                wrong = 0
                handler.removeCallbacks(closeIdle)
                dialog.dismiss()
                onOk()
                return
            }
            wrong++
            entered.setLength(0)
            paint()
            shake()
            if (wrong >= MAX_TRIES) {
                wrong = 0
                lockedUntil = SystemClock.elapsedRealtime() + LOCK_MS
                showLocked()
            } else {
                sub.setTextColor(0xFFF87171.toInt())
                sub.setText(R.string.pin_wrong)
            }
        }
        fun press(d: Char) {
            touch()
            if (showLocked() || entered.length >= n) return
            sub.setTextColor(Ui.SLATE_400)
            sub.setText(R.string.pin_sub)
            entered.append(d)
            paint()
            if (entered.length == n) handler.postDelayed({ submit() }, 120)
        }

        // keypad: 1-9, cancel, 0, unlock — always left-to-right like a phone keypad
        val pad = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; layoutDirection = View.LAYOUT_DIRECTION_LTR; setPadding(0, dp(24), 0, 0) }
        val keys = listOf("123", "456", "789", "C0U")
        for (row in keys) {
            val r = LinearLayout(a).apply { orientation = LinearLayout.HORIZONTAL }
            for (k in row) {
                val v = when (k) {
                    'C' -> Ui.button(a, a.getString(R.string.cancel), Ui.SLATE_800, Ui.SLATE_300, Ui.SLATE_600) { handler.removeCallbacks(closeIdle); dialog.dismiss() }.apply { textSize = 14f }
                    'U' -> Ui.button(a, a.getString(R.string.pin_unlock), Ui.INDIGO_600, Color.WHITE) { touch(); submit() }.apply { textSize = 14f }
                    else -> Ui.button(a, k.toString(), Ui.SLATE_700, Color.WHITE) { press(k) }.apply { textSize = 20f }
                }
                v.minHeight = dp(56)
                r.addView(v, LinearLayout.LayoutParams(0, dp(56), 1f).apply { setMargins(dp(5), dp(5), dp(5), dp(5)) })
            }
            pad.addView(r, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        card.addView(pad, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        card.addView(Ui.text(a, a.getString(R.string.pin_timeout), 12f, Ui.SLATE_500).apply { gravity = Gravity.CENTER; setPadding(0, dp(16), 0, 0) })

        val scrim = FrameLayout(a).apply {
            setBackgroundColor(0xCC020617.toInt())
            addView(card, FrameLayout.LayoutParams(dp(380).coerceAtMost(resources.displayMetrics.widthPixels - dp(24)),
                ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        }
        dialog.setContentView(scrim)
        dialog.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        dialog.setOnDismissListener { handler.removeCallbacks(closeIdle) }
        dialog.show()
        showLocked()
        touch()
    }
}
