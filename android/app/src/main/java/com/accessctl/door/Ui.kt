package com.accessctl.door

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.text.method.HideReturnsTransformationMethod
import android.text.method.PasswordTransformationMethod
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
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
    const val RED_400 = 0xFFF87171.toInt()
    const val INDIGO_50 = 0xFFEEF2FF.toInt()

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
            background = pressable(c, fill, stroke)
            isClickable = true
            isFocusable = true
            setOnClickListener { onClick() }
        }

    /** Fill that darkens while pressed (tap feedback without moving anything). */
    fun pressable(c: Context, fill: Int, stroke: Int = Color.TRANSPARENT) = android.graphics.drawable.StateListDrawable().apply {
        val pressed = if (fill == Color.WHITE || Color.alpha(fill) < 255) SLATE_200 else blend(fill, Color.BLACK, 0.18f)
        addState(intArrayOf(android.R.attr.state_pressed), rounded(c, pressed, 10, stroke))
        addState(intArrayOf(), rounded(c, fill, 10, stroke))
    }

    private fun blend(a: Int, b: Int, t: Float): Int = Color.rgb(
        (Color.red(a) * (1 - t) + Color.red(b) * t).toInt(), (Color.green(a) * (1 - t) + Color.green(b) * t).toInt(),
        (Color.blue(a) * (1 - t) + Color.blue(b) * t).toInt())

    fun setEnabledLook(v: View, on: Boolean) {
        v.isEnabled = on
        v.alpha = if (on) 1f else 0.45f
    }

    /** A labelled text field with its own error line under it (and a show/hide toggle for passwords). */
    class Field(val view: LinearLayout, val edit: EditText, private val error: TextView, private val box: View,
                private val normal: android.graphics.drawable.Drawable, private val bad: android.graphics.drawable.Drawable) {
        val text get() = edit.text.toString()
        fun setError(msg: CharSequence?) {
            error.text = msg ?: ""
            error.visibility = if (msg.isNullOrEmpty()) View.GONE else View.VISIBLE
            box.background = if (msg.isNullOrEmpty()) normal else bad
        }
    }

    enum class Kind { TEXT, URL, PASSWORD }

    fun field(c: Context, label: CharSequence, hint: CharSequence, value: String, kind: Kind, dark: Boolean,
              ime: Int = EditorInfo.IME_ACTION_NEXT, onIme: (() -> Unit)? = null): Field {
        val col = LinearLayout(c).apply { orientation = LinearLayout.VERTICAL }
        col.addView(text(c, label, 14f, if (dark) SLATE_300 else SLATE_700, true).apply { setPadding(0, dp(c, 16), 0, dp(c, 8)) })
        val normal = rounded(c, if (dark) SLATE_900 else Color.WHITE, 10, if (dark) SLATE_600 else SLATE_300)
        val bad = rounded(c, if (dark) SLATE_900 else RED_50, 10, if (dark) RED_400 else RED_700)
        val box = FrameLayout(c).apply { background = normal }
        val edit = EditText(c).apply {
            setHint(hint)
            setText(value)
            inputType = when (kind) {
                Kind.URL -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
                Kind.PASSWORD -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                Kind.TEXT -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            }
            isSingleLine = true
            imeOptions = ime
            if (onIme != null) setOnEditorActionListener { _, a, _ -> if (a == ime) { onIme(); true } else false }
            textSize = 16f
            setTextColor(if (dark) Color.WHITE else SLATE_900)
            setHintTextColor(if (dark) SLATE_500 else SLATE_400)
            background = null
            textDirection = View.TEXT_DIRECTION_LTR   // user names, URLs and passwords are Latin
            val end = if (kind == Kind.PASSWORD) dp(c, 52) else dp(c, 16)
            setPaddingRelative(dp(c, 16), 0, end, 0)
            if (kind == Kind.PASSWORD) transformationMethod = PasswordTransformationMethod.getInstance()
        }
        box.addView(edit, FrameLayout.LayoutParams(-1, dp(c, 52)))
        if (kind == Kind.PASSWORD) {
            var shown = false
            val eye = ImageView(c).apply {
                setImageResource(R.drawable.ic_eye)
                setColorFilter(if (dark) SLATE_400 else SLATE_500)
                scaleType = ImageView.ScaleType.CENTER_INSIDE
                setPadding(dp(c, 14), dp(c, 14), dp(c, 14), dp(c, 14))
                contentDescription = c.getString(R.string.show_password)
                isClickable = true
                isFocusable = true
                background = rounded(c, Color.TRANSPARENT, 10)
                setOnClickListener {
                    shown = !shown
                    val pos = edit.selectionEnd
                    edit.transformationMethod = if (shown) HideReturnsTransformationMethod.getInstance() else PasswordTransformationMethod.getInstance()
                    edit.setSelection(pos.coerceAtLeast(0))
                    setImageResource(if (shown) R.drawable.ic_eye_off else R.drawable.ic_eye)
                    contentDescription = c.getString(if (shown) R.string.hide_password else R.string.show_password)
                }
            }
            box.addView(eye, FrameLayout.LayoutParams(dp(c, 52), dp(c, 52), Gravity.END or Gravity.CENTER_VERTICAL))
        }
        col.addView(box, LinearLayout.LayoutParams(-1, dp(c, 52)))
        val err = text(c, "", 13f, if (dark) RED_400 else RED_700).apply { setPadding(dp(c, 4), dp(c, 6), dp(c, 4), 0); visibility = View.GONE }
        col.addView(err)
        return Field(col, edit, err, box, normal, bad)
    }

    /** Busy state of a button: disabled, with a "working" label; restores the label afterwards. */
    fun busy(v: TextView, on: Boolean, label: CharSequence) {
        setEnabledLook(v, !on)
        v.text = label
    }
}
