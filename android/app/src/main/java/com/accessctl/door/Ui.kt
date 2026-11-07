package com.accessctl.door

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.TextView

/** Small helpers for the code-built SecureEntry screens (colors follow Tailwind slate/indigo, like the web panel). */
object Ui {
    const val SLATE_950 = 0xFF020617.toInt()
    const val SLATE_900 = 0xFF0F172A.toInt()
    const val SLATE_800 = 0xFF1E293B.toInt()
    const val SLATE_700 = 0xFF334155.toInt()
    const val SLATE_600 = 0xFF475569.toInt()
    const val SLATE_500 = 0xFF64748B.toInt()
    const val SLATE_400 = 0xFF94A3B8.toInt()
    const val SLATE_300 = 0xFFCBD5E1.toInt()
    const val SLATE_200 = 0xFFE2E8F0.toInt()
    const val SLATE_50 = 0xFFF8FAFC.toInt()
    const val INDIGO_600 = 0xFF4F46E5.toInt()
    const val INDIGO_500 = 0xFF6366F1.toInt()
    const val INDIGO_300 = 0xFFA5B4FC.toInt()
    const val GREEN_700 = 0xFF15803D.toInt()
    const val GREEN_50 = 0xFFF0FDF4.toInt()
    const val GREEN_200 = 0xFFBBF7D0.toInt()
    const val RED_700 = 0xFFB91C1C.toInt()
    const val RED_50 = 0xFFFEF2F2.toInt()
    const val RED_200 = 0xFFFECACA.toInt()

    fun dp(c: Context, v: Int) = (v * c.resources.displayMetrics.density).toInt()

    fun rounded(c: Context, fill: Int, radiusDp: Int, stroke: Int = Color.TRANSPARENT, strokeDp: Int = 1) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(c, radiusDp).toFloat()
        if (stroke != Color.TRANSPARENT) setStroke(dp(c, strokeDp), stroke)
    }

    fun circle(fill: Int, stroke: Int = Color.TRANSPARENT, strokePx: Int = 0) = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(fill)
        if (strokePx > 0) setStroke(strokePx, stroke)
    }

    fun text(c: Context, s: CharSequence, sp: Float, color: Int, bold: Boolean = false) = TextView(c).apply {
        text = s
        textSize = sp
        setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
    }

    /** A filled or outlined button-like TextView (keeps the design's flat look on every Android version). */
    fun button(c: Context, label: CharSequence, fill: Int, fg: Int, stroke: Int = Color.TRANSPARENT, onClick: () -> Unit) =
        TextView(c).apply {
            text = label
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(fg)
            gravity = Gravity.CENTER
            minHeight = dp(c, 48)
            setPadding(dp(c, 20), 0, dp(c, 20), 0)
            background = rounded(c, fill, 10, stroke)
            isClickable = true
            isFocusable = true
            setOnClickListener { onClick() }
        }

    fun setEnabledLook(v: View, on: Boolean) {
        v.isEnabled = on
        v.alpha = if (on) 1f else 0.45f
    }
}
